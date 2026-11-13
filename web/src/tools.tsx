import { ReactNode, useContext } from "react";
import { fileUrl, kbDocFileUrl, ToolBlock } from "./api";
import { Code, langFromPath, Terminal } from "./Code";
import { ImagePreviewCtx, KbDocOpenCtx } from "./Render";

type Meta = { label: string; icon: string; cat: "sbx" | "file" | "job" | "comsol" | "web" | "misc" };
export const TOOL_META: Record<string, Meta> = {
  execute_command: { label: "執行指令", icon: "⌘", cat: "sbx" },
  submit_job: { label: "背景計算", icon: "⏵", cat: "job" },
  job_status: { label: "計算進度", icon: "◔", cat: "job" },
  list_files: { label: "列出檔案", icon: "▤", cat: "file" },
  read_file: { label: "讀取檔案", icon: "◱", cat: "file" },
  write_file: { label: "寫入檔案", icon: "✎", cat: "file" },
  edit_file: { label: "修改檔案", icon: "✐", cat: "file" },
  see_image: { label: "檢視圖片", icon: "◩", cat: "file" },
  attach_files: { label: "附加成果", icon: "⎘", cat: "file" },
  web_search: { label: "網路搜尋", icon: "⌕", cat: "web" },
  fetch_url: { label: "讀取網頁", icon: "↗", cat: "web" },
  search_papers: { label: "文獻搜尋", icon: "❡", cat: "web" },
  comsol_status: { label: "COMSOL 狀態", icon: "◎", cat: "comsol" },
  comsol_submit: { label: "COMSOL 送出", icon: "◎", cat: "comsol" },
  comsol_job: { label: "COMSOL 結果", icon: "◎", cat: "comsol" },
  comsol_log: { label: "COMSOL log", icon: "◎", cat: "comsol" },
  comsol_download: { label: "COMSOL 下載", icon: "◎", cat: "comsol" },
  comsol_cancel: { label: "COMSOL 取消", icon: "◎", cat: "comsol" },
};
export const meta = (name: string): Meta => TOOL_META[name] ?? { label: name, icon: "•", cat: "misc" };

export function parseJSON(s?: string): any {
  if (!s) return null;
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try { return JSON.parse(t); } catch { return null; }
}

export function splitExit(text?: string): { code: string | null; out: string } {
  if (!text) return { code: null, out: "" };
  const m = text.match(/^exit_code: (\S+)\n?([\s\S]*)$/);
  return m ? { code: m[1], out: m[2] } : { code: null, out: text };
}

const baseName = (p?: string) => (p ?? "").replace(/\/+$/, "").split("/").pop() || (p ?? "");

export function toolSummary(name: string, input: any): string {
  if (!input) return "";
  switch (name) {
    case "execute_command": case "submit_job": return (input.command ?? "").split("\n")[0];
    case "read_file": case "write_file": case "edit_file": case "see_image": case "list_files": return baseName(input.path);
    case "web_search": case "search_papers": return input.query ?? "";
    case "fetch_url": return input.url ?? "";
    case "comsol_submit": return `${input.mode ?? "batch"} · ${input.main_file ?? ""}`;
    case "comsol_job": case "comsol_log": case "comsol_download": case "comsol_cancel": case "job_status": return input.job_id ?? "";
    case "attach_files": return (input.paths ?? []).map((p: string) => p.split("/").pop()).join("、");
    default: return "";
  }
}

const host = (u?: string) => { try { return new URL(u ?? "").hostname.replace(/^www\./, ""); } catch { return ""; } };

function Badge({ kind, children }: { kind: "ok" | "bad" | "run" | "info" | "warn"; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

function SearchList({ data, limit }: { data: any; limit?: number }) {
  const rows: any[] = data?.results ?? [];
  const list = limit ? rows.slice(0, limit) : rows;
  return (
    <div className="results">
      {list.map((r, i) => (
        <a key={i} className="result" href={r.url || r.doi || r.html || r.open_access_url || "#"} target="_blank" rel="noreferrer">
          <div className="result-title">{r.title || "(無標題)"}</div>
          <div className="result-meta">
            {r.source === "arxiv" && <Badge kind="info">arXiv {r.id}</Badge>}
            {r.source === "openalex" && r.venue && <span>{r.venue}</span>}
            {(r.year || r.published) && <span>{r.year || r.published}</span>}
            {r.authors?.length ? <span>{r.authors.slice(0, 3).join(", ")}{r.authors.length > 3 ? " 等" : ""}</span> : null}
            {r.cited_by !== undefined && r.cited_by !== null && <span>被引 {r.cited_by}</span>}
            {!r.source && <span>{host(r.url)}</span>}
          </div>
          {(r.snippet || r.abstract) && <div className="result-snip">{String(r.snippet || r.abstract).slice(0, limit ? 180 : 600)}</div>}
        </a>
      ))}
      {limit && rows.length > limit && <div className="muted small">…另外 {rows.length - limit} 筆</div>}
    </div>
  );
}

function ComsolJob({ d, full }: { d: any; full?: boolean }) {
  const lc = d.log_check ?? {};
  const results = Object.entries(lc.printed_results ?? {});
  const status = d.status;
  const kind = status === "completed" ? (d.success && !lc.problem_count ? "ok" : "warn") : status === "failed" ? "bad" : "run";
  return (
    <div className="comsol">
      <div className="row-wrap">
        <Badge kind={kind as any}>{status}{d.success !== null && d.success !== undefined ? ` · success=${String(d.success)}` : ""}</Badge>
        {d.duration_seconds ? <span className="muted small">{Number(d.duration_seconds).toFixed(1)} s</span> : null}
        {d.queue_position ? <span className="muted small">排隊第 {d.queue_position} 位</span> : null}
      </div>
      {d.verdict && <div className={`verdict ${kind}`}>{d.verdict}</div>}
      {results.length > 0 && (
        <table className="kv"><tbody>
          {results.map(([k, v]) => <tr key={k}><td>{k.replace(/^RESULT_/, "")}</td><td>{String(v)}</td></tr>)}
        </tbody></table>
      )}
      {(lc.error_details ?? []).map((e: string, i: number) => <pre key={i} className="err-pre">{e}</pre>)}
      {d.errors?.length ? d.errors.map((e: any, i: number) => (
        <div key={i} className="err-line">[{e.error_type}] {e.message}{e.line ? ` （第 ${e.line} 行）` : ""}{e.suggestion ? ` — ${e.suggestion}` : ""}</div>
      )) : null}
      {full && d.output_files?.length ? <div className="muted small">輸出檔：{d.output_files.join("、")}</div> : null}
      {full && d.log_tail && <Terminal output={d.log_tail} maxLines={30} />}
    </div>
  );
}

/** Compact body shown inside the chat for a tool step. */
export function ToolBody({ b, threadId }: { b: ToolBlock; threadId: string }) {
  const r = b.result;
  const openImg = useContext(ImagePreviewCtx);
  const text = r?.output ?? r?.preview ?? "";
  const inp = b.input ?? {};
  switch (b.name) {
    case "execute_command": {
      const { code, out } = splitExit(text);
      return <Terminal command={inp.command} output={r ? out : undefined} exitCode={r ? code : undefined} maxLines={10} commandMaxLines={6} />;
    }
    case "write_file":
      return inp.content ? <Code code={inp.content} lang={langFromPath(inp.path)} maxLines={12} /> : null;
    case "edit_file":
      return (
        <div className="diff">
          {inp.old_text !== undefined && <pre className="diff-old">{String(inp.old_text).slice(0, 1500)}</pre>}
          {inp.new_text !== undefined && <pre className="diff-new">{String(inp.new_text).slice(0, 1500)}</pre>}
        </div>
      );
    case "submit_job":
      return <Terminal command={inp.command} commandMaxLines={6} />;
    case "job_status": {
      const d = parseJSON(text);
      if (!d || Array.isArray(d)) return null;
      return (
        <div>
          <div className="row-wrap">
            <Badge kind={d.status === "running" ? "run" : String(d.exit_code) === "0" ? "ok" : "bad"}>
              {d.status === "running" ? "執行中" : `結束 · exit ${d.exit_code}`}
            </Badge>
            {d.elapsed_seconds !== undefined && <span className="muted small">已執行 {d.elapsed_seconds} s</span>}
          </div>
          {d.log_tail && <Terminal output={d.log_tail} maxLines={8} />}
        </div>
      );
    }
    case "comsol_submit": {
      const d = parseJSON(text);
      if (!d) return r?.is_error ? <div className="err-line">{text}</div> : null;
      return (
        <div className="comsol">
          <div className="row-wrap">
            <Badge kind="info">{d.job_id}</Badge>
            {d.queue_position ? <span className="muted small">排隊第 {d.queue_position} 位</span> : null}
          </div>
          {d.uploaded_files && <div className="chips-inline">{d.uploaded_files.map((f: string) => <span key={f} className="chip-s">{f}</span>)}</div>}
          {d.auto_added_data_files && <div className="muted small">自動附上資料檔：{d.auto_added_data_files.join("、")}</div>}
          {(d.warnings ?? []).map((w: string, i: number) => <div key={i} className="warn-line">⚠ {w}</div>)}
        </div>
      );
    }
    case "comsol_job": {
      const d = parseJSON(text);
      return d ? <ComsolJob d={d} /> : null;
    }
    case "comsol_status": {
      const d = parseJSON(text);
      if (!d) return null;
      return (
        <div className="row-wrap">
          <Badge kind={d.health?.comsol_available ? "ok" : "bad"}>{d.health?.status}</Badge>
          <span className="muted small">{d.info?.comsol_version}</span>
          <span className="muted small">排隊 {d.health?.queue_size ?? 0}{d.health?.running_job ? ` · 執行中 ${d.health.running_job}` : ""}</span>
        </div>
      );
    }
    case "web_search": case "search_papers": {
      const d = parseJSON(text);
      return d ? <SearchList data={d} limit={4} /> : null;
    }
    case "fetch_url": {
      const title = text.match(/^Title: (.*)$/m)?.[1];
      return <div className="muted small">{title ? `${title} · ` : ""}{host(inp.url)}</div>;
    }
    case "see_image":
      return <>{(r?.images ?? []).map((p) => <img key={p} className="tool-img" src={fileUrl(threadId, p)} alt={p}
        title="點擊放大" onClick={() => openImg?.(p)} />)}</>;
    case "kb_list": {
      const d = parseJSON(text);
      return d?.documents ? <KbDocResults docs={d.documents} /> : null;
    }
    default:
      return null;
  }
}

export function KbDocResults({ docs }: { docs: any[] }) {
  const openKbDoc = useContext(KbDocOpenCtx);
  if (!docs.length) return <div className="muted small">知識庫沒有文件。</div>;
  return (
    <div className="results-card">
      <div className="results-head"><strong>知識庫文件</strong><span className="muted small"> · {docs.length} 篇 · 點「開啟」在右側閱讀</span></div>
      <div className="kbdoc-list">
      {docs.map((f) => (
        <div key={f.id} className="kbdoc-row">
          <span className="kbdoc-icon">{(f.mime === "application/pdf" || (f.source || "").endsWith(".pdf")) ? "📕" : "📄"}</span>
          <div className="kbdoc-main">
            <span className="kbdoc-name" title={f.source}>{f.title || f.source}</span>
            <span className="muted small">{f.collection}{f.kind === "experience" ? " · 研究經驗" : ""} · {f.chunks} 段</span>
          </div>
          <button className="btn ghost small" onClick={() => openKbDoc?.(f)}>開啟</button>
          {f.has_file && <a className="btn ghost small" href={kbDocFileUrl(f.id, true)} target="_blank" rel="noreferrer">下載</a>}
        </div>
      ))}
      </div>
    </div>
  );
}

/** Full view for the side panel. `text` is the complete tool output. */
export function ToolFull({ name, input, text, isError, images, threadId }:
  { name: string; input: any; text?: string; isError?: boolean; images?: string[]; threadId: string }) {
  const inp = input ?? {};
  const openImg = useContext(ImagePreviewCtx);
  const d = parseJSON(text);
  let inputView: ReactNode = <Code code={JSON.stringify(inp, null, 2)} lang="json" wrap />;
  if (name === "execute_command" || name === "submit_job") inputView = <Terminal command={inp.command} />;
  if (name === "write_file") inputView = (<><div className="muted small mono">{inp.path}</div><Code code={inp.content ?? ""} lang={langFromPath(inp.path)} /></>);
  if (name === "edit_file") inputView = (
    <><div className="muted small mono">{inp.path}</div>
      <div className="diff"><pre className="diff-old">{inp.old_text}</pre><pre className="diff-new">{inp.new_text}</pre></div></>
  );
  let outputView: ReactNode = null;
  if (text !== undefined) {
    if (name === "execute_command") { const { code, out } = splitExit(text); outputView = <Terminal output={out} exitCode={code} maxLines={400} />; }
    else if (name === "comsol_job" && d) outputView = <ComsolJob d={d} full />;
    else if ((name === "web_search" || name === "search_papers") && d) outputView = <SearchList data={d} />;
    else if (name === "read_file") outputView = <Code code={text} lang={langFromPath(inp.path)} />;
    else if (name === "comsol_log") outputView = <Terminal output={text} maxLines={400} />;
    else if (d) outputView = <Code code={JSON.stringify(d, null, 2)} lang="json" wrap />;
    else outputView = <Code code={text} wrap />;
  }
  return (
    <div className="tool-full">
      <h4>輸入</h4>
      {inputView}
      <h4>輸出 {isError && <span className="badge bad">錯誤</span>}</h4>
      {text === undefined ? <div className="muted small">執行中…</div> : outputView}
      {images?.map((p) => <img key={p} className="tool-img big" src={fileUrl(threadId, p)} alt={p}
        title="點擊放大" onClick={() => openImg?.(p)} />)}
    </div>
  );
}
