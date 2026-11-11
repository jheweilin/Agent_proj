import { useEffect, useMemo, useState } from "react";
import {
  api, fetchText, FileEntry, fileUrl, fmtDuration, fmtSize, fmtTokens, modelName, ThreadStatus, ToolBlock, ToolDetail,
} from "./api";
import { Code, langFromPath, Terminal } from "./Code";
import { KbDocRef, Markdown } from "./Render";
import { kbDocFileUrl } from "./api";
import { meta, ToolFull, toolSummary } from "./tools";

export type PanelTab = "detail" | "files" | "status" | "kbdoc";

export default function Panel({ threadId, tab, setTab, selected, filePath, setFilePath, kbDoc, tick, liveRunning, onClose }: {
  threadId: string; tab: PanelTab; setTab: (t: PanelTab) => void; selected: ToolBlock | null;
  filePath: string | null; setFilePath: (p: string | null) => void; kbDoc: KbDocRef | null;
  tick: number; liveRunning: boolean; onClose: () => void;
}) {
  return (
    <aside className="panel">
      <div className="panel-tabs">
        {kbDoc && <button className={tab === "kbdoc" ? "on" : ""} onClick={() => setTab("kbdoc")}>論文</button>}
        <button className={tab === "detail" ? "on" : ""} onClick={() => setTab("detail")}>步驟詳情</button>
        <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>檔案</button>
        <button className={tab === "status" ? "on" : ""} onClick={() => setTab("status")}>狀態</button>
        <span className="spacer" />
        <button className="icon" onClick={onClose} aria-label="關閉面板">✕</button>
      </div>
      <div className="panel-body">
        {tab === "kbdoc" && kbDoc && <KbDocView doc={kbDoc} />}
        {tab === "detail" && <DetailTab threadId={threadId} selected={selected} tick={tick} />}
        {tab === "files" && <FilesTab threadId={threadId} tick={tick} filePath={filePath} setFilePath={setFilePath} />}
        {tab === "status" && <StatusTab threadId={threadId} tick={tick} liveRunning={liveRunning} openFile={(p) => { setFilePath(p); setTab("files"); }} />}
      </div>
    </aside>
  );
}

function KbDocView({ doc }: { doc: KbDocRef }) {
  const isPdf = doc.mime === "application/pdf" || (doc.source || "").toLowerCase().endsWith(".pdf");
  const isImg = (doc.mime || "").startsWith("image/");
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setText(null); setErr("");
    if (doc.has_file && (isPdf || isImg)) return;   // shown via iframe/img, no text fetch
    api.kbDocText(doc.id).then((r) => setText(r.text)).catch((e) => setErr(e.message));
  }, [doc.id]);
  return (
    <div className="preview">
      <div className="preview-head">
        <span className="small" title={doc.source}>{doc.title || doc.source}</span>
        <span className="spacer" />
        {doc.has_file && <a className="btn ghost small" href={kbDocFileUrl(doc.id)} target="_blank" rel="noreferrer">新分頁</a>}
        {doc.has_file && <a className="btn ghost small" href={kbDocFileUrl(doc.id, true)}>下載</a>}
      </div>
      <div className="preview-body">
        {doc.has_file && isPdf && <iframe src={kbDocFileUrl(doc.id)} title={doc.source} className="preview-pdf" />}
        {doc.has_file && isImg && <img src={kbDocFileUrl(doc.id)} alt={doc.source} className="preview-img" />}
        {!(doc.has_file && (isPdf || isImg)) && (
          err ? <div className="error small">{err}</div>
            : text === null ? <div className="muted small">載入中…</div>
              : <Markdown text={text} threadId="" />
        )}
        {!doc.has_file && <div className="muted small pad">（此文件在支援保留原始檔之前上傳，只能看抽取出的文字。）</div>}
      </div>
    </div>
  );
}

function DetailTab({ threadId, selected, tick }: { threadId: string; selected: ToolBlock | null; tick: number }) {
  const [detail, setDetail] = useState<ToolDetail | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setDetail(null); setErr("");
    if (!selected) return;
    api.toolDetail(threadId, selected.id).then(setDetail).catch((e) => setErr(e.status === 404 ? "" : e.message));
  }, [threadId, selected?.id, selected?.result ? 1 : 0, tick]);
  if (!selected) return <div className="empty">點對話中任一個步驟的「詳情」，這裡會顯示完整的輸入與輸出。</div>;
  const m = meta(selected.name);
  const res = detail?.result;
  const text = res?.text ?? selected.result?.output ?? selected.result?.preview;
  return (
    <div className="detail">
      <div className="detail-head">
        <span className={`step-dot inline cat-${m.cat}`}>{m.icon}</span>
        <div>
          <div className="detail-title">{m.label}</div>
          <div className="muted small mono">{toolSummary(selected.name, selected.input)}</div>
        </div>
        {selected.result?.seconds !== undefined && <span className="muted small">{selected.result.seconds}s</span>}
      </div>
      {err && <div className="error small">{err}</div>}
      <ToolFull name={selected.name} input={detail?.input ?? selected.input} threadId={threadId}
        text={selected.result || res ? text : undefined} isError={res?.is_error ?? selected.result?.is_error}
        images={res?.images ?? selected.result?.images} />
    </div>
  );
}

// ------------------------------------------------------------------ files

const IMG = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const TEXT = ["txt", "log", "py", "java", "sh", "json", "md", "csv", "tsv", "xml", "yaml", "yml", "ini", "cfg", "toml",
  "c", "cc", "cpp", "h", "hpp", "geo", "inp", "m", "out", "dat", "namelist", "in", "html", "status"];
const ext = (p: string) => (p.split("/").pop() || "").split(".").pop()?.toLowerCase() || "";

function FilesTab({ threadId, tick, filePath, setFilePath }:
  { threadId: string; tick: number; filePath: string | null; setFilePath: (p: string | null) => void }) {
  const [dir, setDir] = useState("/workspace");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.files(threadId, dir).then((r) => { setEntries(r.entries); setErr(""); }).catch((e) => setErr(e.message));
  }, [threadId, dir, tick]);
  useEffect(() => {
    if (filePath) setDir(filePath.split("/").slice(0, -1).join("/") || "/workspace");
  }, [filePath]);
  const crumbs = dir.split("/").filter(Boolean);
  return (
    <div className="files-tab">
      <div className="crumbs">
        {crumbs.map((c, i) => {
          const p = "/" + crumbs.slice(0, i + 1).join("/");
          return <span key={p}><button onClick={() => { setDir(p); setFilePath(null); }}>{c}</button>{i < crumbs.length - 1 && " / "}</span>;
        })}
      </div>
      {err && <div className="error small">{err}</div>}
      <div className={`file-list ${filePath ? "short" : ""}`}>
        {dir !== "/workspace" && (
          <div className="file-row" onClick={() => { setDir(dir.split("/").slice(0, -1).join("/") || "/workspace"); setFilePath(null); }}>
            <span className="f-ico">↰</span><span className="f-name">..</span>
          </div>
        )}
        {entries.length === 0 && <div className="empty small">（空的）</div>}
        {entries.map((e) => (
          <div key={e.path} className={`file-row ${e.path === filePath ? "on" : ""}`}
               onClick={() => (e.dir ? (setDir(e.path), setFilePath(null)) : setFilePath(e.path))}>
            <span className="f-ico">{e.dir ? "▸" : IMG.includes(ext(e.name)) ? "◩" : "◱"}</span>
            <span className="f-name">{e.name}</span>
            {!e.dir && <span className="muted small">{fmtSize(e.size)}</span>}
          </div>
        ))}
      </div>
      {filePath && <FilePreview threadId={threadId} path={filePath} tick={tick} onClose={() => setFilePath(null)} />}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 301);
    const sep = lines[0]?.includes("\t") ? "\t" : lines[0]?.includes(",") ? "," : /\s+/;
    return lines.map((l) => l.trim().split(sep as any));
  }, [text]);
  return (
    <div className="csv-wrap"><table className="csv"><tbody>
      {rows.map((r, i) => <tr key={i}>{r.map((c, j) => i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>)}</tr>)}
    </tbody></table></div>
  );
}

export function FilePreview({ threadId, path, tick, onClose }: { threadId: string; path: string; tick: number; onClose?: () => void }) {
  const e = ext(path);
  const [text, setText] = useState<string | null>(null);
  const [trunc, setTrunc] = useState(false);
  const [err, setErr] = useState("");
  const hasExt = (path.split("/").pop() || "").includes(".");
  const isText = TEXT.includes(e) || !hasExt;
  useEffect(() => {
    setText(null); setErr("");
    if (!isText) return;
    fetchText(threadId, path, 800_000).then((r) => { setText(r.text); setTrunc(r.truncated); }).catch((x) => setErr(x.message));
  }, [threadId, path, tick]);
  const name = path.split("/").pop();
  return (
    <div className="preview">
      <div className="preview-head">
        <span className="mono small">{name}</span>
        <span className="spacer" />
        <a className="btn ghost small" href={fileUrl(threadId, path)} target="_blank" rel="noreferrer">新分頁</a>
        <a className="btn ghost small" href={fileUrl(threadId, path, true)}>下載</a>
        {onClose && <button className="icon" onClick={onClose}>✕</button>}
      </div>
      <div className="preview-body">
        {IMG.includes(e) && <img src={fileUrl(threadId, path)} alt={name} className="preview-img" />}
        {e === "pdf" && <iframe src={fileUrl(threadId, path)} title={name} className="preview-pdf" />}
        {isText && err && <div className="error small">{err}</div>}
        {isText && text === null && !err && <div className="muted small">載入中…</div>}
        {isText && text !== null && (
          (e === "csv" || e === "tsv") ? <CsvTable text={text} />
            : e === "md" ? <Markdown text={text} threadId={threadId} />
              : e === "log" || e === "out" ? <Terminal output={text} maxLines={500} />
                : <Code code={text} lang={langFromPath(path)} />
        )}
        {trunc && <div className="muted small">（檔案太大，只顯示前 800 KB）</div>}
        {!IMG.includes(e) && e !== "pdf" && !isText && (
          <div className="empty">這種檔案（.{e}）無法在瀏覽器預覽，請下載。{e === "mph" && " 可用 COMSOL 開啟。"}</div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ status

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>;
}

function StatusTab({ threadId, tick, liveRunning, openFile }:
  { threadId: string; tick: number; liveRunning: boolean; openFile: (p: string) => void }) {
  const [st, setSt] = useState<ThreadStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => api.status(threadId).then((s) => alive && setSt(s)).catch(() => {});
    load();
    const t = setInterval(load, liveRunning ? 4000 : 15000);
    return () => { alive = false; clearInterval(t); };
  }, [threadId, tick, liveRunning]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!st) return <div className="empty">載入中…</div>;
  const run = st.run;
  const u: any = run?.usage || {};
  const started = run?.started_at ? new Date(run.started_at).getTime() : null;
  const ended = run?.finished_at ? new Date(run.finished_at).getTime() : null;
  const elapsed = started ? ((ended ?? now) - started) / 1000 : NaN;
  const statusLabel: Record<string, string> = { queued: "排隊中", running: "執行中", completed: "完成", failed: "失敗", stopped: "已停止" };
  const sb = st.sandbox;
  const sbLabel: Record<string, string> = { running: "運作中", exited: "已休眠", created: "建立中", none: "尚未建立" };
  return (
    <div className="status">
      <section className="card">
        <h4>最近一次執行</h4>
        {run ? (
          <div className="kv-grid">
            <span>狀態</span><span><span className={`badge ${run.status === "completed" ? "ok" : run.status === "failed" ? "bad" : run.status === "running" ? "run" : "warn"}`}>{statusLabel[run.status] ?? run.status}</span></span>
            <span>模型</span><span>{modelName(run.model || st.model)}</span>
            <span>耗時</span><span>{fmtDuration(elapsed)}</span>
            <span>模型回覆</span><span>{run.steps ?? 0} 次{u.requests ? `（${u.requests} 次呼叫）` : ""}</span>
            <span>Tokens</span><span>輸入 {fmtTokens((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0))} · 快取 {fmtTokens(u.cache_read_input_tokens)} · 輸出 {fmtTokens(u.output_tokens)}</span>
            {run.error && <><span>錯誤</span><span className="err-line">{run.error}</span></>}
          </div>
        ) : <div className="muted small">這個對話還沒有執行過。</div>}
      </section>

      <section className="card">
        <h4>沙盒與 GPU</h4>
        <div className="kv-grid">
          <span>沙盒</span><span><span className={`badge ${sb.state === "running" ? "ok" : "info"}`}>{sbLabel[sb.state] ?? sb.state}</span>
            {sb.state === "exited" && <span className="muted small"> 下次執行時自動喚醒，檔案都保留</span>}</span>
          {sb.gpu && <>
            <span>GPU</span><span>{sb.gpu.name}</span>
            <span>顯示記憶體</span><span>{(sb.gpu.mem_used_mb / 1024).toFixed(1)} / {(sb.gpu.mem_total_mb / 1024).toFixed(0)} GB<Bar value={sb.gpu.mem_used_mb} max={sb.gpu.mem_total_mb} /></span>
            <span>使用率</span><span>{sb.gpu.util_pct}%<Bar value={sb.gpu.util_pct} max={100} /></span>
          </>}
        </div>
      </section>

      {st.kb && st.kb.docs > 0 && (
        <section className="card">
          <h4>知識庫</h4>
          <div className="kv-grid">
            <span>已匯入</span><span>{st.kb.docs} 份文件 · {st.kb.chunks} 段</span>
          </div>
          <div className="muted small">上傳的文件會自動建索引（Voyage embedding），可用 kb_search 檢索。</div>
        </section>
      )}

      <section className="card">
        <h4>COMSOL 服務</h4>
        {st.comsol ? (
          <div className="kv-grid">
            <span>狀態</span><span><span className={`badge ${st.comsol.status === "healthy" ? "ok" : "bad"}`}>{st.comsol.status === "healthy" ? "正常" : st.comsol.status}</span></span>
            <span>排隊</span><span>{st.comsol.queue_size ?? 0} 個 job</span>
            <span>執行中</span><span className="mono small">{st.comsol.running_job || "（閒置）"}</span>
          </div>
        ) : <div className="muted small">無法取得</div>}
        <div className="muted small">全實驗室共用，一次只跑一個 job。</div>
      </section>

      <section className="card">
        <h4>背景計算</h4>
        {st.jobs.length === 0 ? <div className="muted small">沒有背景計算。</div> : st.jobs.map((j) => (
          <div key={j.job_id} className="job">
            <div className="row-wrap">
              <span className={`badge ${j.status === "running" ? "run" : j.exit_code === "0" ? "ok" : "bad"}`}>
                {j.status === "running" ? "執行中" : `exit ${j.exit_code}`}</span>
              <strong className="small">{j.name}</strong>
              <span className="muted small">{j.started_at}</span>
              <button className="btn ghost small" onClick={() => openFile(j.log_path)}>看 log</button>
            </div>
            <div className="mono small muted ellip">{j.command}</div>
          </div>
        ))}
      </section>

      <section className="card">
        <h4>待辦清單 <span className="muted small">/workspace/todo.md</span></h4>
        {st.todo ? <Markdown text={st.todo} threadId={threadId} /> : <div className="muted small">agent 做多步驟工作時會在這裡記錄進度。</div>}
      </section>
    </div>
  );
}
