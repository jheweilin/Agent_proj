import { DragEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Attachment, Block, copyText, eventsUrl, fmtDuration, fmtTime, fmtTokens, Item, modelName, parsePipe, PlanStep, Project, RunInfo, ToolBlock, Usage } from "./api";
import Panel, { PanelTab } from "./Panel";
import { ApprovalBar, CrossLabCard, EvidenceCard, NominateCard, PipelineNote, StageTracker, stageLabels } from "./Pipeline";
import { AssistantTurn, FileOpenCtx, KbDocOpenCtx, KbDocRef, Markdown } from "./Render";
import { meta } from "./tools";

type Live = {
  blocks: Block[]; attachments: Attachment[]; status: string; error: string;
  iteration: number; usage: Partial<Usage>; model: string; startedAt: number; stage: string;
};
const emptyLive = (): Live => ({ blocks: [], attachments: [], status: "", error: "", iteration: 0, usage: {}, model: "", startedAt: Date.now(), stage: "" });

export const EXAMPLES = [
  { title: "統計檢定", domain: "research", text: "給兩組實驗測量值，先檢查常態性與變異數同質性，再選 t 檢定或無母數檢定判斷差異是否顯著，附箱型圖與效果量" },
  { title: "資料擬合", domain: "research", text: "產生一組帶雜訊的指數衰減數據，用非線性最小二乘擬合出衰減常數並估計其不確定度，附上殘差圖" },
  { title: "機器學習", domain: "research", text: "用 scikit-learn 在一個公開資料集上訓練分類模型，做 5 折交叉驗證，報告準確率、混淆矩陣與特徵重要度" },
  { title: "文獻回顧", domain: "research", text: "搜尋近五年「微塑膠對人體健康的影響」的代表性論文，整理各自的方法與主要發現，並列出可引用的來源" },
];

export default function Chat({ threadId, onActivity, initialPrompt, onPromptUsed, onOpenDirectory }: {
  threadId: string; onActivity: () => void; initialPrompt?: string | null; onPromptUsed?: () => void;
  onOpenDirectory?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [live, setLive] = useState<Live>(emptyLive());
  const [mode, setMode] = useState<string>("chat");
  const [shared, setShared] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [nominateOpen, setNominateOpen] = useState(false);  // header「納入實驗室庫」re-opens a skipped nominate card
  const [nominateHint, setNominateHint] = useState(false);  // one-time pulse on the header button after a skip
  const [copied, setCopied] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [suggestProject, setSuggestProject] = useState<boolean | null>(null);
  const [dismissPromote, setDismissPromote] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);   // closed until an agent run is active (then auto-opens)
  const [panelTab, setPanelTab] = useState<PanelTab>("status");
  const [selected, setSelected] = useState<ToolBlock | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [kbDoc, setKbDoc] = useState<KbDocRef | null>(null);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const esRef = useRef<EventSource | null>(null);
  const committed = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  const load = useCallback(async () => {
    const [m, t] = await Promise.all([api.messages(threadId), api.thread(threadId)]);
    setItems(m.items);
    setRuns(m.runs);
    setTitle(t.title);
    setMode(t.mode);
    setShared(!!t.shared);
    setProject(m.project);
    setSuggestProject(t.suggest_project ?? null);
    setDismissPromote(!!t.promote_dismissed);
    return t.active_run_id;
  }, [threadId]);

  const connect = useCallback((runId: string) => {
    esRef.current?.close();
    committed.current = 0;
    setLive(emptyLive());
    setActiveRun(runId);
    const es = new EventSource(eventsUrl(runId));
    esRef.current = es;
    es.onmessage = (msg) => {
      let ev: any;
      try { ev = JSON.parse(msg.data); } catch { return; }
      if (ev.type === "run_end") {
        es.close();
        esRef.current = null;
        load().then(() => { setActiveRun(null); setLive(emptyLive()); setTick((x) => x + 1); onActivity(); });
        return;
      }
      if (ev.type === "project") setProject((p) => (p ? { ...p, stage: ev.stage, status: ev.status } : p));
      setLive((prev) => reduce(prev, ev, committed));
      if (ev.type === "tool_result") {
        setTick((x) => x + 1);
        setSelected((s) => (s && s.id === ev.id ? { ...s, result: { is_error: ev.is_error, preview: ev.preview, output: ev.output, images: ev.ui?.images, seconds: ev.seconds } } : s));
      }
    };
  }, [load, onActivity]);

  useEffect(() => {
    load().then((active) => { if (active) connect(active); }).catch((e) => setError(e.message));
    return () => esRef.current?.close();
  }, [load, connect]);

  useEffect(() => { if (!activeRun) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [activeRun]);

  useEffect(() => { if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" }); }, [items, live]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  const send = useCallback(async (override?: string) => {
    const body = (override ?? text).trim();
    if (!body || activeRun) return;
    setError("");
    try {
      const r = await api.send(threadId, body, uploads);
      setText("");
      setUploads([]);
      stickRef.current = true;
      await load();
      connect(r.run_id);
      onActivity();
    } catch (e: any) {
      setError(e.message);
    }
  }, [text, activeRun, threadId, uploads, load, connect, onActivity]);

  useEffect(() => {
    if (initialPrompt && !sentInitial.current && items.length === 0 && !activeRun) {
      sentInitial.current = true;
      onPromptUsed?.();
      send(initialPrompt);
    }
  }, [initialPrompt, items.length, activeRun, send, onPromptUsed]);

  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!activeRun) setStopping(false); }, [activeRun]);  // reset once the run ends
  const stop = async () => { if (!activeRun) return; setStopping(true); await api.stop(activeRun).catch(() => {}); };

  const passGate = useCallback(async (action: () => Promise<{ run_id?: string }>) => {
    setGateBusy(true);
    setError("");
    try {
      stickRef.current = true;
      const r = await action();
      await load();
      if (r.run_id) connect(r.run_id);
      onActivity();
    } catch (e: any) { setError(e.message); } finally { setGateBusy(false); }
  }, [load, connect, onActivity]);
  const approve = (planSteps?: PlanStep[], comsolOk?: boolean) => passGate(() => api.approve(threadId, planSteps, comsolOk));
  const reject = (fb: string) => passGate(() => api.reject(threadId, fb));
  const answerClarify = (answers: string) => passGate(() => api.answerClarify(threadId, answers));
  const resume = (note?: string) => passGate(() => api.resume(threadId, note));
  const handoff = (note: string) => passGate(() => api.handoff(threadId, note));
  const promote = () => passGate(() => api.promote(threadId));

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const r = await api.upload(threadId, Array.from(files));
      setUploads((u) => [...u, ...r.paths]);
      setTick((x) => x + 1);
    } catch (e: any) { setError(e.message); } finally { setUploading(false); }
  };

  // drag & drop upload to /workspace/uploads
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types || []).includes("Files");
  const onDragEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true); };
  const onDragOver = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; };
  const onDragLeave = (e: DragEvent) => { if (!hasFiles(e)) return; if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } };
  const onDrop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); pickFiles(e.dataTransfer.files); };

  const shareUrl = `${location.origin}${location.pathname}#/v/${threadId}`;
  const toggleShare = async (next: boolean) => {
    try { const r = await api.shareThread(threadId, next); setShared(r.shared); } catch (e: any) { setError(e.message); }
  };
  const openStep = (b: ToolBlock) => { setSelected(b); setPanelTab("detail"); setPanelOpen(true); };
  const openFile = (p: string) => { setFilePath(p); setPanelTab("files"); setPanelOpen(true); };
  const openKbDoc = (d: KbDocRef) => { setKbDoc(d); setPanelTab("kbdoc"); setPanelOpen(true); };
  const openPanel = (t: PanelTab) => { if (panelOpen && panelTab === t) setPanelOpen(false); else { setPanelTab(t); setPanelOpen(true); } };
  // the side panel (steps/files/status) auto-opens only while an agent run is active; it stays closed
  // on a fresh conversation. The user can still open it manually via the head chips.
  useEffect(() => { if (activeRun) setPanelOpen(true); }, [activeRun]);

  const runById = useMemo(() => Object.fromEntries(runs.map((r) => [r.id, r])), [runs]);
  const shown = activeRun ? items.filter((it) => !(it.kind === "assistant" && it.run_id === activeRun)) : items;
  // Collapse duplicate images across turns: COMSOL re-runs re-export the same plot (same descriptive
  // filename, e.g. Tz15_coarse10_i6.png) into different job folders — visually identical, so they pile
  // up. Dedup by filename (not size — re-runs differ by a few bytes), keeping the first appearance.
  // Different plots keep distinct names (coarse vs normal, T vs U), so genuinely different figures stay.
  const dedupAtt: Record<number, Attachment[]> = {};
  {
    const seen = new Set<string>();
    for (const it of shown) {
      if (it.kind !== "assistant") continue;
      dedupAtt[it.id] = (it.attachments || []).filter((f) => {
        if (!f.mime.startsWith("image/")) return true;
        if (seen.has(f.name)) return false;
        seen.add(f.name);
        return true;
      });
    }
  }
  const lastRun = runs[runs.length - 1];
  const liveTokens = (live.usage.input_tokens || 0) + (live.usage.cache_read_input_tokens || 0) + (live.usage.cache_creation_input_tokens || 0);
  const isProject = mode === "project";
  const atGate = isProject && !activeRun && !!project &&
    (project.status === "awaiting_clarification" || project.status === "awaiting_plan_approval"
      || project.status === "awaiting_acceptance" || project.status === "interrupted");
  const ann = useMemo(() => (isProject ? stageLabels(shown)
    : { labels: {} as Record<number, string>, stages: {} as Record<number, string> }), [shown, isProject]);
  const jumpToStage = useCallback((stage: string) => {
    const target = stage === "approve_plan" ? "plan" : stage === "report" ? "research" : stage;
    const els = scrollRef.current?.querySelectorAll(`[data-stage="${target}"]`);
    if (!els || !els.length) return;
    const el = (stage === "report" ? els[els.length - 1] : els[0]) as HTMLElement;
    stickRef.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="chat-wrap">
      <div className="chat" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {dragging && (
          <div className="drop-overlay">
            <div className="drop-hint">⬆ 放開即可上傳到 /workspace/uploads</div>
          </div>
        )}
        <header className="chat-head">
          <div className="chat-title" title={title}>{title || "對話"}</div>
          <span className="spacer" />
          {!isProject && !activeRun && items.length > 0 && (
            <button className="btn ghost small head-promote" disabled={gateBusy} onClick={promote}
                    title="把這個對話接上九階段研究流程（釐清→規劃→研究→驗證→審查，關鍵處你把關）">轉成研究專案</button>
          )}
          {isProject && !activeRun && project?.status === "completed" && !project.nomination && (
            <button className={"btn ghost small head-nominate" + (nominateHint ? " pulse" : "")}
                    onClick={() => { setNominateOpen(true); setNominateHint(false); stickRef.current = true; bottomRef.current?.scrollIntoView({ block: "end" }); }}
                    title="把這次研究整理成經驗筆記、納入實驗室知識庫">納入實驗室庫</button>
          )}
          {items.length > 0 && (
            <div className="share-wrap">
              <button className={"btn ghost small" + (shared ? " on" : "")} onClick={() => setShareOpen((v) => !v)}
                      title="產生唯讀分享連結（只有登入本平台的人看得到）">{shared ? "🔗 已分享" : "分享"}</button>
              {shareOpen && (
                <div className="share-pop" onMouseLeave={() => setShareOpen(false)}>
                  <label className="share-toggle">
                    <input type="checkbox" checked={shared} onChange={(e) => toggleShare(e.target.checked)} />
                    <span>開啟唯讀分享</span>
                  </label>
                  <div className="muted small">任何登入本平台的人，拿到連結就能唯讀看這個對話（含步驟與產生的檔案），但不能修改。</div>
                  {shared && (
                    <div className="share-link">
                      <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                      <button className="btn small" onClick={async () => { if (await copyText(shareUrl)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>{copied ? "已複製 ✓" : "複製"}</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="head-chips">
            <button
              className={"head-chip" + (panelOpen && panelTab === "status" ? " on" : activeRun ? " running" : lastRun?.status === "failed" ? " bad" : "")}
              onClick={() => openPanel("status")}
              title="執行狀態、沙盒與 GPU、COMSOL、待辦">
              {activeRun ? (
                <><span className="spinner sm" /> 執行中 · 第 {live.iteration || 1} 輪 · {fmtDuration((now - live.startedAt) / 1000)}
                  {liveTokens > 0 && <span className="muted"> · {fmtTokens(liveTokens + (live.usage.output_tokens || 0))} tokens</span>}</>
              ) : lastRun?.status === "failed" ? "⚠ 上次執行失敗"
                : lastRun?.status === "completed" ? "✓ 完成"
                : "狀態"}
            </button>
            <button className={"head-chip panel-toggle" + (panelOpen && panelTab === "files" ? " on" : "")} onClick={() => openPanel("files")} title="工作區檔案瀏覽與下載">檔案</button>
            <button className={"head-chip panel-toggle" + (panelOpen && panelTab === "detail" ? " on" : "")} onClick={() => openPanel("detail")} title="點對話中任一步驟可看完整輸入與輸出">步驟</button>
          </div>
        </header>

        <FileOpenCtx.Provider value={openFile}>
        <KbDocOpenCtx.Provider value={openKbDoc}>
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          <div className="messages-inner">
            {isProject && project && <StageTracker project={project} live={!!activeRun} onJump={jumpToStage} />}
            {shown.length === 0 && !activeRun && (
              isProject ? (
                <div className="project-intro">
                  <div className="examples-title">研究專案模式</div>
                  <p className="muted">描述你的研究想法，流程會自動開始：釐清 → 檢索證據 → 規劃 →（你核准）→ 研究 →（你驗收）。每一步都看得到，關鍵決策由你把關。</p>
                </div>
              ) : (
                <div className="examples">
                  <div className="examples-title">從一個問題開始</div>
                  <div className="example-list">
                    {EXAMPLES.map((ex) => (
                      <button key={ex.title} className="example" onClick={() => send(ex.text)}>
                        <span className="ex-t">{ex.title}</span><span className="ex-d">{ex.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}
            {shown.map((it) => {
              if (it.kind === "user") {
                const p = isProject ? parsePipe(it.text) : null;
                if (p?.kind === "evidence") return <EvidenceCard key={`u${it.id}`} body={p.body} threadId={threadId} />;
                if (p?.kind === "note") return <PipelineNote key={`u${it.id}`} note={p.note} body={p.body} />;
                return (
                  <div key={`u${it.id}`} className="msg user">
                    <div className="bubble"><Markdown text={it.text} threadId={threadId} /></div>
                    <div className="msg-time">{fmtTime(it.created_at)}</div>
                  </div>
                );
              }
              return (
                <div key={`a${it.id}`} className="msg assistant" data-stage={ann.stages[it.id]}>
                  <AssistantTurn blocks={it.blocks} attachments={dedupAtt[it.id] ?? it.attachments} threadId={threadId} run={runById[it.run_id]}
                    roleLabel={ann.labels[it.id]} selectedId={selected?.id} onSelect={openStep} onOpenFile={openFile} />
                </div>
              );
            })}
            {activeRun && (
              <div className="msg assistant">
                <AssistantTurn blocks={live.blocks} attachments={live.attachments} threadId={threadId} live
                  roleLabel={isProject ? live.stage : undefined}
                  selectedId={selected?.id} onSelect={openStep} onOpenFile={openFile} />
                <div className="status-line">
                  <span className="pulse-dot" />
                  <span>{live.status || "思考中…"}</span>
                  {live.model && <span className="muted">· {modelName(live.model)}</span>}
                </div>
                {live.error && <div className="error">{live.error}</div>}
              </div>
            )}
            {!activeRun && lastRun?.status === "failed" && lastRun.error && <div className="error">上一次執行失敗：{lastRun.error}</div>}
            {/* current-action cards live at the end of the conversation flow (scroll with history,
                never squeeze the messages area the way a fixed composer block would) */}
            {!isProject && suggestProject && !dismissPromote && !activeRun && items.length > 0 && (
              <div className="promote-suggest">
                <div className="promote-text">
                  <strong>這看起來是個完整研究任務</strong>
                  <span className="muted small">要改用<strong>研究專案</strong>嗎？會走九階段（釐清→規劃→研究→驗證→審查），關鍵處由你把關。</span>
                </div>
                <div className="promote-actions">
                  <button className="btn primary small" disabled={gateBusy} onClick={promote}>轉成研究專案</button>
                  <button className="btn ghost small" disabled={gateBusy}
                        onClick={() => { setDismissPromote(true); api.dismissPromote(threadId).catch(() => {}); }}>繼續用對話</button>
                </div>
              </div>
            )}
            {isProject && !activeRun && project?.cross_lab && project.cross_lab.length > 0 && (
              <CrossLabCard matches={project.cross_lab} threadId={threadId} topic={title} onOpenDirectory={onOpenDirectory} />
            )}
            {atGate && project && <ApprovalBar project={project} busy={gateBusy} onApprove={approve} onReject={reject} onAnswer={answerClarify} onResume={resume} onHandoff={handoff} />}
            {isProject && !activeRun && project?.status === "completed"
              && <NominateCard project={project} threadId={threadId} forceShow={nominateOpen}
                   onClose={() => { setNominateOpen(false); setNominateHint(true); setTimeout(() => setNominateHint(false), 2000); }} />}
            <div ref={bottomRef} />
          </div>
        </div>
        </KbDocOpenCtx.Provider>
        </FileOpenCtx.Provider>

        <div className="composer">
          {error && <div className="error">{error}</div>}
          {uploads.length > 0 && (
            <div className="chips">
              {uploads.map((p) => (
                <span key={p} className="chip">📄 {p.split("/").pop()}
                  <button className="icon" onClick={() => setUploads((u) => u.filter((x) => x !== p))}>✕</button></span>
              ))}
            </div>
          )}
          <div className="composer-box">
            <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
              rows={Math.min(10, Math.max(2, text.split("\n").length))}
              placeholder={atGate ? "請先用上方的卡片處理目前的關卡（回覆／核准／退回）"
                : activeRun ? (stopping ? "停止中…等目前步驟結束就會中斷" : "執行中…可以按「停止」中斷")
                : isProject ? (project?.status === "completed" || project?.status === "handoff"
                    ? "針對目前的成果繼續追問，或要求調整…"
                    : "描述你的研究想法，流程會自動開始…")
                  : "描述你的研究問題，或上傳資料與文件…"}
              disabled={!!activeRun || atGate} />
            <div className="composer-bar">
              <label className="btn ghost small" title="上傳檔案到工作區 /workspace/uploads">
                {uploading ? "上傳中…" : "＋ 上傳檔案"}
                <input type="file" multiple hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
              </label>
              <span className="muted small hint">Enter 送出 · Shift+Enter 換行</span>
              <span className="spacer" />
              {activeRun
                ? <button className="btn danger" onClick={stop} disabled={stopping}>{stopping ? "停止中…" : "■ 停止"}</button>
                : <button className="btn primary" onClick={() => send()} disabled={!text.trim() || atGate}>送出</button>}
            </div>
          </div>
        </div>
      </div>
      {panelOpen && (
        <Panel threadId={threadId} tab={panelTab} setTab={setPanelTab} selected={selected} filePath={filePath}
          setFilePath={setFilePath} kbDoc={kbDoc} tick={tick} liveRunning={!!activeRun} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}

function reduce(prev: Live, ev: any, committed: { current: number }): Live {
  const blocks = [...prev.blocks];
  const last = blocks[blocks.length - 1];
  switch (ev.type) {
    case "run_start":
      committed.current = 0;
      return { ...emptyLive(), model: ev.model || "", startedAt: ev.started_at ? new Date(ev.started_at).getTime() : Date.now() };
    case "iteration":
      return { ...prev, iteration: ev.n, usage: ev.usage || prev.usage, model: ev.model || prev.model };
    case "block_start":
      blocks.push(ev.block === "thinking" ? { type: "thinking", text: "" } : { type: "text", text: "" });
      return { ...prev, blocks, status: ev.block === "thinking" ? "思考中…" : "撰寫回覆…" };
    case "text_delta":
      if (last && last.type === "text") blocks[blocks.length - 1] = { ...last, text: last.text + ev.text };
      else blocks.push({ type: "text", text: ev.text });
      return { ...prev, blocks };
    case "thinking_delta":
      if (last && last.type === "thinking") blocks[blocks.length - 1] = { ...last, text: last.text + ev.text };
      else blocks.push({ type: "thinking", text: ev.text });
      return { ...prev, blocks };
    case "stage_start":
      return { ...prev, stage: ev.role === "clarifier" ? "釐清 · Clarifier" : ev.role === "planner" ? "規劃 · Planner"
        : ev.role === "researcher" ? "研究 · Researcher" : ev.role === "retrieval" ? "檢索證據" : ev.label || prev.stage,
        status: `${ev.label}中…` };
    case "tool_start":
      blocks.push({ type: "tool", id: ev.id, name: ev.name, result: null });
      return { ...prev, blocks, status: `準備${meta(ev.name).label}…` };
    case "tool_input":
      return { ...prev, status: `${meta(ev.name).label}中…`,
        blocks: blocks.map((b) => (b.type === "tool" && b.id === ev.id ? { ...b, input: ev.input } : b)) };
    case "tool_progress":
      return { ...prev,
        blocks: blocks.map((b) => (b.type === "tool" && b.id === ev.id ? { ...b, progress: ev.progress } : b)) };
    case "tool_result":
      return { ...prev, status: "分析結果…",
        blocks: blocks.map((b) => (b.type === "tool" && b.id === ev.id
          ? { ...b, result: { is_error: ev.is_error, preview: ev.preview, output: ev.output, images: ev.ui?.images, seconds: ev.seconds }, progress: null } : b)) };
    case "attachments":
      return { ...prev, attachments: [...prev.attachments, ...(ev.files || [])] };
    case "status":
      return { ...prev, status: ev.text };
    case "assistant_done":
      committed.current = blocks.length;
      return { ...prev, usage: ev.usage || prev.usage };
    case "discard_partial":
      return { ...prev, blocks: blocks.slice(0, committed.current) };
    case "error":
      return { ...prev, error: ev.message };
    default:
      return prev;
  }
}
