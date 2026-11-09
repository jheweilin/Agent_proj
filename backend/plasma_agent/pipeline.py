"""Nine-stage research pipeline (project mode) — the FSM behind the architecture diagram.

One run advances the project forward through stages until it either reaches a human gate
(plan approval, or result acceptance) or finishes. LLM stages run the agent loop with a
role overlay (Clarifier/Planner/Researcher); the retrieval stage is programmatic. The two
human gates pause the run; the approve/reject API (api.py) resumes with a new run.

Phase B implements stages ①②③④⑤ and the two gates; programmatic verification ⑥, independent
replication ⑦, read-only review ⑧ and programmatic grading ⑨ arrive in Phase D. The stage
labels below list all nine so the UI can show the full track with the current stage marked.
"""
from __future__ import annotations

import json
import logging
import uuid

from sqlalchemy import select

from . import agent, events, kb, roles, sandbox, tools
from .db import Message, Project, Run, SessionLocal

log = logging.getLogger("plasma_agent.pipeline")

# machine markers prefixed on injected pipeline messages so the UI renders them as stage cards /
# system notes instead of plain chat bubbles (the model just reads past them to the Chinese text)
EVIDENCE_MARK = "[[pa:evidence]]"


def _note(kind: str) -> str:
    return f"[[pa:note:{kind}]]"

# display order + labels for the whole pipeline (the UI shows all nine; B1 runs a subset)
STAGE_LABELS: list[tuple[str, str]] = [
    ("clarify", "釐清"), ("retrieve", "檢索證據"), ("plan", "規劃"),
    ("approve_plan", "核准計畫"), ("research", "研究"), ("verify", "驗證"),
    ("replicate", "第二實作"), ("review", "審查"), ("report", "等級與報告"),
]


async def _get_or_create(thread) -> Project:
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none()
        if p is None:
            p = Project(thread_id=thread.id, domain=getattr(thread, "domain", "plasma"),
                        stage="clarify", status="running")
            s.add(p)
            await s.commit()
        return p


async def _set(thread_id: uuid.UUID, stage: str, status: str, outer) -> None:
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread_id))).scalar_one_or_none()
        if p:
            p.stage, p.status = stage, status
            await s.commit()
    await outer.publish({"type": "project", "stage": stage, "status": status})


async def _latest_user_text(thread_id: uuid.UUID) -> str:
    async with SessionLocal() as s:
        rows = (await s.execute(select(Message).where(Message.thread_id == thread_id)
                                .order_by(Message.id))).scalars().all()
    for m in reversed(rows):
        if m.role == "user":
            txt = " ".join(b.get("text", "") for b in m.content if b.get("type") == "text").strip()
            if txt:
                return txt
    return ""


async def _run_role(outer, role, stage: str) -> None:
    """Run one LLM stage as its own agent loop, folding its usage into the outer run."""
    await outer.publish({"type": "stage_start", "stage": stage, "role": role.name, "label": role.label})
    r = agent.Runner(outer.run, outer.thread, outer.user, outer.domain, role=role)
    await r.loop()
    for k in outer.usage:
        outer.usage[k] += r.usage.get(k, 0)
    outer.model = r.model
    await outer.publish({"type": "stage_end", "stage": stage, "role": role.name})


async def _retrieve(outer) -> None:
    """Programmatic evidence retrieval (stage ②): fusion literature search, injected for the Planner.

    Phase B uses the paper search (arXiv + OpenAlex); the vector knowledge base arrives in Phase C.
    """
    stage = "retrieve"
    await outer.publish({"type": "stage_start", "stage": stage, "role": "retrieval", "label": "檢索證據"})
    query = await _latest_user_text(outer.thread.id)
    parts: list[str] = []
    # 1) the thread's own knowledge base (uploaded docs) — highest priority
    if kb.enabled():
        try:
            ds = await kb.datasets_for_thread(outer.thread.id)
            hits = await kb.search(ds, query, top_k=5)
            if hits:
                parts.append("【你上傳的資料（知識庫）】\n" + json.dumps(hits, ensure_ascii=False, indent=1))
        except Exception as e:
            log.warning("kb retrieval failed: %s", e)
    # 2) literature search (arXiv + OpenAlex)
    try:
        res = await tools.run_tool(outer.ctx, "search_papers",
                                   {"step_note": "程式自動檢索文獻證據", "query": query[:300], "max_results": 6})
        parts.append("【文獻（arXiv／OpenAlex）】\n" + tools.text_of(res.content, 5000))
    except Exception as e:  # retrieval must never crash the pipeline; the Planner just gets less to cite
        log.warning("paper retrieval failed: %s", e)
        parts.append(f"（文獻檢索失敗：{e}）")
    body = "\n\n".join(parts) if parts else "（這次沒有檢索到可用的證據。）"
    text = (EVIDENCE_MARK + "\n【檢索證據 ②（程式自動檢索，供規劃階段引用；只列實際查到的來源，不要杜撰）】\n\n" + body)
    await agent._save_message(outer.thread.id, outer.run.id, "user", [{"type": "text", "text": text}])
    await outer.publish({"type": "stage_end", "stage": stage, "role": "retrieval"})


def _grade(verdict: dict | None) -> dict:
    """Compute the research grade from the Verifier's structured verdict (stage ⑨, programmatic)."""
    if not verdict or not verdict.get("checks"):
        return {"level": "未定", "passed": 0, "total": 0, "summary": "沒有可用的結構化驗證結果（驗證者未記錄）。"}
    checks = verdict["checks"]
    total = len(checks)
    passed = sum(1 for c in checks if c.get("passed"))
    overall = bool(verdict.get("overall_passed"))
    if overall and passed == total:
        level = "通過"
    elif passed >= max(1, round(total * 0.6)):
        level = "部分通過"
    else:
        level = "未通過"
    return {"level": level, "passed": passed, "total": total, "summary": verdict.get("summary", "")}


async def _verify(outer) -> None:
    """Stage ⑥ (independent verification) + ⑨ (programmatic grade): run the Verifier, then grade."""
    vf = sandbox.workspace_dir(str(outer.thread.id)) / ".pipeline" / "verification.json"
    try:
        vf.unlink()  # drop any stale verdict so the grade reflects this run only
    except FileNotFoundError:
        pass
    # the turn must end with a user message before the next LLM role runs (Bedrock has no prefill)
    await agent._save_message(outer.thread.id, outer.run.id, "user", [{"type": "text", "text": _note("verify") +
        "\n（請以獨立驗證者的身分，重跑並查核上述研究結果；完成後用 record_verification 記錄結構化結論。）"}])
    await _run_role(outer, roles.VERIFIER, "verify")
    verdict = None
    try:
        verdict = json.loads(vf.read_text())
    except Exception as e:
        log.warning("no verification verdict: %s", e)
    grade = _grade(verdict)
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == outer.thread.id))).scalar_one_or_none()
        if p:
            p.card = {**(p.card or {}), "verification": verdict, "grade": grade}
            await s.commit()
    await outer.publish({"type": "grade", **grade})


async def _record_run_stage(run_id: uuid.UUID, stage: str) -> None:
    async with SessionLocal() as s:
        r = await s.get(Run, run_id)
        if r:
            r.stage = stage
            await s.commit()


async def advance(run: Run, thread, user, domain, outer) -> str:
    """Drive the FSM forward from the project's current stage until a gate or terminal state."""
    project = await _get_or_create(thread)
    stage = project.stage

    while True:
        if stage == "clarify":
            await _run_role(outer, roles.CLARIFIER, stage)
            stage = "retrieve"
            await _set(thread.id, stage, "running", outer)
        elif stage == "retrieve":
            await _retrieve(outer)
            stage = "plan"
            await _set(thread.id, stage, "running", outer)
        elif stage == "plan":
            await _run_role(outer, roles.PLANNER, stage)
            stage = "approve_plan"
            await _set(thread.id, stage, "awaiting_plan_approval", outer)
            await outer.publish({"type": "awaiting_approval", "gate": "plan"})
            break
        elif stage == "research":
            await _run_role(outer, roles.RESEARCHER, stage)
            stage = "verify"
            await _set(thread.id, stage, "running", outer)
        elif stage == "verify":
            await _verify(outer)          # stage ⑥ (verify) + ⑨ (programmatic grade)
            stage = "report"
            await _set(thread.id, stage, "awaiting_acceptance", outer)
            await outer.publish({"type": "awaiting_approval", "gate": "accept"})
            break
        else:
            # approve_plan / report gates, or an unknown stage: nothing to run in this pass
            break

    await _record_run_stage(run.id, stage)
    return "completed"


# ---------------------------------------------------------------- approval transitions (called by the API)

async def gate_status(thread_id: uuid.UUID) -> Project | None:
    async with SessionLocal() as s:
        return (await s.execute(select(Project).where(Project.thread_id == thread_id))).scalar_one_or_none()


async def _append_user(thread_id: uuid.UUID, run_id: uuid.UUID, text: str) -> None:
    await agent._save_message(thread_id, run_id, "user", [{"type": "text", "text": text}])


async def approve(thread) -> dict:
    """Advance through the current human gate. Plan gate → research; acceptance gate → completed."""
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none()
        if p is None:
            return {"ok": False, "detail": "這個對話不是研究專案"}
        if p.status == "awaiting_plan_approval":
            run = Run(thread_id=thread.id, status="queued", model="", stage="research")
            s.add(run)
            await s.flush()
            await _append_user(thread.id, run.id,
                               _note("approved_plan") + "\n（使用者已核准計畫，請嚴格依計畫開始執行研究。）")
            p.stage, p.status = "research", "running"
            await s.commit()
            await events.enqueue_run(str(run.id))
            return {"ok": True, "stage": "research", "status": "running", "run_id": str(run.id)}
        if p.status == "awaiting_acceptance":
            p.stage, p.status = "report", "completed"
            await s.commit()
            return {"ok": True, "stage": "report", "status": "completed"}
        return {"ok": False, "detail": "目前沒有待核准的關卡"}


async def reject(thread, feedback: str) -> dict:
    """Send the current gate back. Plan gate → re-clarify; acceptance gate → redo research."""
    fb = (feedback or "").strip()
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none()
        if p is None:
            return {"ok": False, "detail": "這個對話不是研究專案"}
        if p.status == "awaiting_plan_approval":
            run = Run(thread_id=thread.id, status="queued", model="", stage="clarify")
            s.add(run)
            await s.flush()
            await _append_user(thread.id, run.id, _note("reject_plan") +
                               f"\n（使用者退回計畫，請依意見重新釐清與規劃。意見：{fb or '未提供，請自行檢討計畫的弱點'}）")
            p.stage, p.status = "clarify", "running"
            await s.commit()
            await events.enqueue_run(str(run.id))
            return {"ok": True, "stage": "clarify", "status": "running", "run_id": str(run.id)}
        if p.status == "awaiting_acceptance":
            run = Run(thread_id=thread.id, status="queued", model="", stage="research")
            s.add(run)
            await s.flush()
            await _append_user(thread.id, run.id, _note("reject_accept") +
                               f"\n（使用者不接受結果，請依意見修正後重做研究。意見：{fb or '未提供，請自行檢討結果的弱點'}）")
            p.stage, p.status = "research", "running"
            await s.commit()
            await events.enqueue_run(str(run.id))
            return {"ok": True, "stage": "research", "status": "running", "run_id": str(run.id)}
        return {"ok": False, "detail": "目前沒有待退回的關卡"}


def project_out(p: Project | None) -> dict | None:
    if p is None:
        return None
    return {"stage": p.stage, "status": p.status, "grade": (p.card or {}).get("grade"),
            "stages": [{"name": n, "label": l} for n, l in STAGE_LABELS]}
