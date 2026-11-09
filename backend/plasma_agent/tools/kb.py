"""Knowledge base tools: Agentic RAG over the thread's uploaded documents (+ shared base library)."""
from __future__ import annotations

import json

from .. import kb
from .base import ToolContext, ToolResult, tool


@tool(
    "kb_search",
    """搜尋這個對話的知識庫（你上傳的文件，加上共用基礎庫），用語意相似度找最相關的段落並重排序。
需要引用上傳資料、或下結論前查證據時使用；可以用不同問法多查幾次。回傳每段內容、來源檔名與相關分數。""",
    {"query": {"type": "string", "description": "要查的問題或關鍵概念"},
     "top_k": {"type": "integer", "minimum": 1, "maximum": 10, "description": "回傳幾段，預設 5"}},
    ["query"],
)
async def kb_search(ctx: ToolContext, args: dict) -> ToolResult:
    if not kb.enabled():
        return ToolResult("知識庫未啟用（缺少 VOYAGE_API_KEY）。", is_error=True)
    ds = await kb.datasets_for_thread(ctx.thread_id)
    res = await kb.search(ds, args["query"], int(args.get("top_k") or 5))
    if not res:
        return ToolResult("知識庫沒有相關內容（可能還沒上傳文件，或這個查詢沒有匹配）。")
    body = json.dumps({"query": args["query"], "results": res}, ensure_ascii=False, indent=1)
    return ToolResult(body, preview=f"知識庫「{args['query']}」：{len(res)} 段")


@tool(
    "kb_read",
    "讀取知識庫裡某份文件的完整內容（用檔名片段比對），用來細讀 kb_search 找到的來源。",
    {"source": {"type": "string", "description": "檔名或其中一段（例如 paper.pdf）"}},
    ["source"],
)
async def kb_read(ctx: ToolContext, args: dict) -> ToolResult:
    if not kb.enabled():
        return ToolResult("知識庫未啟用（缺少 VOYAGE_API_KEY）。", is_error=True)
    ds = await kb.datasets_for_thread(ctx.thread_id)
    body = await kb.read_document(ds, args["source"])
    if body is None:
        return ToolResult(f"知識庫裡找不到符合「{args['source']}」的文件。", is_error=True)
    return ToolResult(body, preview=f"讀取 {args['source']}")
