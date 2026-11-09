"""Web and literature search (Bedrock has no server-side web search, so these run in the worker)."""
from __future__ import annotations

import asyncio
import io
import json
import re
import xml.etree.ElementTree as ET

import httpx

from .. import sandbox
from ..config import settings
from .base import ToolContext, ToolResult, tool

UA = "Mozilla/5.0 (X11; Linux x86_64) PlasmaAgent/1.0"
FETCH_LIMIT = 40000


async def _tavily(query: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post("https://api.tavily.com/search",
                         headers={"Authorization": f"Bearer {settings.tavily_api_key}"},
                         json={"query": query, "max_results": n, "search_depth": "advanced"})
        r.raise_for_status()
        return [{"title": x.get("title"), "url": x.get("url"), "snippet": x.get("content")}
                for x in r.json().get("results", [])]


def _ddg(query: str, n: int) -> list[dict]:
    from ddgs import DDGS
    return [{"title": x.get("title"), "url": x.get("href"), "snippet": x.get("body")}
            for x in DDGS().text(query, max_results=n)]


@tool(
    "web_search",
    """搜尋網路，回傳標題、網址、摘要。查最新資訊、軟體文件、錯誤訊息時使用。
要讀全文請接著用 fetch_url。找學術論文優先用 search_papers。""",
    {"query": {"type": "string"},
     "max_results": {"type": "integer", "minimum": 1, "maximum": 15}},
    ["query"],
)
async def web_search(ctx: ToolContext, args: dict) -> ToolResult:
    n = int(args.get("max_results") or 8)
    q = args["query"]
    source = "tavily" if settings.tavily_api_key else "duckduckgo"
    try:
        results = await _tavily(q, n) if settings.tavily_api_key else await asyncio.to_thread(_ddg, q, n)
    except Exception as e:
        if source == "tavily":
            results, source = await asyncio.to_thread(_ddg, q, n), "duckduckgo"
        else:
            return ToolResult(f"搜尋失敗：{e}", is_error=True)
    body = json.dumps({"source": source, "results": results}, ensure_ascii=False, indent=1)
    return ToolResult(body, preview=f"搜尋「{q}」：{len(results)} 筆")


def _html_to_text(html: str) -> tuple[str, str]:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else ""
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "svg", "form"]):
        tag.decompose()
    text = soup.get_text("\n")
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return title, text.strip()


def _pdf_to_text(data: bytes, max_pages: int = 40) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    pages = [reader.pages[i].extract_text() or "" for i in range(min(len(reader.pages), max_pages))]
    note = f"\n[PDF 共 {len(reader.pages)} 頁，擷取前 {len(pages)} 頁]" if len(reader.pages) > max_pages else ""
    return "\n\n".join(pages) + note


@tool(
    "fetch_url",
    """下載網頁或 PDF 並轉成純文字。save_to 可同時把原始檔存到 /workspace（例如下載論文 PDF、資料檔）。
讀 arXiv 論文時，HTML 版（https://arxiv.org/html/<id>）通常比 PDF 好讀。""",
    {"url": {"type": "string"},
     "save_to": {"type": "string", "description": "可選：存到 /workspace 的路徑"},
     "max_chars": {"type": "integer", "minimum": 1000, "maximum": 200000}},
    ["url"],
)
async def fetch_url(ctx: ToolContext, args: dict) -> ToolResult:
    url = args["url"]
    if not re.match(r"^https?://", url):
        return ToolResult("只支援 http/https 網址", is_error=True)
    async with httpx.AsyncClient(timeout=60, follow_redirects=True, headers={"User-Agent": UA}) as c:
        r = await c.get(url)
    if r.status_code >= 400:
        return ToolResult(f"HTTP {r.status_code}：{url}", is_error=True)
    saved = ""
    if args.get("save_to"):
        p = sandbox.resolve_path(ctx.thread_id, args["save_to"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(r.content)
        saved = f"\n[原始檔已存到 {sandbox.to_container_path(ctx.thread_id, p)}，{len(r.content)} bytes]"
    ctype = r.headers.get("content-type", "")
    if "pdf" in ctype or url.lower().endswith(".pdf"):
        title, text = "", await asyncio.to_thread(_pdf_to_text, r.content)
    elif "html" in ctype or "xml" in ctype:
        title, text = await asyncio.to_thread(_html_to_text, r.text)
    elif ctype.startswith("text/") or "json" in ctype:
        title, text = "", r.text
    else:
        return ToolResult(f"內容類型 {ctype}，無法轉成文字。{saved}", is_error=not saved)
    limit = int(args.get("max_chars") or FETCH_LIMIT)
    if len(text) > limit:
        text = text[:limit] + f"\n…[已截斷，全文 {len(text)} 字元]"
    head = f"URL: {r.url}\n" + (f"Title: {title}\n" if title else "")
    return ToolResult(head + "\n" + text + saved, preview=f"讀取 {url}")


async def _arxiv(q: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": UA}) as c:
        r = await c.get("https://export.arxiv.org/api/query",
                        params={"search_query": f"all:{q}", "max_results": n, "sortBy": "relevance"})
    r.raise_for_status()
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for e in ET.fromstring(r.text).findall("a:entry", ns):
        aid = (e.findtext("a:id", "", ns) or "").rsplit("/abs/", 1)[-1]
        out.append({
            "source": "arxiv", "id": aid,
            "title": " ".join((e.findtext("a:title", "", ns) or "").split()),
            "authors": [a.findtext("a:name", "", ns) for a in e.findall("a:author", ns)][:8],
            "published": (e.findtext("a:published", "", ns) or "")[:10],
            "abstract": " ".join((e.findtext("a:summary", "", ns) or "").split())[:1500],
            "url": f"https://arxiv.org/abs/{aid}", "html": f"https://arxiv.org/html/{aid}",
        })
    return out


def _inverted_to_text(inv: dict | None) -> str:
    if not inv:
        return ""
    pos = sorted((i, w) for w, idx in inv.items() for i in idx)
    return " ".join(w for _, w in pos)


async def _openalex(q: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": UA}) as c:
        r = await c.get("https://api.openalex.org/works", params={"search": q, "per-page": n})
    r.raise_for_status()
    out = []
    for w in r.json().get("results", []):
        out.append({
            "source": "openalex", "title": w.get("display_name"),
            "year": w.get("publication_year"), "doi": w.get("doi"),
            "venue": ((w.get("primary_location") or {}).get("source") or {}).get("display_name"),
            "authors": [a["author"]["display_name"] for a in w.get("authorships", [])][:8],
            "cited_by": w.get("cited_by_count"),
            "open_access_url": (w.get("open_access") or {}).get("oa_url"),
            "abstract": _inverted_to_text(w.get("abstract_inverted_index"))[:1500],
        })
    return out


@tool(
    "search_papers",
    """搜尋學術文獻：arXiv（預印本）與 OpenAlex（期刊論文，含 DOI、引用數、開放取用連結）。
回傳標題、作者、年份、摘要與連結。引用文獻時只能引用這裡實際找到的論文。""",
    {"query": {"type": "string", "description": "英文關鍵字效果最好"},
     "source": {"type": "string", "enum": ["both", "arxiv", "openalex"]},
     "max_results": {"type": "integer", "minimum": 1, "maximum": 20}},
    ["query"],
)
async def search_papers(ctx: ToolContext, args: dict) -> ToolResult:
    q, n, src = args["query"], int(args.get("max_results") or 8), args.get("source") or "both"
    tasks = []
    if src in ("both", "arxiv"):
        tasks.append(_arxiv(q, n))
    if src in ("both", "openalex"):
        tasks.append(_openalex(q, n))
    res = await asyncio.gather(*tasks, return_exceptions=True)
    papers, errors = [], []
    for x in res:
        (errors.append(str(x)) if isinstance(x, Exception) else papers.extend(x))
    if not papers and errors:
        return ToolResult(f"文獻搜尋失敗：{'; '.join(errors)}", is_error=True)
    body = json.dumps({"results": papers, "errors": errors or None}, ensure_ascii=False, indent=1)
    return ToolResult(body, preview=f"文獻「{q}」：{len(papers)} 篇")
