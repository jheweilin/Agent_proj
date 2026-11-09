import { useState } from "react";
import { Item, parsePipe, Project } from "./api";
import { Markdown } from "./Render";

// stages actually implemented in the current phase; the rest show as "之後" (Phase D)
const IMPLEMENTED = new Set(["clarify", "retrieve", "plan", "approve_plan", "research", "verify", "replicate", "review", "report"]);
const GATE = new Set(["approve_plan", "report"]); // human gates (report = result acceptance)
const GRADE_CLASS: Record<string, string> = { "通過": "ok", "部分通過": "warn", "未通過": "bad", "未定": "muted" };

const CLAR = "釐清 · Clarifier", PLAN = "規劃 · Planner", RES = "研究 · Researcher";
const VERIF = "驗證 · Verifier", REPLIC = "第二實作 · Replicator", REVIEW = "審查 · Reviewer";
const STAGE_OF: Record<string, string> = {
  [CLAR]: "clarify", [PLAN]: "plan", [RES]: "research", [VERIF]: "verify", [REPLIC]: "replicate", [REVIEW]: "review",
};
const NOTE_STAGE: Record<string, string> = { reject_plan: CLAR, verify: VERIF, replicate: REPLIC, review: REVIEW };

// who runs each stage + a one-line description, shown on hover
const STAGE_META: Record<string, { who: string; desc: string }> = {
  clarify: { who: "AI", desc: "把你的想法收斂成明確、可執行的研究問題" },
  retrieve: { who: "程式", desc: "自動檢索知識庫與文獻，整理成證據" },
  plan: { who: "AI", desc: "依證據設計模擬／分析計畫，參數標明來源" },
  approve_plan: { who: "你", desc: "看過計畫後核准，或退回並說明要改的地方" },
  research: { who: "AI", desc: "在 GPU 沙盒裡寫程式、跑模擬、畫圖、交件" },
  verify: { who: "程式", desc: "重跑、單位、守恆、收斂、與已知解比對（Phase D）" },
  replicate: { who: "AI", desc: "獨立重做一次，和研究結果對照（Phase D）" },
  review: { who: "AI", desc: "唯讀審查物理與推論（Phase D）" },
  report: { who: "程式／你", desc: "依驗證結果產生等級與報告，交由你驗收" },
};

/** Per assistant turn: the role label to show, and which stage it belongs to (for click-to-jump). */
export function stageLabels(items: Item[]): { labels: Record<number, string>; stages: Record<number, string> } {
  let cur = CLAR;
  const labels: Record<number, string> = {};
  const stages: Record<number, string> = {};
  for (const it of items) {
    if (it.kind === "user") {
      const p = parsePipe(it.text);
      if (p?.kind === "evidence") cur = PLAN;
      else if (p?.kind === "note") cur = NOTE_STAGE[p.note] || RES;
    } else {
      labels[it.id] = cur;
      stages[it.id] = STAGE_OF[cur];
    }
  }
  return { labels, stages };
}

export function StageTracker({ project, live, onJump }: { project: Project; live?: boolean; onJump?: (stage: string) => void }) {
  const order = project.stages.map((s) => s.name);
  const curIdx = order.indexOf(project.stage);
  const done = project.status === "completed";
  return (
    <div className="track" role="list">
      {project.stages.map((s, i) => {
        const soon = !IMPLEMENTED.has(s.name);
        let state: string;
        if (soon) state = "soon";
        else if (done) state = "done";
        else if (i < curIdx) state = "done";
        else if (i === curIdx) state = "current";
        else state = "upcoming";
        const waiting = state === "current" &&
          (project.status === "awaiting_plan_approval" || project.status === "awaiting_acceptance");
        const running = state === "current" && project.status === "running" && !!live;
        const gate = GATE.has(s.name);
        const statusText = state === "done" ? "已完成" : waiting ? "待你處理"
          : running || state === "current" ? "進行中" : soon ? "之後（Phase D）" : "尚未開始";
        const m = STAGE_META[s.name];
        return (
          <button key={s.name} type="button" role="listitem"
            className={`track-node ${state} ${gate ? "gate" : ""} ${waiting ? "waiting" : ""}`}
            data-tip={`${s.label}（${m?.who}）\n${statusText}\n${m?.desc}`}
            onClick={() => onJump?.(s.name)}>
            <div className="track-dot">
              {state === "done" ? "✓" : running ? <span className="spinner sm" /> : gate ? "◆" : i + 1}
            </div>
            <div className="track-label">{s.label}</div>
          </button>
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
                  : "程式已依獨立驗證結果評級。確認無誤即可完成；或退回並說明要修正的地方。"}
          </div>
        </div>
      </div>
      {accept && project.grade && (
        <div className={`grade grade-${GRADE_CLASS[project.grade.level] || "muted"}`}>
          <span className="grade-level">{project.grade.level}</span>
          <span className="grade-count">獨立驗證 {project.grade.passed}/{project.grade.total} 項通過</span>
          {project.grade.summary && <span className="grade-sum">{project.grade.summary}</span>}
        </div>
      )}
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
    <div className={`evidence ${open ? "open" : ""}`} data-stage="retrieve">
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
  verify: "開始獨立驗證",
  replicate: "開始獨立複現",
  review: "開始唯讀審查",
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
