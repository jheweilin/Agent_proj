import { useState } from "react";
import { api, fmtSize, KbDoc, kbDocFileUrl } from "./api";

// Shared file-manager list for the base + lab knowledge libraries. Shows each document's type,
// size, date, chunk count and tags; lets you preview the retained original (inline PDF/image/text),
// inspect the extracted text that was embedded, edit title/tags, replace the file, or delete.
function icon(doc: KbDoc): string {
  const m = doc.mime || "", s = (doc.source || "").toLowerCase();
  if (m === "application/pdf" || s.endsWith(".pdf")) return "📕";
  if (m.startsWith("image/")) return "🖼";
  if (s.endsWith(".md") || s.endsWith(".markdown")) return "📝";
  if (m.startsWith("text/") || s.match(/\.(txt|csv|tsv|json|tex|rst|log|ya?ml|py)$/)) return "📄";
  return "📎";
}

export default function KbDocList({ docs, canManage, enabled, onDelete, onChanged }: {
  docs: KbDoc[]; canManage: boolean; enabled: boolean;
  onDelete: (doc: KbDoc) => void; onChanged: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);   // docId whose original is previewed
  const [textFor, setTextFor] = useState<string | null>(null);   // docId whose extracted text is shown
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [eTitle, setETitle] = useState("");
  const [eTags, setETags] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const showText = (d: KbDoc) => {
    if (textFor === d.id) { setTextFor(null); return; }
    setPreview(null);
    guard(async () => { const r = await api.kbDocText(d.id); setText(r.text); setTextFor(d.id); });
  };
  const togglePreview = (d: KbDoc) => { setTextFor(null); setPreview((p) => (p === d.id ? null : d.id)); };
  const startEdit = (d: KbDoc) => { setEditing(d.id); setETitle(d.title || d.source); setETags((d.tags || []).join("、")); };
  const splitTags = (s: string) => s.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
  const saveEdit = (d: KbDoc) => guard(async () => {
    await api.kbDocEdit(d.id, { title: eTitle.trim(), tags: splitTags(eTags) }); setEditing(null); onChanged();
  });
  const replace = (d: KbDoc, f: File | null) => f && guard(async () => { await api.kbDocReplace(d.id, f); onChanged(); });

  if (docs.length === 0) return <div className="muted small pad">{enabled ? "還沒有文件。" : "知識庫未啟用。"}</div>;

  return (
    <div className="kbfiles">
      {err && <div className="error small">{err}</div>}
      {docs.map((d) => {
        const isPdf = (d.mime === "application/pdf") || (d.source || "").toLowerCase().endsWith(".pdf");
        const isImg = (d.mime || "").startsWith("image/");
        return (
          <div key={d.id} className="kbfile">
            <div className="kbfile-row">
              <span className="kbfile-icon">{icon(d)}</span>
              <div className="kbfile-main">
                <div className="kbfile-name" title={d.source}>
                  {d.title || d.source}
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
                {d.has_file && <button className="btn ghost small" onClick={() => togglePreview(d)}>預覽</button>}
                {d.has_file && <a className="btn ghost small" href={kbDocFileUrl(d.id, true)} target="_blank" rel="noreferrer">下載</a>}
                <button className="btn ghost small" onClick={() => showText(d)}>文字</button>
                {canManage && <button className="btn ghost small" disabled={busy} onClick={() => startEdit(d)}>編輯</button>}
                {canManage && <label className={`btn ghost small${busy ? " disabled" : ""}`}>替換
                  <input type="file" hidden disabled={busy} onChange={(e) => { replace(d, e.target.files?.[0] || null); e.target.value = ""; }} /></label>}
                {canManage && <button className="icon" title="刪除" disabled={busy} onClick={() => onDelete(d)}>✕</button>}
              </div>
            </div>

            {editing === d.id && (
              <div className="kbfile-edit">
                <input className="search" value={eTitle} disabled={busy} placeholder="顯示標題"
                       onChange={(e) => setETitle(e.target.value)} />
                <input className="search" value={eTags} disabled={busy} placeholder="主題標籤，用、或逗號分隔"
                       onChange={(e) => setETags(e.target.value)} />
                <div className="prof-actions">
                  <button className="btn primary small" disabled={busy} onClick={() => saveEdit(d)}>儲存</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                </div>
              </div>
            )}
            {preview === d.id && (
              isImg ? <img className="kbfile-preview-img" src={kbDocFileUrl(d.id)} alt={d.source} />
                    : <iframe className="kbfile-preview" src={kbDocFileUrl(d.id)} title={d.source} />
            )}
            {textFor === d.id && <pre className="kbfile-text">{text || "（沒有抽取到文字）"}</pre>}
          </div>
        );
      })}
    </div>
  );
}
