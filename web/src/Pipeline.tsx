import { useEffect, useState } from "react";
import { api, Item, Lab, parsePipe, PlanStep, PlanTool, Project } from "./api";
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
const NOTE_STAGE: Record<string, string> = { reject_plan: CLAR, verify: VERIF, replicate: REPLIC, review: REVIEW, verify_fail: RES };

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

type EditStep = { title: string; detail: string; source: string; enabled: boolean };

export function ApprovalBar({ project, busy, onApprove, onReject }: {
  project: Project; busy: boolean; onApprove: (planSteps?: PlanStep[], planTools?: PlanTool[]) => void; onReject: (fb: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [fb, setFb] = useState("");
  const [steps, setSteps] = useState<EditStep[]>([]);
  const [tools, setTools] = useState<(PlanTool & { enabled: boolean })[]>([]);
  const plan = project.status === "awaiting_plan_approval";
  const accept = project.status === "awaiting_acceptance";
  const incoming = project.plan_steps;
  const incomingTools = project.plan_tools;
  // sync the editable checklist when the planner's recorded steps arrive / change
  useEffect(() => {
    setSteps((incoming || []).map((s) => ({
      title: s.title || "", detail: s.detail || "", source: s.source || "", enabled: s.enabled !== false,
    })));
  }, [JSON.stringify(incoming || [])]);
  useEffect(() => {
    setTools((incomingTools || []).map((t) => ({ name: t.name || "", why: t.why || "", enabled: t.enabled !== false })));
  }, [JSON.stringify(incomingTools || [])]);
  if (!plan && !accept) return null;
  const hasTodo = plan && steps.length > 0;
  const hasTools = plan && tools.length > 0;
  // auto-grow the plan textareas so long content wraps instead of being clipped to one line
  const fit = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };
  const patch = (i: number, p: Partial<EditStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const toggleTool = (i: number, on: boolean) => setTools((s) => s.map((x, j) => (j === i ? { ...x, enabled: on } : x)));
  const anyOn = steps.some((s) => s.enabled);
  return (
    <div className="approve">
      <div className="approve-head">
        <span className={`approve-icon ${accept ? "ok" : ""}`}>{plan ? "◆" : "✓"}</span>
        <div>
          <strong>{plan ? "計畫待核准" : "結果待驗收"}</strong>
          <div className="muted small">
            {plan ? (hasTodo ? "勾選要執行的步驟、可直接改文字，再核准開始研究；或退回重新規劃。"
                             : "看過上方的規劃後核准即可開始研究；或退回並說明要修改的地方。")
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
      {hasTools && !rejecting && (
        <div className="plan-tools">
          <div className="plan-tools-title">會用到的工具／引擎（勾選要用的）</div>
          <div className="plan-tools-grid">
            {tools.map((t, i) => (
              <label className={`plan-tool${t.enabled ? "" : " off"}`} key={i}>
                <input type="checkbox" checked={t.enabled} disabled={busy} onChange={(e) => toggleTool(i, e.target.checked)} />
                <span className="plan-tool-name">{t.name}</span>
                {t.why && <span className="plan-tool-why muted small">{t.why}</span>}
              </label>
            ))}
          </div>
        </div>
      )}
      {hasTodo && !rejecting && (
        <div className="plan-todo">
          {steps.map((st, i) => (
            <div className={`plan-step${st.enabled ? "" : " off"}`} key={i}>
              <input type="checkbox" checked={st.enabled} disabled={busy}
                     onChange={(e) => patch(i, { enabled: e.target.checked })} />
              <div className="plan-step-main">
                <textarea className="plan-step-title" value={st.title} disabled={busy || !st.enabled} rows={1}
                          ref={fit} onInput={(e) => fit(e.currentTarget)}
                          onChange={(e) => patch(i, { title: e.target.value })} />
                <textarea className="plan-step-detail" value={st.detail} disabled={busy || !st.enabled} rows={1}
                          placeholder="做法與要檢查什麼（可留空）"
                          ref={fit} onInput={(e) => fit(e.currentTarget)}
                          onChange={(e) => patch(i, { detail: e.target.value })} />
                {st.source && <span className="plan-step-src">來源：{st.source}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {!rejecting ? (
        <div className="approve-actions">
          <button className="btn primary" disabled={busy || (hasTodo && !anyOn)}
                  onClick={() => onApprove(hasTodo ? steps : undefined, hasTools ? tools : undefined)}>
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

// Shown on a COMPLETED project: nominate this research as an experience note into a lab KB (閘門①).
// Any member may nominate; a lab owner approves it in the 實驗室庫 before it becomes retrievable.
export function NominateCard({ project, threadId }: { project: Project; threadId: string }) {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [sel, setSel] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [doneAuto, setDoneAuto] = useState(false);  // optimistic: owner's nomination auto-approves
  const [err, setErr] = useState("");
  const dismissKey = `pa:nominate-dismissed:${threadId}`;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(dismissKey) === "1");
  const nom = project.nomination;
  useEffect(() => {
    if (nom || dismissed) return;  // already nominated or dismissed — no need to load labs
    api.labs().then((r) => { setLabs(r.labs); setSel(r.labs[0]?.id || ""); }).catch(() => {});
  }, [nom, dismissed]);
  if (project.status !== "completed") return null;
  // user chose to skip; keep it hidden (已提名的卡片仍會顯示狀態，不受此影響)
  if (dismissed && !nom && !done) return null;

  if (nom || done) {
    const name = nom?.lab_name || labs.find((l) => l.id === done)?.name || "";
    const status = nom?.status || (doneAuto ? "approved" : "pending");
    return (
      <div className="nominate done">
        {status === "error"
          ? <span className="muted small">提名失敗：{nom?.detail || "請稍後再試"}</span>
          : status === "generating"
          ? <span className="muted small">正在整理研究經驗筆記並納入<strong>{name}</strong>…</span>
          : status === "pending"
          ? <span className="muted small">✓ 已提名納入<strong>{name}</strong>，待負責人審核後納入實驗室庫。</span>
          : <span className="muted small">✓ 已納入<strong>{name}</strong>實驗室庫，立即可被檢索。</span>}
      </div>
    );
  }
  const go = () => {
    if (!sel) return;
    setBusy(true); setErr("");
    api.nominate(threadId, sel).then((r) => { setDone(r.lab_id); setDoneAuto(r.auto_approve); })
      .catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  const skip = () => { localStorage.setItem(dismissKey, "1"); setDismissed(true); };
  const selLab = labs.find((l) => l.id === sel);
  const isOwnerOfSel = selLab?.role === "owner";
  return (
    <div className="nominate">
      <button className="nominate-close" onClick={skip} title="略過，不提名" aria-label="略過">×</button>
      <div className="nominate-head">
        <strong>把這次研究納入實驗室知識庫？</strong>
        <div className="muted small">會整理成一篇「研究經驗」筆記（方法＋踩坑）。{isOwnerOfSel
          ? "你是這個實驗室的負責人，會直接納入、立即可被同實驗室成員查到。"
          : "送交實驗室負責人審核；通過後，同實驗室的成員聊天就查得到。"}</div>
      </div>
      {labs.length === 0 ? (
        <span className="muted small">你還沒有加入任何實驗室——加入後即可提名。</span>
      ) : (
        <div className="nominate-actions">
          {labs.length > 1 && (
            <select value={sel} onChange={(e) => setSel(e.target.value)} disabled={busy}>
              {labs.map((l) => <option key={l.id} value={l.id}>{l.name}{l.role === "owner" ? "（我的實驗室）" : ""}</option>)}
            </select>
          )}
          <button className="btn primary small" disabled={busy || !sel} onClick={go}>
            {busy ? "處理中…" : isOwnerOfSel ? "納入我的實驗室庫" : labs.length > 1 ? "提名到所選實驗室" : `提名到「${labs[0].name}」`}
          </button>
          <button className="btn small" disabled={busy} onClick={skip}>略過</button>
        </div>
      )}
      {err && <div className="error small">{err}</div>}
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
  promote: "已從一般對話轉為研究專案",
  approved_plan: "計畫已核准 — 開始研究",
  reject_plan: "計畫退回 — 重新釐清與規劃",
  reject_accept: "結果退回 — 重做研究",
  verify: "開始獨立驗證",
  verify_fail: "驗證沒過 — 退回研究修正",
  replicate: "開始獨立複現",
  review: "開始唯讀審查",
};

export function PipelineNote({ note, body }: { note: string; body: string }) {
  const fb = body.replace(/^（[^：]*：?/, "").replace(/）\s*$/, "").trim();
  const isReject = note.startsWith("reject") || note === "verify_fail";
  return (
    <div className={`pipe-note ${isReject ? "reject" : "ok"}`}>
      <span className="pipe-line" />
      <span className="pipe-tag" title={body}>{NOTE_LABEL[note] || "流程"}{isReject && fb ? `：${fb.slice(0, 40)}` : ""}</span>
      <span className="pipe-line" />
    </div>
  );
}
