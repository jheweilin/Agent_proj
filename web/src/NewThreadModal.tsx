import { useEffect, useMemo, useState } from "react";
import { api, DomainChoice, ModelsInfo, ThreadConfig } from "./api";

type CreateOpts = { domain: string; mode: string; config?: ThreadConfig };

// short, plain-language description of what each agent slot does — shown next to its model picker
const AGENT_DESC: Record<string, string> = {
  chat: "回答與動手做的 AI 助理",
  clarifier: "把想法收斂成明確的問題",
  planner: "依證據擬定可執行的計畫",
  researcher: "在沙盒寫程式、跑模擬、交付",
  verifier: "獨立重算，查守恆與誤差",
  replicator: "隔離重做一次，交叉比對",
  reviewer: "唯讀審查，挑出疑慮",
};

// Centered dialog for starting a new chat / research project, with advanced per-agent model,
// reasoning effort and iteration-cap options. Replaces the old fixed topbar controls.
export default function NewThreadModal(
  { domains, defaultDomain, defaultMode, onCreate, onClose }:
  { domains: DomainChoice[]; defaultDomain: string; defaultMode: string;
    onCreate: (o: CreateOpts) => void; onClose: () => void }) {
  const [mode, setMode] = useState(defaultMode);
  const [domain, setDomain] = useState(defaultDomain);
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<Record<string, string>>({});
  const [effort, setEffort] = useState("");
  const [maxIters, setMaxIters] = useState<string>("");

  useEffect(() => {
    api.models().then((m) => {
      setInfo(m);
      setEffort(m.defaults.effort);
      setMaxIters(String(m.defaults.max_iterations));
    }).catch(() => { /* advanced options just stay unavailable */ });
  }, []);

  const slots = useMemo(() => info?.agents.filter((a) => a.modes.includes(mode)) ?? [], [info, mode]);
  const modelOf = (key: string) => models[key] || info?.default_model || "";

  const create = () => {
    const cfg: ThreadConfig = {};
    if (info) {
      const m: Record<string, string> = {};
      for (const sl of slots) {
        const v = models[sl.key];
        if (v && v !== info.default_model) m[sl.key] = v;  // only non-default overrides
      }
      if (Object.keys(m).length) cfg.models = m;
      if (effort && effort !== info.defaults.effort) cfg.effort = effort;
      const mi = parseInt(maxIters, 10);
      if (mi && mi !== info.defaults.max_iterations) cfg.max_iterations = mi;
    }
    onCreate({ domain, mode, config: Object.keys(cfg).length ? cfg : undefined });
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>開新對話</h3>
          <button className="icon" onClick={onClose} aria-label="關閉">✕</button>
        </div>

        <label className="field-label">要怎麼進行？</label>
        <div className="mode-cards">
          <button className={`mode-card ${mode === "chat" ? "on" : ""}`} onClick={() => setMode("chat")}>
            <span className="mc-title">一般對話</span>
            <span className="mc-desc">單一 AI 助理，全部工具可用、會查你所屬實驗室的知識庫，直接問、直接做。適合快速問答、計算、畫圖。</span>
          </button>
          <button className={`mode-card ${mode === "project" ? "on" : ""}`} onClick={() => setMode("project")}>
            <span className="mc-title">研究專案</span>
            <span className="mc-desc">完整九階段流程：AI 先幫你釐清問題、查證據、擬計畫，<strong>你核准後</strong>才動手做，再獨立驗證、複現、審查並評等，最後<strong>由你驗收</strong>。</span>
          </button>
        </div>

        <button className={`adv-toggle ${advanced ? "open" : ""}`} onClick={() => setAdvanced((v) => !v)}>
          <span className="chev">{advanced ? "▾" : "▸"}</span> 進階選項
          <span className="field-hint inline">選用；不動就用預設</span>
        </button>

        {advanced && (
          <div className="adv-body">
            {!info && <div className="muted small">載入模型清單…</div>}
            {info && (
              <>
                <div className="adv-sec-title">
                  {mode === "project" ? "每個階段用哪個模型" : "AI 模型"}
                  {slots.length > 1 && (
                    <select className="apply-all" value="" title="一次套用到所有階段"
                            onChange={(e) => { const v = e.target.value; if (v) setModels(Object.fromEntries(slots.map((s) => [s.key, v]))); }}>
                      <option value="">套用到全部…</option>
                      {info.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  )}
                </div>
                <p className="field-hint">預設 Sonnet 5.5（均衡）。要更強的推理選 Opus，要更快更省選 Haiku。</p>
                {slots.map((sl) => (
                  <div key={sl.key} className="agent-row">
                    <span className="agent-label">
                      <span className="al-name">{sl.label}</span>
                      <span className="al-desc">{AGENT_DESC[sl.key] ?? ""}</span>
                    </span>
                    <select value={modelOf(sl.key)}
                            onChange={(e) => setModels((m) => ({ ...m, [sl.key]: e.target.value }))}>
                      {info.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                ))}

                <div className="adv-sec-title">推理與執行</div>
                <div className="agent-row">
                  <span className="agent-label">
                    <span className="al-name">推理強度</span>
                    <span className="al-desc">越高思考越深、越慢</span>
                  </span>
                  <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                    <option value="low">低 · 快速</option>
                    <option value="medium">中 · 均衡（預設）</option>
                    <option value="high">高 · 深入</option>
                  </select>
                </div>
                <div className="agent-row">
                  <span className="agent-label">
                    <span className="al-name">工具輪數上限</span>
                    <span className="al-desc">一次執行最多呼叫幾輪工具</span>
                  </span>
                  <input className="num-input" type="number" min={1} max={300} value={maxIters}
                         onChange={(e) => setMaxIters(e.target.value)} />
                </div>
              </>
            )}
          </div>
        )}

        <div className="modal-foot">
          <button className="btn small" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={create}>建立{mode === "project" ? "研究專案" : "對話"}</button>
        </div>
      </div>
    </div>
  );
}
