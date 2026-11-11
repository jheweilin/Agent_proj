import { useEffect, useState } from "react";
import { api, DirectoryLab, Lab } from "./api";

// Public cross-lab specialty directory (L2+L3). Shows each lab's specialty card (name, summary,
// keywords) — no content — and lets an owner request access to another lab's knowledge (L3);
// the grantor's owner then decides whether and at what granularity to grant.
export default function LabDirectory({ onClose }: { onClose: () => void }) {
  const [labs, setLabs] = useState<DirectoryLab[] | null>(null);
  const [owned, setOwned] = useState<Lab[]>([]);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);  // card whose request form is open
  const [grantee, setGrantee] = useState("");                 // my lab making the request
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());  // cards showing their full summary
  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  useEffect(() => {
    api.labDirectory().then((r) => setLabs(r.labs)).catch((e) => setErr(e.message));
    api.labs().then((r) => {
      const mine = r.labs.filter((l) => l.role === "owner");
      setOwned(mine); setGrantee(mine[0]?.id || "");
    }).catch(() => {});
  }, []);

  const shown = (labs || []).filter((l) => {
    const t = q.trim().toLowerCase();
    return !t || l.name.toLowerCase().includes(t) || l.summary.toLowerCase().includes(t)
      || l.keywords.some((k) => k.toLowerCase().includes(t));
  });

  const send = (grantorId: string) => {
    if (!grantee) return;
    setBusy(true); setErr("");
    api.requestGrant(grantee, grantorId, note.trim())
      .then(() => { setSent((s) => new Set(s).add(grantorId)); setOpenId(null); setNote(""); })
      .catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>實驗室名錄</h3>
          <button className="icon" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <p className="muted small">各實驗室<strong>自願公開</strong>的專長名片（只有方向與關鍵字、不含內容）。想跨領域合作可向對方<strong>申請授權</strong>，由對方負責人決定是否提供、提供整庫或部分。</p>
        {err && <div className="error small">{err}</div>}
        <input className="search" placeholder="搜尋領域、關鍵字…" value={q} onChange={(e) => setQ(e.target.value)}
               style={{ width: "100%", boxSizing: "border-box", marginBottom: 4 }} />
        {labs === null && <div className="muted small pad">載入中…</div>}
        {labs !== null && shown.length === 0 && (
          <div className="muted small pad">{labs.length === 0 ? "目前還沒有實驗室公開專長名片。" : "沒有符合的實驗室。"}</div>
        )}
        <div className="dir-list">
          {shown.map((l) => {
            const canAsk = owned.length > 0 && !owned.some((o) => o.id === l.id);
            return (
              <div key={l.id} className="dir-card">
                <div className="dir-head">
                  <strong>{l.name}</strong>
                  <span className="muted small">{l.member_count} 名成員{l.is_member ? " · 你已加入" : ""}</span>
                </div>
                {l.summary && (<>
                  <div className={`dir-summary${expanded.has(l.id) ? "" : " clamp"}`}>{l.summary}</div>
                  {l.summary.length > 100 &&
                    <button className="dir-more" onClick={() => toggleExpand(l.id)}>{expanded.has(l.id) ? "收合" : "…更多"}</button>}
                </>)}
                {l.keywords.length > 0 && (
                  <div className="dir-tags">{l.keywords.map((k) => <span key={k} className="dir-tag">{k}</span>)}</div>
                )}
                <div className="dir-foot">
                  {sent.has(l.id) ? <span className="muted small">✓ 已送出合作申請，等對方負責人回覆</span>
                    : canAsk ? (openId === l.id ? null : <button className="btn small" onClick={() => setOpenId(l.id)}>申請合作</button>)
                    : owned.length === 0 ? <span className="muted small">需先擁有實驗室才能申請合作</span> : null}
                </div>
                {openId === l.id && (
                  <div className="dir-req">
                    {owned.length > 1 && (
                      <select value={grantee} onChange={(e) => setGrantee(e.target.value)} disabled={busy}>
                        {owned.map((o) => <option key={o.id} value={o.id}>以「{o.name}」申請</option>)}
                      </select>
                    )}
                    <input className="search" placeholder="想了解什麼／合作目的（可留空）" value={note}
                           onChange={(e) => setNote(e.target.value)} disabled={busy} />
                    <div className="dir-req-actions">
                      <button className="btn primary small" disabled={busy} onClick={() => send(l.id)}>送出申請</button>
                      <button className="btn ghost small" disabled={busy} onClick={() => setOpenId(null)}>取消</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
