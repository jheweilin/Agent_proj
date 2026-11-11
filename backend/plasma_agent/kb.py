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
from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.dialects.postgresql import array

from .config import settings
from .db import KbChunk, KbDataset, KbDocument, KbGrant, LabMember, SessionLocal, Thread

log = logging.getLogger("plasma_agent.kb")
VOYAGE = "https://api.voyageai.com/v1"
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".py", ".tex", ".rst", ".log", ".yaml", ".yml"}


def enabled() -> bool:
    return bool(settings.voyage_api_key)


async def _voyage(path: str, payload: dict) -> dict:
    import asyncio
    async with httpx.AsyncClient(timeout=90) as c:
        for attempt in range(5):  # Voyage rate limits (429) are common on the low tier — back off and retry
            r = await c.post(f"{VOYAGE}/{path}",
                             headers={"Authorization": f"Bearer {settings.voyage_api_key}"}, json=payload)
            if r.status_code == 429 and attempt < 4:
                wait = float(r.headers.get("retry-after") or (2 ** attempt))
                log.warning("voyage %s rate-limited (429); retrying in %.1fs", path, wait)
                await asyncio.sleep(wait)
                continue
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


async def get_or_create_dataset(thread_id, owner_id=None, category: str = "task", name: str = "",
                                lab_id=None) -> uuid.UUID:
    async with SessionLocal() as s:
        q = select(KbDataset).where(KbDataset.category == category)
        if category == "task":
            q = q.where(KbDataset.thread_id == thread_id)
        elif category == "lab":
            q = q.where(KbDataset.lab_id == lab_id)
        else:  # base: the single shared dataset
            q = q.where(KbDataset.thread_id.is_(None), KbDataset.lab_id.is_(None))
        ds = (await s.execute(q)).scalars().first()
        if ds is None:
            ds = KbDataset(thread_id=thread_id if category == "task" else None,
                           lab_id=lab_id if category == "lab" else None,
                           owner_id=owner_id, category=category, name=name or category)
            s.add(ds)
            await s.commit()
        return ds.id


def kb_files_dir() -> Path:
    """Where original base/lab KB uploads are kept (under the workspaces volume so api can serve them)."""
    d = settings.workspaces_dir / "_kb"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _unlink_quietly(path: str) -> None:
    if path:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


async def ingest(dataset_id, source: str, body: str, *, origin: str = "upload", kind: str = "reference",
                 status: str = "approved", source_thread_id=None, submitted_by=None, tags=None,
                 title: str = "", file_path: str = "", byte_size: int = 0, mime: str = "") -> dict:
    """Chunk + embed `body` and store it under `source`, replacing any earlier copy of that source.

    The keyword metadata drives the knowledge flywheel (see docs/LAB_KNOWLEDGE_PLAN.md): manual
    uploads keep the defaults (upload/reference/approved); a nominated research experience is stored
    as research/experience/pending until a lab owner approves it (only `approved` is retrievable).
    `file_path` (if given) is the retained original file so the UI can preview/download it."""
    chunks = chunk_text(body)
    if not chunks:
        return {"source": source, "chunks": 0}
    fh = hashlib.sha256(body.encode("utf-8", "replace")).hexdigest()
    async with SessionLocal() as s:
        old = (await s.execute(select(KbDocument).where(KbDocument.dataset_id == dataset_id,
                                                        KbDocument.source == source))).scalars().all()
        for d in old:
            _unlink_quietly(d.file_path)   # drop the replaced original so it doesn't orphan
            await s.execute(delete(KbChunk).where(KbChunk.document_id == d.id))
            await s.delete(d)
        doc = KbDocument(dataset_id=dataset_id, source=source, file_hash=fh, n_chunks=len(chunks),
                         origin=origin, kind=kind, status=status,
                         source_thread_id=source_thread_id, submitted_by=submitted_by, tags=list(tags or []),
                         title=title, file_path=file_path, byte_size=byte_size, mime=mime)
        s.add(doc)
        await s.flush()
        vecs = await embed(chunks, "document")
        for i, (ch, v) in enumerate(zip(chunks, vecs)):
            s.add(KbChunk(dataset_id=dataset_id, document_id=doc.id, chunk_index=i,
                          content=ch, embedding=v, meta={"source": source}))
        await s.commit()
        doc_id = str(doc.id)
    return {"id": doc_id, "source": source, "chunks": len(chunks)}


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
    """Datasets visible to a thread: its own task dataset, the shared base library, and the
    lab libraries of every lab the thread's owner belongs to."""
    async with SessionLocal() as s:
        owner = (await s.execute(select(Thread.user_id).where(Thread.id == thread_id))).scalar_one_or_none()
        lab_ids: list[uuid.UUID] = []
        if owner is not None:
            lab_ids = list((await s.execute(
                select(LabMember.lab_id).where(LabMember.user_id == owner))).scalars().all())
        conds = [KbDataset.thread_id == thread_id, KbDataset.category == "base"]
        if lab_ids:
            conds.append((KbDataset.category == "lab") & (KbDataset.lab_id.in_(lab_ids)))
        rows = (await s.execute(select(KbDataset.id).where(or_(*conds)))).scalars().all()
    return list(rows)


async def lab_dataset_id(lab_id, name: str = "") -> uuid.UUID:
    """The KB dataset for one lab — searchable only from threads owned by its members."""
    return await get_or_create_dataset(None, category="lab", lab_id=lab_id, name=name or "實驗室庫")


def _as_uuid(x):
    try:
        return uuid.UUID(str(x))
    except (ValueError, TypeError):
        return None


async def visible_scope(thread_id) -> dict:
    """Everything a thread may retrieve (L3): its own task + base + its owner's labs (via
    datasets_for_thread), PLUS cross-lab grants to those labs — whole dataset (full), specific
    documents, or documents carrying granted tags. Nothing is copied; this just widens the filter."""
    datasets = list(await datasets_for_thread(thread_id))
    doc_ids: list = []
    tag_filters: list = []
    async with SessionLocal() as s:
        owner = (await s.execute(select(Thread.user_id).where(Thread.id == thread_id))).scalar_one_or_none()
        lab_ids = list((await s.execute(
            select(LabMember.lab_id).where(LabMember.user_id == owner))).scalars().all()) if owner else []
        if lab_ids:
            grants = (await s.execute(select(KbGrant).where(
                KbGrant.grantee_lab_id.in_(lab_ids), KbGrant.status == "granted"))).scalars().all()
            for g in grants:
                ds = (await s.execute(select(KbDataset.id).where(
                    KbDataset.category == "lab", KbDataset.lab_id == g.grantor_lab_id))).scalars().first()
                if ds is None:
                    continue
                if g.scope == "full":
                    datasets.append(ds)
                elif g.scope == "documents":
                    doc_ids += [u for u in (_as_uuid(x) for x in (g.scope_ref or [])) if u]
                elif g.scope == "tags":
                    tags = [t for t in (g.scope_ref or []) if t]
                    if tags:
                        tag_filters.append((ds, tags))
    return {"datasets": list(dict.fromkeys(datasets)), "doc_ids": doc_ids, "tag_filters": tag_filters}


def _norm_scope(scope) -> dict:
    """Accept either a flat dataset-id list (back-compat) or a full scope dict."""
    if isinstance(scope, dict):
        return {"datasets": scope.get("datasets") or [], "doc_ids": scope.get("doc_ids") or [],
                "tag_filters": scope.get("tag_filters") or []}
    return {"datasets": list(scope or []), "doc_ids": [], "tag_filters": []}


def _scope_clause(scope: dict, doc_model=False):
    """OR of the reachable-chunk conditions. doc_model=True builds it on KbDocument (for read)."""
    ds_col = KbDocument.dataset_id if doc_model else KbChunk.dataset_id
    conds = []
    if scope["datasets"]:
        conds.append(ds_col.in_(scope["datasets"]))
    if scope["doc_ids"]:
        conds.append((KbDocument.id if doc_model else KbChunk.document_id).in_(scope["doc_ids"]))
    for ds_id, tags in scope["tag_filters"]:
        conds.append(and_(ds_col == ds_id, KbDocument.tags.op("?|")(array(tags))))
    return or_(*conds) if conds else None


async def search(scope, query: str, top_k: int = 5, pool: int = 30) -> list[dict]:
    """Cosine vector search over the visible scope (dataset-id list or a visible_scope dict),
    then Voyage rerank to the best `top_k`. Only approved documents are searched."""
    scope = _norm_scope(scope)
    clause = _scope_clause(scope)
    if clause is None or not query.strip():
        return []
    qv = (await embed([query], "query"))[0]
    async with SessionLocal() as s:
        dist = KbChunk.embedding.cosine_distance(qv).label("dist")
        rows = (await s.execute(
            select(KbChunk.content, KbDocument.source, KbChunk.chunk_index, dist)
            .join(KbDocument, KbDocument.id == KbChunk.document_id)
            .where(clause, KbDocument.status == "approved")
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


async def list_visible_documents(thread_id) -> list[dict]:
    """Every document this thread can see (its uploads + base + its labs + cross-lab grants),
    with a human collection label — so the agent can list 'what papers are available' and the UI
    can open each one. Only approved docs."""
    scope = await visible_scope(thread_id)
    clause = _scope_clause(scope, doc_model=True)
    if clause is None:
        return []
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(KbDocument, KbDataset).join(KbDataset, KbDataset.id == KbDocument.dataset_id)
            .where(clause, KbDocument.status == "approved")
            .order_by(KbDataset.category, KbDocument.created_at.desc()))).all()
    out = []
    for d, ds in rows:
        label = (f"實驗室庫：{ds.name}" if ds.category == "lab"
                 else "基礎庫" if ds.category == "base" else "本對話上傳")
        out.append({"id": str(d.id), "title": d.title or d.source, "source": d.source, "collection": label,
                    "kind": d.kind, "chunks": d.n_chunks, "has_file": bool(d.file_path), "mime": d.mime})
    return out


async def read_document(scope, source: str, max_chars: int = 20000) -> str | None:
    """Return the full text of a stored document (its chunks joined), matched by source name,
    restricted to the visible scope (dataset-id list or visible_scope dict)."""
    scope = _norm_scope(scope)
    clause = _scope_clause(scope, doc_model=True)
    if clause is None:
        return None
    async with SessionLocal() as s:
        doc = (await s.execute(select(KbDocument).where(clause,
                                                        KbDocument.status == "approved",
                                                        KbDocument.source.ilike(f"%{source}%"))
                               .order_by(KbDocument.created_at.desc()))).scalars().first()
        if doc is None:
            return None
        rows = (await s.execute(select(KbChunk.content).where(KbChunk.document_id == doc.id)
                                .order_by(KbChunk.chunk_index))).scalars().all()
    body = "\n\n".join(rows)
    return body if len(body) <= max_chars else body[:max_chars] + "\n…（截斷）"


async def profile_material(dataset_id, max_docs: int = 40, max_chunks: int = 30) -> dict:
    """Material for an LLM specialty-profile draft: approved doc titles + a sample of their text."""
    async with SessionLocal() as s:
        docs = (await s.execute(select(KbDocument.source).where(KbDocument.dataset_id == dataset_id,
                KbDocument.status == "approved").order_by(KbDocument.created_at.desc()).limit(max_docs))).scalars().all()
        chunks = (await s.execute(select(KbChunk.content).join(KbDocument, KbDocument.id == KbChunk.document_id)
                .where(KbChunk.dataset_id == dataset_id, KbDocument.status == "approved")
                .order_by(KbChunk.chunk_index).limit(max_chunks))).scalars().all()
    return {"sources": list(docs), "excerpts": [c[:600] for c in chunks]}


async def base_dataset_id() -> uuid.UUID:
    """The shared base library — searchable from every thread (see datasets_for_thread)."""
    return await get_or_create_dataset(None, category="base", name="基礎庫")


async def list_documents(dataset_id, status: str | None = "approved") -> list[dict]:
    """List a dataset's documents. `status=None` lists every status; defaults to approved only
    (so the lab library shows live docs; the pending review queue passes status="pending")."""
    async with SessionLocal() as s:
        q = select(KbDocument).where(KbDocument.dataset_id == dataset_id)
        if status is not None:
            q = q.where(KbDocument.status == status)
        rows = (await s.execute(q.order_by(KbDocument.created_at.desc()))).scalars().all()
    return [{"id": str(d.id), "source": d.source, "title": d.title or d.source, "chunks": d.n_chunks,
             "origin": d.origin, "kind": d.kind, "status": d.status, "tags": d.tags or [],
             "size": d.byte_size, "mime": d.mime, "has_file": bool(d.file_path),
             "source_thread_id": str(d.source_thread_id) if d.source_thread_id else None,
             "submitted_by": str(d.submitted_by) if d.submitted_by else None,
             "created_at": d.created_at.isoformat()} for d in rows]


async def get_document(doc_id: str) -> KbDocument | None:
    async with SessionLocal() as s:
        try:
            return await s.get(KbDocument, uuid.UUID(doc_id))
        except ValueError:
            return None


async def document_text(doc_id: str, max_chars: int = 200000) -> str:
    """The text that was extracted + embedded from a document (its chunks, in order)."""
    async with SessionLocal() as s:
        rows = (await s.execute(select(KbChunk.content).where(KbChunk.document_id == uuid.UUID(doc_id))
                                .order_by(KbChunk.chunk_index))).scalars().all()
    body = "\n\n".join(rows)
    return body if len(body) <= max_chars else body[:max_chars] + "\n…（截斷）"


async def set_document_meta(doc_id: str, dataset_id, *, title=None, tags=None) -> bool:
    """Edit a document's display title and/or topic tags. Scoped to dataset_id."""
    async with SessionLocal() as s:
        try:
            d = await s.get(KbDocument, uuid.UUID(doc_id))
        except ValueError:
            return False
        if d is None or d.dataset_id != dataset_id:
            return False
        if title is not None:
            d.title = title.strip()[:600]
        if tags is not None:
            d.tags = [t.strip() for t in tags if t.strip()][:12]
        await s.commit()
    return True


async def set_document_tags(doc_id: str, dataset_id, tags: list[str]) -> bool:
    """Set a document's topic tags (used for tag-scoped cross-lab grants). Scoped to dataset_id."""
    async with SessionLocal() as s:
        try:
            d = await s.get(KbDocument, uuid.UUID(doc_id))
        except ValueError:
            return False
        if d is None or d.dataset_id != dataset_id:
            return False
        d.tags = [t.strip() for t in tags if t.strip()][:12]
        await s.commit()
    return True


async def set_document_status(doc_id: str, dataset_id, status: str) -> bool:
    """Approve/reject a document (owner review). Scoped to `dataset_id` so a doc id from another
    collection can't be flipped. Returns False if not found / not in that dataset."""
    async with SessionLocal() as s:
        try:
            d = await s.get(KbDocument, uuid.UUID(doc_id))
        except ValueError:
            return False
        if d is None or d.dataset_id != dataset_id:
            return False
        d.status = status
        await s.commit()
    return True


async def delete_document(doc_id: str, dataset_id=None) -> bool:
    """Delete a document and its chunks. If `dataset_id` is given, only delete when the document
    belongs to that dataset (so a lab member can't delete another collection's document by id)."""
    async with SessionLocal() as s:
        try:
            d = await s.get(KbDocument, uuid.UUID(doc_id))
        except ValueError:
            return False
        if d is None or (dataset_id is not None and d.dataset_id != dataset_id):
            return False
        _unlink_quietly(d.file_path)
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
