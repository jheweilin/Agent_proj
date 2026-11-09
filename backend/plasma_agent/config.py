"""Runtime configuration, read once from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # --- database / queue ---
    database_url: str = field(default_factory=lambda: _env(
        "DATABASE_URL", "postgresql+asyncpg://plasma:plasma@postgres:5432/plasma"))
    redis_url: str = field(default_factory=lambda: _env("REDIS_URL", "redis://redis:6379/0"))

    # --- auth ---
    jwt_secret: str = field(default_factory=lambda: _env("JWT_SECRET", "change-me"))
    jwt_ttl_hours: int = field(default_factory=lambda: _int("JWT_TTL_HOURS", 24 * 7))
    allow_registration: bool = field(default_factory=lambda: _env("ALLOW_REGISTRATION", "1") == "1")

    # --- LLM (Amazon Bedrock) ---
    aws_region: str = field(default_factory=lambda: _env("AWS_REGION", "ap-southeast-1"))
    model: str = field(default_factory=lambda: _env("MODEL", "global.anthropic.claude-sonnet-5-5"))
    fallback_model: str = field(default_factory=lambda: _env("FALLBACK_MODEL", "global.anthropic.claude-opus-5-5"))
    title_model: str = field(default_factory=lambda: _env("TITLE_MODEL", "global.anthropic.claude-haiku-5-5"))
    effort: str = field(default_factory=lambda: _env("EFFORT", "medium"))
    max_tokens: int = field(default_factory=lambda: _int("MAX_TOKENS", 64000))
    max_iterations: int = field(default_factory=lambda: _int("MAX_ITERATIONS", 100))

    # --- domains (one engine, pluggable research domains; see domains.py) ---
    default_domain: str = field(default_factory=lambda: _env("DEFAULT_DOMAIN", "plasma"))

    # --- sandbox ---
    sandbox_image: str = field(default_factory=lambda: _env(
        "SANDBOX_IMAGE", "public.ecr.aws/z1o8z4f9/agent:plasma-1.1.0"))
    sandbox_gpu: str = field(default_factory=lambda: _env("SANDBOX_GPU", "nvidia.com/gpu=0"))
    sandbox_mem: str = field(default_factory=lambda: _env("SANDBOX_MEM", "16g"))
    sandbox_cpus: float = field(default_factory=lambda: float(_env("SANDBOX_CPUS", "12")))
    sandbox_idle_minutes: int = field(default_factory=lambda: _int("SANDBOX_IDLE_MINUTES", 120))
    workspaces_dir: Path = field(default_factory=lambda: Path(_env(
        "WORKSPACES_DIR", "/data/plasma-agent/workspaces")))
    # host path of the COMSOL Application Library, mounted read-only into every sandbox
    comsol_library_dir: str = field(default_factory=lambda: _env(
        "COMSOL_LIBRARY_DIR", "/data/jhewlin/comsol64_applications"))

    # --- external services ---
    comsol_api: str = field(default_factory=lambda: _env(
        "COMSOL_API", "http://140.134.138.17:2035/api/v1").rstrip("/"))
    tavily_api_key: str = field(default_factory=lambda: _env("TAVILY_API_KEY"))

    # --- knowledge base (Voyage AI embedding + rerank, pgvector store) ---
    voyage_api_key: str = field(default_factory=lambda: _env("VOYAGE_API_KEY"))
    voyage_embed_model: str = field(default_factory=lambda: _env("VOYAGE_EMBED_MODEL", "voyage-3.5"))
    voyage_rerank_model: str = field(default_factory=lambda: _env("VOYAGE_RERANK_MODEL", "rerank-2.5"))
    embed_dim: int = field(default_factory=lambda: _int("EMBED_DIM", 1024))

    # --- worker ---
    worker_concurrency: int = field(default_factory=lambda: _int("WORKER_CONCURRENCY", 3))
    guides_dir: Path = field(default_factory=lambda: Path(_env("GUIDES_DIR", "/app/guides")))
    prompts_dir: Path = field(default_factory=lambda: Path(_env("PROMPTS_DIR", "/app/prompts")))
    static_dir: Path = field(default_factory=lambda: Path(_env("STATIC_DIR", "/app/static")))


settings = Settings()
