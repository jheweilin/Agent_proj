import { useState } from "react";
import { Item, parsePipe, Project } from "./api";
import { Markdown } from "./Render";

// stages actually implemented in the current phase; the rest show as "之後" (Phase D)
const IMPLEMENTED = new Set(["clarify", "retrieve", "plan", "approve_plan", "research", "report"]);
const GATE = new Set(["approve_plan", "report"]); // human gates (report = result acceptance)

const CLAR = "釐清 · Clarifier", PLAN = "規劃 · Planner", RES = "研究 · Researcher";

/** Label each assistant turn with the role that produced it, inferred from the pipeline markers. */
export function stageLabels(items: Item[]): Record<number, string> {
  let cur = CLAR;
  const out: Record<number, string> = {};
  for (const it of items) {
    if (it.kind === "user") {
      const p = parsePipe(it.text);
      if (p?.kind === "evidence") cur = PLAN;
      else if (p?.kind === "note") cur = p.note === "reject_plan" ? CLAR : RES;
    } else {
      out[it.id] = cur;
    }
  }
  return out;
}

export function StageTracker({ project, live }: { project: Project; live?: boolean }) {
  const order = project.stages.map((s) => s.name);
  const curIdx = order.indexOf(project.stage);
  const done = project.status === "completed";
  return (
    <div className="track" role="list">
      {project.stages.map((s, i) => {
        const soon = !IMPLEMENTED.has(s.name);
        let state: string;
        if (soon) state = done ? "soon" : "soon";
        else if (done) state = "done";
        else if (i < curIdx) state = "done";
        else if (i === curIdx) state = "current";
        else state = "upcoming";
        const waiting = state === "current" &&
          (project.status === "awaiting_plan_approval" || project.status === "awaiting_acceptance");
        const running = state === "current" && project.status === "running" && !!live;
        const gate = GATE.has(s.name);
        return (
          <div key={s.name} className={`track-node ${state} ${gate ? "gate" : ""} ${waiting ? "waiting" : ""}`} role="listitem">
            <div className="track-dot">
              {state === "done" ? "✓" : running ? <span className="spinner sm" /> : gate ? "◆" : i + 1}
            </div>
            <div className="track-label">{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}

export function ApprovalBar({ project, busy, onApprove, onReject }: {
  project: Project; busy: boolean; onApprove: () => void; onReject: (fb: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [fb, setFb] = useState("");
  const plan = project.status === "awaiting_plan_approval";
  const accept = project.status === "awaiting_acceptance";
  if (!plan && !accept) return null;
  return (
    <div className="approve">
      <div className="approve-head">
        <span className={`approve-icon ${accept ? "ok" : ""}`}>{plan ? "◆" : "✓"}</span>
        <div>
          <strong>{plan ? "計畫待核准" : "結果待驗收"}</strong>
          <div className="muted small">
            {plan ? "看過上方的規劃後核准即可開始研究；或退回並說明要修改的地方。"
                  : "確認研究結果無誤即可完成；或退回並說明要修正的地方。"}
          </div>
        </div>
      </div>
      {!rejecting ? (
        <div className="approve-actions">
          <button className="btn primary" disabled={busy} onClick={onApprove}>
            {plan ? "核准並開始研究" : "接受並完成"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setRejecting(true)}>退回修改</button>
        </div>
      ) : (
        <div className="approve-reject">
          <textarea value={fb} onChange={(e) => setFb(e.target.value)} rows={3} autoFocus
            placeholder={plan ? "要修改計畫的哪裡？（可留空，agent 會自行檢討）"
                              : "結果哪裡需要修正？（可留空）"} />
          <div className="approve-actions">
            <button className="btn danger" disabled={busy} onClick={() => onReject(fb)}>送出退回</button>
            <button className="btn ghost" disabled={busy} onClick={() => setRejecting(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function EvidenceCard({ body, threadId }: { body: string; threadId: string }) {
  const [open, setOpen] = useState(false);
  const inner = body.replace(/^【[^\n]*】\n*/, ""); // heading is shown in the card header instead
  return (
    <div className={`evidence ${open ? "open" : ""}`}>
      <button className="evidence-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="evidence-icon">❡</span>
        <span className="evidence-title">檢索證據 ②</span>
        <span className="muted small">程式自動檢索，供規劃引用</span>
      </button>
      {open && <div className="evidence-body"><Markdown text={"```\n" + inner.trim() + "\n```"} threadId={threadId} /></div>}
    </div>
  );
}

const NOTE_LABEL: Record<string, string> = {
  approved_plan: "計畫已核准 — 開始研究",
  reject_plan: "計畫退回 — 重新釐清與規劃",
  reject_accept: "結果退回 — 重做研究",
};

export function PipelineNote({ note, body }: { note: string; body: string }) {
  const fb = body.replace(/^（[^：]*：?/, "").replace(/）\s*$/, "").trim();
  const isReject = note.startsWith("reject");
  return (
    <div className={`pipe-note ${isReject ? "reject" : "ok"}`}>
      <span className="pipe-line" />
      <span className="pipe-tag" title={body}>{NOTE_LABEL[note] || "流程"}{isReject && fb ? `：${fb.slice(0, 40)}` : ""}</span>
      <span className="pipe-line" />
    </div>
  );
}
