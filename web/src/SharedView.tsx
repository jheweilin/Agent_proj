import { useCallback, useEffect, useState } from "react";
import { api, Item, Project, RunInfo, ToolBlock } from "./api";
import Panel, { PanelTab } from "./Panel";
import { EvidenceCard, PipelineNote, StageTracker, stageLabels } from "./Pipeline";
import { parsePipe } from "./api";
import { AssistantTurn, FileOpenCtx, Markdown } from "./Render";
import { fmtTime } from "./api";

// Read-only viewer for a shared conversation (owner shared it, or a lab owner reviewing a
// nomination). Reuses the same render components as Chat but with no composer / gates / live run.
export default function SharedView({ threadId, onExit }: { threadId: string; onExit: () => void }) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState("chat");
  const [items, setItems] = useState<Item[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // right-panel (step detail / files)
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("detail");
  const [selected, setSelected] = useState<ToolBlock | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.messages(threadId), api.thread(threadId)])
      .then(([m, t]) => {
        if (!alive) return;
        setItems(m.items); setRuns(m.runs); setProject(m.project);
        setTitle(t.title); setMode(t.mode);
      })
      .catch((e) => alive && setError(e.message?.includes("找不到") ? "這個分享連結無效或已被取消。" : (e.message || "載入失敗")))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [threadId]);

  const openStep = (b: ToolBlock) => { setSelected(b); setPanelTab("detail"); setPanelOpen(true); };
  const openFile = (p: string) => { setFilePath(p); setPanelTab("files"); setPanelOpen(true); };
  const jumpToStage = useCallback((stage: string) => {
    const el = document.querySelector(`.messages [data-stage="${stage}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const isProject = mode === "project";
  const runById = Object.fromEntries(runs.map((r) => [r.id, r]));
  const ann = isProject ? stageLabels(items) : { labels: {} as Record<number, string>, stages: {} as Record<number, string> };

  return (
    <div className="layout shared">
      <header className="topbar">
        <button className="topbtn" onClick={onExit} title="回到我的工作區">← 返回</button>
        <div className="brand" style={{ cursor: "default" }}>
          <span className="logo sm" />
          <span className="brand-name">{title || "分享的對話"}</span>
        </div>
        <span className="read-badge" title="你正在唯讀檢視別人分享的對話">👁 唯讀檢視</span>
        <span className="spacer" />
      </header>

      <main className="chat-wrap">
        <div className="chat">
          {loading && <div className="center muted">載入中…</div>}
          {error && <div className="center muted">{error}</div>}
          {!loading && !error && (
            <FileOpenCtx.Provider value={openFile}>
              <div className="messages">
                <div className="messages-inner">
                  {isProject && project && <StageTracker project={project} live={false} onJump={jumpToStage} />}
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
        </div>
        {panelOpen && (
          <Panel threadId={threadId} tab={panelTab} setTab={setPanelTab} selected={selected}
                 filePath={filePath} setFilePath={setFilePath} kbDoc={null} tick={0} liveRunning={false}
                 onClose={() => setPanelOpen(false)} readOnly />
        )}
      </main>
    </div>
  );
}
