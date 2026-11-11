import { useCallback, useEffect, useState } from "react";
import { api, Grant, KbDoc, Lab, User } from "./api";
import KbDocList from "./KbDocList";

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
  // L3 grants (owner) + per-doc tag editing
  const [grants, setGrants] = useState<{ incoming: Grant[]; outgoing: Grant[] }>({ incoming: [], outgoing: [] });
  const [approveFor, setApproveFor] = useState<string | null>(null);  // grant id being approved
  const [aScope, setAScope] = useState<"full" | "documents" | "tags">("full");
  const [aDocs, setADocs] = useState<Set<string>>(new Set());
  const [aTags, setATags] = useState("");
  const [section, setSection] = useState("files");   // which left-rail section is shown

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
      // only the owner can see / review the nomination queue + grants
      if (d.role === "owner") {
        setPending((await api.labKbPending(id)).documents);
        setGrants(await api.labGrants(id));
      } else { setPending([]); setGrants({ incoming: [], outgoing: [] }); }
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => {
    if (sel) { loadDetail(sel); setSection((x) => (x === "manage" ? "files" : x)); }
    else { setLab(null); setDocs([]); setSection("manage"); }
  }, [sel, loadDetail]);

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

  const openApprove = (gid: string) => { setApproveFor(gid); setAScope("full"); setADocs(new Set()); setATags(""); };
  const doApprove = (gid: string) => sel && guard(async () => {
    const ref = aScope === "documents" ? Array.from(aDocs) : aScope === "tags" ? splitKw(aTags) : [];
    await api.actGrant(gid, "approve", { scope: aScope, scope_ref: ref });
    setApproveFor(null); await loadDetail(sel);
  });
  const grantAct = (gid: string, action: "reject" | "revoke") =>
    sel && (action === "reject" || confirm("收回這個授權？對方將立即無法再檢索到。")) &&
    guard(async () => { await api.actGrant(gid, action); await loadDetail(sel); });

  const GRANT_STATUS: Record<string, string> = {
    requested: "申請中", granted: "已授權", rejected: "已拒絕", revoked: "已收回",
  };
  const SCOPE_LABEL: Record<string, string> = { full: "整庫", documents: "指定文件", tags: "指定主題" };

  const isOwner = lab?.role === "owner";
  let draft: { summary: string; keywords: string[] } | null = null;
  try { draft = lab?.profile_draft ? JSON.parse(lab.profile_draft) : null; } catch { draft = null; }
  const totalChunks = docs.reduce((a, d) => a + d.chunks, 0);

  const pendingN = pending.length;
  const requestsN = grants.incoming.filter((g) => g.status === "requested").length;
  const railBtn = (key: string, label: string, badge?: number) => (
    <button className={`lablib-tab${section === key ? " on" : ""}`} onClick={() => setSection(key)}>
      {label}{badge ? <span className="lablib-badge">{badge}</span> : null}
    </button>
  );

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal lablib" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>實驗室庫{lab ? `：${lab.name}` : ""}</h3>
          {labs.length > 1 && (
            <select className="lablib-switch" value={sel || ""} onChange={(e) => setSel(e.target.value)}>
              {labs.map((l) => <option key={l.id} value={l.id}>{l.name}{l.role === "owner" ? "（負責人）" : ""}</option>)}
            </select>
          )}
          <span className="spacer" />
          <button className="icon" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        {err && <div className="error small">{err}</div>}

        <div className="lablib-body">
          <nav className="lablib-rail">
            {lab && <>
              {railBtn("files", `文件 ${docs.length}`)}
              {railBtn("members", `成員 ${lab.member_count ?? ""}`)}
              {isOwner && railBtn("pending", "待審納入", pendingN)}
              {isOwner && railBtn("grants", "跨域授權", requestsN)}
              {isOwner && railBtn("profile", "專長名片")}
            </>}
            <div className="lablib-rail-sep" />
            {railBtn("manage", "＋ 建立／加入")}
          </nav>

          <div className="lablib-content">
            {section === "files" && lab && (<>
              {!enabled && <div className="error small">知識庫未啟用（部署時需設定 VOYAGE_API_KEY）。</div>}
              <p className="muted small">實驗室的文件<strong>只有成員的研究專案查得到</strong>。上傳論文 PDF 或資料；檢索證據與 kb_search 會一起查。</p>
              <div className="kb-bar">
                <label className={`btn primary small${busy || !enabled ? " disabled" : ""}`}>
                  {busy ? "處理中…" : "＋ 上傳到實驗室庫"}
                  <input type="file" multiple hidden disabled={busy || !enabled}
                         onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
                </label>
                {docs.length > 0 && <span className="muted small">{docs.length} 份文件 · {totalChunks} 段</span>}
              </div>
              <KbDocList docs={docs} canManage={enabled} enabled={enabled} onDelete={delDoc}
                         onChanged={() => sel && loadDetail(sel)} />
            </>)}

            {section === "members" && lab && (<>
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
            </>)}

            {section === "pending" && isOwner && (<>
              <div className="lab-sec-title">待審納入 <span className="muted small"> · 成員提名、你核准後才進庫並可被檢索</span></div>
              {pendingN === 0 && <div className="muted small pad">目前沒有待審的研究經驗。</div>}
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
            </>)}

            {section === "grants" && isOwner && (<>
              <div className="lab-sec-title">跨實驗室授權 <span className="muted small"> · 別的實驗室申請存取、以及你送出的申請</span></div>
              {grants.incoming.length === 0 && grants.outgoing.length === 0 &&
                <div className="muted small pad">還沒有任何跨實驗室授權往來。到「名錄」可申請存取別的實驗室。</div>}
              <div className="kb-list">
                {grants.incoming.map((g) => (
                  <div key={g.id} className="kb-doc">
                    <div className="kb-row">
                      <div className="kb-main">
                        <span className="kb-name">{g.grantee_name}</span>
                        <span className="muted small">想存取本實驗室{g.note ? `：「${g.note}」` : ""}</span>
                        <span className="grant-status">{GRANT_STATUS[g.status]}{g.status === "granted" ? `（${SCOPE_LABEL[g.scope]}）` : ""}</span>
                      </div>
                      {g.status === "requested" && approveFor !== g.id && (
                        <>
                          <button className="btn small" disabled={busy} onClick={() => openApprove(g.id)}>授權</button>
                          <button className="icon" title="拒絕" disabled={busy} onClick={() => grantAct(g.id, "reject")}>✕</button>
                        </>
                      )}
                      {g.status === "granted" && <button className="btn ghost small" disabled={busy} onClick={() => grantAct(g.id, "revoke")}>收回</button>}
                    </div>
                    {approveFor === g.id && (
                      <div className="grant-approve">
                        <div className="grant-scopes">
                          {(["full", "documents", "tags"] as const).map((sc) => (
                            <label key={sc}><input type="radio" checked={aScope === sc} onChange={() => setAScope(sc)} /> {SCOPE_LABEL[sc]}</label>
                          ))}
                        </div>
                        {aScope === "documents" && (
                          <div className="grant-docs">
                            {docs.length === 0 && <span className="muted small">這個庫還沒有文件。</span>}
                            {docs.map((d) => (
                              <label key={d.id} className="grant-doc">
                                <input type="checkbox" checked={aDocs.has(d.id)} onChange={(e) =>
                                  setADocs((s) => { const n = new Set(s); e.target.checked ? n.add(d.id) : n.delete(d.id); return n; })} />
                                <span className="kb-name">{d.title || d.source}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {aScope === "tags" && (
                          <input className="search" placeholder="授權哪些主題標籤，用、或逗號分隔" value={aTags}
                                 disabled={busy} onChange={(e) => setATags(e.target.value)} />
                        )}
                        <div className="prof-actions">
                          <button className="btn primary small" disabled={busy || (aScope === "documents" && aDocs.size === 0)}
                                  onClick={() => doApprove(g.id)}>確認授權</button>
                          <button className="btn ghost small" disabled={busy} onClick={() => setApproveFor(null)}>取消</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {grants.outgoing.map((g) => (
                  <div key={g.id} className="kb-row">
                    <div className="kb-main">
                      <span className="kb-name">已向 {g.grantor_name} 申請</span>
                      <span className="grant-status">{GRANT_STATUS[g.status]}{g.status === "granted" ? `（${SCOPE_LABEL[g.scope]}）` : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>)}

            {section === "profile" && isOwner && (<>
              <div className="lab-sec-title">專長名片 <span className="muted small"> · 公開到跨實驗室名錄（只放方向與關鍵字，不含內容）</span></div>
              <div className="lab-profile">
                <label className="prof-public">
                  <input type="checkbox" checked={pPublic} disabled={busy} onChange={(e) => setPPublic(e.target.checked)} />
                  <span>公開到名錄（讓別的實驗室搜尋得到）</span>
                </label>
                <textarea className="prof-summary" rows={4} value={pSummary} disabled={busy}
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
            </>)}

            {section === "manage" && (<>
              <div className="lab-sec-title">建立／加入實驗室</div>
              {labs.length === 0 && <p className="muted small">你還沒有加入任何實驗室。{canCreate ? "建立一個，或" : "請"}用加入碼加入。</p>}
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
              {!canCreate && <p className="muted small">（只有教職員能建立實驗室。）</p>}
            </>)}
          </div>
        </div>
      </div>
    </div>
  );
}
