"""Database models and session helpers (PostgreSQL via SQLAlchemy async)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .config import settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Thread(Base):
    __tablename__ = "threads"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), default="新對話")
    # research domain profile (plasma/general); see domains.py
    domain: Mapped[str] = mapped_column(String(40), default="plasma", server_default="plasma")
    # "chat" = plain single-agent chat (Phase A), "project" = nine-stage research pipeline (Phase B)
    mode: Mapped[str] = mapped_column(String(20), default="chat", server_default="chat")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Message(Base):
    """One Messages-API message, stored verbatim (append-only) so it can be replayed.

    `content` is the exact list of content blocks sent to / received from the model,
    including thinking blocks, which must be passed back unchanged.
    """
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    thread_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("threads.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[list] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (Index("ix_messages_thread_id_id", "thread_id", "id"),)


class Project(Base):
    """A nine-stage research project bound to one thread (pipeline mode).

    `stage` is the current FSM stage; `status` tracks whether we are running or paused
    at a human gate. `card` holds the research card (per-stage notes / acceptance evidence).
    """
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True),
                                                 ForeignKey("threads.id", ondelete="CASCADE"), unique=True, index=True)
    domain: Mapped[str] = mapped_column(String(40), default="plasma")
    stage: Mapped[str] = mapped_column(String(40), default="clarify")
    # running | awaiting_plan_approval | awaiting_acceptance | completed
    status: Mapped[str] = mapped_column(String(40), default="running")
    card: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("threads.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|running|completed|failed|stopped
    # which pipeline stage(s) this run executed (project mode); null for chat mode
    stage: Mapped[str | None] = mapped_column(String(40), nullable=True)
    model: Mapped[str] = mapped_column(String(200), default="")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    usage: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class KbDataset(Base):
    """A knowledge-base collection. `category`: task (bound to one thread), base (shared), lab (restricted)."""
    __tablename__ = "kb_datasets"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    thread_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True),
                                                        ForeignKey("threads.id", ondelete="CASCADE"), nullable=True, index=True)
    category: Mapped[str] = mapped_column(String(20), default="task")
    name: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class KbDocument(Base):
    __tablename__ = "kb_documents"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dataset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True),
                                                  ForeignKey("kb_datasets.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(600), default="")   # filename / path / url
    file_hash: Mapped[str] = mapped_column(String(64), default="")
    n_chunks: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class KbChunk(Base):
    __tablename__ = "kb_chunks"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dataset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True),
                                                  ForeignKey("kb_datasets.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True),
                                                   ForeignKey("kb_documents.id", ondelete="CASCADE"), index=True)
    chunk_index: Mapped[int] = mapped_column(Integer, default=0)
    content: Mapped[str] = mapped_column(Text)
    embedding = mapped_column(Vector(settings.embed_dim))
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)


engine = create_async_engine(settings.database_url, pool_pre_ping=True, pool_size=10)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    async with engine.begin() as conn:
        # api and worker both init the schema on boot; serialize so a newly-added table isn't
        # created twice concurrently (duplicate pg_type → crash). Lock is released on commit.
        await conn.exec_driver_sql("SELECT pg_advisory_xact_lock(912750001)")
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")  # needed before kb_chunks (vector column)
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_kb_chunks_embedding ON kb_chunks "
            "USING hnsw (embedding vector_cosine_ops)")
        # lightweight migration: add columns to pre-existing tables (create_all won't alter them)
        await conn.exec_driver_sql(
            "ALTER TABLE threads ADD COLUMN IF NOT EXISTS domain VARCHAR(40) NOT NULL DEFAULT 'plasma'")
        await conn.exec_driver_sql(
            "ALTER TABLE threads ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'chat'")
        await conn.exec_driver_sql(
            "ALTER TABLE runs ADD COLUMN IF NOT EXISTS stage VARCHAR(40)")


async def get_session():
    async with SessionLocal() as session:
        yield session


__all__ = ["Base", "User", "Thread", "Message", "Project", "Run", "KbDataset", "KbDocument", "KbChunk",
           "SessionLocal", "engine", "init_db", "get_session", "utcnow", "func"]
