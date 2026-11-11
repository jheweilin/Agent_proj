"""Worker process: pulls run ids from Redis and executes them (bounded concurrency)."""
from __future__ import annotations

import asyncio
import logging
import signal

from sqlalchemy import update

from . import events, labs, pipeline, sandbox
from .agent import execute_run
from .config import settings
from .db import Run, SessionLocal, init_db, utcnow

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("plasma_agent.worker")


async def _recover_orphans() -> None:
    """Runs left in 'running' by a previous worker process can never finish: fail them."""
    async with SessionLocal() as s:
        await s.execute(update(Run).where(Run.status == "running")
                        .values(status="failed", error="worker 重新啟動，執行中斷", finished_at=utcnow()))
        await s.commit()


async def _reaper() -> None:
    while True:
        try:
            n = await sandbox.reap_idle()
            if n:
                log.info("stopped %d idle sandboxes", n)
        except Exception:
            log.exception("reaper failed")
        await asyncio.sleep(300)


async def _sandbox_status() -> None:
    """Every 20 s publish each sandbox's state (+ GPU use for running ones) to Redis for the UI."""
    import json
    r = events.get_redis()
    query = "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits"
    while True:
        try:
            def _collect():
                out = []
                for c in sandbox.client().containers.list(all=True, filters={"label": sandbox.LABEL}):
                    tid = c.labels.get(f"{sandbox.LABEL}.thread", "")
                    info = {"state": c.status, "name": c.name}
                    if c.status == "running":
                        try:
                            res = c.exec_run(["bash", "-c", query])
                            if res.exit_code == 0:
                                name, used, total, util = [x.strip() for x in res.output.decode().split("\n")[0].split(",")]
                                info["gpu"] = {"name": name, "mem_used_mb": int(used), "mem_total_mb": int(total),
                                               "util_pct": int(util)}
                        except Exception:
                            pass
                    out.append((tid, info))
                return out
            for tid, info in await asyncio.to_thread(_collect):
                if tid:
                    await r.set(f"pa:sbx:status:{tid}", json.dumps(info), ex=90)
        except Exception:
            log.exception("sandbox status collection failed")
        await asyncio.sleep(20)


async def main() -> None:
    await init_db()
    await _recover_orphans()
    settings.workspaces_dir.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(settings.worker_concurrency)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    reaper = asyncio.create_task(_reaper())
    status_task = asyncio.create_task(_sandbox_status())
    r = events.get_redis()
    running: set[asyncio.Task] = set()
    log.info("worker started: model=%s concurrency=%d", settings.model, settings.worker_concurrency)

    async def guarded(run_id: str):
        async with sem:
            try:
                await execute_run(run_id)
            except Exception:
                log.exception("run %s failed outside the loop", run_id)

    while not stop.is_set():
        await sem.acquire()
        sem.release()
        item = await r.blpop([events.CLEANUP_KEY, events.NOMINATE_KEY, events.LABPROFILE_KEY, events.QUEUE_KEY], timeout=5)
        if not item:
            continue
        key, value = item
        if key == events.CLEANUP_KEY:
            try:
                await sandbox.remove(value, delete_workspace=True)
                log.info("removed sandbox + workspace of deleted thread %s", value)
            except Exception:
                log.exception("cleanup of %s failed", value)
            continue
        if key == events.NOMINATE_KEY:
            # research project → lab KB nomination (LLM summary + embedding); runs here for Bedrock creds
            async def nominate(payload: str):
                import json as _json
                async with sem:
                    try:
                        p = _json.loads(payload)
                        await pipeline.nominate_experience(p["thread_id"], p["user_id"], p["lab_id"], p.get("lab_name", ""))
                    except Exception:
                        log.exception("nomination failed")
            nt = asyncio.create_task(nominate(value))
            running.add(nt)
            nt.add_done_callback(running.discard)
            continue
        if key == events.LABPROFILE_KEY:
            async def profile(lab_id: str):
                async with sem:
                    try:
                        await labs.generate_profile_draft(lab_id)
                    except Exception:
                        log.exception("lab profile draft failed")
            pt = asyncio.create_task(profile(value))
            running.add(pt)
            pt.add_done_callback(running.discard)
            continue
        run_id = value
        log.info("picked run %s", run_id)
        t = asyncio.create_task(guarded(run_id))
        running.add(t)
        t.add_done_callback(running.discard)

    log.info("shutting down, waiting for %d runs", len(running))
    reaper.cancel()
    status_task.cancel()
    if running:
        await asyncio.wait(running, timeout=60)


if __name__ == "__main__":
    asyncio.run(main())
