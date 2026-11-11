"""Run event bus on Redis.

- Run queue:     list   `pa:queue`          (run ids, BLPOP by the worker)
- Run events:    stream `pa:run:{id}:events` (XADD by the worker, XREAD by SSE clients;
                 stream ids let a reconnecting browser resume where it left off)
- Stop request:  key    `pa:run:{id}:stop`
"""
from __future__ import annotations

import json
from typing import Any

import redis.asyncio as aioredis

from .config import settings

QUEUE_KEY = "pa:queue"
CLEANUP_KEY = "pa:cleanup"  # thread ids whose sandbox + workspace should be removed
NOMINATE_KEY = "pa:nominate"  # json payloads: research project → lab KB nomination (LLM runs in worker)
LABPROFILE_KEY = "pa:labprofile"  # lab ids: generate a specialty-profile draft (LLM runs in worker)
LABCARDS_KEY = "pa:labcards"  # lab ids: regenerate welcome example cards from the adopted profile (LLM in worker)
EVENT_TTL_SECONDS = 24 * 3600

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


def events_key(run_id: str) -> str:
    return f"pa:run:{run_id}:events"


def stop_key(run_id: str) -> str:
    return f"pa:run:{run_id}:stop"


async def publish(run_id: str, event: dict[str, Any]) -> None:
    r = get_redis()
    key = events_key(run_id)
    await r.xadd(key, {"data": json.dumps(event, ensure_ascii=False, default=str)}, maxlen=20000, approximate=True)
    await r.expire(key, EVENT_TTL_SECONDS)


async def enqueue_run(run_id: str) -> None:
    await get_redis().rpush(QUEUE_KEY, run_id)


async def enqueue_nomination(payload: dict[str, Any]) -> None:
    await get_redis().rpush(NOMINATE_KEY, json.dumps(payload, default=str))


async def enqueue_lab_profile(lab_id: str) -> None:
    await get_redis().rpush(LABPROFILE_KEY, lab_id)


async def enqueue_lab_cards(lab_id: str) -> None:
    await get_redis().rpush(LABCARDS_KEY, lab_id)


async def request_stop(run_id: str) -> None:
    await get_redis().set(stop_key(run_id), "1", ex=EVENT_TTL_SECONDS)


async def stop_requested(run_id: str) -> bool:
    return bool(await get_redis().exists(stop_key(run_id)))
