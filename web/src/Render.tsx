import { createContext, memo, ReactNode, useContext, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Attachment, Block, fileUrl, fmtDuration, fmtSize, fmtTokens, modelName, RunInfo, ToolBlock, ToolProgress, zipUrl } from "./api";
import { APP_NAME } from "./brand";
import { Code } from "./Code";
import { KbDocResults, meta, parseJSON, ToolBody, toolSummary } from "./tools";

export const FileOpenCtx = createContext<((path: string) => void) | null>(null);
// open a knowledge-base document (lab/base/task) in the side panel — used by the kb_list tool view
export type KbDocRef = { id: string; title?: string; source: string; mime?: string; has_file?: boolean };
export const KbDocOpenCtx = createContext<((doc: KbDocRef) => void) | null>(null);

const isWorkspacePath = (s: string) => s.startsWith("/workspace") || !/^[a-z]+:|^\/\/|^#/i.test(s);

export const Markdown = memo(function Markdown({ text, threadId }: { text: string; threadId: string }) {
  const openFile = useContext(FileOpenCtx);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={(url) => url}
        components={{
          img: ({ src, alt }) => {
            const s = String(src || "");
            return <img src={isWorkspacePath(s) ? fileUrl(threadId, s) : s} alt={alt || ""} className="md-img" />;
          },
          a: ({ href, children }) => {
            const h = String(href || "");
            return <a href={h.startsWith("/workspace") ? fileUrl(threadId, h) : h} target="_blank" rel="noreferrer">{children}</a>;
          },
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const m = /language-(\w+)/.exec(className || "");
            const content = String(children ?? "").replace(/\n$/, "");
            if (!m && !content.includes("\n")) {
              if (openFile && /^\/workspace\/\S+[^/]$/.test(content)) {
                return <button className="ws-link" onClick={() => openFile(content)} title="在右側預覽">{content}</button>;
              }
              return <code className="inline">{children}</code>;
            }
            return <Code code={content} lang={m?.[1]} />;
          },
        }}
      >{text}</ReactMarkdown>
    </div>
  );
});

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  const first = text.trim().split("\n")[0].slice(0, 90);
  return (
    <div className={`thinking ${open ? "open" : ""}`}>
      <button className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? "▾" : "▸"}</span> 思考{live ? "中…" : ""}
        {!open && <span className="thinking-peek">{first}</span>}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

// interim notes the model writes between tool calls — collapsed like thinking, only the final text is the answer
function InterimNote({ text, threadId }: { text: string; threadId: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  const first = text.trim().replace(/\s+/g, " ").slice(0, 90);
  return (
    <div className={`thinking note ${open ? "open" : ""}`}>
      <button className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? "▾" : "▸"}</span> 說明
        {!open && <span className="thinking-peek">{first}</span>}
      </button>
      {open && <div className="thinking-body"><Markdown text={text} threadId={threadId} /></div>}
    </div>
  );
}

// live progress for a long-running step (COMSOL solve), bound to the step via tool_progress events
function StepProgress({ p }: { p: ToolProgress }) {
  const queued = !!p.queue_position && p.queue_position > 0;
  if (queued) {
    return (
      <div className="step-prog">
        <div className="step-prog-row"><span className="spinner sm" /> COMSOL 排隊中 · 第 {p.queue_position} 位
          {p.elapsed != null && <span className="muted"> · 已 {fmtDuration(p.elapsed)}</span>}</div>
      </div>
    );
  }
  return (
    <div className="step-prog">
      <div className="step-prog-row">
        <span className="step-prog-stage">{p.stage || "求解中"}</span>
        {p.percent != null && <span className="muted">· {p.percent}%</span>}
        {p.elapsed != null && <span className="muted">· 已 {fmtDuration(p.elapsed)}</span>}
      </div>
      {p.percent != null && <div className="prog-bar"><div className="prog-fill" style={{ width: `${p.percent}%` }} /></div>}
    </div>
  );
}

function ToolStep({ b, threadId, selected, onSelect }:
  { b: ToolBlock; threadId: string; selected: boolean; onSelect: (b: ToolBlock) => void }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const m = meta(b.name);
  const r = b.result;
  const state = !r ? "running" : r.is_error ? "error" : "ok";
  // one-line header by default; failed steps open themselves so problems are visible
  const open = userOpen ?? state === "error";
  if (b.name === "attach_files" && r && !r.is_error) return null;
  if (b.name === "kb_list" && r && !r.is_error) return null;  // surfaced prominently in the turn body instead
  return (
    <div className={`step ${state} cat-${m.cat} ${selected ? "selected" : ""}`}>
      <div className="step-dot">{state === "running" ? <span className="spinner sm" /> : m.icon}</div>
      <div className="step-main">
        <div className="step-head" onClick={() => setUserOpen(!open)}>
          <span className="chev">{open ? "▾" : "▸"}</span>
          <span className="step-label">{b.input?.step_note?.trim() || m.label}</span>
          <span className="step-sum mono">{toolSummary(b.name, b.input)}</span>
          {r?.seconds !== undefined && <span className="step-time">{r.seconds}s</span>}
          {state === "error" && <span className="badge bad">失敗</span>}
          <button className="step-open" onClick={(e) => { e.stopPropagation(); onSelect(b); }} title="在右側面板查看完整內容">詳情</button>
        </div>
        {state === "running" && b.progress && <StepProgress p={b.progress} />}
        {open && (
          <div className="step-body">
            <ToolBody b={b} threadId={threadId} />
            {state === "error" && !["comsol_submit"].includes(b.name) && r?.preview && b.name !== "execute_command" && (
              <div className="err-line">{r.preview.slice(0, 600)}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StepGroup({ steps, threadId, selectedId, onSelect, live }:
  { steps: ToolBlock[]; threadId: string; selectedId?: string; onSelect: (b: ToolBlock) => void; live?: boolean }) {
  const visible = steps.filter((s) => !(["attach_files", "kb_list"].includes(s.name) && s.result && !s.result.is_error));
  // finished turns start collapsed (one summary line); the turn that is running stays open
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !!live;
  const setOpen = (f: (v: boolean) => boolean) => setUserOpen(f(open));
  if (!visible.length) return null;
  const errors = visible.filter((s) => s.result?.is_error).length;
  const running = visible.some((s) => !s.result);
  return (
    <div className="steps">
      <button className="steps-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        {running || live ? "執行步驟" : "已執行步驟"} · {visible.length}
        {errors > 0 && <span className="badge bad">{errors} 個失敗</span>}
        {!open && <span className="steps-kinds">{Array.from(new Set(visible.map((v) => meta(v.name).label))).slice(0, 5).join("、")}</span>}
      </button>
      {open && <div className="steps-list">{visible.map((s) => (
        <ToolStep key={s.id} b={s} threadId={threadId} selected={s.id === selectedId} onSelect={onSelect} />
      ))}</div>}
    </div>
  );
}

const EXT_LABEL: Record<string, string> = {
  mph: "COMSOL 模型", status: "COMSOL 狀態", csv: "CSV 數據", txt: "文字數據", json: "JSON", java: "Java 原始碼",
  py: "Python 程式", pdf: "PDF", h5: "HDF5", md: "Markdown", log: "Log", zip: "壓縮檔",
};

// intermediate files (logs, solver status) are hidden behind a toggle so the main results stand out
const isSecondaryFile = (f: Attachment) => /\.(log|status)$/i.test(f.name);

function AttFile({ f, threadId, onOpenFile }:
  { f: Attachment; threadId: string; onOpenFile: (path: string) => void }) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  return (
    <div className="att-file">
      <span className="att-ext">{ext.slice(0, 6).toUpperCase()}</span>
      <div className="att-main">
        <button className="att-name" onClick={() => onOpenFile(f.path)} title={f.path}>{f.name}</button>
        <span className="muted small">{EXT_LABEL[ext] ?? "檔案"} · {fmtSize(f.size)} · <span className="mono">{f.path.replace(/\/[^/]*$/, "")}</span></span>
      </div>
      <button className="icon" onClick={() => onOpenFile(f.path)}>預覽</button>
      <a className="btn ghost small" href={fileUrl(threadId, f.path, true)}>下載</a>
    </div>
  );
}

function Attachments({ files, threadId, onOpenFile }:
  { files: Attachment[]; threadId: string; onOpenFile: (path: string) => void }) {
  const [showSecondary, setShowSecondary] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);  // image path shown enlarged
  if (!files.length) return null;
  const seen = new Set<string>();
  const uniq = files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  const images = uniq.filter((f) => f.mime.startsWith("image/"));
  const others = uniq.filter((f) => !f.mime.startsWith("image/"));
  const primary = others.filter((f) => !isSecondaryFile(f));
  const secondary = others.filter(isSecondaryFile);
  const total = uniq.reduce((a, f) => a + (f.size || 0), 0);
  return (
    <section className="results-card">
      <header className="results-head">
        <div>
          <strong>本次產生的檔案</strong>
          <span className="muted small"> · {uniq.length} 個 · {fmtSize(total)}</span>
        </div>
        <a className="btn primary small" href={zipUrl(threadId, uniq.map((f) => f.path), "results")} title="打包成 zip 下載">全部下載</a>
      </header>
      {images.length > 0 && (
        <>
          <div className="results-sub">圖片（{images.length}）</div>
          <div className="att-grid">{images.map((f) => (
            <figure key={f.path} className="att-img">
              <img src={fileUrl(threadId, f.path)} alt={f.name} loading="lazy" onClick={() => setLightbox(f.path)} title="點擊放大預覽" />
              <figcaption>
                <span className="att-cap" title={f.path}>{f.name}</span>
                <span className="muted small">{fmtSize(f.size)}</span>
                <button className="icon" onClick={() => setLightbox(f.path)}>預覽</button>
                <a className="icon" href={fileUrl(threadId, f.path, true)}>下載</a>
              </figcaption>
            </figure>
          ))}</div>
        </>
      )}
      {primary.length > 0 && (
        <>
          <div className="results-sub">模型與數據（{primary.length}）</div>
          <div className="att-files">{primary.map((f) => (
            <AttFile key={f.path} f={f} threadId={threadId} onOpenFile={onOpenFile} />
          ))}</div>
        </>
      )}
      {secondary.length > 0 && (
        <>
          <button className="more-files" onClick={() => setShowSecondary((v) => !v)}>
            <span className="chev">{showSecondary ? "▾" : "▸"}</span>
            其餘 {secondary.length} 個檔案（log、狀態等）
          </button>
          {showSecondary && <div className="att-files">{secondary.map((f) => (
            <AttFile key={f.path} f={f} threadId={threadId} onOpenFile={onOpenFile} />
          ))}</div>}
        </>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={fileUrl(threadId, lightbox)} alt={lightbox.split("/").pop() || ""} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span className="mono small">{lightbox.split("/").pop()}</span>
            <a className="btn ghost small" href={fileUrl(threadId, lightbox, true)}>下載</a>
            <button className="icon" onClick={() => setLightbox(null)} aria-label="關閉">✕</button>
          </div>
        </div>
      )}
    </section>
  );
}

export function RunMeta({ run }: { run?: RunInfo }) {
  if (!run) return null;
  const u: any = run.usage || {};
  const dur = run.started_at && run.finished_at
    ? (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000 : NaN;
  const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return (
    <div className="run-meta">
      {run.model && <span>{modelName(run.model)}</span>}
      {isFinite(dur) && <span>耗時 {fmtDuration(dur)}</span>}
      {u.requests ? <span>{u.requests} 次模型呼叫</span> : null}
      {inTok ? <span title={`快取讀取 ${u.cache_read_input_tokens || 0}`}>輸入 {fmtTokens(inTok)} · 輸出 {fmtTokens(u.output_tokens)} tokens</span> : null}
      {run.status === "stopped" && <span className="badge warn">已停止</span>}
      {run.status === "failed" && <span className="badge bad">失敗</span>}
    </div>
  );
}

export function AssistantTurn({ blocks, attachments, threadId, live, run, roleLabel, selectedId, onSelect, onOpenFile }: {
  blocks: Block[]; attachments: Attachment[]; threadId: string; live?: boolean; run?: RunInfo; roleLabel?: string;
  selectedId?: string; onSelect: (b: ToolBlock) => void; onOpenFile: (p: string) => void;
}) {
  // group consecutive tool blocks into one timeline
  const parts: ReactNode[] = [];
  let group: ToolBlock[] = [];
  const flush = (key: string) => {
    if (group.length) {
      parts.push(<StepGroup key={key} steps={group} threadId={threadId} selectedId={selectedId} onSelect={onSelect} live={live} />);
      group = [];
    }
  };
  // only the final text block is the answer; earlier ones are interim notes written between tool calls
  const lastTextIdx = blocks.reduce((acc, b, i) => (b.type === "text" && b.text ? i : acc), -1);
  blocks.forEach((b, i) => {
    if (b.type === "tool") { group.push(b); return; }
    flush(`g${i}`);
    if (b.type === "text") {
      if (!b.text) return;
      if (!live && i !== lastTextIdx) parts.push(<InterimNote key={i} text={b.text} threadId={threadId} />);
      else parts.push(<Markdown key={i} text={b.text} threadId={threadId} />);
    } else parts.push(<Thinking key={i} text={b.text} live={live && i === blocks.length - 1} />);
  });
  flush("gend");
  const lastText = [...blocks].reverse().find((b) => b.type === "text") as { text: string } | undefined;
  return (
    <div className="turn">
      <div className="turn-head">
        <span className="avatar">S</span><span className="turn-name">{APP_NAME}</span>
        {roleLabel && <span className="role-chip">{roleLabel}</span>}
        {!live && lastText && (
          <button className="icon small" title="複製回覆" onClick={() => navigator.clipboard?.writeText(lastText.text)}>複製</button>
        )}
      </div>
      <div className="turn-body">
        {parts}
        {(() => {
          // surface kb_list results as a clickable document card (the step itself is hidden)
          const docs = (blocks as any[]).filter((b) => b.type === "tool" && b.name === "kb_list" && b.result && !b.result.is_error)
            .flatMap((b) => parseJSON(b.result?.output ?? b.result?.preview)?.documents ?? []);
          return docs.length ? <KbDocResults docs={docs} /> : null;
        })()}
        <Attachments files={attachments} threadId={threadId} onOpenFile={onOpenFile} />
        {!live && <RunMeta run={run} />}
      </div>
    </div>
  );
}
