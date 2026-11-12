import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtTime, Item, parsePipe, Project, RunInfo, ToolBlock } from "./api";
import Panel, { PanelTab } from "./Panel";
import { EvidenceCard, PipelineNote, StageTracker, stageLabels } from "./Pipeline";
import { AssistantTurn, FileOpenCtx, Markdown } from "./Render";

// read-only banner shown at a human gate: mobile can see *that* the project needs the user,
// but acting on it (editing/approving a plan, accepting results) is desktop-only.
const GATE_HINT: Record<string, string> = {
  awaiting_clarification: "正在等待你補充釐清資訊",
  awaiting_plan_approval: "正在等待你核准研究計畫",
  awaiting_acceptance: "正在等待你驗收研究結果",
  interrupted: "研究已中斷，等待你決定是否續跑",
};

// Mobile = read-only. Reuses the same render components as Chat/SharedView (stage tracker,
// assistant turns, step/file panel) with no composer, no gates, no live streaming — just a
// periodic refetch so a running project's status/results stay fresh. Mutating actions are
// surfaced as a hint pointing the user to the desktop version.
export default function MobileThread({ threadId }: { threadId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [mode, setMode] = useState("chat");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("detail");
  const [selected, setSelected] = useState<ToolBlock | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const seen = useRef(false);

  const load = useCallback(async (first: boolean) => {
    try {
      const m = await api.messages(threadId);
      setItems(m.items); setRuns(m.runs); setProject(m.project);
      if (first) { const t = await api.thread(threadId); setMode(t.mode); }
    } catch (e: any) {
      if (first) setError(e?.message || "載入失敗");
    } finally {
      if (first) setLoading(false);
    }
  }, [threadId]);

  useEffect(() => { seen.current = false; setLoading(true); load(true); }, [load]);

  // keep status/results fresh while a run is executing (the main reason to watch on a phone)
  const live = runs.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => load(false), 6000);
    return () => clearInterval(id);
  }, [live, load]);

  const openStep = (b: ToolBlock) => { setSelected(b); setPanelTab("detail"); setPanelOpen(true); };
  const openFile = (p: string) => { setFilePath(p); setPanelTab("files"); setPanelOpen(true); };
  const jumpToStage = useCallback((stage: string) => {
    document.querySelector(`.messages [data-stage="${stage}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const isProject = mode === "project";
  const runById = Object.fromEntries(runs.map((r) => [r.id, r]));
  const ann = isProject ? stageLabels(items) : { labels: {} as Record<number, string>, stages: {} as Record<number, string> };
  const gateHint = isProject && project ? GATE_HINT[project.status] : undefined;

  return (
    <div className="chat">
      {loading && <div className="center muted">載入中…</div>}
      {error && <div className="center muted">{error}</div>}
      {!loading && !error && (
        <FileOpenCtx.Provider value={openFile}>
          <div className="messages">
            <div className="messages-inner">
              {isProject && project && <StageTracker project={project} live={false} onJump={jumpToStage} />}
              {gateHint && (
                <div className="mobile-gate">
                  <span className="mobile-gate-dot">◆</span>
                  <span>{gateHint}，請用電腦版操作。</span>
                </div>
              )}
              {items.map((it) => {
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
              {items.length === 0 && <div className="center muted">這個對話還沒有內容。</div>}
            </div>
          </div>
        </FileOpenCtx.Provider>
      )}
      {panelOpen && (
        <Panel threadId={threadId} tab={panelTab} setTab={setPanelTab} selected={selected}
               filePath={filePath} setFilePath={setFilePath} kbDoc={null} tick={0} liveRunning={false}
               onClose={() => setPanelOpen(false)} readOnly />
      )}
    </div>
  );
}
