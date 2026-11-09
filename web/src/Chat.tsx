import { DragEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Attachment, Block, eventsUrl, fmtDuration, fmtTime, fmtTokens, Item, modelName, parsePipe, Project, RunInfo, ToolBlock, Usage } from "./api";
import Panel, { PanelTab } from "./Panel";
import { ApprovalBar, EvidenceCard, PipelineNote, StageTracker, stageLabels } from "./Pipeline";
import { AssistantTurn, FileOpenCtx, Markdown } from "./Render";
import { meta } from "./tools";

type Live = {
  blocks: Block[]; attachments: Attachment[]; status: string; error: string;
  iteration: number; usage: Partial<Usage>; model: string; startedAt: number; stage: string;
};
const emptyLive = (): Live => ({ blocks: [], attachments: [], status: "", error: "", iteration: 0, usage: {}, model: "", startedAt: Date.now(), stage: "" });

export const EXAMPLES = [
  { title: "電漿參數", text: "用 PlasmaPy 計算氬氣電漿在 n=1e17 m⁻³、Te=3 eV 下的 Debye 長度、電漿頻率與每個 Debye 球內的粒子數，並和解析公式比對" },
  { title: "PIC 模擬", text: "用 SMILEI 設定一個 1D 雙流不穩定性（two-stream instability）的小型 PIC 模擬，跑完畫出相空間圖並和線性理論成長率比較" },
  { title: "COMSOL 模型", text: "用 COMSOL 建立一個簡單的 2D 平行板電極靜電模型，算出中間的電位分布並和解析解比較" },
  { title: "文獻調查", text: "搜尋近三年關於大氣壓電漿噴流（atmospheric pressure plasma jet）數值模擬的代表性論文並整理重點" },
];

export default function Chat({ threadId, onActivity, initialPrompt, onPromptUsed }: {
  threadId: string; onActivity: () => void; initialPrompt?: string | null; onPromptUsed?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [live, setLive] = useState<Live>(emptyLive());
  const [mode, setMode] = useState<string>("chat");
  const [project, setProject] = useState<Project | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 1200);
  const [panelTab, setPanelTab] = useState<PanelTab>("status");
  const [selected, setSelected] = useState<ToolBlock | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
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
    setProject(m.project);
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

  const stop = async () => { if (activeRun) await api.stop(activeRun).catch(() => {}); };

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
  const approve = () => passGate(() => api.approve(threadId));
  const reject = (fb: string) => passGate(() => api.reject(threadId, fb));

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

  const openStep = (b: ToolBlock) => { setSelected(b); setPanelTab("detail"); setPanelOpen(true); };
  const openFile = (p: string) => { setFilePath(p); setPanelTab("files"); setPanelOpen(true); };
  const openPanel = (t: PanelTab) => { if (panelOpen && panelTab === t) setPanelOpen(false); else { setPanelTab(t); setPanelOpen(true); } };

  const runById = useMemo(() => Object.fromEntries(runs.map((r) => [r.id, r])), [runs]);
  const shown = activeRun ? items.filter((it) => !(it.kind === "assistant" && it.run_id === activeRun)) : items;
  const lastRun = runs[runs.length - 1];
  const liveTokens = (live.usage.input_tokens || 0) + (live.usage.cache_read_input_tokens || 0) + (live.usage.cache_creation_input_tokens || 0);
  const isProject = mode === "project";
  const atGate = isProject && !activeRun && !!project &&
    (project.status === "awaiting_plan_approval" || project.status === "awaiting_acceptance");
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
          {activeRun ? (
            <div className="run-chip running">
              <span className="spinner sm" /> 執行中 · 第 {live.iteration || 1} 輪 · {fmtDuration((now - live.startedAt) / 1000)}
              {liveTokens > 0 && <span className="muted"> · {fmtTokens(liveTokens + (live.usage.output_tokens || 0))} tokens</span>}
            </div>
          ) : lastRun && lastRun.status === "failed" ? <div className="run-chip bad">上次執行失敗</div> : null}
          <span className="spacer" />
          <div className="seg">
            <button className={panelOpen && panelTab === "detail" ? "on" : ""} onClick={() => openPanel("detail")}>步驟</button>
            <button className={panelOpen && panelTab === "files" ? "on" : ""} onClick={() => openPanel("files")}>檔案</button>
            <button className={panelOpen && panelTab === "status" ? "on" : ""} onClick={() => openPanel("status")}>狀態</button>
          </div>
        </header>

        <FileOpenCtx.Provider value={openFile}>
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
                  <AssistantTurn blocks={it.blocks} attachments={it.attachments} threadId={threadId} run={runById[it.run_id]}
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
            <div ref={bottomRef} />
          </div>
        </div>
        </FileOpenCtx.Provider>

        <div className="composer">
          {atGate && project && <ApprovalBar project={project} busy={gateBusy} onApprove={approve} onReject={reject} />}
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
              placeholder={atGate ? "請先用上方的核准／退回處理目前的關卡"
                : activeRun ? "執行中…可以按「停止」中斷"
                : isProject ? "描述你的研究想法，流程會自動開始…" : "描述你的電漿研究問題，或上傳資料與模型檔…"}
              disabled={!!activeRun || atGate} />
            <div className="composer-bar">
              <label className="btn ghost small" title="上傳檔案到工作區 /workspace/uploads">
                {uploading ? "上傳中…" : "＋ 上傳檔案"}
                <input type="file" multiple hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
              </label>
              <span className="muted small hint">Enter 送出 · Shift+Enter 換行</span>
              <span className="spacer" />
              {activeRun
                ? <button className="btn danger" onClick={stop}>■ 停止</button>
                : <button className="btn primary" onClick={() => send()} disabled={!text.trim() || atGate}>送出</button>}
            </div>
          </div>
        </div>
      </div>
      {panelOpen && (
        <Panel threadId={threadId} tab={panelTab} setTab={setPanelTab} selected={selected} filePath={filePath}
          setFilePath={setFilePath} tick={tick} liveRunning={!!activeRun} onClose={() => setPanelOpen(false)} />
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
