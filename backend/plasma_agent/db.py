"""Database models and session helpers (PostgreSQL via SQLAlchemy async)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from pgvector.sqlalchemy import Vector
from sqlalchemy import (BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint, func)
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
    # faculty (教職員) may create/own labs. Backfilled from FACULTY_EMAILS at login/register now;
    # a future nid identity API will set this at login instead. See auth.identity_flags.
    is_faculty: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
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
    # per-thread runtime config set at creation: {"models": {agent_key: model_id}, "effort", "max_iterations"}.
    # Missing keys fall back to settings defaults. See agent.thread_runtime.
    config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
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


class Lab(Base):
    """A research lab (實驗室). Owned by a faculty member; its KB is shared among members only.

    Profile fields (L2 專長名錄, docs/LAB_KNOWLEDGE_PLAN.md): a public specialty card for the
    cross-lab directory. `summary`/`keywords` are owner-curated (LLM may draft into `profile_draft`);
    only shown in the directory when `is_public` is set."""
    __tablename__ = "labs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(300), default="")
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True),
                                                ForeignKey("users.id", ondelete="CASCADE"), index=True)
    join_code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    keywords: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    profile_draft: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")  # LLM draft, owner reviews
    profile_status: Mapped[str] = mapped_column(String(20), nullable=False, default="", server_default="")  # ''|generating|ready|error
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LabMember(Base):
    """Membership of a user in a lab. `role`: owner | member."""
    __tablename__ = "lab_members"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lab_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True),
                                              ForeignKey("labs.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True),
                                               ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20), default="member")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (UniqueConstraint("lab_id", "user_id", name="uq_lab_member"),)


class KbDataset(Base):
    """A knowledge-base collection. `category`: task (bound to one thread), base (shared), lab (per-lab)."""
    __tablename__ = "kb_datasets"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    thread_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True),
                                                        ForeignKey("threads.id", ondelete="CASCADE"), nullable=True, index=True)
    # for category=="lab": the lab this dataset belongs to (null for task/base)
    lab_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True),
                                                     ForeignKey("labs.id", ondelete="CASCADE"), nullable=True, index=True)
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
    # knowledge-flywheel metadata (docs/LAB_KNOWLEDGE_PLAN.md):
    #   origin: upload (manual) | research (platform research project) | chat
    #   kind:   reference (papers/IP) | experience (how-to + pitfalls, generated)
    #   status: approved (visible to retrieval) | pending (nominated, awaiting owner) | rejected
    # Defaults keep every pre-existing / manually-uploaded doc approved+reference+upload.
    origin: Mapped[str] = mapped_column(String(20), nullable=False, default="upload", server_default="upload")
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="reference", server_default="reference")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="approved", server_default="approved")
    source_thread_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)  # back-link to origin project
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)       # nominator
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")    # topic tags (L3 grants)
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
        await conn.exec_driver_sql(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_faculty BOOLEAN NOT NULL DEFAULT false")
        await conn.exec_driver_sql(
            "ALTER TABLE kb_datasets ADD COLUMN IF NOT EXISTS lab_id UUID")
        await conn.exec_driver_sql(
            "ALTER TABLE threads ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb")
        # knowledge-flywheel columns on kb_documents (existing rows → upload/reference/approved)
        await conn.exec_driver_sql(
            "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'upload'")
        await conn.exec_driver_sql(
            "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'reference'")
        await conn.exec_driver_sql(
            "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'approved'")
        await conn.exec_driver_sql(
            "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS source_thread_id UUID")
        await conn.exec_driver_sql(
            "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS submitted_by UUID")
        await conn.exec_driver_sql(
            "ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb")
        # lab profile columns (L2 專長名錄)
        await conn.exec_driver_sql("ALTER TABLE labs ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''")
        await conn.exec_driver_sql("ALTER TABLE labs ADD COLUMN IF NOT EXISTS keywords JSONB NOT NULL DEFAULT '[]'::jsonb")
        await conn.exec_driver_sql("ALTER TABLE labs ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false")
        await conn.exec_driver_sql("ALTER TABLE labs ADD COLUMN IF NOT EXISTS profile_draft TEXT NOT NULL DEFAULT ''")
        await conn.exec_driver_sql("ALTER TABLE labs ADD COLUMN IF NOT EXISTS profile_status VARCHAR(20) NOT NULL DEFAULT ''")


async def get_session():
    async with SessionLocal() as session:
        yield session


__all__ = ["Base", "User", "Thread", "Message", "Project", "Run", "Lab", "LabMember",
           "KbDataset", "KbDocument", "KbChunk",
           "SessionLocal", "engine", "init_db", "get_session", "utcnow", "func"]
