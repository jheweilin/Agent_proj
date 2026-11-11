import { useCallback, useEffect, useState } from "react";
import { api, KbDoc, Lab, User } from "./api";

// Per-lab shared knowledge library + membership management.
// Faculty create labs; members join by code (or are added by email). A lab's documents are
// searchable only from threads owned by its members.
export default function LabLibrary({ user, onClose }: { user: User; onClose: () => void }) {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [lab, setLab] = useState<Lab | null>(null);     // selected lab detail (members, join_code)
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [pending, setPending] = useState<KbDoc[]>([]);  // nominated experience notes awaiting owner review
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [newName, setNewName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [addEmail, setAddEmail] = useState("");
  // L2 specialty profile editor (owner)
  const [pSummary, setPSummary] = useState("");
  const [pKeywords, setPKeywords] = useState("");
  const [pPublic, setPPublic] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const loadLabs = useCallback(async () => {
    try {
      const r = await api.labs();
      setLabs(r.labs);
      setCanCreate(r.can_create);
      setSel((cur) => cur && r.labs.some((l) => l.id === cur) ? cur : (r.labs[0]?.id ?? null));
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { loadLabs(); }, [loadLabs]);

  const loadDetail = useCallback(async (id: string) => {
    setErr("");
    try {
      const [d, k] = await Promise.all([api.lab(id), api.labKb(id)]);
      setLab(d);
      setEnabled(k.enabled);
      setDocs(k.documents);
      setPSummary(d.summary || "");
      setPKeywords((d.keywords || []).join("、"));
      setPPublic(!!d.is_public);
      // only the owner can see / review the nomination queue
      setPending(d.role === "owner" ? (await api.labKbPending(id)).documents : []);
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { if (sel) loadDetail(sel); else { setLab(null); setDocs([]); } }, [sel, loadDetail]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const upload = (files: FileList | null) => {
    if (!files || !files.length || !sel) return;
    guard(async () => { await api.labKbUpload(sel, Array.from(files)); await loadDetail(sel); });
  };
  const delDoc = (d: KbDoc) =>
    sel && confirm(`從實驗室庫刪除「${d.source}」？`) &&
    guard(async () => { await api.labKbDelete(sel, d.id); await loadDetail(sel); });
  const review = (d: KbDoc, action: "approve" | "reject") =>
    sel && (action === "approve" || confirm(`退回並刪除「${d.source}」？`)) &&
    guard(async () => { await api.labKbReview(sel, d.id, action); await loadDetail(sel); });

  const create = () => newName.trim() &&
    guard(async () => { const l = await api.createLab(newName.trim()); setNewName(""); await loadLabs(); setSel(l.id); });
  const join = () => joinCode.trim() &&
    guard(async () => { const l = await api.joinLab(joinCode.trim()); setJoinCode(""); await loadLabs(); setSel(l.id); });
  const addMember = () => sel && addEmail.trim() &&
    guard(async () => { await api.addLabMember(sel, addEmail.trim()); setAddEmail(""); await loadDetail(sel); });
  const removeMember = (uid: string, label: string) =>
    sel && confirm(`移除成員「${label}」？`) &&
    guard(async () => { await api.removeLabMember(sel, uid); await loadDetail(sel); });
  const leave = () => sel && confirm("確定要退出這個實驗室？") &&
    guard(async () => { await api.removeLabMember(sel, user.id); await loadLabs(); });
  const regen = () => sel && confirm("重置加入碼？舊的加入碼會立即失效。") &&
    guard(async () => { await api.regenLabCode(sel); await loadDetail(sel); });

  const splitKw = (s: string) => s.split(/[、,，\s]+/).map((k) => k.trim()).filter(Boolean).slice(0, 8);
  const saveProfile = () => sel &&
    guard(async () => { await api.setLabProfile(sel, { summary: pSummary.trim(), keywords: splitKw(pKeywords), is_public: pPublic }); await loadDetail(sel); });
  const genDraft = () => sel && guard(async () => {
    setDrafting(true);
    try {
      await api.draftLabProfile(sel);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const d = await api.lab(sel);
        if (d.profile_status !== "generating") { setLab(d); break; }
      }
    } finally { setDrafting(false); }
  });
  const adoptDraft = (summary: string, keywords: string[]) => { setPSummary(summary); setPKeywords(keywords.join("、")); };

  const isOwner = lab?.role === "owner";
  let draft: { summary: string; keywords: string[] } | null = null;
  try { draft = lab?.profile_draft ? JSON.parse(lab.profile_draft) : null; } catch { draft = null; }
  const totalChunks = docs.reduce((a, d) => a + d.chunks, 0);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>實驗室庫</h3>
          <button className="icon" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <p className="muted small">實驗室的文件<strong>只有成員的研究專案查得到</strong>。由教職員建立、用加入碼或 Email 加入成員；檢索證據與 kb_search 會一起查成員所屬實驗室的庫。</p>
        {err && <div className="error small">{err}</div>}

        {labs.length > 0 && (
          <div className="lab-tabs">
            {labs.map((l) => (
              <button key={l.id} className={`lab-tab${l.id === sel ? " on" : ""}`} onClick={() => setSel(l.id)}>
                {l.name}{l.role === "owner" && <span className="muted small"> · 負責人</span>}
              </button>
            ))}
          </div>
        )}

        {lab && (
          <div className="lab-body">
            {!enabled && <div className="error small">知識庫未啟用（部署時需設定 VOYAGE_API_KEY）。</div>}
            <div className="kb-bar">
              <label className={`btn primary small${busy || !enabled ? " disabled" : ""}`}>
                {busy ? "處理中…" : "＋ 上傳到實驗室庫"}
                <input type="file" multiple hidden disabled={busy || !enabled}
                       onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
              </label>
              {docs.length > 0 && <span className="muted small">{docs.length} 份文件 · {totalChunks} 段</span>}
            </div>
            <div className="kb-list">
              {docs.length === 0 && enabled && <div className="muted small pad">這個實驗室庫還沒有文件。</div>}
              {docs.map((d) => (
                <div key={d.id} className="kb-row">
                  <div className="kb-main">
                    <span className="kb-name" title={d.source}>{d.source}</span>
                    {d.kind === "experience" && <span className="kb-badge">研究經驗</span>}
                    <span className="muted small">{d.chunks} 段</span>
                  </div>
                  <button className="icon" title="從實驗室庫刪除" onClick={() => delDoc(d)}>✕</button>
                </div>
              ))}
            </div>

            {isOwner && pending.length > 0 && (
              <>
                <div className="lab-sec-title">待審納入 <span className="muted small"> · {pending.length} 份研究經驗等你審核</span></div>
                <div className="kb-list">
                  {pending.map((d) => (
                    <div key={d.id} className="kb-row pending">
                      <div className="kb-main">
                        <span className="kb-name" title={d.source}>{d.source}</span>
                        {d.submitted_by_name && <span className="muted small">由 {d.submitted_by_name} 提名 · {d.chunks} 段</span>}
                      </div>
                      <button className="btn small" disabled={busy} onClick={() => review(d, "approve")}>納入</button>
                      <button className="icon" title="退回並刪除" disabled={busy} onClick={() => review(d, "reject")}>✕</button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {isOwner && (
              <>
                <div className="lab-sec-title">專長名片 <span className="muted small"> · 公開到跨實驗室名錄（只放方向與關鍵字，不含內容）</span></div>
                <div className="lab-profile">
                  <label className="prof-public">
                    <input type="checkbox" checked={pPublic} disabled={busy} onChange={(e) => setPPublic(e.target.checked)} />
                    <span>公開到名錄（讓別的實驗室搜尋得到）</span>
                  </label>
                  <textarea className="prof-summary" rows={3} value={pSummary} disabled={busy}
                            placeholder="用 3～5 句話描述研究方向與專長…" onChange={(e) => setPSummary(e.target.value)} />
                  <input className="search" value={pKeywords} disabled={busy}
                         placeholder="關鍵字，用、或逗號分隔（最多 8 個）" onChange={(e) => setPKeywords(e.target.value)} />
                  <div className="prof-actions">
                    <button className="btn primary small" disabled={busy} onClick={saveProfile}>儲存名片</button>
                    <button className="btn small" disabled={busy || drafting || !enabled}
                            onClick={genDraft} title="讓 AI 讀實驗室庫草擬一版">
                      {drafting ? "AI 草擬中…" : "AI 生成草稿"}
                    </button>
                  </div>
                  {draft && (draft.summary || draft.keywords?.length) && (
                    <div className="prof-draft">
                      <div className="muted small">AI 草稿（可採用後再修改）：</div>
                      {draft.summary && <div className="prof-draft-sum">{draft.summary}</div>}
                      {draft.keywords?.length > 0 && <div className="dir-tags">{draft.keywords.map((k) => <span key={k} className="dir-tag">{k}</span>)}</div>}
                      <button className="btn small" disabled={busy} onClick={() => adoptDraft(draft!.summary, draft!.keywords || [])}>採用草稿</button>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="lab-sec-title">成員{lab.member_count != null && <span className="muted small"> · {lab.member_count} 人</span>}</div>
            {isOwner && (
              <div className="lab-code">
                <span className="muted small">加入碼</span>
                <code className="join-code">{lab.join_code}</code>
                <button className="btn small" disabled={busy}
                        onClick={() => navigator.clipboard?.writeText(lab.join_code || "").catch(() => {})}>複製</button>
                <button className="btn small" disabled={busy} onClick={regen}>重置</button>
              </div>
            )}
            <div className="kb-list">
              {lab.members?.map((m) => (
                <div key={m.user_id} className="kb-row">
                  <div className="kb-main">
                    <span className="kb-name">{m.name || m.email}</span>
                    <span className="muted small">{m.role === "owner" ? "負責人" : m.email}</span>
                  </div>
                  {isOwner && m.role !== "owner" &&
                    <button className="icon" title="移除成員" onClick={() => removeMember(m.user_id, m.name || m.email)}>✕</button>}
                </div>
              ))}
            </div>
            {isOwner ? (
              <div className="lab-form">
                <input className="search" placeholder="用 Email 加入已註冊成員…" value={addEmail}
                       onChange={(e) => setAddEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addMember()} />
                <button className="btn small" disabled={busy || !addEmail.trim()} onClick={addMember}>加入</button>
              </div>
            ) : (
              <div className="lab-form"><button className="btn small" disabled={busy} onClick={leave}>退出這個實驗室</button></div>
            )}
          </div>
        )}

        {labs.length === 0 && <div className="muted small pad">你還沒有加入任何實驗室。{canCreate ? "建立一個，或" : "請"}用加入碼加入。</div>}

        <div className="lab-actions">
          {canCreate && (
            <div className="lab-form">
              <input className="search" placeholder="實驗室名稱…" value={newName}
                     onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
              <button className="btn primary small" disabled={busy || !newName.trim()} onClick={create}>建立實驗室</button>
            </div>
          )}
          <div className="lab-form">
            <input className="search" placeholder="輸入加入碼…" value={joinCode}
                   onChange={(e) => setJoinCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && join()} />
            <button className="btn small" disabled={busy || !joinCode.trim()} onClick={join}>加入</button>
          </div>
        </div>
      </div>
    </div>
  );
}
