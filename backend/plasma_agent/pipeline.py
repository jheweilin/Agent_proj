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

from . import agent, events, kb, labs, roles, sandbox, tools
from .db import Message, Project, Run, SessionLocal, Thread

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


async def _run_role(outer, role, stage: str, init_messages=None, block_external=False) -> None:
    """Run one LLM stage as its own agent loop, folding its usage into the outer run.

    `init_messages` runs the role from a constructed context instead of the thread history
    (used by the Replicator so it can't see the research results — true independence).
    `block_external` hard-removes external/licensed services (COMSOL) when the user didn't authorise them.
    """
    await outer.publish({"type": "stage_start", "stage": stage, "role": role.name, "label": role.label})
    model, effort, max_iters = agent.thread_runtime(outer.thread, role.name)
    r = agent.Runner(outer.run, outer.thread, outer.user, outer.domain, role=role, init_messages=init_messages,
                     model=model, effort=effort, max_iters=max_iters, block_external=block_external)
    await r.loop()
    for k in outer.usage:
        outer.usage[k] += r.usage.get(k, 0)
    outer.model = r.model
    await outer.publish({"type": "stage_end", "stage": stage, "role": role.name})


async def _latest_assistant_text(thread_id: uuid.UUID) -> str:
    async with SessionLocal() as s:
        rows = (await s.execute(select(Message).where(Message.thread_id == thread_id)
                                .order_by(Message.id))).scalars().all()
    for m in reversed(rows):
        if m.role == "assistant":
            txt = "\n".join(b.get("text", "") for b in m.content if b.get("type") == "text").strip()
            if txt:
                return txt
    return ""


async def _report_text(thread_id: uuid.UUID) -> str:
    """The pipeline's final report = latest assistant text from a staged (pipeline) run, so it isn't
    shadowed by post-completion follow-up chat turns."""
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(Message).join(Run, Run.id == Message.run_id)
            .where(Message.thread_id == thread_id, Message.role == "assistant", Run.stage.isnot(None))
            .order_by(Message.id))).scalars().all()
    for m in reversed(rows):
        txt = "\n".join(b.get("text", "") for b in m.content if b.get("type") == "text").strip()
        if txt:
            return txt
    return ""


async def _followup_texts(thread_id: uuid.UUID, max_chars: int = 4000) -> str:
    """Assistant replies from post-completion follow-up chat turns (runs with no pipeline stage), so a
    nomination can also capture work done after the project finished (extra plots, analyses, …)."""
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(Message).join(Run, Run.id == Message.run_id)
            .where(Message.thread_id == thread_id, Message.role == "assistant", Run.stage.is_(None))
            .order_by(Message.id))).scalars().all()
    out = []
    for m in rows:
        txt = "\n".join(b.get("text", "") for b in m.content if b.get("type") == "text").strip()
        if txt:
            out.append(txt)
    return "\n\n".join(out)[:max_chars]


def _read_json(thread_id, name: str):
    try:
        return json.loads((sandbox.workspace_dir(str(thread_id)) / ".pipeline" / name).read_text())
    except Exception:
        return None


async def _set_card(thread_id, **fields) -> None:
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread_id))).scalar_one_or_none()
        if p:
            p.card = {**(p.card or {}), **fields}
            await s.commit()


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
            scope = await kb.visible_scope(outer.thread.id)
            hits = await kb.search(scope, query, top_k=5)
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
    # cross-lab collaboration: surface public labs whose specialty matches this research topic
    try:
        idea = await _first_user_text(outer.thread.id)
        matches = await labs.match_labs(idea, await labs.user_lab_ids(outer.user.id))
        if matches:
            await _set_card(outer.thread.id, cross_lab=matches)
            names = "、".join(m["name"] for m in matches)
            await outer.publish({"type": "status", "text": f"找到相關實驗室：{names}"})
    except Exception as e:
        log.warning("cross-lab match failed: %s", e)
    await outer.publish({"type": "stage_end", "stage": stage, "role": "retrieval"})


def _grade(verdict: dict | None, replication: dict | None, review: dict | None) -> dict:
    """Stage ⑨ (programmatic): fold verification, independent replication and review into a grade."""
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
    extra = []
    if replication is not None:
        extra.append("第二實作已獨立重做")
    if review is not None:
        if not review.get("consistent", True) and level == "通過":
            level = "部分通過"
        extra.append(f"審查{'一致' if review.get('consistent') else '指出不一致'}"
                     + (f"、{len(review.get('concerns') or [])} 項疑慮" if review.get("concerns") else ""))
    summary = verdict.get("summary", "")
    if extra:
        summary = (summary + "｜" + "；".join(extra)) if summary else "；".join(extra)
    return {"level": level, "passed": passed, "total": total, "summary": summary}


async def _verify(outer, block_external=False) -> None:
    """Stage ⑥: independent verification (same sandbox, reruns & checks → structured verdict)."""
    try:
        (sandbox.workspace_dir(str(outer.thread.id)) / ".pipeline" / "verification.json").unlink()
    except FileNotFoundError:
        pass
    # the turn must end with a user message before the next LLM role runs (Bedrock has no prefill)
    await agent._save_message(outer.thread.id, outer.run.id, "user", [{"type": "text", "text": _note("verify") +
        "\n（請以獨立驗證者的身分，重跑並查核上述研究結果；完成後用 record_verification 記錄結構化結論。）"}])
    await _run_role(outer, roles.VERIFIER, "verify", block_external=block_external)
    await _set_card(outer.thread.id, verification=_read_json(outer.thread.id, "verification.json"))


async def _replicate(outer) -> None:
    """Stage ⑦: independent replication. The Replicator sees only the plan (isolated context)."""
    try:
        (sandbox.workspace_dir(str(outer.thread.id)) / ".pipeline" / "replication.json").unlink()
    except FileNotFoundError:
        pass
    plan = (await _get_card(outer.thread.id)).get("plan") or await _latest_assistant_text(outer.thread.id)
    msg = [{"type": "text", "text": _note("replicate") +
            "\n（以下是已核准的研究計畫。請完全獨立、只在 /workspace/.replica 裡，依計畫重做一次並用 "
            "record_replication 記錄關鍵數值；不要參考他人結果、不要上網或查知識庫。）\n\n【計畫】\n" + plan}]
    await agent._save_message(outer.thread.id, outer.run.id, "user", msg)
    # run from a constructed context (just the plan) so the Replicator can't see the research
    await _run_role(outer, roles.REPLICATOR, "replicate", init_messages=[{"role": "user", "content": msg}])
    await _set_card(outer.thread.id, replication=_read_json(outer.thread.id, "replication.json"))


async def _review(outer) -> None:
    """Stage ⑧: read-only review of research + verification + replication for consistency."""
    try:
        (sandbox.workspace_dir(str(outer.thread.id)) / ".pipeline" / "review.json").unlink()
    except FileNotFoundError:
        pass
    await agent._save_message(outer.thread.id, outer.run.id, "user", [{"type": "text", "text": _note("review") +
        "\n（請審查上述研究、驗證與第二實作的物理與推論，以及三方結果是否一致；用 record_review 記錄疑慮與是否一致。）"}])
    await _run_role(outer, roles.REVIEWER, "review")
    await _set_card(outer.thread.id, review=_read_json(outer.thread.id, "review.json"))


async def _finalize_grade(outer) -> None:
    card = await _get_card(outer.thread.id)
    grade = _grade(card.get("verification"), card.get("replication"), card.get("review"))
    await _set_card(outer.thread.id, grade=grade)
    await outer.publish({"type": "grade", **grade})


async def _get_card(thread_id) -> dict:
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread_id))).scalar_one_or_none()
        return dict(p.card or {}) if p else {}


MAX_VERIFY_RETRIES = 1


async def _should_retry_research(outer) -> bool:
    """Retry edge ⑥→⑤: if verification failed, loop back to research with the findings (bounded)."""
    verdict = _read_json(outer.thread.id, "verification.json")
    if not verdict or verdict.get("overall_passed"):
        return False
    retries = int((await _get_card(outer.thread.id)).get("verify_retries", 0))
    if retries >= MAX_VERIFY_RETRIES:
        return False   # give up auto-retrying; let the human decide at the acceptance gate
    await _set_card(outer.thread.id, verify_retries=retries + 1)
    fails = [c for c in verdict.get("checks", []) if not c.get("passed")]
    detail = "\n".join(f"- {c.get('name')}：{c.get('detail')}" for c in fails) or verdict.get("summary", "")
    await agent._save_message(outer.thread.id, outer.run.id, "user", [{"type": "text", "text": _note("verify_fail") +
        "\n（獨立驗證沒通過，請針對下列問題修正後重新交件；修正後會再自動驗證一次。）\n\n" + detail}])
    return True


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
    comsol_ok = bool((project.card or {}).get("comsol_authorized"))  # external services opt-in from the plan gate

    while True:
        if stage == "clarify":
            try:   # drop stale questions from a previous clarify pass
                (sandbox.workspace_dir(str(thread.id)) / ".pipeline" / "questions.json").unlink()
            except FileNotFoundError:
                pass
            await _run_role(outer, roles.CLARIFIER, stage)
            q = (_read_json(thread.id, "questions.json") or {}).get("questions") or []
            if q:   # clarifier needs the user: pause at the clarification gate
                await _set_card(thread.id, questions=q)
                await _set(thread.id, "clarify", "awaiting_clarification", outer)
                await outer.publish({"type": "awaiting_approval", "gate": "clarify"})
                break
            await _set_card(thread.id, questions=[])
            stage = "retrieve"
            await _set(thread.id, stage, "running", outer)
        elif stage == "retrieve":
            await _retrieve(outer)
            stage = "plan"
            await _set(thread.id, stage, "running", outer)
        elif stage == "plan":
            try:   # drop any stale checklist from a previous planning pass
                (sandbox.workspace_dir(str(thread.id)) / ".pipeline" / "plan.json").unlink()
            except FileNotFoundError:
                pass
            await _run_role(outer, roles.PLANNER, stage)
            pj = _read_json(thread.id, "plan.json") or {}
            steps = pj.get("steps") or []
            tools = pj.get("tools") or []
            # capture plan text (for the Replicator) + structured steps + candidate tools (approval checklist)
            await _set_card(thread.id, plan=await _latest_assistant_text(thread.id), plan_steps=steps, plan_tools=tools)
            stage = "approve_plan"
            await _set(thread.id, stage, "awaiting_plan_approval", outer)
            await outer.publish({"type": "awaiting_approval", "gate": "plan"})
            break
        elif stage == "research":
            await _run_role(outer, roles.RESEARCHER, stage, block_external=not comsol_ok)
            stage = "verify"
            await _set(thread.id, stage, "running", outer)
        elif stage == "verify":
            await _verify(outer, block_external=not comsol_ok)          # ⑥ independent verification
            if await _should_retry_research(outer):   # ⑥→⑤: failed verification loops back to research
                stage = "research"
            else:
                stage = "replicate"
            await _set(thread.id, stage, "running", outer)
        elif stage == "replicate":
            await _replicate(outer)       # ⑦ independent replication (isolated context)
            stage = "review"
            await _set(thread.id, stage, "running", outer)
        elif stage == "review":
            await _review(outer)          # ⑧ read-only review
            await _finalize_grade(outer)  # ⑨ programmatic grade from all three
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


def _approved_plan_note(steps) -> str:
    """Build the approved-plan user message. If the user kept/edited a step checklist, inject the
    final enabled steps so the Researcher follows exactly what was confirmed; else a generic note."""
    enabled = [st for st in (steps or []) if st.get("enabled", True) and (st.get("title") or "").strip()]
    if not enabled:
        return _note("approved_plan") + "\n（使用者已核准計畫，請嚴格依計畫開始執行研究。）"
    lines = [_note("approved_plan"),
             "（使用者已核准計畫，並確認下列執行步驟。請**嚴格依這些步驟**執行研究，不要自行增刪或改順序；"
             "先完成前一步並確認無誤再進行下一步。計畫其餘的方法與參數仍以上文為準。）", "",
             "已核准的執行步驟："]
    for i, st in enumerate(enabled, 1):
        line = f"{i}. {(st.get('title') or '').strip()}"
        if (st.get("detail") or "").strip():
            line += f" — {st['detail'].strip()}"
        if (st.get("source") or "").strip():
            line += f"（來源：{st['source'].strip()}）"
        lines.append(line)
    return "\n".join(lines)


def _external_note(comsol_ok: bool) -> str:
    """Tell the Researcher/Verifier whether the user authorised the external COMSOL service. Internal
    sandbox libraries need no opt-in and are left unconstrained."""
    if comsol_ok:
        return ("\n\n使用者已**授權使用 COMSOL** 共用服務（可送有限元求解）。其餘沙盒函式庫自由使用。")
    return ("\n\n使用者**未授權 COMSOL**：請勿使用 COMSOL 共用服務（相關工具已停用）；需要數值模擬請改用"
            "開源工具（FEniCS／scikit-fem／自寫 FDM-FVM 等）。其餘沙盒函式庫自由使用。")


async def approve(thread, plan_steps=None, comsol_ok=False) -> dict:
    """Advance through the current human gate. Plan gate → research; acceptance gate → completed.

    `plan_steps` = the user's edited/checked step checklist (None = not edited, use the Planner's).
    `comsol_ok` = whether the user authorised the external COMSOL service at the plan gate (default off:
    internal libraries never need opt-in, only external/licensed services do)."""
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none()
        if p is None:
            return {"ok": False, "detail": "這個對話不是研究專案"}
        if p.status == "awaiting_plan_approval":
            steps = plan_steps if plan_steps is not None else (p.card or {}).get("plan_steps") or []
            run = Run(thread_id=thread.id, status="queued", model="", stage="research")
            s.add(run)
            await s.flush()
            await _append_user(thread.id, run.id, _approved_plan_note(steps) + _external_note(comsol_ok))
            p.stage, p.status = "research", "running"
            p.card = {**(p.card or {}), "verify_retries": 0, "plan_steps": steps, "comsol_authorized": comsol_ok}
            await s.commit()
            await events.enqueue_run(str(run.id))
            return {"ok": True, "stage": "research", "status": "running", "run_id": str(run.id)}
        if p.status == "awaiting_acceptance":
            p.stage, p.status = "report", "completed"
            await s.commit()
            return {"ok": True, "stage": "report", "status": "completed"}
        return {"ok": False, "detail": "目前沒有待核准的關卡"}


async def promote(thread) -> dict:
    """Turn an existing chat thread into a research project: flip mode, create the Project at the
    clarify stage, and enqueue a run that starts the pipeline using the existing conversation as the
    research idea (a user note ensures the turn ends on a user message — Bedrock has no prefill)."""
    async with SessionLocal() as s:
        if (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none():
            return {"ok": False, "detail": "這個對話已經是研究專案"}
        t = await s.get(Thread, thread.id)
        t.mode, t.suggest_project = "project", False
        s.add(Project(thread_id=thread.id, domain=getattr(t, "domain", "plasma"), stage="clarify", status="running"))
        run = Run(thread_id=thread.id, status="queued", model="", stage="clarify")
        s.add(run)
        await s.flush()
        run_id = run.id
        await s.commit()   # commit first to release the threads-row lock; inserting the note message
        # (FK → threads) in a separate session would otherwise wait on this txn forever
    await _append_user(thread.id, run_id, _note("promote") +
        "\n（使用者把這個對話轉為研究專案。請把以上對話內容當作研究想法，從第一階段「釐清」開始。）")
    await events.enqueue_run(str(run_id))
    return {"ok": True, "stage": "clarify", "status": "running", "run_id": str(run_id)}


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
            p.card = {**(p.card or {}), "verify_retries": 0}   # fresh research cycle
            await s.commit()
            await events.enqueue_run(str(run.id))
            return {"ok": True, "stage": "research", "status": "running", "run_id": str(run.id)}
        return {"ok": False, "detail": "目前沒有待退回的關卡"}


def _clarify_answers_note(questions, answers: str) -> str:
    """The user's answers to the clarifier's questions, echoed with the questions for context."""
    lines = [_note("clarify_answer"),
             "（使用者回覆了釐清問題。請據此更新釐清結果；若資訊已足夠就**不要再呼叫 ask_user**，"
             "把這些答案併進「範圍與假設」直接完成釐清、進入規劃。）", ""]
    qs = [q.get("question", "") for q in (questions or []) if q.get("question")]
    if qs:
        lines.append("你先前問的問題：")
        lines += [f"{i}. {q}" for i, q in enumerate(qs, 1)]
        lines.append("")
    lines.append("使用者的回覆：")
    lines.append(answers.strip() or "（使用者未填具體內容，請用合理預設並在假設中註明。）")
    return "\n".join(lines)


async def mark_interrupted(thread_id: uuid.UUID) -> str | None:
    """A project run ended as stopped/failed mid-stage — flip the project out of 'running' so the UI
    stops looking like it's still working and can offer a resume. Returns the stage, or None if the
    project was at a gate / not running (nothing to mark)."""
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread_id))).scalar_one_or_none()
        if p and p.status == "running":
            p.status = "interrupted"
            await s.commit()
            return p.stage
    return None


async def resume(thread, note: str = "") -> dict:
    """Continue an interrupted project from where it stopped (re-enqueue a run at the current stage).

    An optional `note` is injected as a user message so the resumed stage follows the extra guidance."""
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none()
        if p is None:
            return {"ok": False, "detail": "這個對話不是研究專案"}
        if p.status != "interrupted":
            return {"ok": False, "detail": "目前沒有可續跑的中斷研究"}
        stage = p.stage
        run = Run(thread_id=thread.id, status="queued", model="", stage=stage)
        s.add(run)
        await s.flush()
        p.status = "running"
        rid = run.id
        await s.commit()
    if (note or "").strip():
        await _append_user(thread.id, rid, "（續跑補充指示）" + note.strip())
    await events.enqueue_run(str(rid))
    return {"ok": True, "stage": stage, "status": "running", "run_id": str(rid)}


async def handoff(thread, note: str) -> dict:
    """Hand an interrupted project off to free chat: run the user's instruction against the existing
    results/sandbox instead of finishing the pipeline. The project goes to 'handoff' (a terminal, chat
    state) so this and every later message is answered by the normal chat loop (see agent.execute_run)."""
    note = (note or "").strip()
    if not note:
        return {"ok": False, "detail": "請先輸入要 agent 用現有成果做的事"}
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none()
        if p is None:
            return {"ok": False, "detail": "這個對話不是研究專案"}
        if p.status != "interrupted":
            return {"ok": False, "detail": "目前沒有可接手的中斷研究"}
        run = Run(thread_id=thread.id, status="queued", model="")
        s.add(run)
        await s.flush()
        p.status = "handoff"   # leave the pipeline; further turns are free chat on the existing results
        rid = run.id
        await s.commit()
    await _append_user(thread.id, rid, note)
    await events.enqueue_run(str(rid))
    return {"ok": True, "status": "handoff", "run_id": str(rid)}


async def answer_clarification(thread, answers: str) -> dict:
    """Resume from the clarification gate: inject the user's answers and re-run the clarifier."""
    async with SessionLocal() as s:
        p = (await s.execute(select(Project).where(Project.thread_id == thread.id))).scalar_one_or_none()
        if p is None:
            return {"ok": False, "detail": "這個對話不是研究專案"}
        if p.status != "awaiting_clarification":
            return {"ok": False, "detail": "目前沒有待回覆的釐清問題"}
        questions = (p.card or {}).get("questions") or []
        run = Run(thread_id=thread.id, status="queued", model="", stage="clarify")
        s.add(run)
        await s.flush()
        await _append_user(thread.id, run.id, _clarify_answers_note(questions, answers or ""))
        p.stage, p.status = "clarify", "running"
        p.card = {**(p.card or {}), "questions": []}
        await s.commit()
        await events.enqueue_run(str(run.id))
        return {"ok": True, "stage": "clarify", "status": "running", "run_id": str(run.id)}


# ---------------------------------------------------------------- knowledge flywheel: nominate research → lab KB

async def _first_user_text(thread_id: uuid.UUID) -> str:
    async with SessionLocal() as s:
        rows = (await s.execute(select(Message).where(Message.thread_id == thread_id)
                                .order_by(Message.id))).scalars().all()
    for m in rows:
        if m.role == "user":
            txt = " ".join(b.get("text", "") for b in m.content
                           if b.get("type") == "text" and not b.get("text", "").startswith("[[pa:")).strip()
            if txt:
                return txt
    return ""


async def build_experience_doc(thread, card: dict) -> tuple[str, str]:
    """Distil a finished project into a structured '存法二' experience note (method + pitfalls +
    negative results + back-link), the unit that gets nominated into a lab KB. Returns (title, markdown)."""
    idea = await _first_user_text(thread.id)
    report = await _report_text(thread.id) or await _latest_assistant_text(thread.id)
    followup = await _followup_texts(thread.id)
    plan = (card.get("plan") or "").strip()
    grade = card.get("grade") or {}
    verification = card.get("verification") or {}
    review = card.get("review") or {}
    retries = int(card.get("verify_retries", 0))
    # the valuable tacit knowledge: what failed / had to be redone
    failed = [c for c in (verification.get("checks") or []) if not c.get("passed")]
    pitfalls = []
    if retries:
        pitfalls.append(f"驗證未過、研究退回重做 {retries} 次")
    pitfalls += [f"驗證項「{c.get('name')}」未過：{c.get('detail')}" for c in failed]
    pitfalls += [f"審查疑慮：{c}" for c in (review.get("concerns") or [])]
    ctx = {
        "原始問題／想法": idea[:2000],
        "研究計畫": plan[:4000],
        "最終報告": report[:6000],
        "等級": grade,
        "驗證摘要": verification.get("summary", ""),
        "踩坑與負面結果（請務必寫進文件）": pitfalls,
    }
    if followup.strip():
        ctx["完成後的延伸追問與成果（也要整理進筆記）"] = followup
    prompt = (
        "你要把一個已完成的研究專案，整理成一篇**給實驗室新成員看的經驗筆記**，之後會存進實驗室知識庫、"
        "讓學弟妹用聊天就能問到『學長當初怎麼做、在哪踩雷、怎麼解決的』。請用繁體中文、Markdown，"
        "**務必保留方法與踩坑／負面結果**（這才是最有價值的部分，不要只寫漂亮的成功結論）。"
        "若素材含『完成後的延伸追問與成果』，請把其中有價值的結果（例如額外產生的圖、補充分析）"
        "也整理進對應段落（方法／關鍵結果）。\n\n"
        "固定結構：\n"
        "# <研究題目>\n"
        "- **研究問題**：\n"
        "- **方法與設定**：用了哪些工具／關鍵參數／邊界條件\n"
        "- **過程與踩坑**：中間哪裡卡住、為何退回重做、最後怎麼解的（保留負面結果）\n"
        "- **關鍵結果**：\n"
        "- **結論**：\n"
        "- **限制與後續**：\n\n"
        "只輸出這篇筆記本身，第一行用 `# ` 開頭當標題。以下是這個專案的素材（JSON）：\n\n"
        + json.dumps(ctx, ensure_ascii=False, indent=1))
    model, _, _ = agent.thread_runtime(thread, "chat")
    resp = await agent.client().messages.create(
        model=model, max_tokens=4000, output_config={"effort": "low"},
        messages=[{"role": "user", "content": prompt}])
    md = "".join(b.text for b in resp.content if b.type == "text").strip()
    title = idea[:40] or "研究經驗"
    for line in md.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()[:80] or title
            break
    back = f"\n\n---\n*來源：本平台研究專案（thread `{thread.id}`）。想看完整過程可回原專案查閱。*"
    return title, (md + back if md else f"# {title}{back}")


async def mark_nomination(thread_id, lab_id, lab_name: str, status: str, **extra) -> None:
    """Record nomination state on project.card so the UI reflects it immediately (api sets
    'generating' before enqueueing; the worker updates to 'pending'/'error')."""
    await _set_card(thread_id, nomination={"lab_id": str(lab_id), "lab_name": lab_name, "status": status, **extra})


async def nominate_experience(thread_id, user_id, lab_id, lab_name: str = "", approved: bool = False) -> None:
    """Generate the experience note and ingest it into the lab KB. Members' nominations land as
    pending (awaiting owner review, 閘門①); the lab owner's own project is approved straight away
    (no self-review). Heavy (LLM + embedding), needs Bedrock creds — runs in the worker."""
    try:
        async with SessionLocal() as s:
            thread = await s.get(Thread, uuid.UUID(str(thread_id)))
        if thread is None:
            return
        card = await _get_card(thread.id)
        title, body = await build_experience_doc(thread, card)
        dsid = await kb.lab_dataset_id(lab_id, name=lab_name)
        source = f"研究經驗：{title}"
        status = "approved" if approved else "pending"
        res = await kb.ingest(dsid, source, body, origin="research", kind="experience", status=status,
                              source_thread_id=thread.id, submitted_by=uuid.UUID(str(user_id)))
        await mark_nomination(thread.id, lab_id, lab_name, status, source=source, doc_id=res.get("id"))
    except Exception as e:
        log.exception("nominate_experience failed: %s", e)
        await mark_nomination(thread_id, lab_id, lab_name, "error", detail=str(e)[:300])


def project_out(p: Project | None) -> dict | None:
    if p is None:
        return None
    return {"stage": p.stage, "status": p.status, "grade": (p.card or {}).get("grade"),
            "plan_steps": (p.card or {}).get("plan_steps") or [],
            "plan_tools": (p.card or {}).get("plan_tools") or [],
            "questions": (p.card or {}).get("questions") or [],
            "nomination": (p.card or {}).get("nomination"),
            "cross_lab": (p.card or {}).get("cross_lab") or [],
            "stages": [{"name": n, "label": l} for n, l in STAGE_LABELS]}
