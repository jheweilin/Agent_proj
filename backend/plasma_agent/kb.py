"""Knowledge base: Voyage AI embeddings + rerank over a pgvector store.

Datasets are scoped by `category`: task (bound to one thread's uploads), base (shared), lab
(restricted, later). Ingest = parse → chunk → embed(document) → store. Retrieve = embed(query)
→ vector search (cosine) → Voyage rerank → passages with their source.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import Path

import httpx
from sqlalchemy import delete, func, select, text

from .config import settings
from .db import KbChunk, KbDataset, KbDocument, SessionLocal

log = logging.getLogger("plasma_agent.kb")
VOYAGE = "https://api.voyageai.com/v1"
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".py", ".tex", ".rst", ".log", ".yaml", ".yml"}


def enabled() -> bool:
    return bool(settings.voyage_api_key)


async def _voyage(path: str, payload: dict) -> dict:
    async with httpx.AsyncClient(timeout=90) as c:
        r = await c.post(f"{VOYAGE}/{path}",
                         headers={"Authorization": f"Bearer {settings.voyage_api_key}"}, json=payload)
        r.raise_for_status()
        return r.json()


async def embed(texts: list[str], input_type: str) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), 96):  # Voyage caps batch size / tokens; keep batches small
        data = await _voyage("embeddings", {"model": settings.voyage_embed_model, "input": texts[i:i + 96],
                                            "input_type": input_type, "output_dimension": settings.embed_dim})
        out.extend(d["embedding"] for d in data["data"])
    return out


async def rerank(query: str, docs: list[str], top_k: int) -> list[tuple[int, float]]:
    if not docs:
        return []
    data = await _voyage("rerank", {"model": settings.voyage_rerank_model, "query": query,
                                    "documents": docs, "top_k": min(top_k, len(docs))})
    return [(d["index"], d["relevance_score"]) for d in data["data"]]


def chunk_text(s: str, size: int = 1400, overlap: int = 200) -> list[str]:
    """Pack paragraphs into ~size-char windows; hard-split any single oversized paragraph."""
    s = (s or "").strip()
    if not s:
        return []
    paras = [p.strip() for p in s.split("\n\n") if p.strip()]
    chunks: list[str] = []
    cur = ""
    for p in paras:
        if len(cur) + len(p) + 2 <= size:
            cur = f"{cur}\n\n{p}" if cur else p
        else:
            if cur:
                chunks.append(cur)
                cur = ""
            if len(p) <= size:
                cur = p
            else:
                for i in range(0, len(p), size - overlap):
                    chunks.append(p[i:i + size])
    if cur:
        chunks.append(cur)
    return chunks


def extract_text(path: Path) -> str:
    suf = path.suffix.lower()
    if suf == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        return "\n\n".join((pg.extract_text() or "") for pg in reader.pages)
    if suf in TEXT_EXTS:
        return path.read_text(errors="replace")
    return ""  # unsupported type (image, binary, …): nothing to index


async def get_or_create_dataset(thread_id, owner_id=None, category: str = "task", name: str = "") -> uuid.UUID:
    async with SessionLocal() as s:
        q = select(KbDataset).where(KbDataset.category == category)
        q = q.where(KbDataset.thread_id == thread_id) if category == "task" else q.where(KbDataset.thread_id.is_(None))
        ds = (await s.execute(q)).scalars().first()
        if ds is None:
            ds = KbDataset(thread_id=thread_id if category == "task" else None,
                           owner_id=owner_id, category=category, name=name or category)
            s.add(ds)
            await s.commit()
        return ds.id


async def ingest(dataset_id, source: str, body: str) -> dict:
    """Chunk + embed `body` and store it under `source`, replacing any earlier copy of that source."""
    chunks = chunk_text(body)
    if not chunks:
        return {"source": source, "chunks": 0}
    fh = hashlib.sha256(body.encode("utf-8", "replace")).hexdigest()
    async with SessionLocal() as s:
        old = (await s.execute(select(KbDocument).where(KbDocument.dataset_id == dataset_id,
                                                        KbDocument.source == source))).scalars().all()
        for d in old:
            await s.execute(delete(KbChunk).where(KbChunk.document_id == d.id))
            await s.delete(d)
        doc = KbDocument(dataset_id=dataset_id, source=source, file_hash=fh, n_chunks=len(chunks))
        s.add(doc)
        await s.flush()
        vecs = await embed(chunks, "document")
        for i, (ch, v) in enumerate(zip(chunks, vecs)):
            s.add(KbChunk(dataset_id=dataset_id, document_id=doc.id, chunk_index=i,
                          content=ch, embedding=v, meta={"source": source}))
        await s.commit()
    return {"source": source, "chunks": len(chunks)}


async def ingest_file(dataset_id, path: Path, source: str | None = None) -> dict:
    body = await _to_thread_extract(path)
    src = source or path.name
    if not body.strip():
        return {"source": src, "chunks": 0, "skipped": "no extractable text"}
    return await ingest(dataset_id, src, body)


async def _to_thread_extract(path: Path) -> str:
    import asyncio
    return await asyncio.to_thread(extract_text, path)


async def datasets_for_thread(thread_id) -> list[uuid.UUID]:
    """Datasets visible to a thread: its own task dataset + any shared base datasets."""
    async with SessionLocal() as s:
        rows = (await s.execute(select(KbDataset.id).where(
            (KbDataset.thread_id == thread_id) | (KbDataset.category == "base")))).scalars().all()
    return list(rows)


async def search(dataset_ids: list[uuid.UUID], query: str, top_k: int = 5, pool: int = 30) -> list[dict]:
    """Cosine vector search over the given datasets, then Voyage rerank to the best `top_k`."""
    if not dataset_ids or not query.strip():
        return []
    qv = (await embed([query], "query"))[0]
    async with SessionLocal() as s:
        dist = KbChunk.embedding.cosine_distance(qv).label("dist")
        rows = (await s.execute(
            select(KbChunk.content, KbDocument.source, KbChunk.chunk_index, dist)
            .join(KbDocument, KbDocument.id == KbChunk.document_id)
            .where(KbChunk.dataset_id.in_(dataset_ids))
            .order_by(dist).limit(pool))).all()
    cand = [{"content": r[0], "source": r[1], "chunk": r[2], "distance": round(float(r[3]), 4)} for r in rows]
    if not cand:
        return []
    order = await rerank(query, [c["content"] for c in cand], top_k)
    if not order:
        return cand[:top_k]
    out = []
    for idx, score in order:
        c = dict(cand[idx])
        c["score"] = round(float(score), 4)
        out.append(c)
    return out


async def read_document(dataset_ids: list[uuid.UUID], source: str, max_chars: int = 20000) -> str | None:
    """Return the full text of a stored document (its chunks joined), matched by source name."""
    async with SessionLocal() as s:
        doc = (await s.execute(select(KbDocument).where(KbDocument.dataset_id.in_(dataset_ids),
                                                        KbDocument.source.ilike(f"%{source}%"))
                               .order_by(KbDocument.created_at.desc()))).scalars().first()
        if doc is None:
            return None
        rows = (await s.execute(select(KbChunk.content).where(KbChunk.document_id == doc.id)
                                .order_by(KbChunk.chunk_index))).scalars().all()
    body = "\n\n".join(rows)
    return body if len(body) <= max_chars else body[:max_chars] + "\n…（截斷）"


async def base_dataset_id() -> uuid.UUID:
    """The shared base library — searchable from every thread (see datasets_for_thread)."""
    return await get_or_create_dataset(None, category="base", name="基礎庫")


async def list_documents(dataset_id) -> list[dict]:
    async with SessionLocal() as s:
        rows = (await s.execute(select(KbDocument).where(KbDocument.dataset_id == dataset_id)
                                .order_by(KbDocument.created_at.desc()))).scalars().all()
    return [{"id": str(d.id), "source": d.source, "chunks": d.n_chunks,
             "created_at": d.created_at.isoformat()} for d in rows]


async def delete_document(doc_id: str) -> bool:
    async with SessionLocal() as s:
        try:
            d = await s.get(KbDocument, uuid.UUID(doc_id))
        except ValueError:
            return False
        if d is None:
            return False
        await s.execute(delete(KbChunk).where(KbChunk.document_id == d.id))
        await s.delete(d)
        await s.commit()
    return True


async def thread_stats(thread_id) -> dict:
    async with SessionLocal() as s:
        ds = (await s.execute(select(KbDataset.id).where(KbDataset.thread_id == thread_id,
                                                         KbDataset.category == "task"))).scalars().first()
        if ds is None:
            return {"docs": 0, "chunks": 0}
        docs = (await s.execute(select(func.count()).select_from(KbDocument)
                                .where(KbDocument.dataset_id == ds))).scalar_one()
        chunks = (await s.execute(select(func.count()).select_from(KbChunk)
                                  .where(KbChunk.dataset_id == ds))).scalar_one()
        return {"docs": docs, "chunks": chunks}
