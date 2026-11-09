"""Tool registry: definitions sent to the model + async handlers run by the worker."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import jsonschema


@dataclass
class ToolContext:
    thread_id: str
    run_id: str
    user_email: str
    publish: Callable[[dict], Awaitable[None]]
    # id of the tool call currently running — set by the agent loop before each call so a
    # long-running tool can publish progress bound to its own step (tools run one at a time)
    tool_use_id: str | None = None
    # the active research domain (plasma/general); forward-looking, used by per-domain routing
    domain: Any = None


@dataclass
class ToolResult:
    content: str | list[dict]
    is_error: bool = False
    # short human-readable preview for the UI (the model gets `content`)
    preview: str | None = None
    # extra data for the UI (e.g. attachment list, image paths)
    ui: dict = field(default_factory=dict)


Handler = Callable[[ToolContext, dict], Awaitable[ToolResult]]


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict
    handler: Handler

    def definition(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
            "eager_input_streaming": True,
        }


REGISTRY: dict[str, Tool] = {}


STEP_NOTE = {
    "step_note": {
        "type": "string",
        "description": "用繁體中文一句話說明這一步在做什麼、為什麼（動詞開頭、具體），"
                       "這會成為使用者看到的步驟標題，例如「用 MPI 跑 SMILEI two-stream 模擬」"
                       "或「寫出靜電模型的 COMSOL Java」。",
    },
}


def tool(name: str, description: str, properties: dict, required: list[str] | None = None):
    # step_note goes first and is required, so the model always emits it early (streamed to the UI as the step title)
    schema = {"type": "object", "properties": {**STEP_NOTE, **properties},
              "required": ["step_note", *(required or [])], "additionalProperties": False}

    def deco(fn: Handler) -> Handler:
        REGISTRY[name] = Tool(name, description.strip(), schema, fn)
        return fn
    return deco


def definitions(allow: set[str] | None = None) -> list[dict]:
    # deterministic order keeps the prompt-cache prefix stable; `allow` restricts the set
    # of tools a domain exposes (None = every registered tool)
    names = sorted(REGISTRY if allow is None else (n for n in REGISTRY if n in allow))
    return [REGISTRY[n].definition() for n in names]


async def run_tool(ctx: ToolContext, name: str, args: Any) -> ToolResult:
    t = REGISTRY.get(name)
    if t is None:
        return ToolResult(f"未知的工具：{name}", is_error=True)
    if not isinstance(args, dict):
        return ToolResult(json.dumps({"INVALID_JSON": str(args)[:2000]}, ensure_ascii=False), is_error=True)
    try:
        jsonschema.validate(args, t.input_schema)
    except jsonschema.ValidationError as e:
        return ToolResult(f"參數不符合格式：{e.message}", is_error=True)
    try:
        return await t.handler(ctx, args)
    except Exception as e:  # tool failures go back to the model, never crash the run
        return ToolResult(f"工具執行失敗：{type(e).__name__}: {e}", is_error=True)


def text_of(content: str | list[dict], limit: int = 1500) -> str:
    if isinstance(content, str):
        s = content
    else:
        s = "\n".join(b.get("text", "") for b in content if b.get("type") == "text")
    return s if len(s) <= limit else s[:limit] + " …"
