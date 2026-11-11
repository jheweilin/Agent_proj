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


def _write(thread_id: str, name: str, payload: dict) -> None:
    d = sandbox.workspace_dir(thread_id) / ".pipeline"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2))


@tool(
    "record_plan",
    """把這份計畫的「執行步驟」與「會用到的工具／引擎」記成結構化清單，讓使用者在核准關卡逐項勾選與編輯（規劃階段結束前一定要呼叫）。
步驟要具體、可執行、有先後順序；數值方法或參數有依據的標來源，沒有的標「假設」。
`tools` 列出你判斷這個研究會用到的工具／模擬引擎（如 PlasmaPy、SciPy、SMILEI、COMSOL、matplotlib…），每個附一句為什麼，讓使用者勾選要用哪些。""",
    {
        "steps": {"type": "array", "minItems": 1,
                  "items": {"type": "object", "additionalProperties": False,
                            "properties": {
                                "title": {"type": "string", "description": "這一步要做什麼，一句話"},
                                "detail": {"type": "string", "description": "做法與要檢查什麼；沒有就空字串"},
                                "source": {"type": "string", "description": "依據的文獻標題/DOI；若是自訂假設就填「假設」，沒有就空字串"}},
                            "required": ["title", "detail", "source"]}},
        "tools": {"type": "array",
                  "description": "這個研究會用到的工具／模擬引擎，供使用者勾選",
                  "items": {"type": "object", "additionalProperties": False,
                            "properties": {
                                "name": {"type": "string", "description": "工具／引擎名稱，如 PlasmaPy、COMSOL、SciPy"},
                                "why": {"type": "string", "description": "為什麼這個研究需要它，一句話"}},
                            "required": ["name", "why"]}},
    },
    ["steps"],
)
async def record_plan(ctx: ToolContext, args: dict) -> ToolResult:
    _write(ctx.thread_id, "plan.json", {"steps": args["steps"], "tools": args.get("tools") or []})
    n = len(args["steps"])
    return ToolResult(f"已記錄 {n} 個執行步驟與候選工具，等待使用者在核准關卡確認。", preview=f"計畫 {n} 步")


@tool(
    "record_replication",
    """記錄你（第二實作）獨立重做後得到的關鍵數值，供程式和研究者的結果對照（第二實作階段結束前呼叫）。
只記你自己算出來的，不要抄別人的。""",
    {
        "results": {"type": "array", "minItems": 1,
                    "items": {"type": "object", "additionalProperties": False,
                              "properties": {"name": {"type": "string", "description": "量的名稱，例如「30° 的 T/T0」"},
                                             "value": {"type": "string", "description": "你獨立算出的數值"},
                                             "unit": {"type": "string", "description": "單位，沒有就填無因次或空字串"}},
                              "required": ["name", "value", "unit"]}},
        "notes": {"type": "string", "description": "一句話說明你怎麼做的、結果如何"},
    },
    ["results", "notes"],
)
async def record_replication(ctx: ToolContext, args: dict) -> ToolResult:
    _write(ctx.thread_id, "replication.json", {"results": args["results"], "notes": args.get("notes", "")})
    return ToolResult(f"已記錄第二實作的 {len(args['results'])} 項獨立結果。", preview="第二實作結果已記錄")


@tool(
    "record_review",
    "記錄你（審查）的結論：疑慮清單與三方結果是否一致（審查階段結束前呼叫）。你只提問題，不改等級。",
    {
        "concerns": {"type": "array", "items": {"type": "string"},
                     "description": "逐條列出你發現的問題或疑慮；沒有就給空陣列"},
        "consistent": {"type": "boolean", "description": "研究／驗證／第二實作三方的關鍵結果是否一致"},
        "notes": {"type": "string", "description": "一兩句總結審查意見"},
    },
    ["concerns", "consistent", "notes"],
)
async def record_review(ctx: ToolContext, args: dict) -> ToolResult:
    _write(ctx.thread_id, "review.json",
           {"concerns": args["concerns"], "consistent": bool(args["consistent"]), "notes": args.get("notes", "")})
    c = len(args["concerns"])
    return ToolResult(f"已記錄審查：{'一致' if args['consistent'] else '不一致'}，{c} 項疑慮。", preview=f"審查 {c} 項疑慮")
