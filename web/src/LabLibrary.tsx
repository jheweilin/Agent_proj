import { DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, copyText, Grant, KbDoc, Lab, User } from "./api";
import KbDocList from "./KbDocList";

const IcTrash = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
  <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
  <path d="M6 6v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>;
const initial = (s: string) => (s || "?").trim().charAt(0).toUpperCase();

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
  const autoDraftedRef = useRef<string | null>(null);   // auto-draft an empty profile once per lab
  // L3 grants (owner) + per-doc tag editing
  const [grants, setGrants] = useState<{ incoming: Grant[]; outgoing: Grant[] }>({ incoming: [], outgoing: [] });
  const [approveFor, setApproveFor] = useState<string | null>(null);  // grant id being approved
  const [aScope, setAScope] = useState<"full" | "documents" | "tags">("full");
  const [aDocs, setADocs] = useState<Set<string>>(new Set());
  const [aTags, setATags] = useState("");
  const [aSuggest, setASuggest] = useState<{ query: string; documents: { id: string; title: string; score: number }[]; tags: string[] } | null>(null);
  const [aLoading, setALoading] = useState(false);
  const [section, setSection] = useState("files");   // which left-rail section is shown
  const [secQ, setSecQ] = useState("");              // per-section search box (members/pending/grants)

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

  // Auto-draft the specialty card the first time an owner opens it with nothing written yet.
  useEffect(() => {
    if (section !== "profile" || lab?.role !== "owner" || !enabled || !sel || drafting) return;
    if (pSummary.trim() || autoDraftedRef.current === sel) return;
    let hasDraft = false;
    try { const d = lab?.profile_draft ? JSON.parse(lab.profile_draft) : null; hasDraft = !!(d && (d.summary || d.keywords?.length)); } catch { /* ignore */ }
    if (hasDraft) return;                       // an AI draft already waits to be adopted
    autoDraftedRef.current = sel;
    genDraft();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, sel, enabled, pSummary, lab]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const upload = (files: FileList | null) => {
    if (!files || !files.length || !sel) return;
    guard(async () => { await api.labKbUpload(sel, Array.from(files)); await loadDetail(sel); });
  };
  // drag & drop upload onto the files section (same as the chat composer)
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const onDragEnter = (e: DragEvent) => { e.preventDefault(); if (!enabled || busy) return; dragDepth.current++; setDragging(true); };
  const onDragOver = (e: DragEvent) => { e.preventDefault(); };
  const onDragLeave = (e: DragEvent) => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (!enabled || busy) return;
    upload(e.dataTransfer.files);
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

  const openApprove = async (gid: string) => {
    setApproveFor(gid); setAScope("full"); setADocs(new Set()); setATags(""); setASuggest(null); setALoading(true);
    try {
      const sg = await api.grantSuggest(gid);
      setASuggest(sg);
      if (sg.documents.length) { setAScope("documents"); setADocs(new Set(sg.documents.map((d) => d.id))); }
      if (sg.tags.length) setATags(sg.tags.join("、"));
    } catch { /* suggestion is best-effort; owner can still pick manually */ }
    finally { setALoading(false); }
  };
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
  // count = neutral tally (文件/成員); alert = action-needed pill (待審/跨域)
  const railBtn = (key: string, label: string, opts?: { count?: number; alert?: number }) => (
    <button className={`lablib-tab${section === key ? " on" : ""}`} onClick={() => { setSection(key); setSecQ(""); }}>
      <span className="lablib-tab-label">{label}</span>
      {opts?.count != null && <span className="lablib-count">{opts.count}</span>}
      {opts?.alert ? <span className="lablib-badge">{opts.alert}</span> : null}
    </button>
  );

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal lablib" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>實驗室管理{lab ? `：${lab.name}` : ""}</h3>
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
              {railBtn("files", "文件", { count: docs.length })}
              {railBtn("members", "成員", { count: lab.member_count ?? undefined })}
              {isOwner && railBtn("pending", "待審納入", { alert: pendingN })}
              {isOwner && railBtn("grants", "跨域授權", { alert: requestsN })}
              {isOwner && railBtn("profile", "專長名片")}
            </>}
            <div className="lablib-rail-sep" />
            {railBtn("manage", canCreate ? "＋ 建立／加入" : "＋ 加入實驗室")}
          </nav>

          <div className="lablib-content">
            {section === "files" && lab && (
              <div className={`kb-drop${dragging ? " over" : ""}`}
                   onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
                {dragging && <div className="kb-drop-hint">⬆ 放開即可上傳到實驗室庫</div>}
                {!enabled && <div className="error small">知識庫未啟用（部署時需設定 VOYAGE_API_KEY）。</div>}
                <p className="muted small">實驗室的文件<strong>只有成員的研究專案查得到</strong>。上傳論文 PDF 或資料（可多檔、可直接拖曳到這裡）；檢索證據與 kb_search 會一起查。</p>
                <div className="kb-bar">
                  <label className={`btn primary small${busy || !enabled ? " disabled" : ""}`}>
                    {busy ? "處理中…" : "＋ 上傳到實驗室庫"}
                    <input type="file" multiple hidden disabled={busy || !enabled}
                           onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
                  </label>
                  {docs.length > 0 && <span className="muted small">{docs.length} 份文件 · {totalChunks} 段</span>}
                  {docs.length > 1 && <input className="search kb-search" placeholder="搜尋文件…" value={secQ} onChange={(e) => setSecQ(e.target.value)} />}
                </div>
                <KbDocList docs={docs} canManage={enabled} enabled={enabled} onDelete={delDoc}
                           query={secQ} allowConfidential onChanged={() => sel && loadDetail(sel)} />
              </div>
            )}

            {section === "members" && lab && (<>
              <div className="lab-toolbar">
                <div className="lab-toolbar-top">
                  <div className="lab-sec-title">成員{lab.member_count != null && <span className="muted small"> · {lab.member_count} 人</span>}</div>
                  {(lab.members?.length ?? 0) > 1 &&
                    <input className="search kb-search" placeholder="搜尋成員…" value={secQ} onChange={(e) => setSecQ(e.target.value)} />}
                </div>
                {isOwner && (
                  <div className="lab-toolbar-actions">
                    <input className="search" placeholder="用 Email 加入已註冊成員…" value={addEmail}
                           onChange={(e) => setAddEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addMember()} />
                    <button className="btn primary small" disabled={busy || !addEmail.trim()} onClick={addMember}>加入</button>
                    <span className="lab-code">
                      <span className="muted small hint"
                            data-tip="把這組加入碼給你的學生／成員，他們在頂部「實驗室管理 → 建立／加入」輸入即可加入本實驗室。按「重置」會讓舊碼立即失效。">加入碼 ⓘ</span>
                      <code className="join-code">{lab.join_code}</code>
                      <button className="btn small hint" data-tip="複製加入碼" disabled={busy}
                              onClick={() => copyText(lab.join_code || "")}>複製</button>
                      <button className="btn small hint" data-tip="產生新的加入碼，舊碼立即失效" disabled={busy} onClick={regen}>重置</button>
                    </span>
                  </div>
                )}
              </div>
              <div className="kb-list member-list">
                {(lab.members || [])
                  .filter((m) => !secQ.trim() || [m.name, m.email].some((x) => (x || "").toLowerCase().includes(secQ.trim().toLowerCase())))
                  .map((m) => (
                  <div key={m.user_id} className="kb-row">
                    <span className="kb-avatar">{initial(m.name || m.email)}</span>
                    <div className="kb-main">
                      <span className="kb-name">{m.name || m.email}</span>
                      {m.role === "owner" && <span className="role-badge">負責人</span>}
                      <span className="muted small kb-sub">{m.email}</span>
                    </div>
                    {isOwner && m.role !== "owner" &&
                      <button className="iconbtn danger" title="移除成員" disabled={busy}
                              onClick={() => removeMember(m.user_id, m.name || m.email)}><IcTrash /></button>}
                  </div>
                ))}
              </div>
              {!isOwner && (
                <div className="lab-footer"><button className="btn ghost small" disabled={busy} onClick={leave}>退出這個實驗室</button></div>
              )}
            </>)}

            {section === "pending" && isOwner && (<>
              <div className="lab-toolbar">
                <div className="lab-toolbar-top">
                  <div className="lab-sec-title">待審納入 <span className="muted small"> · 成員提名、你核准後才進庫並可被檢索</span></div>
                  {pendingN > 1 &&
                    <input className="search kb-search" placeholder="搜尋待審…" value={secQ} onChange={(e) => setSecQ(e.target.value)} />}
                </div>
              </div>
              {pendingN === 0 && <div className="muted small pad">目前沒有待審的研究經驗。</div>}
              <div className="kb-list">
                {pending
                  .filter((d) => !secQ.trim() || [d.source, d.submitted_by_name].some((x) => (x || "").toLowerCase().includes(secQ.trim().toLowerCase())))
                  .map((d) => (
                  <div key={d.id} className="kb-row lab-card await">
                    <div className="kb-main">
                      <span className="kb-name" title={d.source}>{d.source}</span>
                      {d.submitted_by_name && <span className="muted small">由 {d.submitted_by_name} 提名 · {d.chunks} 段</span>}
                    </div>
                    {d.source_thread_id && (
                      <a className="btn ghost small" href={`${location.origin}${location.pathname}#/v/${d.source_thread_id}`}
                         target="_blank" rel="noreferrer" title="唯讀看學生當初的完整研究對話（含步驟與圖）">看完整對話</a>
                    )}
                    <button className="btn primary small" disabled={busy} onClick={() => review(d, "approve")}>納入</button>
                    <button className="iconbtn danger" title="退回並刪除" disabled={busy} onClick={() => review(d, "reject")}><IcTrash /></button>
                  </div>
                ))}
              </div>
            </>)}

            {section === "grants" && isOwner && (<>
              <div className="lab-toolbar">
                <div className="lab-toolbar-top">
                  <div className="lab-sec-title">跨實驗室授權 <span className="muted small"> · 別的實驗室申請存取、以及你送出的申請</span></div>
                  {grants.incoming.length + grants.outgoing.length > 1 &&
                    <input className="search kb-search" placeholder="搜尋授權…" value={secQ} onChange={(e) => setSecQ(e.target.value)} />}
                </div>
              </div>
              {grants.incoming.length === 0 && grants.outgoing.length === 0 &&
                <div className="muted small pad">還沒有任何跨實驗室授權往來。到「名錄」可申請存取別的實驗室。</div>}
              <div className="kb-list grant-list">
                {grants.incoming
                  .filter((g) => !secQ.trim() || [g.grantee_name, g.note].some((x) => (x || "").toLowerCase().includes(secQ.trim().toLowerCase())))
                  .map((g) => (
                  <div key={g.id} className={`kb-doc lab-card ${g.status === "granted" ? "ok" : g.status === "requested" ? "await" : "neutral"}`}>
                    <div className="kb-row">
                      <div className="kb-main">
                        <span className="kb-name">{g.grantee_name}</span>
                        <span className="muted small">想存取本實驗室{g.note ? `：「${g.note}」` : ""}</span>
                        <span className={`grant-status ${g.status}`}>{GRANT_STATUS[g.status]}{g.status === "granted" ? `（${SCOPE_LABEL[g.scope]}）` : ""}</span>
                      </div>
                      {g.status === "requested" && approveFor !== g.id && (
                        <>
                          <button className="btn small" disabled={busy} onClick={() => openApprove(g.id)}>授權</button>
                          <button className="iconbtn danger" title="拒絕並移除申請" disabled={busy} onClick={() => grantAct(g.id, "reject")}><IcTrash /></button>
                        </>
                      )}
                      {g.status === "granted" && <button className="btn ghost small" disabled={busy} onClick={() => grantAct(g.id, "revoke")}>收回</button>}
                    </div>
                    {approveFor === g.id && (
                      <div className="grant-approve">
                        {aLoading
                          ? <div className="muted small">正在依申請目的挑選相關文件…</div>
                          : aSuggest && (aSuggest.documents.length || aSuggest.tags.length)
                            ? <div className="grant-hint">✨ 已依申請目的{aSuggest.query ? `「${aSuggest.query}」` : ""}自動挑選{aSuggest.documents.length ? ` ${aSuggest.documents.length} 份相關文件` : ""}{aSuggest.tags.length ? `、${aSuggest.tags.length} 個主題標籤` : ""}，可自行增減。<span className="muted">（🔒 不外流的文件不會被挑選）</span></div>
                            : aSuggest
                              ? <div className="muted small">沒找到明顯相關的文件；請自行選擇授權範圍。</div>
                              : null}
                        <div className="grant-scopes">
                          {(["full", "documents", "tags"] as const).map((sc) => (
                            <label key={sc}><input type="radio" checked={aScope === sc} onChange={() => setAScope(sc)} /> {SCOPE_LABEL[sc]}</label>
                          ))}
                        </div>
                        {aScope === "documents" && (
                          <div className="grant-docs">
                            {docs.length === 0 && <span className="muted small">這個庫還沒有文件。</span>}
                            {docs.map((d) => {
                              const suggested = !!aSuggest?.documents.some((x) => x.id === d.id);
                              return (
                              <label key={d.id} className="grant-doc">
                                <input type="checkbox" checked={aDocs.has(d.id)} onChange={(e) =>
                                  setADocs((s) => { const n = new Set(s); e.target.checked ? n.add(d.id) : n.delete(d.id); return n; })} />
                                <span className="kb-name">{d.title || d.source}</span>
                                {suggested && <span className="grant-sugtag">建議</span>}
                                {d.confidential && <span className="kb-badge lock">🔒</span>}
                              </label>
                            );})}
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
                {grants.outgoing
                  .filter((g) => !secQ.trim() || (g.grantor_name || "").toLowerCase().includes(secQ.trim().toLowerCase()))
                  .map((g) => (
                  <div key={g.id} className={`kb-row lab-card ${g.status === "granted" ? "ok" : g.status === "requested" ? "await" : "neutral"}`}>
                    <div className="kb-main">
                      <span className="kb-name">已向 {g.grantor_name} 申請</span>
                      <span className={`grant-status ${g.status}`}>{GRANT_STATUS[g.status]}{g.status === "granted" ? `（${SCOPE_LABEL[g.scope]}）` : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>)}

            {section === "profile" && isOwner && (<>
              <div className="lab-toolbar">
                <div className="lab-toolbar-top">
                  <div className="lab-sec-title">專長名片 <span className="muted small"> · 公開到跨實驗室名錄（只放方向與關鍵字，不含內容）</span></div>
                </div>
              </div>
              <div className="lab-profile">
                <div className="prof-aihint">
                  <span>✨ 讓 AI 讀你的實驗室庫，自動草擬一版研究方向簡介與關鍵字，再自行潤飾。{!pSummary.trim() && !drafting && " 名片還空著時會自動為你草擬。"}</span>
                  <button className="btn primary small" disabled={busy || drafting || !enabled}
                          onClick={genDraft} title="讓 AI 讀實驗室庫草擬一版">
                    {drafting ? "AI 草擬中…" : "✨ AI 生成草稿"}
                  </button>
                </div>
                {draft && (draft.summary || draft.keywords?.length) && (
                  <div className="prof-draft">
                    <div className="prof-draft-head">
                      <span className="muted small">AI 草稿</span>
                      <button className="btn primary small" disabled={busy} onClick={() => adoptDraft(draft!.summary, draft!.keywords || [])}>採用</button>
                    </div>
                    {draft.summary && <div className="prof-draft-sum">{draft.summary}</div>}
                    {draft.keywords?.length > 0 && <div className="dir-tags">{draft.keywords.map((k) => <span key={k} className="dir-tag">{k}</span>)}</div>}
                  </div>
                )}
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
                </div>
              </div>
            </>)}

            {section === "manage" && (<>
              <div className="lab-sec-title">{canCreate ? "建立／加入實驗室" : "加入實驗室"}</div>
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
