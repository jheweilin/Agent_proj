"""Per-thread sandbox containers, managed directly through the Docker API.

Each conversation gets one long-lived container from the plasma image:
- /workspace inside the container is bind-mounted from WORKSPACES_DIR/<thread_id> on the host,
  so the worker and the API can read/write files without `docker exec`.
- GPU access is a single CDI device (default nvidia.com/gpu=0).
- Idle containers are stopped by `reap_idle()`; the workspace survives.
"""
from __future__ import annotations

import asyncio
import shlex
import shutil
import time
from pathlib import Path

import docker
from docker.errors import NotFound
from docker.types import DeviceRequest

from .config import settings
from .events import get_redis

LABEL = "plasma-agent.sandbox"
CONTAINER_WORKSPACE = "/workspace"
CONTAINER_COMSOL_LIBRARY = "/comsol_examples"
MAX_OUTPUT_CHARS = 30000

_client: docker.DockerClient | None = None
_locks: dict[str, asyncio.Lock] = {}


def client() -> docker.DockerClient:
    global _client
    if _client is None:
        _client = docker.from_env(timeout=600)
    return _client


def container_name(thread_id: str) -> str:
    return f"pa-sbx-{thread_id.replace('-', '')[:12]}"


def workspace_dir(thread_id: str) -> Path:
    return settings.workspaces_dir / thread_id


class PathError(ValueError):
    pass


def resolve_path(thread_id: str, path: str) -> Path:
    """Map a model/user-supplied path to a host path inside the thread workspace.

    Accepts relative paths and absolute `/workspace/...` paths; rejects anything that
    escapes the workspace (`..`, other absolute paths, symlinks pointing outside).
    """
    root = workspace_dir(thread_id).resolve()
    p = (path or ".").strip()
    if p == CONTAINER_WORKSPACE or p.startswith(CONTAINER_WORKSPACE + "/"):
        p = p[len(CONTAINER_WORKSPACE):].lstrip("/") or "."
    if p.startswith("/"):
        raise PathError(f"路徑必須在 /workspace 之內：{path}")
    target = (root / p).resolve()
    if target != root and not target.is_relative_to(root):
        raise PathError(f"路徑超出 /workspace：{path}")
    return target


def to_container_path(thread_id: str, host_path: Path) -> str:
    rel = host_path.resolve().relative_to(workspace_dir(thread_id).resolve())
    return CONTAINER_WORKSPACE if str(rel) == "." else f"{CONTAINER_WORKSPACE}/{rel}"


def _lock(thread_id: str) -> asyncio.Lock:
    if thread_id not in _locks:
        _locks[thread_id] = asyncio.Lock()
    return _locks[thread_id]


def _prepare_workspace(thread_id: str) -> Path:
    ws = workspace_dir(thread_id)
    ws.mkdir(parents=True, exist_ok=True)
    guides = ws / ".guides"
    guides.mkdir(exist_ok=True)
    if settings.guides_dir.is_dir():
        # guides + reference examples (refreshed when the image ships newer copies)
        for f in settings.guides_dir.rglob("*"):
            if not f.is_file():
                continue
            dst = guides / f.relative_to(settings.guides_dir)
            if not dst.exists() or dst.stat().st_mtime < f.stat().st_mtime:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst)
    return ws


def unfinished_jobs(thread_id: str) -> list[Path]:
    jobs = workspace_dir(thread_id) / ".jobs"
    if not jobs.is_dir():
        return []
    return [d for d in jobs.iterdir() if d.is_dir() and (d / "meta.json").exists()
            and not (d / "exit_code").exists()]


def _has_library_mount(c) -> bool:
    return any(m.get("Destination") == CONTAINER_COMSOL_LIBRARY for m in c.attrs.get("Mounts", []))


def _ensure_sync(thread_id: str):
    name = container_name(thread_id)
    dc = client()
    _prepare_workspace(thread_id)  # refresh .guides/ in existing workspaces too (new examples after a deploy)
    try:
        c = dc.containers.get(name)
        # Sandboxes created before the library mount existed: mounts are fixed at creation, so recreate.
        # /workspace survives; anything installed elsewhere does not. Never interrupt a running background job.
        if settings.comsol_library_dir and not _has_library_mount(c) \
                and not (c.status == "running" and unfinished_jobs(thread_id)):
            for d in unfinished_jobs(thread_id):
                (d / "exit_code").write_text("killed: sandbox was stopped\n")
            c.remove(force=True)
            raise NotFound(f"recreating {name} to add the COMSOL library mount")
        if c.status != "running":
            # background jobs died with the container; record that so job_status is truthful
            for d in unfinished_jobs(thread_id):
                (d / "exit_code").write_text("killed: sandbox was stopped\n")
            c.start()
            c.reload()
        return c
    except NotFound:
        pass
    ws = _prepare_workspace(thread_id)
    device_requests = []
    if settings.sandbox_gpu:
        device_requests.append(DeviceRequest(driver="cdi", device_ids=[settings.sandbox_gpu]))
    volumes = {str(ws): {"bind": CONTAINER_WORKSPACE, "mode": "rw"}}
    if settings.comsol_library_dir:
        volumes[settings.comsol_library_dir] = {"bind": CONTAINER_COMSOL_LIBRARY, "mode": "ro"}
    c = dc.containers.run(
        settings.sandbox_image,
        command=["sleep", "infinity"],
        name=name,
        detach=True,
        working_dir=CONTAINER_WORKSPACE,
        volumes=volumes,
        device_requests=device_requests,
        mem_limit=settings.sandbox_mem,
        nano_cpus=int(settings.sandbox_cpus * 1e9),
        shm_size="4g",
        labels={LABEL: "1", f"{LABEL}.thread": thread_id},
        environment={"PYTHONUNBUFFERED": "1", "MPLBACKEND": "Agg", "OMPI_ALLOW_RUN_AS_ROOT": "1",
                     "OMPI_ALLOW_RUN_AS_ROOT_CONFIRM": "1"},
        restart_policy={"Name": "no"},
    )
    return c


async def ensure(thread_id: str):
    async with _lock(thread_id):
        c = await asyncio.to_thread(_ensure_sync, thread_id)
    await touch(thread_id)
    return c


async def touch(thread_id: str) -> None:
    await get_redis().set(f"pa:sbx:last_used:{thread_id}", str(time.time()))


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    head = text[: limit // 3]
    tail = text[-(limit * 2 // 3):]
    return f"{head}\n\n...[已截斷 {len(text) - limit} 字元]...\n\n{tail}"


async def exec_command(thread_id: str, command: str, timeout_seconds: int = 600,
                       workdir: str = CONTAINER_WORKSPACE) -> tuple[int, str]:
    """Run `command` with bash -lc inside the sandbox. Returns (exit_code, combined output)."""
    c = await ensure(thread_id)
    timeout_seconds = max(1, min(int(timeout_seconds), 3600))
    wrapped = f"timeout -k 10 {timeout_seconds} bash -lc {shlex.quote(command)}"

    def _run():
        res = c.exec_run(["bash", "-lc", wrapped], workdir=workdir, demux=False)
        out = (res.output or b"").decode("utf-8", errors="replace")
        return res.exit_code, out

    code, out = await asyncio.to_thread(_run)
    await touch(thread_id)
    if code == 124:
        out += f"\n[指令超過 {timeout_seconds} 秒被終止；長時間計算請改用 submit_job]"
    return code, _truncate(out)


async def remove(thread_id: str, delete_workspace: bool = False) -> None:
    import uuid
    thread_id = str(uuid.UUID(thread_id))  # refuse anything that is not a thread id

    def _rm():
        try:
            client().containers.get(container_name(thread_id)).remove(force=True)
        except NotFound:
            pass
    await asyncio.to_thread(_rm)
    if delete_workspace:
        ws = workspace_dir(thread_id)
        if ws.exists():
            await asyncio.to_thread(shutil.rmtree, ws, True)


async def reap_idle() -> int:
    """Stop running sandboxes that have been idle longer than SANDBOX_IDLE_MINUTES."""
    r = get_redis()
    limit = settings.sandbox_idle_minutes * 60
    stopped = 0

    def _list():
        return client().containers.list(filters={"label": LABEL})

    for c in await asyncio.to_thread(_list):
        thread_id = c.labels.get(f"{LABEL}.thread", "")
        if not thread_id:
            continue
        if await r.exists(f"pa:thread:{thread_id}:busy") or unfinished_jobs(thread_id):
            continue
        last = float(await r.get(f"pa:sbx:last_used:{thread_id}") or 0)
        if time.time() - last > limit:
            await asyncio.to_thread(c.stop, timeout=10)
            stopped += 1
    return stopped
