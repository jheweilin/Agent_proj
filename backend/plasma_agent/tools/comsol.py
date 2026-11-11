"""COMSOL Multiphysics through the lab's COMSOL REST API (see .guides/COMSOL_AGENT_GUIDE.md).

The checks here come from the guide's field notes: a job can report
`completed / success: true` while the log contains errors or NaN, so every finished
job is checked against its log, and RESULT_ lines printed by the Java code are extracted.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import zipfile

import httpx

from .. import events, sandbox
from ..config import settings
from .base import ToolContext, ToolResult, tool

TERMINAL = {"completed", "failed", "cancelled"}
BAD_PATTERNS = ["/*****Error", "Error running java class", "Exception", "NaN", "License checkout failed"]


DATA_EXTS = ("mph", "txt", "csv", "dat", "xlsx", "xls", "json", "mphbin", "mphtxt", "nas", "stl", "step", "stp",
             "igs", "iges", "dxf", "x_t", "x_b", "png", "jpg", "tif", "m", "sec", "lut")
REF_RE = re.compile(r'"([^"\n]+\.(?:' + "|".join(DATA_EXTS) + r'))"', re.IGNORECASE)


OUTPUT_HINT = re.compile(r"export|\.save\(", re.IGNORECASE)  # exportImage(...) matches "export"
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".tif")


def _referenced_files(src: str) -> list[str]:
    """Quoted file names with data-file extensions in Java source (e.g. set("Filepath", "x.txt")) that the model
    reads. Names on lines that export or save results (Image/Data export filenames, exportImage(...), "./x.png")
    are outputs, not inputs, and are skipped."""
    seen, out = set(), []
    for line in src.splitlines():
        code = line.split("//", 1)[0]
        for m in REF_RE.finditer(code):
            ref = m.group(1)
            if ref in seen or ref.lower().startswith(("http://", "https://")) or ref.startswith("./"):
                continue
            if OUTPUT_HINT.search(code):
                continue
            seen.add(ref)
            out.append(ref)
    return out


def _find_in_workspace(thread_id: str, name: str, near: "Path") -> "Path | None":
    """Look for a referenced data file: next to the main file first, then anywhere in /workspace."""
    base = name.replace("\\", "/").split("/")[-1]
    cand = near.parent / base
    if cand.is_file():
        return cand
    root = sandbox.workspace_dir(thread_id)
    hits = [p for p in root.rglob(base) if p.is_file() and ".jobs" not in p.parts]
    return sorted(hits, key=lambda p: len(p.parts))[0] if hits else None


def _api(path: str) -> str:
    return f"{settings.comsol_api}{path}"


async def _get(path: str, timeout: float = 30) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as c:
        return await c.get(_api(path))


PROGRESS = re.compile(r"^\s*(-+\s*Current Progress:|Memory:\s)")
# [ \t] (not \s) so the stage text can't run across the newline into the next line
PROG_LINE = re.compile(r"Current Progress:[ \t]*(\d+)[ \t]*%[ \t]*-[ \t]*([^\n]*?)[ \t]*$", re.M)
STAGE_LINE = re.compile(r"^<----[ \t]*(.*?)[ \t]+in Study\b", re.M)


def _parse_progress(log: str) -> tuple[str | None, int | None]:
    """Latest COMSOL progress from the batch log: the current sub-step name and its percent.
    COMSOL prints `Current Progress: N % - <stage>`; the percent restarts per sub-step, so it is
    'progress within the current stage', not overall. When the stage text is blank (e.g. inside a
    solver) fall back to the last `<---- <stage> in Study ...` banner."""
    stage, pct = None, None
    ms = PROG_LINE.findall(log)
    if ms:
        pct = int(ms[-1][0])
        stage = ms[-1][1].strip() or None
    if not stage:
        ss = STAGE_LINE.findall(log)
        if ss:
            stage = ss[-1].strip()
    return stage, pct


def _scan_log(log: str) -> dict:
    """Find error markers and return them WITH the lines that follow: COMSOL prints only
    `/*****Error****/` + `Error running java class.` as markers; the real cause (exception,
    unknown feature, wrong property, failing line) comes in the next lines."""
    lines = log.splitlines()
    problems, details, seen = [], [], set()
    for i, line in enumerate(lines):
        if not any(b in line for b in BAD_PATTERNS):
            continue
        problems.append(line.strip()[:300])
        if i in seen:
            continue
        ctx = []
        for j in range(i, min(len(lines), i + 25)):
            seen.add(j)
            s = lines[j].rstrip()
            if s and not PROGRESS.match(s):
                ctx.append(s[:400])
        if ctx:
            details.append("\n".join(ctx))
    results = re.findall(r"^\s*(RESULT_[A-Za-z0-9_]+)\s*=\s*(.+?)\s*$", log, flags=re.M)
    out = {"problem_lines": problems[:30], "problem_count": len(problems),
           "printed_results": {k: v for k, v in results}}
    if details:
        out["error_details"] = details[:6]
        out["note"] = ("RESULT_ 值是在錯誤發生前印出的；錯誤之後的步驟沒有執行。"
                       "依 error_details 修正對應的那一行再重送。")
    return out


@tool(
    "comsol_status",
    "查詢 COMSOL 服務狀態：是否可用、版本、排隊中的 job 數與正在執行的 job。送出前先看排隊狀況。",
    {},
)
async def comsol_status(ctx: ToolContext, args: dict) -> ToolResult:
    try:
        h = (await _get("/health", 10)).json()
        info = (await _get("/info", 10)).json()
    except Exception as e:
        return ToolResult(f"COMSOL 服務連不上：{e}", is_error=True)
    return ToolResult(json.dumps({"health": h, "info": info}, ensure_ascii=False, indent=1),
                      preview=f"COMSOL {info.get('comsol_version')}，排隊 {h.get('queue_size')}")


@tool(
    "comsol_submit",
    """把 /workspace 內的 COMSOL 模型送到 COMSOL 服務執行。
- main_file：.java / .mph / .class（.java 的 public class 名稱必須和檔名相同）
- mode：compile 只檢查語法（幾秒），batch 編譯並執行模擬
- data_files：模型會讀取的資料檔（Java 內用相對路徑引用）；Java 引用到的檔案會自動附上
- 後處理既有結果：Java 用 ModelUtil.load("m", "xxx.mph") 載入先前下載的 .mph（會自動附上），不需重新求解
服務一次只跑一個 job（先進先出）。送出後用 comsol_job 等待結果。""",
    {"main_file": {"type": "string"},
     "mode": {"type": "string", "enum": ["batch", "compile"]},
     "data_files": {"type": "array", "items": {"type": "string"}},
     "study": {"type": "string"},
     "parameters": {"type": "object", "description": "模型參數，例如 {\"V0\": 100}"}},
    ["main_file"],
)
async def comsol_submit(ctx: ToolContext, args: dict) -> ToolResult:
    main = sandbox.resolve_path(ctx.thread_id, args["main_file"])
    if not main.is_file() or main.suffix.lower() not in {".java", ".mph", ".class"}:
        return ToolResult(f"main_file 必須是存在的 .java/.mph/.class：{args['main_file']}", is_error=True)
    warnings = []
    data_paths: list = []
    for df in args.get("data_files") or []:
        p = sandbox.resolve_path(ctx.thread_id, df)
        if not p.is_file():
            return ToolResult(f"資料檔不存在：{df}", is_error=True)
        data_paths.append(p)
    auto_added = []
    if main.suffix.lower() == ".java":
        src = main.read_text(errors="replace")
        if not re.search(rf"public\s+class\s+{re.escape(main.stem)}\b", src):
            return ToolResult(f"public class 名稱必須是 {main.stem}（與檔名相同）", is_error=True)
        if "model.save" in src and "throws" not in src:
            warnings.append("main 沒有宣告 throws java.io.IOException，model.save() 會編譯失敗")
        if "modelPath(" in src:
            warnings.append("程式碼含 model.modelPath(...)（匯出時的本機路徑），服務端不存在，建議刪除")
        # Data files the model reads (cross sections, tables, CAD...) must travel with the job:
        # the service puts every uploaded file in one directory next to the class.
        missing, with_dirs = [], []
        given = {p.name for p in data_paths}
        for ref in _referenced_files(src):
            base = ref.replace("\\", "/").split("/")[-1]
            if base != ref:
                with_dirs.append(ref)
            if base in given or base == main.name:
                continue
            hit = _find_in_workspace(ctx.thread_id, ref, main)
            if hit is None and base.lower().endswith(IMAGE_EXTS):
                warnings.append(f"程式碼提到 {ref}，但工作區沒有這個檔；如果它是要輸出的圖就沒問題")
            elif hit is None:
                missing.append(ref)
            else:
                data_paths.append(hit)
                given.add(base)
                auto_added.append(sandbox.to_container_path(ctx.thread_id, hit))
        if missing:
            return ToolResult(
                "Java 程式碼引用了下列資料檔，但在 /workspace 找不到，沒有送出：\n"
                + "\n".join(f"- {m}" for m in missing)
                + "\n請把檔案放進 /workspace（使用者上傳的檔案在 /workspace/uploads/），或確認檔名。", is_error=True)
        if with_dirs:
            warnings.append("程式碼用帶目錄的路徑引用資料檔：" + ", ".join(with_dirs)
                            + "。服務端會把上傳檔案放在同一個目錄，請改成只寫檔名（例如 \"Ar_xsecs_reduced.txt\"）")
    files = [("files", (main.name, main.read_bytes(), "application/octet-stream"))]
    for p in data_paths:
        files.append(("files", (p.name, p.read_bytes(), "application/octet-stream")))
    data = {"owner": f"plasma-agent:{ctx.user_email}:{ctx.thread_id[:8]}"}
    if args.get("study"):
        data["study"] = args["study"]
    if args.get("parameters"):
        data["parameters"] = json.dumps(args["parameters"])
    endpoint = "/compile" if args.get("mode") == "compile" else "/batch"
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(_api(endpoint), files=files, data=data)
    if r.status_code >= 400:
        return ToolResult(f"送出失敗 HTTP {r.status_code}：{r.text[:2000]}", is_error=True)
    job = r.json()
    out = {"job_id": job.get("id"), "type": job.get("type"), "status": job.get("status"),
           "queue_position": job.get("queue_position"),
           "uploaded_files": [main.name] + [p.name for p in data_paths]}
    if auto_added:
        out["auto_added_data_files"] = auto_added
    if warnings:
        out["warnings"] = warnings
    return ToolResult(json.dumps(out, ensure_ascii=False, indent=1),
                      preview=f"COMSOL {endpoint[1:]} {out['job_id']}（排隊 {out['queue_position']}）")


BLOCK_RE = re.compile(r"^#PA_DATA_BEGIN ([^\n]*)\n(.*?)^#PA_DATA_END[ \t]*$", re.M | re.S)
SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")
NUM_ROW = re.compile(r"[-+0-9.eE,NaInfity ]+")


def _parse_blocks(log: str) -> list[tuple[dict, str]]:
    """Data blocks printed by the Java helpers (dumpGrid2D / dumpLine / dumpTable)."""
    out = []
    for m in BLOCK_RE.finditer(log):
        meta = dict(kv.split("=", 1) for kv in m.group(1).split() if "=" in kv)
        cols = meta.pop("cols", "")
        # keep only numeric CSV rows (COMSOL may interleave progress lines into stdout)
        body = "\n".join(l.strip() for l in m.group(2).splitlines() if NUM_ROW.fullmatch(l.strip() or "x"))
        if cols and body:
            meta["name"] = SAFE_NAME.sub("_", meta.get("name", f"data{len(out) + 1}"))[:60]
            out.append((meta, cols + "\n" + body + "\n"))
    return out


def _attachment(thread_id: str, p) -> dict:
    import mimetypes
    return {"path": sandbox.to_container_path(thread_id, p), "name": p.name, "size": p.stat().st_size,
            "mime": mimetypes.guess_type(p.name)[0] or "application/octet-stream"}


async def _collect_results(ctx: ToolContext, jid: str, log: str | None = None, force: bool = False) -> dict:
    """Download a finished job's outputs into /workspace/comsol/<job_id>/, pull preview images out of
    the .mph files, turn #PA_DATA blocks from the log into CSV + quick-look PNGs, and attach it all."""
    dest = sandbox.resolve_path(ctx.thread_id, f"comsol/{jid}")
    marker = dest / ".collected.json"
    if marker.exists() and not force:
        return json.loads(marker.read_text())
    dest.mkdir(parents=True, exist_ok=True)
    files, previews, plots, data_files, notes = [], [], [], [], []
    async with httpx.AsyncClient(timeout=900) as c:
        r = await c.get(_api(f"/jobs/{jid}/download"))
        if r.status_code >= 400:
            return {"error": f"下載失敗 HTTP {r.status_code}：{r.text[:300]}"}
        cd = r.headers.get("content-disposition", "")
        m = re.search(r'filename="?([^";]+)"?', cd)
        name = (m.group(1) if m else f"{jid}_result").split("/")[-1]
        blob = dest / name
        blob.write_bytes(r.content)
        if zipfile.is_zipfile(blob) and not name.endswith(".mph"):
            with zipfile.ZipFile(blob) as z:
                for member in z.namelist():
                    target = (dest / member).resolve()
                    if target.is_relative_to(dest.resolve()) and not member.endswith("/"):
                        z.extract(member, dest)
                        files.append(target)
            blob.unlink()
        else:
            files.append(blob)
        meta = await c.get(_api(f"/jobs/{jid}/results"))
        if meta.status_code == 200:
            (dest / "results.json").write_text(json.dumps(meta.json(), ensure_ascii=False, indent=1))
        if log is None:
            log = (await c.get(_api(f"/jobs/{jid}/log"))).json().get("log", "")
    # preview images saved inside .mph files (present when the model was saved from the GUI)
    for f in [x for x in files if x.suffix == ".mph" and zipfile.is_zipfile(x)]:
        with zipfile.ZipFile(f) as z:
            names = z.namelist()
            pick = next((n for n in ("modelimage_large.png", "modelimage.png") if n in names), None)
            if pick:
                out = dest / f"{f.stem}_preview.png"
                out.write_bytes(z.read(pick))
                previews.append(out)
    if not previews and not any(x.suffix.lower() == ".png" for x in files) and any(x.suffix == ".mph" for x in files):
        notes.append("這個 job 沒有匯出圖片；要看 COMSOL 的圖，請在 Java 用 Image 匯出（見 plot_data/README.md）")
    # data blocks -> CSV -> quick-look plots (rendered in the sandbox, which has matplotlib)
    blocks = _parse_blocks(log or "")
    stats = []
    if blocks:
        ddir = dest / "data"
        ddir.mkdir(exist_ok=True)
        for meta_d, csv_text in blocks:
            (ddir / f"{meta_d['name']}.csv").write_text(csv_text)
            (ddir / f"{meta_d['name']}.meta.json").write_text(json.dumps(meta_d))
            data_files.append(ddir / f"{meta_d['name']}.csv")
        code, out = await sandbox.exec_command(
            ctx.thread_id, f"python /workspace/.guides/tools/comsol_quickplot.py {sandbox.to_container_path(ctx.thread_id, ddir)}", 300)
        for line in out.splitlines():
            try:
                st = json.loads(line)
            except ValueError:
                continue
            stats.append(st)
            if st.get("png"):
                hp = sandbox.resolve_path(ctx.thread_id, st["png"])
                if hp.is_file():
                    plots.append(hp)
        if code != 0:
            notes.append(f"自動繪圖失敗（exit {code}）：{out[-500:]}")
    files = [x for x in files if x.is_file()]
    images = [x for x in files if x.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif"}]  # COMSOL Image exports
    others = [x for x in files if x not in images]
    attach = [_attachment(ctx.thread_id, p) for p in images + plots + previews + others + data_files]
    result = {
        "folder": sandbox.to_container_path(ctx.thread_id, dest),
        "comsol_images": [sandbox.to_container_path(ctx.thread_id, p) for p in images],
        "files": [sandbox.to_container_path(ctx.thread_id, p) for p in files],
        "preview_images": [sandbox.to_container_path(ctx.thread_id, p) for p in previews],
        "plots": [sandbox.to_container_path(ctx.thread_id, p) for p in plots],
        "data_stats": stats,
        "attachments": attach,
    }
    if notes:
        result["notes"] = notes
    marker.write_text(json.dumps(result, ensure_ascii=False))
    if attach:
        await ctx.publish({"type": "attachments", "files": attach})
    return result


@tool(
    "comsol_job",
    """查詢 COMSOL job。wait_seconds > 0 時等到 job 結束或等待時間到（最多 900 秒）。
job 結束後會自動讀取 log，回報 Error/Exception/NaN（error_details 是實際錯誤內容）與 Java 印出的 RESULT_xxx= 數值。
batch job 成功後會**自動**把所有結果下載到 /workspace/comsol/<job_id>/ 並附給使用者：.mph、.mph.status、
Java 裡用 Image/Data 匯出的圖與數據檔（collected.comsol_images），以及 log 裡 #PA_DATA 數據區塊轉成的 CSV 與預覽圖
（collected.plots）。不需要再呼叫 comsol_download。
注意：status=completed、success=true 不代表結果正確，一定要看 log_check 與 data_stats，並用 see_image 檢查圖。""",
    {"job_id": {"type": "string"},
     "wait_seconds": {"type": "integer", "minimum": 0, "maximum": 900}},
    ["job_id"],
)
async def comsol_job(ctx: ToolContext, args: dict) -> ToolResult:
    jid = args["job_id"]
    started = time.time()
    deadline = started + int(args.get("wait_seconds") or 0)
    while True:
        r = await _get(f"/jobs/{jid}")
        if r.status_code == 404:
            return ToolResult(f"找不到 COMSOL job：{jid}", is_error=True)
        job = r.json()
        if job.get("status") in TERMINAL or time.time() >= deadline:
            break
        # honour a user "停止" even while a long solve is running: cancel the COMSOL job and bail,
        # instead of blocking here until the whole solve finishes
        if await events.stop_requested(ctx.run_id):
            try:
                async with httpx.AsyncClient(timeout=30) as c:
                    await c.post(_api(f"/jobs/{jid}/cancel"))
            except Exception:
                pass
            return ToolResult(json.dumps({"job_id": jid, "status": "cancelled",
                                          "note": "使用者按下停止，已取消 COMSOL job"}, ensure_ascii=False),
                              preview=f"COMSOL {jid}: 已依停止請求取消")
        # live progress bound to this step (see ToolContext.tool_use_id)
        qpos = job.get("queue_position")
        prog: dict = {"status": job.get("status"), "elapsed": int(time.time() - started)}
        if qpos:
            prog["queue_position"] = qpos
        else:
            try:
                log = (await _get(f"/jobs/{jid}/log", 15)).json().get("log", "")
                stage, pct = _parse_progress(log)
                if stage:
                    prog["stage"] = stage
                if pct is not None:
                    prog["percent"] = pct
            except Exception:
                pass
        await ctx.publish({"type": "tool_progress", "id": ctx.tool_use_id, "name": "comsol_job", "progress": prog})
        await asyncio.sleep(5)
    out = {k: job.get(k) for k in ("id", "type", "status", "success", "exit_code", "error_message",
                                     "duration_seconds", "output_files", "errors", "queue_position")}
    ui: dict = {}
    if job.get("status") in TERMINAL:
        log = (await _get(f"/jobs/{jid}/log", 60)).json().get("log", "")
        scan = _scan_log(log)
        out["log_check"] = scan
        if job.get("success") and scan["problem_count"]:
            out["verdict"] = "警告：job 回報成功，但 log 內有錯誤訊息，結果很可能不正確"
        elif job.get("success"):
            out["verdict"] = "log 沒有發現錯誤；仍需核對 printed_results、data_stats 與圖是否合理"
        else:
            out["verdict"] = "失敗；依 errors[] 與 error_details 修正後重送"
        out["log_tail"] = re.sub(r"(?ms)^#PA_DATA_BEGIN.*?^#PA_DATA_END\s*$", "[數據區塊已轉成 CSV]", log)[-3000:]
        if job.get("type") == "batch" and job.get("status") == "completed" and job.get("output_files"):
            await ctx.publish({"type": "status", "text": "下載 COMSOL 結果並產生預覽圖…"})
            collected = await _collect_results(ctx, jid, log)
            out["collected"] = collected
            out["attachments"] = collected.get("attachments", [])
            ui = {"attachments": out["attachments"]}
    return ToolResult(json.dumps(out, ensure_ascii=False, indent=1),
                      preview=f"COMSOL {jid}: {job.get('status')} success={job.get('success')}", ui=ui)


@tool(
    "comsol_log",
    "讀取 COMSOL job 的完整 log（tail_chars 控制回傳最後幾個字元，預設 15000）。",
    {"job_id": {"type": "string"}, "tail_chars": {"type": "integer", "minimum": 500, "maximum": 100000}},
    ["job_id"],
)
async def comsol_log(ctx: ToolContext, args: dict) -> ToolResult:
    r = await _get(f"/jobs/{args['job_id']}/log", 60)
    if r.status_code >= 400:
        return ToolResult(f"HTTP {r.status_code}：{r.text[:500]}", is_error=True)
    log = r.json().get("log", "")
    n = int(args.get("tail_chars") or 15000)
    return ToolResult(log[-n:] if len(log) > n else log)


@tool(
    "comsol_download",
    """重新下載 COMSOL job 的結果到 /workspace/comsol/<job_id>/（.mph、.mph.status 等），重新抽取預覽圖、
數據區塊 CSV 與預覽圖，並附給使用者。成功的 batch job 在 comsol_job 時已自動做過，通常不需要呼叫。""",
    {"job_id": {"type": "string"}},
    ["job_id"],
)
async def comsol_download(ctx: ToolContext, args: dict) -> ToolResult:
    collected = await _collect_results(ctx, args["job_id"], force=True)
    if "error" in collected:
        return ToolResult(collected["error"], is_error=True)
    return ToolResult(json.dumps({"collected": collected, "attachments": collected.get("attachments", [])},
                                 ensure_ascii=False, indent=1),
                      preview=f"下載 {args['job_id']}：{len(collected.get('files', []))} 個檔、{len(collected.get('plots', []))} 張圖",
                      ui={"attachments": collected.get("attachments", [])})


@tool(
    "comsol_cancel",
    "取消排隊中或執行中的 COMSOL job。",
    {"job_id": {"type": "string"}},
    ["job_id"],
)
async def comsol_cancel(ctx: ToolContext, args: dict) -> ToolResult:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(_api(f"/jobs/{args['job_id']}/cancel"))
    return ToolResult(r.text[:1000], is_error=r.status_code >= 400)
