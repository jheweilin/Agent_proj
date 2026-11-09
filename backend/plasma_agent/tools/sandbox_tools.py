"""Sandbox tools: shell, background jobs, files, images, attachments."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import mimetypes
import secrets
import shlex
import time
from pathlib import Path

from .. import sandbox
from .base import ToolContext, ToolResult, tool

READ_LIMIT = 60000
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


@tool(
    "execute_command",
    """在沙盒（Ubuntu 24.04、CUDA、plasma 電漿軟體環境）裡用 bash 執行指令，工作目錄 /workspace。
回傳結束碼與合併的 stdout/stderr（過長會截斷）。適合安裝套件、檢查環境、跑幾分鐘內可結束的計算。
預估超過 10 分鐘的計算（模擬、參數掃描）請改用 submit_job。""",
    {
        "command": {"type": "string", "description": "要執行的 bash 指令"},
        "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 3600,
                            "description": "逾時秒數，預設 600"},
        "workdir": {"type": "string", "description": "工作目錄（/workspace 之內），預設 /workspace"},
    },
    ["command"],
)
async def execute_command(ctx: ToolContext, args: dict) -> ToolResult:
    workdir = sandbox.CONTAINER_WORKSPACE
    if args.get("workdir"):
        workdir = sandbox.to_container_path(ctx.thread_id, sandbox.resolve_path(ctx.thread_id, args["workdir"]))
    await ctx.publish({"type": "status", "text": "準備沙盒並執行指令…"})
    code, out = await sandbox.exec_command(ctx.thread_id, args["command"], args.get("timeout_seconds", 600), workdir)
    body = f"exit_code: {code}\n{out}" if out else f"exit_code: {code}\n(沒有輸出)"
    return ToolResult(body, is_error=False, preview=body[-1500:])


# ---------------------------------------------------------------- background jobs

def _jobs_dir(thread_id: str) -> Path:
    d = sandbox.workspace_dir(thread_id) / ".jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _job_state(thread_id: str, job_id: str) -> dict:
    d = _jobs_dir(thread_id) / job_id
    if not d.is_dir():
        raise ValueError(f"找不到 job：{job_id}")
    meta = json.loads((d / "meta.json").read_text())
    exit_file = d / "exit_code"
    log = d / "output.log"
    state = {"job_id": job_id, "name": meta.get("name"), "command": meta.get("command"),
             "started_at": meta.get("started_at"), "status": "running", "exit_code": None}
    if exit_file.exists():
        raw = exit_file.read_text().strip()
        state["status"] = "finished"
        state["exit_code"] = int(raw) if raw.lstrip("-").isdigit() else raw
    state["elapsed_seconds"] = int(time.time() - meta.get("started_ts", time.time()))
    if log.exists():
        data = log.read_bytes()[-6000:].decode("utf-8", errors="replace")
        state["log_tail"] = data
        state["log_path"] = f"/workspace/.jobs/{job_id}/output.log"
    outs = meta.get("expected_outputs") or []
    if outs:
        exist = {}
        for p in outs:
            try:
                hp = sandbox.resolve_path(thread_id, p)
                exist[p] = hp.exists() and hp.stat().st_size > 0 and hp.stat().st_mtime >= meta.get("started_ts", 0)
            except Exception:
                exist[p] = False
        state["expected_outputs_ready"] = exist
    return state


@tool(
    "submit_job",
    """在沙盒背景啟動長時間計算（模擬、參數掃描、MPI 執行等），立即回傳 job_id，不會被 600 秒逾時中斷。
完整輸出寫在 /workspace/.jobs/<job_id>/output.log。之後用 job_status 查進度或等待完成。
expected_outputs 請列出這個計算應產生的結果檔，用來判斷是否真的成功（結束碼 0 不代表結果正確）。""",
    {
        "command": {"type": "string", "description": "要在背景執行的 bash 指令（會在 workdir 執行）"},
        "name": {"type": "string", "description": "簡短名稱"},
        "workdir": {"type": "string", "description": "工作目錄，預設 /workspace"},
        "expected_outputs": {"type": "array", "items": {"type": "string"},
                             "description": "預期產生的結果檔路徑"},
    },
    ["command"],
)
async def submit_job(ctx: ToolContext, args: dict) -> ToolResult:
    job_id = "job_" + secrets.token_hex(4)
    d = _jobs_dir(ctx.thread_id) / job_id
    d.mkdir()
    workdir = sandbox.CONTAINER_WORKSPACE
    if args.get("workdir"):
        workdir = sandbox.to_container_path(ctx.thread_id, sandbox.resolve_path(ctx.thread_id, args["workdir"]))
    meta = {"name": args.get("name") or job_id, "command": args["command"], "workdir": workdir,
            "expected_outputs": args.get("expected_outputs") or [],
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S"), "started_ts": time.time()}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    (d / "run.sh").write_text(f"cd {shlex.quote(workdir)}\n{args['command']}\n")
    jd = f"/workspace/.jobs/{job_id}"
    launcher = (f"setsid nohup bash -c 'bash -l {jd}/run.sh > {jd}/output.log 2>&1; "
                f"echo $? > {jd}/exit_code' > /dev/null 2>&1 & echo $! > {jd}/pid")
    code, out = await sandbox.exec_command(ctx.thread_id, launcher, 30)
    if code != 0:
        return ToolResult(f"啟動失敗（exit {code}）：{out}", is_error=True)
    return ToolResult(json.dumps({"job_id": job_id, "status": "running", "log": f"{jd}/output.log"},
                                 ensure_ascii=False), preview=f"{job_id} 已在背景啟動")


@tool(
    "job_status",
    """查詢背景 job 的狀態與 log 尾段。wait_seconds > 0 時會等到 job 結束或等待時間到為止（最多 900 秒），
可避免頻繁查詢。不給 job_id 則列出這個對話所有 job。""",
    {
        "job_id": {"type": "string"},
        "wait_seconds": {"type": "integer", "minimum": 0, "maximum": 900},
    },
)
async def job_status(ctx: ToolContext, args: dict) -> ToolResult:
    jid = args.get("job_id")
    if not jid:
        jobs = []
        for d in sorted(_jobs_dir(ctx.thread_id).iterdir()):
            if d.is_dir() and (d / "meta.json").exists():
                st = _job_state(ctx.thread_id, d.name)
                st.pop("log_tail", None)
                jobs.append(st)
        return ToolResult(json.dumps(jobs, ensure_ascii=False, indent=1) if jobs else "目前沒有背景 job")
    wait = int(args.get("wait_seconds") or 0)
    deadline = time.time() + wait
    st = _job_state(ctx.thread_id, jid)
    while st["status"] == "running" and time.time() < deadline:
        await asyncio.sleep(5)
        await sandbox.touch(ctx.thread_id)
        st = _job_state(ctx.thread_id, jid)
    body = json.dumps(st, ensure_ascii=False, indent=1)
    return ToolResult(body, preview=f"{jid}: {st['status']} exit={st['exit_code']}")


# ---------------------------------------------------------------- files

@tool(
    "list_files",
    "列出 /workspace 內某個目錄的檔案（含大小）。recursive=true 時遞迴列出（最多 500 筆）。",
    {"path": {"type": "string", "description": "目錄，預設 /workspace"},
     "recursive": {"type": "boolean"}},
)
async def list_files(ctx: ToolContext, args: dict) -> ToolResult:
    base = sandbox.resolve_path(ctx.thread_id, args.get("path") or ".")
    if not base.exists():
        return ToolResult(f"不存在：{args.get('path')}", is_error=True)
    it = base.rglob("*") if args.get("recursive") else base.iterdir()
    rows = []
    for p in sorted(it):
        if any(part.startswith(".jobs") for part in p.relative_to(base).parts):
            continue
        rel = sandbox.to_container_path(ctx.thread_id, p)
        rows.append(f"{rel}/" if p.is_dir() else f"{rel}  ({p.stat().st_size} bytes)")
        if len(rows) >= 500:
            rows.append("…（超過 500 筆，已截斷）")
            break
    return ToolResult("\n".join(rows) or "(空目錄)")


@tool(
    "read_file",
    "讀取 /workspace 內的文字檔。大檔可用 offset/limit（以行為單位）分段讀取。",
    {"path": {"type": "string"},
     "offset": {"type": "integer", "minimum": 0, "description": "從第幾行開始（0 起算）"},
     "limit": {"type": "integer", "minimum": 1, "description": "讀幾行，預設 2000"}},
    ["path"],
)
async def read_file(ctx: ToolContext, args: dict) -> ToolResult:
    p = sandbox.resolve_path(ctx.thread_id, args["path"])
    if not p.is_file():
        return ToolResult(f"不是檔案或不存在：{args['path']}", is_error=True)
    lines = p.read_text(errors="replace").splitlines()
    off = int(args.get("offset") or 0)
    lim = int(args.get("limit") or 2000)
    chunk = "\n".join(lines[off:off + lim])
    if len(chunk) > READ_LIMIT:
        chunk = chunk[:READ_LIMIT] + "\n…（已截斷，請用 offset/limit 讀取其餘部分）"
    more = f"\n[共 {len(lines)} 行，顯示 {off}–{min(off + lim, len(lines))}]" if len(lines) > lim or off else ""
    return ToolResult(chunk + more, preview=f"讀取 {args['path']}")


@tool(
    "write_file",
    "寫入（覆蓋）/workspace 內的文字檔，必要時自動建立目錄。",
    {"path": {"type": "string"}, "content": {"type": "string"}},
    ["path", "content"],
)
async def write_file(ctx: ToolContext, args: dict) -> ToolResult:
    p = sandbox.resolve_path(ctx.thread_id, args["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(args["content"])
    return ToolResult(f"已寫入 {sandbox.to_container_path(ctx.thread_id, p)}（{len(args['content'])} 字元）")


@tool(
    "edit_file",
    "把檔案中唯一出現的一段文字 old_text 換成 new_text（old_text 必須剛好出現一次）。",
    {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}},
    ["path", "old_text", "new_text"],
)
async def edit_file(ctx: ToolContext, args: dict) -> ToolResult:
    p = sandbox.resolve_path(ctx.thread_id, args["path"])
    if not p.is_file():
        return ToolResult(f"檔案不存在：{args['path']}", is_error=True)
    s = p.read_text(errors="replace")
    n = s.count(args["old_text"])
    if n != 1:
        return ToolResult(f"old_text 出現 {n} 次，必須剛好 1 次", is_error=True)
    p.write_text(s.replace(args["old_text"], args["new_text"], 1))
    return ToolResult(f"已修改 {args['path']}")


@tool(
    "see_image",
    "讀取 /workspace 內的圖片（png/jpg/gif/webp）給自己檢視，用來確認圖表、模擬結果圖是否正確。",
    {"path": {"type": "string"}},
    ["path"],
)
async def see_image(ctx: ToolContext, args: dict) -> ToolResult:
    from PIL import Image

    p = sandbox.resolve_path(ctx.thread_id, args["path"])
    if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
        return ToolResult(f"不是支援的圖片：{args['path']}", is_error=True)
    img = Image.open(p)
    img.load()
    if max(img.size) > 1568:
        img.thumbnail((1568, 1568))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    data = base64.b64encode(buf.getvalue()).decode()
    rel = sandbox.to_container_path(ctx.thread_id, p)
    return ToolResult(
        [{"type": "text", "text": f"圖片 {rel}（{img.size[0]}×{img.size[1]}）"},
         {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}}],
        preview=f"檢視圖片 {rel}", ui={"images": [rel]})


@tool(
    "attach_files",
    """把 /workspace 內的成果檔（圖、報告、資料、模型檔）附在回覆裡給使用者下載或預覽。
交付成果時一定要用這個工具附上，不要只寫路徑。""",
    {"paths": {"type": "array", "items": {"type": "string"}, "minItems": 1},
     "note": {"type": "string"}},
    ["paths"],
)
async def attach_files(ctx: ToolContext, args: dict) -> ToolResult:
    files, missing = [], []
    for raw in args["paths"]:
        try:
            p = sandbox.resolve_path(ctx.thread_id, raw)
        except sandbox.PathError:
            missing.append(raw)
            continue
        if p.is_file():
            files.append({"path": sandbox.to_container_path(ctx.thread_id, p), "name": p.name,
                          "size": p.stat().st_size,
                          "mime": mimetypes.guess_type(p.name)[0] or "application/octet-stream"})
        else:
            missing.append(raw)
    await ctx.publish({"type": "attachments", "files": files})
    msg = f"已附上 {len(files)} 個檔案"
    if missing:
        msg += f"；找不到：{', '.join(missing)}"
    return ToolResult(msg, is_error=bool(missing) and not files, ui={"attachments": files})
