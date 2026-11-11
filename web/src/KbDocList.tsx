import { useState } from "react";
import { api, fmtSize, KbDoc, kbDocFileUrl } from "./api";
import { Markdown } from "./Render";

// Minimal stroke icons (Feather/Lucide style) for the per-file action row — keeps the list tidy
// instead of a wall of text buttons; each button carries a title tooltip for its meaning.
const sv = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IcEye = () => <svg {...sv}><path d="M1.5 12s3.8-7 10.5-7 10.5 7 10.5 7-3.8 7-10.5 7S1.5 12 1.5 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
const IcDownload = () => <svg {...sv}><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></svg>;
const IcChat = () => <svg {...sv}><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" /></svg>;
const IcText = () => <svg {...sv}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h6" /></svg>;
const IcTrash = () => <svg {...sv}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M6 6v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>;
const IcClose = () => <svg {...sv}><path d="M6 6l12 12" /><path d="M18 6 6 18" /></svg>;
const IcExternal = () => <svg {...sv}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg>;

// Shared file-manager list for the base + lab knowledge libraries. Shows each document's type,
// size, date, chunk count and tags; lets you preview the retained original (PDF/image in a lightbox),
// inspect the extracted text that was embedded, edit title/tags, replace the file, or delete.
function icon(doc: KbDoc): string {
  const m = doc.mime || "", s = (doc.source || "").toLowerCase();
  if (m === "application/pdf" || s.endsWith(".pdf")) return "📕";
  if (m.startsWith("image/")) return "🖼";
  if (s.endsWith(".md") || s.endsWith(".markdown")) return "📝";
  if (m.startsWith("text/") || s.match(/\.(txt|csv|tsv|json|tex|rst|log|ya?ml|py)$/)) return "📄";
  return "📎";
}

export default function KbDocList({ docs, canManage, enabled, onDelete, onChanged, query }: {
  docs: KbDoc[]; canManage: boolean; enabled: boolean;
  onDelete: (doc: KbDoc) => void; onChanged: () => void; query?: string;
}) {
  const [preview, setPreview] = useState<KbDoc | null>(null);    // doc whose original is previewed in the lightbox
  const [textFor, setTextFor] = useState<string | null>(null);   // docId whose extracted text is shown
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [eTitle, setETitle] = useState("");
  const [eTags, setETags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const showText = (d: KbDoc) => {
    if (textFor === d.id) { setTextFor(null); return; }
    guard(async () => { const r = await api.kbDocText(d.id); setText(r.text); setTextFor(d.id); });
  };
  const startEdit = (d: KbDoc) => { setEditing(d.id); setETitle(d.title || d.source); setETags(d.tags || []); setNewTag(""); };
  const toggleTag = (t: string) => setETags((xs) => xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t].slice(0, 12));
  const addTag = () => { const t = newTag.trim(); if (t && !eTags.includes(t)) setETags((xs) => [...xs, t].slice(0, 12)); setNewTag(""); };
  const saveEdit = (d: KbDoc) => guard(async () => {
    await api.kbDocEdit(d.id, { title: eTitle.trim(), tags: eTags }); setEditing(null); onChanged();
  });

  // Tags are selected, not typed: the pool is the union of tags already used across this library.
  const libTags = Array.from(new Set(docs.flatMap((d) => d.tags || []))).sort();

  if (docs.length === 0) return <div className="muted small pad">{enabled ? "還沒有文件。" : "知識庫未啟用。"}</div>;

  const needle = (query || "").trim().toLowerCase();
  const shown = needle
    ? docs.filter((d) => [d.title, d.source, ...(d.tags || [])].some((x) => (x || "").toLowerCase().includes(needle)))
    : docs;

  return (
    <div className="kbfiles">
      {err && <div className="error small">{err}</div>}
      {shown.length === 0 && <div className="muted small pad">沒有符合「{query}」的文件。</div>}
      {shown.map((d) => {
        return (
          <div key={d.id} className="kbfile">
            <div className="kbfile-row">
              <span className="kbfile-icon">{icon(d)}</span>
              <div className="kbfile-main">
                <div className="kbfile-name">
                  <span className={`kbfile-title${canManage ? " editable" : ""}`}
                        title={canManage ? "點擊以編輯名稱與標籤" : (d.title || d.source)}
                        onClick={canManage ? () => startEdit(d) : undefined}>{d.title || d.source}</span>
                  {d.kind === "experience" && <span className="kb-badge">研究經驗</span>}
                </div>
                <div className="kbfile-meta muted small">
                  {d.size ? fmtSize(d.size) : "—"} · {d.chunks} 段
                  {d.created_at && ` · ${new Date(d.created_at).toLocaleDateString("zh-TW")}`}
                  {!d.has_file && " · 無原始檔"}
                </div>
                {(d.tags || []).length > 0 && <div className="dir-tags">{d.tags!.map((t) => <span key={t} className="dir-tag">{t}</span>)}</div>}
              </div>
              <div className="kbfile-actions">
                {d.has_file && <button className="iconbtn" title="預覽原始檔" onClick={() => setPreview(d)}><IcEye /></button>}
                {d.has_file && <a className="iconbtn" title="下載" href={kbDocFileUrl(d.id, true)} target="_blank" rel="noreferrer"><IcDownload /></a>}
                {d.kind === "experience" ? (<>
                  {d.source_thread_id && <a className="iconbtn" href={`${location.origin}${location.pathname}#/v/${d.source_thread_id}`}
                     target="_blank" rel="noreferrer" title="看完整對話：唯讀看這篇筆記的原始研究對話（含步驟與圖）；若原對話已刪除，請看「摘要」"><IcChat /></a>}
                  <button className={`iconbtn${textFor === d.id ? " on" : ""}`} onClick={() => showText(d)} title="摘要：這篇研究經驗筆記（實驗室實際留存、可被檢索的知識）"><IcText /></button>
                </>) : (
                  <button className={`iconbtn${textFor === d.id ? " on" : ""}`} onClick={() => showText(d)} title="抽取的文字內容"><IcText /></button>
                )}
                {canManage && <button className="iconbtn danger" title="刪除" disabled={busy} onClick={() => onDelete(d)}><IcTrash /></button>}
              </div>
            </div>

            {editing === d.id && (() => {
              const pool = Array.from(new Set([...libTags, ...eTags]));
              return (
              <div className="kbfile-edit">
                <label className="field-label">檔案名稱</label>
                <input className="search" value={eTitle} disabled={busy} placeholder="檔案名稱"
                       onChange={(e) => setETitle(e.target.value)} />
                <label className="field-label">主題標籤<span className="muted"> · 點選套用／取消</span></label>
                <div className="tag-pick">
                  {pool.length === 0 && <span className="muted small">尚無標籤，於下方新增。</span>}
                  {pool.map((t) => (
                    <button key={t} type="button" className={`tagchip${eTags.includes(t) ? " on" : ""}`}
                            disabled={busy} onClick={() => toggleTag(t)}>{t}</button>
                  ))}
                </div>
                <div className="tag-add">
                  <input className="search" value={newTag} disabled={busy} placeholder="新增標籤…"
                         onChange={(e) => setNewTag(e.target.value)}
                         onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} />
                  <button className="btn ghost small" type="button" disabled={busy || !newTag.trim()} onClick={addTag}>＋新增</button>
                </div>
                <div className="prof-actions">
                  <button className="btn primary small" disabled={busy} onClick={() => saveEdit(d)}>儲存</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                </div>
              </div>
              );
            })()}
            {textFor === d.id && (d.kind === "experience"
              ? <div className="pending-view">{text ? <Markdown text={text} threadId="" /> : <span className="muted small">（沒有內容）</span>}</div>
              : <pre className="kbfile-text">{text || "（沒有抽取到文字）"}</pre>)}
          </div>
        );
      })}

      {preview && (() => {
        const isImg = (preview.mime || "").startsWith("image/");
        return (
          <div className="modal-scrim" onClick={() => setPreview(null)}>
            <div className="kbprev" onClick={(e) => e.stopPropagation()}>
              <div className="kbprev-head">
                <span className="kbprev-title" title={preview.title || preview.source}>{preview.title || preview.source}</span>
                <div className="kbprev-acts">
                  <a className="iconbtn" title="在新分頁開啟" href={kbDocFileUrl(preview.id)} target="_blank" rel="noreferrer"><IcExternal /></a>
                  <a className="iconbtn" title="下載" href={kbDocFileUrl(preview.id, true)} target="_blank" rel="noreferrer"><IcDownload /></a>
                  <button className="iconbtn" title="關閉" onClick={() => setPreview(null)}><IcClose /></button>
                </div>
              </div>
              <div className="kbprev-body">
                {isImg ? <img className="kbprev-img" src={kbDocFileUrl(preview.id)} alt={preview.source} />
                       : <iframe className="kbprev-frame" src={kbDocFileUrl(preview.id)} title={preview.source} />}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
