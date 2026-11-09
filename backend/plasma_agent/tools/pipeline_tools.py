"""Pipeline tools: structured outputs the FSM reads back (the Verifier's verdict → the grade)."""
from __future__ import annotations

import json

from .. import sandbox
from .base import ToolContext, ToolResult, tool


@tool(
    "record_verification",
    """記錄這次獨立驗證的結構化結果（驗證階段結束前一定要呼叫）。程式會據此計算等級，所以要誠實：
每一項檢查都要是你親自重跑或計算過的結論，不是照抄研究者的說法。""",
    {
        "checks": {"type": "array", "minItems": 1,
                   "items": {"type": "object", "additionalProperties": False,
                             "properties": {
                                 "name": {"type": "string", "description": "檢查項目，例如「重跑週期」「能量守恆」「對照解析解」"},
                                 "passed": {"type": "boolean"},
                                 "detail": {"type": "string", "description": "數值與依據，例如「相對誤差 1.7%，在容差內」"}},
                             "required": ["name", "passed", "detail"]}},
        "overall_passed": {"type": "boolean", "description": "整體是否通過（任何關鍵項目沒過就 false）"},
        "summary": {"type": "string", "description": "一兩句總結，含最關鍵的數字"},
    },
    ["checks", "overall_passed", "summary"],
)
async def record_verification(ctx: ToolContext, args: dict) -> ToolResult:
    d = sandbox.workspace_dir(ctx.thread_id) / ".pipeline"
    d.mkdir(parents=True, exist_ok=True)
    payload = {"checks": args["checks"], "overall_passed": bool(args["overall_passed"]),
               "summary": args.get("summary", "")}
    (d / "verification.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    n = len(args["checks"])
    p = sum(1 for c in args["checks"] if c.get("passed"))
    return ToolResult(f"已記錄驗證結果：{p}/{n} 項通過，整體{'通過' if payload['overall_passed'] else '未通過'}。",
                      preview=f"驗證 {p}/{n} 通過")
