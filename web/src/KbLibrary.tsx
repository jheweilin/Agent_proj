import { useCallback, useEffect, useState } from "react";
import { api, KbDoc } from "./api";
import KbDocList from "./KbDocList";

// Shared base knowledge library — documents every research project can search.
export default function KbLibrary({ onClose }: { onClose: () => void }) {
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.kbBase();
      setEnabled(r.enabled);
      setCanManage(r.can_manage);
      setDocs(r.documents);
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true); setErr("");
    try { await api.kbBaseUpload(Array.from(files)); await load(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const del = async (d: KbDoc) => {
    if (!confirm(`從基礎庫刪除「${d.source}」？`)) return;
    await api.kbBaseDelete(d.id).catch(() => {});
    load();
  };

  const totalChunks = docs.reduce((a, d) => a + d.chunks, 0);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>基礎庫</h3>
          <button className="icon" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <p className="muted small">這裡的文件<strong>所有研究專案都查得到</strong>（共用）。適合放教科書、手冊、常用文獻；檢索證據與 kb_search 都會一起查。{!canManage && "（僅管理員可編輯）"}</p>
        {!enabled && <div className="error small">知識庫未啟用（部署時需設定 VOYAGE_API_KEY）。</div>}
        <div className="kb-bar">
          {canManage && (
            <label className={`btn primary small${busy || !enabled ? " disabled" : ""}`}>
              {busy ? "匯入中…" : "＋ 上傳到基礎庫"}
              <input type="file" multiple hidden disabled={busy || !enabled}
                     onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
            </label>
          )}
          {docs.length > 0 && <span className="muted small">{docs.length} 份文件 · {totalChunks} 段</span>}
        </div>
        {err && <div className="error small">{err}</div>}
        <KbDocList docs={docs} canManage={canManage} enabled={enabled} onDelete={del} onChanged={load} />
      </div>
    </div>
  );
}
