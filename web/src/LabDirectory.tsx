import { useEffect, useState } from "react";
import { api, DirectoryLab } from "./api";

// Public cross-lab specialty directory (L2). Shows only each lab's specialty card (name, summary,
// keywords) — no content. Discovering who to ask; the request/grant flow (L3) comes next.
export default function LabDirectory({ onClose }: { onClose: () => void }) {
  const [labs, setLabs] = useState<DirectoryLab[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    api.labDirectory().then((r) => setLabs(r.labs)).catch((e) => setErr(e.message));
  }, []);

  const shown = (labs || []).filter((l) => {
    const t = q.trim().toLowerCase();
    return !t || l.name.toLowerCase().includes(t) || l.summary.toLowerCase().includes(t)
      || l.keywords.some((k) => k.toLowerCase().includes(t));
  });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>實驗室名錄</h3>
          <button className="icon" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <p className="muted small">各實驗室<strong>自願公開</strong>的專長名片（只有方向與關鍵字、不含內容），用來尋找跨領域合作對象。跨實驗室申請授權將在下一階段開放。</p>
        {err && <div className="error small">{err}</div>}
        <input className="search" placeholder="搜尋領域、關鍵字…" value={q} onChange={(e) => setQ(e.target.value)}
               style={{ width: "100%", boxSizing: "border-box", marginBottom: 4 }} />
        {labs === null && <div className="muted small pad">載入中…</div>}
        {labs !== null && shown.length === 0 && (
          <div className="muted small pad">{labs.length === 0 ? "目前還沒有實驗室公開專長名片。" : "沒有符合的實驗室。"}</div>
        )}
        <div className="dir-list">
          {shown.map((l) => (
            <div key={l.id} className="dir-card">
              <div className="dir-head">
                <strong>{l.name}</strong>
                <span className="muted small">{l.member_count} 名成員{l.is_member ? " · 你已加入" : ""}</span>
              </div>
              {l.summary && <div className="dir-summary">{l.summary}</div>}
              {l.keywords.length > 0 && (
                <div className="dir-tags">{l.keywords.map((k) => <span key={k} className="dir-tag">{k}</span>)}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
