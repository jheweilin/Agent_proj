"""The agent loop: Claude on Bedrock + tools, one run per user message.

History is append-only: every assistant message is stored exactly as returned
(thinking blocks included) and replayed unchanged, which the current Claude models
require for their thinking blocks to stay valid.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone

import anthropic
from sqlalchemy import select

from . import domains, events, tools
from .config import settings
from .db import Message, Run, SessionLocal, Thread, User, utcnow

log = logging.getLogger("plasma_agent.agent")

_client: anthropic.AsyncAnthropicBedrock | None = None


def client() -> anthropic.AsyncAnthropicBedrock:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropicBedrock(aws_region=settings.aws_region, max_retries=4,
                                                 timeout=anthropic.Timeout(900.0, connect=20.0))
    return _client


def system_prompt(domain: domains.Domain, role=None) -> list[dict]:
    base = (settings.prompts_dir / domain.prompt_file).read_text()
    blocks = [{"type": "text", "text": base}]
    if role is not None:  # pipeline stage overlay (Clarifier/Planner/Researcher)
        blocks.append({"type": "text", "text": role.overlay})
    today = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")
    blocks.append({"type": "text", "text": f"今天日期（台灣時間）：{today}"})
    return blocks


BINDING_BETA = "thinking-binding-controls-2026-08-01"


def _without_thinking(messages: list[dict]) -> list[dict]:
    """Copy of the history without thinking blocks (the stored history is never edited)."""
    out = []
    for m in messages:
        if m["role"] == "assistant":
            blocks = [b for b in m["content"] if b.get("type") not in ("thinking", "redacted_thinking")]
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": "（略）"}]})
        else:
            out.append(m)
    return out


def _dump_blocks(content) -> list[dict]:
    return [b.model_dump(mode="json", exclude_none=True) for b in content]


def _block_chars(b: dict) -> int:
    t = b.get("type")
    if t == "thinking":
        return len(b.get("thinking", "") or "")
    if t == "text":
        return len(b.get("text", "") or "")
    if t == "tool_use":
        return len(json.dumps(b.get("input", {}), ensure_ascii=False))
    if t == "image" or (t == "tool_result" and isinstance(b.get("content"), list)
                        and any(x.get("type") == "image" for x in b["content"] if isinstance(x, dict))):
        return 2000  # a resized image is roughly this many tokens; count it so it can be trimmed
    if t == "tool_result":
        c = b.get("content")
        return len(c) if isinstance(c, str) else sum(len(x.get("text", "")) for x in c if isinstance(x, dict))
    return 0


def _fit_context(messages: list[dict]) -> list[dict]:
    """Keep the request under the context budget by trimming older TOOL RESULTS only.

    Tool results are user-role blocks with no signatures, so shortening them is safe — unlike
    thinking blocks (bound to the prompt) or assistant text, which we never touch. The last few
    turns are kept verbatim; earlier bulky tool outputs/images are collapsed to a short note.
    """
    budget = settings.max_context_chars
    total = sum(_block_chars(b) for m in messages for b in m["content"])
    if total <= budget:
        return messages
    out = list(messages)
    protect = set(range(max(0, len(out) - 6), len(out)))  # keep the most recent 6 messages intact
    cap = 800
    for i in range(len(out)):
        if total <= budget or i in protect:
            continue
        m = out[i]
        new_blocks, changed = [], False
        for b in m["content"]:
            if b.get("type") == "tool_result":
                before = _block_chars(b)
                c = b.get("content")
                s = c if isinstance(c, str) else "\n".join(
                    x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
                if before > cap:
                    nb = dict(b)
                    nb["content"] = (s[:cap] + " …[較早步驟的輸出已省略以節省長度]") if s else "[較早步驟的輸出已省略]"
                    nb.pop("is_error", None)
                    new_blocks.append(nb)
                    total -= before - len(nb["content"])
                    changed = True
                    continue
            new_blocks.append(b)
        if changed:
            nm = dict(m)
            nm["content"] = new_blocks
            out[i] = nm
    return out


def _scrub_nul(obj):
    """Strip NUL bytes (\\u0000) from any string in the content — PostgreSQL text/JSONB cannot store
    them (asyncpg UntranslatableCharacterError), and they slip in when a tool reads binary data
    (e.g. an STL/.mph) into a result. Valid base64 thinking signatures never contain NUL, so this is
    a no-op for them."""
    if isinstance(obj, str):
        return obj.replace("\x00", "") if "\x00" in obj else obj
    if isinstance(obj, list):
        return [_scrub_nul(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _scrub_nul(v) for k, v in obj.items()}
    return obj


async def _save_message(thread_id: uuid.UUID, run_id: uuid.UUID, role: str, content: list[dict]) -> None:
    content = _scrub_nul(content)
    async with SessionLocal() as s:
        s.add(Message(thread_id=thread_id, run_id=run_id, role=role, content=content))
        t = await s.get(Thread, thread_id)
        if t:
            t.updated_at = utcnow()
        await s.commit()


async def _load_history(thread_id: uuid.UUID) -> list[dict]:
    async with SessionLocal() as s:
        rows = (await s.execute(select(Message).where(Message.thread_id == thread_id)
                                .order_by(Message.id))).scalars().all()
    return [{"role": m.role, "content": m.content} for m in rows]


async def repair_dangling(thread_id: uuid.UUID, run_id: uuid.UUID) -> None:
    """A run that crashed between a tool call and its result leaves a tool_use with no
    tool_result, which the API rejects next turn. Append (never edit) the missing results."""
    messages = await _load_history(thread_id)
    if not messages or messages[-1]["role"] != "assistant":
        return
    pending = [b["id"] for b in messages[-1]["content"] if b.get("type") == "tool_use"]
    if not pending:
        return
    results = [{"type": "tool_result", "tool_use_id": tid, "is_error": True,
                "content": "這個工具呼叫因執行中斷而沒有結果。"} for tid in pending]
    await _save_message(thread_id, run_id, "user", results)


class StopRequested(Exception):
    pass


def thread_runtime(thread: Thread, key: str) -> tuple[str, str, int]:
    """Resolve (model, effort, max_iters) for one agent of a thread from its per-thread config.

    `key` is "chat" (plain chat) or a pipeline role name. Any missing/invalid value falls back to
    the settings default. effort/max_iterations are thread-global (shared by all stages)."""
    cfg = getattr(thread, "config", None) or {}
    model = (cfg.get("models") or {}).get(key) or settings.model
    effort = cfg.get("effort") or settings.effort
    try:
        max_iters = int(cfg.get("max_iterations") or settings.max_iterations)
    except (TypeError, ValueError):
        max_iters = settings.max_iterations
    return model, effort, max_iters


class Runner:
    def __init__(self, run: Run, thread: Thread, user: User, domain: domains.Domain, role=None, init_messages=None,
                 model=None, effort=None, max_iters=None):
        self.run = run
        self.thread = thread
        self.user = user
        self.domain = domain
        self.role = role            # pipeline stage role (None = plain chat / Phase A behaviour)
        # start from a constructed context instead of the thread history (isolated subagent, e.g. Replicator)
        self.init_messages = init_messages
        self.run_id = str(run.id)
        self.thread_id = str(thread.id)
        self.model = model or settings.model          # per-agent model override (new-thread advanced options)
        self.effort = effort or settings.effort
        self.max_iters = max_iters or settings.max_iterations
        # tools this run exposes: the domain's set, further restricted by the role (None = all)
        all_names = set(tools.REGISTRY)
        dom = domain.allowed_tools(all_names)              # None (all registered) or a set
        domain_set = all_names if dom is None else dom
        self._tool_allow = role.allowed_tools(domain_set) if role is not None else dom
        self.binding_beta = True     # send thinking-binding-controls beta with drop_block
        self.strip_thinking = False  # fallback: remove earlier thinking blocks from the request copy
        self.usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
                      "cache_creation_input_tokens": 0, "requests": 0}
        self.ctx = tools.ToolContext(thread_id=self.thread_id, run_id=self.run_id,
                                     user_email=user.email, publish=self.publish, domain=domain)

    async def publish(self, ev: dict) -> None:
        await events.publish(self.run_id, ev)

    async def check_stop(self) -> None:
        if await events.stop_requested(self.run_id):
            raise StopRequested()

    def _add_usage(self, u) -> None:
        self.usage["requests"] += 1
        for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            self.usage[k] += getattr(u, k, 0) or 0

    async def _stream_once(self, messages: list[dict]):
        """One model request, streamed to the browser. Returns the final message."""
        thinking: dict = {"type": "adaptive", "display": "summarized"}
        if self.binding_beta:
            # Thinking blocks are bound to the system prompt + tools they were produced with. After a
            # deploy that changes either, old conversations would 400; drop_block degrades instead.
            thinking["block_binding"] = {"prefix_mismatch_behavior": "drop_block"}
        if self.strip_thinking:
            messages = _without_thinking(messages)
        messages = _fit_context(messages)  # trim older tool outputs if the history is too large
        tool_defs = tools.definitions(self._tool_allow)
        kwargs = dict(
            model=self.model,
            max_tokens=settings.max_tokens,
            system=system_prompt(self.domain, self.role),
            messages=messages,
            thinking=thinking,
            output_config={"effort": self.effort},
            cache_control={"type": "ephemeral"},
        )
        if tool_defs:  # Clarifier/Planner run with no tools; omit the key rather than sending []
            kwargs["tools"] = tool_defs
        if self.binding_beta:
            kwargs["betas"] = [BINDING_BETA]
        n = 0
        async with client().beta.messages.stream(**kwargs) as stream:
            async for ev in stream:
                n += 1
                if n % 40 == 0:
                    await self.check_stop()
                t = ev.type
                if t == "text":
                    await self.publish({"type": "text_delta", "text": ev.text})
                elif t == "thinking":
                    await self.publish({"type": "thinking_delta", "text": ev.thinking})
                elif t == "content_block_start":
                    b = ev.content_block
                    if b.type == "tool_use":
                        await self.publish({"type": "tool_start", "id": b.id, "name": b.name})
                    elif b.type in ("text", "thinking"):
                        await self.publish({"type": "block_start", "block": b.type})
            return await stream.get_final_message()

    async def _call_model(self, messages: list[dict]):
        json_retries = 0
        refusal_retried = False
        while True:
            await self.check_stop()
            try:
                msg = await self._stream_once(messages)
            except anthropic.BadRequestError as e:
                text = str(e)
                if self.binding_beta and ("block_binding" in text or BINDING_BETA in text
                                          or "anthropic_beta" in text or "Extra inputs" in text):
                    log.warning("thinking binding beta rejected, falling back to strip-and-retry: %s", text[:300])
                    self.binding_beta = False
                    self.strip_thinking = True
                    continue
                if "Invalid `signature`" in text and not self.strip_thinking:
                    log.warning("thinking block bound to a different conversation; retrying without old thinking")
                    self.strip_thinking = True
                    continue
                raise
            except ValueError:
                # tool input JSON the SDK could not parse at all: re-issue the turn (bounded)
                json_retries += 1
                if json_retries > 2:
                    raise
                await self.publish({"type": "status", "text": "模型輸出格式異常，重新產生…"})
                continue
            self._add_usage(msg.usage)
            if msg.stop_reason == "refusal" and not refusal_retried and settings.fallback_model \
                    and self.model != settings.fallback_model:
                refusal_retried = True
                self.model = settings.fallback_model  # sticky for the rest of this run
                await self.publish({"type": "status", "text": f"主模型拒絕這個請求，改用 {self.model} 重試…"})
                await self.publish({"type": "discard_partial"})
                continue
            return msg

    async def loop(self) -> str:
        messages = list(self.init_messages) if self.init_messages is not None else await _load_history(self.thread.id)
        truncations = 0
        for i in range(self.max_iters):
            await self.check_stop()
            await self.publish({"type": "iteration", "n": i + 1, "max": self.max_iters,
                                "usage": self.usage, "model": self.model})
            msg = await self._call_model(messages)
            content = _dump_blocks(msg.content)

            if msg.stop_reason == "refusal":
                await self.publish({"type": "discard_partial"})
                note = [{"type": "text", "text": "（模型拒絕回答這個請求。請換個方式描述問題，或補充研究目的與背景。）"}]
                await _save_message(self.thread.id, self.run.id, "assistant", note)
                await self.publish({"type": "assistant_done"})
                return "completed"

            messages.append({"role": "assistant", "content": content})
            await _save_message(self.thread.id, self.run.id, "assistant", content)
            await self.publish({"type": "assistant_done", "usage": self.usage})

            tool_uses = [b for b in msg.content if b.type == "tool_use"]

            if msg.stop_reason == "max_tokens":
                truncations += 1
                if truncations > 3:
                    return "completed"
                if tool_uses:  # truncated tool input: never execute it
                    results = [{"type": "tool_result", "tool_use_id": b.id, "is_error": True,
                                "content": "輸出長度達上限，這個工具呼叫的參數被截斷，沒有執行。請把內容拆小（例如分段寫檔）後重試。"}
                               for b in tool_uses]
                else:
                    results = [{"type": "text", "text": "（輸出達長度上限，請從中斷處繼續。）"}]
                messages.append({"role": "user", "content": results})
                await _save_message(self.thread.id, self.run.id, "user", results)
                continue

            if msg.stop_reason == "pause_turn":
                continue

            if msg.stop_reason != "tool_use" or not tool_uses:
                return "completed"

            results = await self._run_tools(tool_uses)
            messages.append({"role": "user", "content": results})
            await _save_message(self.thread.id, self.run.id, "user", results)

        await self.publish({"type": "status", "text": f"已達單次執行上限 {self.max_iters} 輪，暫停。輸入「繼續」可接著做。"})
        return "completed"

    async def _run_tools(self, tool_uses) -> list[dict]:
        async def one(b):
            t0 = time.time()
            self.ctx.tool_use_id = b.id  # so a long tool can publish progress bound to this step
            res = await tools.run_tool(self.ctx, b.name, b.input)
            await self.publish({
                "type": "tool_result", "id": b.id, "name": b.name, "is_error": res.is_error,
                "preview": res.preview if res.preview is not None else tools.text_of(res.content),
                "output": tools.text_of(res.content, 20000),
                "ui": res.ui, "seconds": round(time.time() - t0, 1),
            })
            block = {"type": "tool_result", "tool_use_id": b.id, "content": res.content}
            if res.is_error:
                block["is_error"] = True
            return block

        for b in tool_uses:
            await self.publish({"type": "tool_input", "id": b.id, "name": b.name, "input": b.input})
        # Run in call order, one at a time: the model often emits dependent calls in one turn
        # (edit a file, then submit it; re-plot, then look at the plot), and running them
        # concurrently made later calls see stale files. All results still go back in ONE
        # user message, in call order.
        return [await one(b) for b in tool_uses]


async def make_title(thread_id: uuid.UUID, first_text: str) -> None:
    title = ""
    try:
        # room for thinking: with a small max_tokens the model can spend it all thinking
        resp = await client().messages.create(
            model=settings.title_model, max_tokens=2000, output_config={"effort": "low"},
            messages=[{"role": "user", "content":
                       "用繁體中文為以下研究對話取一個 6 到 16 字的標題，只輸出標題本身：\n\n" + first_text[:2000]}],
        )
        title = "".join(b.text for b in resp.content if b.type == "text").strip().strip("「」\"'# ").split("\n")[0][:60]
        if not title:
            log.warning("title model returned no text (stop_reason=%s)", resp.stop_reason)
    except Exception as e:  # never fail a run because of the title
        log.warning("title generation failed: %s", e)
    if not title:
        title = " ".join(first_text.split())[:20] or "新對話"
    async with SessionLocal() as s:
        t = await s.get(Thread, thread_id)
        if t and t.title == "新對話":
            t.title = title
            await s.commit()


async def classify_project(thread_id: uuid.UUID, first_text: str) -> None:
    """Flag a chat thread whose opener looks like a verifiable research task, so the UI can offer
    a one-click 轉成研究專案 (never auto-converts). Sets threads.suggest_project. Best-effort."""
    flag = False
    try:
        resp = await client().messages.create(
            model=settings.title_model, max_tokens=1500, output_config={"effort": "low"},
            messages=[{"role": "user", "content":
                       "判斷下面的使用者訊息屬於哪一類，只回答一個字：\n"
                       "Y＝需要實際動手做、並值得查核的研究任務（要跑模擬、建模、數值計算、推導、實驗或資料分析，"
                       "需要規劃與驗證結果）；\n"
                       "N＝一般問答、概念解釋、查詢、閒聊、或只要一段文字說明。\n\n訊息：\n" + first_text[:1500]}])
        up = "".join(b.text for b in resp.content if b.type == "text").strip().upper()
        flag = up.startswith("Y")
    except Exception as e:
        log.warning("project classification failed: %s", e)
        return
    if not flag:
        return   # leave suggest_project null so later turns keep being re-evaluated
    async with SessionLocal() as s:
        t = await s.get(Thread, thread_id)
        if t and not t.suggest_project and not t.promote_dismissed and t.mode == "chat":
            t.suggest_project = True
            await s.commit()


async def execute_run(run_id: str) -> None:
    async with SessionLocal() as s:
        run = await s.get(Run, uuid.UUID(run_id))
        if run is None or run.status not in ("queued",):
            return
        thread = await s.get(Thread, run.thread_id)
        user = await s.get(User, thread.user_id) if thread else None
        if thread is None or user is None:
            return
        domain = domains.get(getattr(thread, "domain", None))
        chat_model, chat_effort, chat_iters = thread_runtime(thread, "chat")
        run.status = "running"
        run.started_at = utcnow()
        run.model = chat_model
        await s.commit()

    r = events.get_redis()
    busy_key = f"pa:thread:{thread.id}:busy"
    await r.set(busy_key, run_id, ex=6 * 3600)
    # project mode drives per-role runners inside pipeline; this outer runner handles chat + shared ctx
    runner = Runner(run, thread, user, domain, model=chat_model, effort=chat_effort, max_iters=chat_iters)
    await runner.publish({"type": "run_start", "run_id": run_id, "model": chat_model,
                          "started_at": utcnow().isoformat()})

    title_task = classify_task = None
    hist = await _load_history(thread.id)
    if thread.title == "新對話":
        first = next((m for m in hist if m["role"] == "user"), None)
        if first:
            txt = " ".join(b.get("text", "") for b in first["content"] if b.get("type") == "text")
            title_task = asyncio.create_task(make_title(thread.id, txt))
    # chat mode: re-check the latest message every turn — suggest promoting whenever the conversation
    # turns into a research task (not just the opener). Stop once flagged or the user dismissed it.
    if (getattr(thread, "mode", "chat") == "chat" and not thread.suggest_project
            and not getattr(thread, "promote_dismissed", False)):
        last_user = next((m for m in reversed(hist) if m["role"] == "user"), None)
        if last_user:
            ltxt = " ".join(b.get("text", "") for b in last_user["content"] if b.get("type") == "text")
            if ltxt.strip():
                classify_task = asyncio.create_task(classify_project(thread.id, ltxt))

    status, error = "failed", None
    try:
        if getattr(thread, "mode", "chat") == "project":
            from . import pipeline  # local import avoids a circular import at module load
            status = await pipeline.advance(run, thread, user, domain, runner)
        else:
            status = await runner.loop()
    except StopRequested:
        status = "stopped"
        await runner.publish({"type": "status", "text": "已停止"})
    except anthropic.APIStatusError as e:
        error = f"模型服務錯誤 {e.status_code}：{getattr(e, 'message', str(e))[:800]}"
    except anthropic.APIConnectionError as e:
        error = f"連不上模型服務：{e}"
    except Exception as e:
        log.exception("run %s crashed", run_id)
        error = f"{type(e).__name__}: {e}"
    if error:
        await runner.publish({"type": "error", "message": error})
    if status != "completed":
        # stopped/crashed between a tool call and its result: close it so the next turn is valid
        try:
            await repair_dangling(thread.id, run.id)
        except Exception:
            log.exception("repair failed for run %s", run_id)

    if title_task:
        await asyncio.wait({title_task}, timeout=20)
    if classify_task:
        await asyncio.wait({classify_task}, timeout=20)

    async with SessionLocal() as s:
        db_run = await s.get(Run, uuid.UUID(run_id))
        db_run.status = status
        db_run.error = error
        db_run.model = runner.model
        db_run.usage = runner.usage
        db_run.finished_at = utcnow()
        await s.commit()
    await r.delete(busy_key)
    # a project run that stopped/crashed mid-stage leaves the project 'running' with no active run —
    # flip it to 'interrupted' so the UI can offer a resume instead of looking stuck
    if getattr(thread, "mode", "chat") == "project" and status in ("stopped", "failed"):
        from . import pipeline
        st = await pipeline.mark_interrupted(thread.id)
        if st is not None:
            await runner.publish({"type": "project", "stage": st, "status": "interrupted"})
    await runner.publish({"type": "run_end", "status": status, "usage": runner.usage})


def user_message_content(text: str, uploads: list[str], previous: dict | None) -> list[dict]:
    """Build a new user turn. If the previous assistant turn still has unanswered tool calls
    (worker crashed), answer them at the start of this turn so the history stays valid."""
    blocks: list[dict] = []
    if previous and previous["role"] == "assistant":
        for b in previous["content"]:
            if b.get("type") == "tool_use":
                blocks.append({"type": "tool_result", "tool_use_id": b["id"], "is_error": True,
                               "content": "這個工具呼叫因執行中斷而沒有結果。"})
    body = text.strip()
    if uploads:
        body += "\n\n[使用者上傳的檔案]\n" + "\n".join(f"- {p}" for p in uploads)
    blocks.append({"type": "text", "text": body})
    return blocks


__all__ = ["execute_run", "user_message_content", "json"]
