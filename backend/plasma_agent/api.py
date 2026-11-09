"""HTTP API (FastAPI) + static web UI."""
from __future__ import annotations

import asyncio
import json
import mimetypes
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import delete, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import domains, events, kb, pipeline, sandbox
from .agent import user_message_content
from .auth import current_user, hash_password, make_token, verify_password
from .config import settings
from .db import Message, Run, Thread, User, func, get_session, init_db, utcnow
from .tools.base import text_of

ACTIVE = ("queued", "running")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Plasma Agent", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")


# ------------------------------------------------------------------ auth

class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=200)
    name: str = Field(default="", max_length=200)


class LoginIn(BaseModel):
    email: str
    password: str


def _user_out(u: User) -> dict:
    return {"id": str(u.id), "email": u.email, "name": u.name}


@app.post("/api/auth/register")
async def register(body: RegisterIn, s: AsyncSession = Depends(get_session)):
    if not settings.allow_registration:
        raise HTTPException(403, "目前不開放註冊")
    email = body.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(400, "Email 格式不正確")
    if (await s.execute(select(User).where(User.email == email))).scalar_one_or_none():
        raise HTTPException(409, "這個 Email 已經註冊過")
    u = User(email=email, name=body.name.strip() or email.split("@")[0], password_hash=hash_password(body.password))
    s.add(u)
    await s.commit()
    return {"token": make_token(u), "user": _user_out(u)}


@app.post("/api/auth/login")
async def login(body: LoginIn, s: AsyncSession = Depends(get_session)):
    u = (await s.execute(select(User).where(User.email == body.email.strip().lower()))).scalar_one_or_none()
    if u is None or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "Email 或密碼錯誤")
    return {"token": make_token(u), "user": _user_out(u)}


@app.get("/api/me")
async def me(user: User = Depends(current_user)):
    return _user_out(user)


@app.get("/api/health")
async def health():
    return {"ok": True}


# ------------------------------------------------------------------ threads

async def _own_thread(thread_id: str, user: User, s: AsyncSession) -> Thread:
    try:
        tid = uuid.UUID(thread_id)
    except ValueError:
        raise HTTPException(404, "找不到對話")
    t = await s.get(Thread, tid)
    if t is None or t.user_id != user.id:
        raise HTTPException(404, "找不到對話")
    return t


async def _active_run(thread_id: uuid.UUID, s: AsyncSession) -> Run | None:
    return (await s.execute(select(Run).where(Run.thread_id == thread_id, Run.status.in_(ACTIVE))
                            .order_by(desc(Run.created_at)).limit(1))).scalar_one_or_none()


def _thread_out(t: Thread, active: Run | None = None) -> dict:
    return {"id": str(t.id), "title": t.title, "domain": getattr(t, "domain", "plasma"),
            "mode": getattr(t, "mode", "chat"), "created_at": t.created_at.isoformat(),
            "updated_at": t.updated_at.isoformat(), "active_run_id": str(active.id) if active else None}


@app.get("/api/domains")
async def list_domains():
    return domains.choices()


@app.get("/api/threads")
async def list_threads(user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    rows = (await s.execute(select(Thread).where(Thread.user_id == user.id)
                            .order_by(desc(Thread.updated_at)).limit(300))).scalars().all()
    return [_thread_out(t) for t in rows]


class ThreadIn(BaseModel):
    title: str | None = None
    domain: str | None = None
    mode: str | None = None


@app.post("/api/threads")
async def create_thread(body: ThreadIn, user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    mode = "project" if body.mode == "project" else "chat"
    t = Thread(user_id=user.id, title=(body.title or "新對話")[:300], domain=domains.get(body.domain).name, mode=mode)
    s.add(t)
    await s.commit()
    sandbox.workspace_dir(str(t.id)).mkdir(parents=True, exist_ok=True)
    return _thread_out(t)


@app.patch("/api/threads/{thread_id}")
async def rename_thread(thread_id: str, body: ThreadIn, user: User = Depends(current_user),
                        s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    if body.title:
        t.title = body.title[:300]
        await s.commit()
    return _thread_out(t)


@app.delete("/api/threads/{thread_id}")
async def delete_thread(thread_id: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    if (active := await _active_run(t.id, s)) is not None:
        await events.request_stop(str(active.id))
    await s.execute(delete(Thread).where(Thread.id == t.id))
    await s.commit()
    await events.get_redis().rpush(events.CLEANUP_KEY, str(t.id))
    return {"ok": True}


@app.get("/api/threads/{thread_id}")
async def get_thread(thread_id: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    return _thread_out(t, await _active_run(t.id, s))


# ------------------------------------------------------------------ messages (display form)

def _short_input(inp: dict) -> dict:
    out = {}
    for k, v in (inp or {}).items():
        if isinstance(v, str) and len(v) > 4000:
            v = v[:4000] + f" …（共 {len(v)} 字元）"
        out[k] = v
    return out


def _display(rows: list[Message]) -> list[dict]:
    """Turn stored API messages into chat items: user bubbles and assistant turns."""
    results: dict[str, dict] = {}
    for m in rows:
        if m.role == "user":
            for b in m.content:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    images = []
                    if isinstance(c, list):
                        for x in c:
                            if x.get("type") == "text" and x.get("text", "").startswith("圖片 "):
                                images.append(x["text"].split(" ")[1].split("（")[0])
                    atts = []
                    if isinstance(c, str) and c.lstrip().startswith("{") and '"attachments"' in c:
                        try:
                            atts = json.loads(c).get("attachments") or []
                        except ValueError:
                            atts = []
                    results[b["tool_use_id"]] = {"is_error": bool(b.get("is_error")),
                                                 "preview": text_of(c or "", 20000), "images": images,
                                                 "attachments": atts}
    items: list[dict] = []
    for m in rows:
        if m.role == "user":
            texts = [b.get("text", "") for b in m.content if b.get("type") == "text"]
            if texts:
                items.append({"kind": "user", "id": m.id, "text": "\n".join(texts),
                              "created_at": m.created_at.isoformat()})
            continue
        if not items or items[-1]["kind"] != "assistant" or items[-1]["run_id"] != str(m.run_id):
            items.append({"kind": "assistant", "id": m.id, "run_id": str(m.run_id), "blocks": [],
                          "attachments": [], "created_at": m.created_at.isoformat()})
        turn = items[-1]
        for b in m.content:
            t = b.get("type")
            if t == "text" and b.get("text"):
                turn["blocks"].append({"type": "text", "text": b["text"]})
            elif t == "thinking" and b.get("thinking"):
                turn["blocks"].append({"type": "thinking", "text": b["thinking"]})
            elif t == "tool_use":
                res = results.get(b["id"])
                turn["blocks"].append({"type": "tool", "id": b["id"], "name": b["name"],
                                       "input": _short_input(b.get("input")), "result": res})
                for a in (res or {}).get("attachments", []):  # files a tool attached itself (e.g. COMSOL results)
                    try:
                        if sandbox.resolve_path(str(m.thread_id), a["path"]).is_file():
                            turn["attachments"].append(a)
                    except (sandbox.PathError, KeyError):
                        pass
                if b["name"] == "attach_files" and not (results.get(b["id"]) or {}).get("is_error"):
                    tid = str(m.thread_id)
                    for p in (b.get("input") or {}).get("paths", []):
                        try:
                            hp = sandbox.resolve_path(tid, p)
                        except sandbox.PathError:
                            continue
                        if hp.is_file():
                            turn["attachments"].append({
                                "path": sandbox.to_container_path(tid, hp), "name": hp.name,
                                "size": hp.stat().st_size,
                                "mime": mimetypes.guess_type(hp.name)[0] or "application/octet-stream"})
    return items


@app.get("/api/threads/{thread_id}/messages")
async def get_messages(thread_id: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    rows = (await s.execute(select(Message).where(Message.thread_id == t.id).order_by(Message.id))).scalars().all()
    runs = (await s.execute(select(Run).where(Run.thread_id == t.id).order_by(Run.created_at))).scalars().all()
    project = pipeline.project_out(await pipeline.gate_status(t.id)) if getattr(t, "mode", "chat") == "project" else None
    return {"items": _display(rows), "runs": [_run_out(r) for r in runs], "project": project}


def _run_out(r: Run) -> dict:
    return {"id": str(r.id), "status": r.status, "error": r.error, "model": r.model, "usage": r.usage,
            "created_at": r.created_at.isoformat(),
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None}


@app.get("/api/threads/{thread_id}/tools/{tool_use_id}")
async def tool_detail(thread_id: str, tool_use_id: str, user: User = Depends(current_user),
                      s: AsyncSession = Depends(get_session)):
    """Full input and output of one tool call (the chat view only carries previews)."""
    t = await _own_thread(thread_id, user, s)
    rows = (await s.execute(select(Message).where(Message.thread_id == t.id).order_by(Message.id))).scalars().all()
    call, result = None, None
    for m in rows:
        for b in m.content:
            if b.get("type") == "tool_use" and b.get("id") == tool_use_id:
                call = b
            elif b.get("type") == "tool_result" and b.get("tool_use_id") == tool_use_id:
                result = b
    if call is None:
        raise HTTPException(404, "找不到這個步驟")
    out = None
    if result is not None:
        c = result.get("content")
        images = []
        if isinstance(c, list):
            for x in c:
                if x.get("type") == "text" and x.get("text", "").startswith("圖片 "):
                    images.append(x["text"].split(" ")[1].split("（")[0])
        out = {"is_error": bool(result.get("is_error")), "text": text_of(c or "", 200000), "images": images}
    return {"id": tool_use_id, "name": call.get("name"), "input": call.get("input"), "result": out}


_comsol_cache: dict = {"t": 0.0, "data": None}


async def _comsol_health() -> dict | None:
    import time
    import httpx
    if time.time() - _comsol_cache["t"] < 10:
        return _comsol_cache["data"]
    try:
        async with httpx.AsyncClient(timeout=4) as c:
            data = (await c.get(f"{settings.comsol_api}/health")).json()
    except Exception as e:
        data = {"status": "unreachable", "error": str(e)[:200]}
    _comsol_cache.update(t=time.time(), data=data)
    return data


@app.get("/api/threads/{thread_id}/status")
async def thread_status(thread_id: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    """Everything the status panel shows: current run, sandbox/GPU, COMSOL queue, background jobs, todo.md."""
    t = await _own_thread(thread_id, user, s)
    tid = str(t.id)
    run = (await s.execute(select(Run).where(Run.thread_id == t.id).order_by(desc(Run.created_at)).limit(1))
           ).scalar_one_or_none()
    run_info = None
    if run:
        steps = (await s.execute(select(func.count()).select_from(Message)
                                 .where(Message.run_id == run.id, Message.role == "assistant"))).scalar_one()
        run_info = {**_run_out(run), "steps": steps}
    raw = await events.get_redis().get(f"pa:sbx:status:{tid}")
    sbx = json.loads(raw) if raw else {"state": "none"}
    jobs = []
    jd = sandbox.workspace_dir(tid) / ".jobs"
    if jd.is_dir():
        for d in sorted(jd.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
            try:
                meta = json.loads((d / "meta.json").read_text())
            except Exception:
                continue
            ex = d / "exit_code"
            jobs.append({"job_id": d.name, "name": meta.get("name"), "command": meta.get("command"),
                         "started_at": meta.get("started_at"),
                         "status": "finished" if ex.exists() else "running",
                         "exit_code": ex.read_text().strip() if ex.exists() else None,
                         "log_path": f"/workspace/.jobs/{d.name}/output.log"})
    todo = None
    tf = sandbox.workspace_dir(tid) / "todo.md"
    if tf.is_file():
        todo = tf.read_text(errors="replace")[:20000]
    project = pipeline.project_out(await pipeline.gate_status(t.id)) if getattr(t, "mode", "chat") == "project" else None
    kbinfo = await kb.thread_stats(t.id) if kb.enabled() else None
    return {"run": run_info, "sandbox": sbx, "comsol": await _comsol_health(), "jobs": jobs, "todo": todo,
            "model": settings.model, "project": project, "kb": kbinfo}


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=200000)
    uploads: list[str] = Field(default_factory=list)


@app.post("/api/threads/{thread_id}/messages")
async def post_message(thread_id: str, body: MessageIn, user: User = Depends(current_user),
                       s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    if await _active_run(t.id, s):
        raise HTTPException(409, "這個對話還在執行中，請等它結束或先按停止")
    if getattr(t, "mode", "chat") == "project":
        p = await pipeline.gate_status(t.id)
        if p and p.status in ("awaiting_plan_approval", "awaiting_acceptance"):
            raise HTTPException(409, "這個研究專案正在等你核准或退回目前的關卡，請用核准／退回按鈕")
    last = (await s.execute(select(Message).where(Message.thread_id == t.id)
                            .order_by(desc(Message.id)).limit(1))).scalar_one_or_none()
    previous = {"role": last.role, "content": last.content} if last else None
    run = Run(thread_id=t.id, status="queued", model=settings.model)
    s.add(run)
    await s.flush()
    s.add(Message(thread_id=t.id, run_id=run.id, role="user",
                  content=user_message_content(body.text, body.uploads, previous)))
    t.updated_at = utcnow()
    await s.commit()
    await events.enqueue_run(str(run.id))
    return {"run_id": str(run.id)}


@app.post("/api/runs/{run_id}/stop")
async def stop_run(run_id: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    run = await s.get(Run, uuid.UUID(run_id))
    if run is None:
        raise HTTPException(404, "找不到執行")
    await _own_thread(str(run.thread_id), user, s)
    await events.request_stop(run_id)
    if run.status == "queued":  # never picked up: worker will skip it
        run.status = "stopped"
        run.finished_at = utcnow()
        await s.commit()
        await events.publish(run_id, {"type": "run_end", "status": "stopped"})
    return {"ok": True}


class RejectIn(BaseModel):
    feedback: str | None = Field(default=None, max_length=10000)


@app.post("/api/threads/{thread_id}/approve")
async def approve_gate(thread_id: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    """Pass the current human gate: approve the plan (→ research) or accept the results (→ done)."""
    t = await _own_thread(thread_id, user, s)
    if await _active_run(t.id, s):
        raise HTTPException(409, "這個專案還在執行中")
    res = await pipeline.approve(t)
    if not res.get("ok"):
        raise HTTPException(400, res.get("detail", "目前無法核准"))
    return res


@app.post("/api/threads/{thread_id}/reject")
async def reject_gate(thread_id: str, body: RejectIn, user: User = Depends(current_user),
                      s: AsyncSession = Depends(get_session)):
    """Send the current gate back with feedback: revise the plan, or redo the research."""
    t = await _own_thread(thread_id, user, s)
    if await _active_run(t.id, s):
        raise HTTPException(409, "這個專案還在執行中")
    res = await pipeline.reject(t, body.feedback or "")
    if not res.get("ok"):
        raise HTTPException(400, res.get("detail", "目前無法退回"))
    return res


@app.get("/api/runs/{run_id}/events")
async def run_events(run_id: str, request: Request, user: User = Depends(current_user),
                     s: AsyncSession = Depends(get_session)):
    run = await s.get(Run, uuid.UUID(run_id))
    if run is None:
        raise HTTPException(404, "找不到執行")
    await _own_thread(str(run.thread_id), user, s)
    finished = run.status not in ACTIVE
    last_id = request.headers.get("last-event-id") or request.query_params.get("last_id") or "0"
    r = events.get_redis()
    key = events.events_key(run_id)

    async def gen():
        nonlocal last_id
        yield "retry: 2000\n\n"
        idle = 0
        while True:
            if await request.is_disconnected():
                return
            res = await r.xread({key: last_id}, block=15000, count=500)
            if not res:
                idle += 1
                yield ": keepalive\n\n"
                if finished or idle > 240:
                    yield f"data: {json.dumps({'type': 'run_end', 'status': run.status})}\n\n"
                    return
                continue
            idle = 0
            for _, entries in res:
                for eid, fields in entries:
                    last_id = eid
                    data = fields.get("data", "{}")
                    yield f"id: {eid}\ndata: {data}\n\n"
                    if '"type": "run_end"' in data:
                        return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ files

@app.get("/api/threads/{thread_id}/files")
async def list_files(thread_id: str, path: str = "/workspace", user: User = Depends(current_user),
                     s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    tid = str(t.id)
    try:
        base = sandbox.resolve_path(tid, path)
    except sandbox.PathError as e:
        raise HTTPException(400, str(e))
    if not base.is_dir():
        return {"path": path, "entries": []}
    entries = []
    for p in sorted(base.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        if p.name in (".jobs", ".guides"):
            continue
        st = p.stat()
        entries.append({"name": p.name, "path": sandbox.to_container_path(tid, p), "dir": p.is_dir(),
                        "size": st.st_size, "mtime": st.st_mtime})
    return {"path": sandbox.to_container_path(tid, base), "entries": entries}


@app.get("/api/threads/{thread_id}/file")
async def get_file(thread_id: str, path: str, download: int = 0, user: User = Depends(current_user),
                   s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    try:
        p = sandbox.resolve_path(str(t.id), path)
    except sandbox.PathError as e:
        raise HTTPException(400, str(e))
    if not p.is_file():
        raise HTTPException(404, "檔案不存在")
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    inline_ok = mime.startswith("image/") or mime in ("application/pdf", "text/plain")
    return FileResponse(p, media_type=mime, filename=p.name,
                        content_disposition_type="inline" if (inline_ok and not download) else "attachment")


@app.get("/api/threads/{thread_id}/zip")
async def download_zip(thread_id: str, path: list[str] = Query(default=[]), name: str = "results",
                       user: User = Depends(current_user), s: AsyncSession = Depends(get_session)):
    """Download several workspace files as one zip (the 'download all' button on a result card)."""
    import io
    import zipfile
    t = await _own_thread(thread_id, user, s)
    files = []
    for raw in path[:200]:
        try:
            p = sandbox.resolve_path(str(t.id), raw)
        except sandbox.PathError:
            continue
        if p.is_file():
            files.append(p)
    if not files:
        raise HTTPException(404, "沒有可下載的檔案")
    buf = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            arc = p.name
            k = 1
            while arc in used:
                arc = f"{p.stem}_{k}{p.suffix}"
                k += 1
            used.add(arc)
            z.write(p, arc)
    buf.seek(0)
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:60] or "results"
    return StreamingResponse(iter([buf.getvalue()]), media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'})


@app.post("/api/threads/{thread_id}/upload")
async def upload(thread_id: str, files: list[UploadFile] = File(...), user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session)):
    t = await _own_thread(thread_id, user, s)
    dest = sandbox.workspace_dir(str(t.id)) / "uploads"
    dest.mkdir(parents=True, exist_ok=True)
    saved, targets = [], []
    for f in files:
        name = Path(f.filename or "file").name.replace("/", "_") or "file"
        target = dest / name
        with target.open("wb") as out:
            while chunk := await f.read(1 << 20):
                out.write(chunk)
        cpath = f"/workspace/uploads/{name}"
        saved.append(cpath)
        targets.append((target, cpath))
    # index text/PDF uploads into this thread's task knowledge base (best-effort)
    ingested = []
    if kb.enabled():
        try:
            dsid = await kb.get_or_create_dataset(t.id, owner_id=user.id, category="task", name="任務資料")
            for target, cpath in targets:
                info = await kb.ingest_file(dsid, target, source=cpath)
                if info.get("chunks"):
                    ingested.append(info)
        except Exception:
            import logging
            logging.getLogger("plasma_agent.api").exception("kb ingest failed")
    return {"paths": saved, "kb": ingested}


# ------------------------------------------------------------------ web UI

if settings.static_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=settings.static_dir / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        f = settings.static_dir / full_path
        if full_path and f.is_file() and f.resolve().is_relative_to(settings.static_dir.resolve()):
            return FileResponse(f)
        return FileResponse(settings.static_dir / "index.html")


__all__ = ["app", "asyncio"]
