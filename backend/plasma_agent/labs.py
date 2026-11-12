"""Lab-domain logic beyond plain CRUD: the LLM specialty-profile draft for the 專長名錄 (L2).

Runs in the worker (needs Bedrock creds) — enqueued via events.LABPROFILE_KEY. The draft lands on
labs.profile_draft (JSON {summary, keywords}) for the owner to review/edit/adopt; see
docs/LAB_KNOWLEDGE_PLAN.md."""
from __future__ import annotations

import json
import logging
import uuid

from sqlalchemy import select

from . import agent, kb
from .config import settings
from .db import Lab, SessionLocal

log = logging.getLogger("plasma_agent.labs")


async def _set_profile(lab_id, **fields) -> None:
    async with SessionLocal() as s:
        lab = await s.get(Lab, uuid.UUID(str(lab_id)))
        if lab:
            for k, v in fields.items():
                setattr(lab, k, v)
            await s.commit()


async def generate_profile_draft(lab_id) -> None:
    """Draft a public specialty summary + keywords from the lab's approved KB, for the directory."""
    try:
        async with SessionLocal() as s:
            lab = await s.get(Lab, uuid.UUID(str(lab_id)))
        if lab is None:
            return
        dsid = await kb.lab_dataset_id(lab.id, name=lab.name)
        mat = await kb.profile_material(dsid)
        prompt = (
            "你要為一個研究實驗室寫一張「公開專長名片」，放在跨實驗室名錄上，讓別的實驗室了解這個實驗室的"
            "研究方向與專長、判斷要不要尋求合作。請**只根據素材**（實驗室知識庫的文件標題與摘錄）歸納，"
            "不要杜撰；若素材太少就寫得保守。用繁體中文。\n\n"
            "輸出 JSON（只輸出 JSON，不要其他文字）：\n"
            '{"summary": "3～5 句話描述研究方向與專長（不含機密細節）", "keywords": ["關鍵字", "最多 8 個"]}\n\n'
            f"實驗室名稱：{lab.name}\n素材：\n" + json.dumps(mat, ensure_ascii=False)[:8000])
        resp = await agent.client().messages.create(
            model=settings.model, max_tokens=1500, output_config={"effort": "low"},
            messages=[{"role": "user", "content": prompt}])
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        # tolerate code fences / stray prose around the JSON
        if "```" in text:
            text = text.split("```")[1].removeprefix("json").strip()
        start, end = text.find("{"), text.rfind("}")
        data = json.loads(text[start:end + 1]) if start >= 0 else {}
        draft = {"summary": str(data.get("summary", "")).strip(),
                 "keywords": [str(k).strip() for k in (data.get("keywords") or []) if str(k).strip()][:8]}
        await _set_profile(lab.id, profile_draft=json.dumps(draft, ensure_ascii=False), profile_status="ready")
    except Exception as e:
        log.exception("generate_profile_draft failed: %s", e)
        await _set_profile(lab_id, profile_status="error")


async def generate_example_cards(lab_id) -> None:
    """From the lab's adopted specialty profile, draft 4 welcome example prompts tailored to its field.

    Stored on labs.example_cards for the home screen. Triggered when the owner saves the profile."""
    try:
        async with SessionLocal() as s:
            lab = await s.get(Lab, uuid.UUID(str(lab_id)))
        if lab is None:
            return
        summary = (lab.summary or "").strip()
        keywords = ", ".join(lab.keywords or [])
        if not summary and not keywords:
            await _set_profile(lab.id, example_cards=[])  # nothing to base them on → fall back to the generic set
            return
        prompt = (
            "你要為一個研究實驗室設計 4 張「範例問題卡」，顯示在這個研究平台的首頁，讓實驗室成員（含新生）"
            "一按就能開始一個貼合本實驗室領域的研究。平台能力：在 GPU Linux 沙盒寫程式／跑模擬／畫圖、"
            "做數值計算與資料分析、搜尋 arXiv／OpenAlex 文獻、查實驗室知識庫。\n"
            "要求：每題要具體、可直接執行、約 1～2 句，貼合下方領域；四題盡量涵蓋不同面向"
            "（例如：數值/模擬、資料分析、文獻回顧、方法比較）。title 4～6 個字。用繁體中文。\n\n"
            "只輸出 JSON（不要其他文字）：\n"
            '{"cards": [{"title": "短標題", "text": "具體的研究問題"}, ... 共 4 題]}\n\n'
            f"實驗室名稱：{lab.name}\n研究方向：{summary}\n關鍵字：{keywords}")
        resp = await agent.client().messages.create(
            model=settings.model, max_tokens=2000, output_config={"effort": "low"},
            messages=[{"role": "user", "content": prompt}])
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        if "```" in text:
            text = text.split("```")[1].removeprefix("json").strip()
        start, end = text.find("{"), text.rfind("}")
        data = json.loads(text[start:end + 1]) if start >= 0 else {}
        cards = []
        for c in (data.get("cards") or [])[:4]:
            title, body = str(c.get("title", "")).strip(), str(c.get("text", "")).strip()
            if title and body:
                cards.append({"title": title[:20], "text": body})
        await _set_profile(lab.id, example_cards=cards)
    except Exception as e:
        log.exception("generate_example_cards failed: %s", e)


async def embed_profile(lab_id) -> None:
    """Embed a lab's specialty card (summary + keywords) into labs.profile_vec so other researchers'
    topics can be matched against it (cross-lab collaboration). Runs in the worker (Voyage)."""
    try:
        if not kb.enabled():
            return
        async with SessionLocal() as s:
            lab = await s.get(Lab, uuid.UUID(str(lab_id)))
        if lab is None:
            return
        text = (lab.summary or "").strip()
        if lab.keywords:
            text = (text + "\n關鍵字：" + "、".join(lab.keywords)).strip()
        vec = (await kb.embed([text], "document"))[0] if text else None
        async with SessionLocal() as s:
            lab = await s.get(Lab, uuid.UUID(str(lab_id)))
            if lab is not None:
                lab.profile_vec = vec
                await s.commit()
    except Exception as e:
        log.exception("embed_profile failed: %s", e)


async def user_lab_ids(user_id) -> set:
    """Lab ids the user belongs to — excluded from their own cross-lab suggestions."""
    from .db import LabMember
    async with SessionLocal() as s:
        rows = (await s.execute(select(LabMember.lab_id).where(LabMember.user_id == uuid.UUID(str(user_id))))).all()
    return {str(r[0]) for r in rows}


async def grant_status(grantee_lab_ids, grantor_lab_id) -> str:
    """Strongest grant state from any of the user's labs (grantee) to a grantor lab, for the
    cross-lab card: 'granted' > 'requested' > 'none'."""
    from .db import KbGrant
    if not grantee_lab_ids:
        return "none"
    gids = [uuid.UUID(str(x)) for x in grantee_lab_ids]
    async with SessionLocal() as s:
        rows = (await s.execute(select(KbGrant.status).where(
            KbGrant.grantee_lab_id.in_(gids),
            KbGrant.grantor_lab_id == uuid.UUID(str(grantor_lab_id))))).scalars().all()
    if "granted" in rows:
        return "granted"
    if "requested" in rows:
        return "requested"
    return "none"


async def match_labs(topic: str, exclude_lab_ids=(), limit: int = 2, max_dist: float = 0.55) -> list[dict]:
    """Find public labs whose specialty is closest to a research topic (cosine on profile_vec).
    Excludes the researcher's own labs; returns [{lab_id, name, summary, keywords, score}] best-first."""
    topic = (topic or "").strip()
    if not topic or not kb.enabled():
        return []
    exclude = {str(x) for x in (exclude_lab_ids or [])}
    try:
        qv = (await kb.embed([topic], "query"))[0]
    except Exception as e:
        log.exception("match_labs embed failed: %s", e)
        return []
    async with SessionLocal() as s:
        dist = Lab.profile_vec.cosine_distance(qv).label("dist")
        rows = (await s.execute(
            select(Lab, dist).where(Lab.is_public.is_(True), Lab.profile_vec.isnot(None))
            .order_by(dist).limit(limit + len(exclude) + 2))).all()
    out = []
    for lab, d in rows:
        if str(lab.id) in exclude or d is None or d > max_dist:
            continue
        out.append({"lab_id": str(lab.id), "name": lab.name, "summary": lab.summary,
                    "keywords": lab.keywords or [], "score": round(1 - float(d), 3)})
        if len(out) >= limit:
            break
    return out
