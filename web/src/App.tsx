import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken, setToken, DomainChoice, Thread, User } from "./api";
import { APP_NAME } from "./brand";
import Chat, { EXAMPLES } from "./Chat";
import KbLibrary from "./KbLibrary";
import Login from "./Login";

type Theme = "auto" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem("pa_theme") as Theme) || "auto"; } catch { return "auto"; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme; else root.dataset.theme = theme;
    try { localStorage.setItem("pa_theme", theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, setTheme];
}

function groupThreads(ts: Thread[]) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86400_000;
  const groups: [string, Thread[]][] = [["今天", []], ["昨天", []], ["過去 7 天", []], ["更早", []]];
  for (const t of ts) {
    const u = new Date(t.updated_at).getTime();
    const idx = u >= start.getTime() ? 0 : u >= start.getTime() - day ? 1 : u >= start.getTime() - 7 * day ? 2 : 3;
    groups[idx][1].push(t);
  }
  return groups.filter(([, list]) => list.length);
}

const FLOW: [string, string, boolean?][] = [
  ["釐清", "AI 把你的想法收斂成明確、可執行的問題"],
  ["檢索證據", "程式自動查知識庫與文獻，整理成證據"],
  ["規劃", "AI 依證據設計計畫，參數標明來源"],
  ["核准", "你核准計畫，或退回並說明要改的地方", true],
  ["研究", "AI 在沙盒裡動手做、驗證、交件"],
  ["驗收", "你驗收結果，或退回重做", true],
];

const CAPS = [
  { icon: "◴", title: "九階段流程", text: "釐清、檢索證據、規劃、研究、驗證、審查——每一步看得到，計畫與結果由你把關" },
  { icon: "⌘", title: "GPU 沙盒", text: "每個對話一個獨立 Linux 環境（RTX 4070 Ti SUPER），寫程式、跑模擬、畫圖" },
  { icon: "❡", title: "知識庫與文獻", text: "上傳的文件自動建索引可檢索；搜尋 arXiv、OpenAlex 與網頁，只引用查到的來源" },
  { icon: "◩", title: "可追溯的交付", text: "結果附上驗證方式與來源，產生的檔案可直接預覽下載" },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [current, setCurrent] = useState<string | null>(() => location.hash.match(/^#\/t\/([0-9a-f-]{36})$/)?.[1] ?? null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const [domainList, setDomainList] = useState<DomainChoice[]>(
    [{ name: "plasma", label: "電漿物理" }, { name: "general", label: "通用研究" }]);
  const [newDomain, setNewDomain] = useState("plasma");
  const [newMode, setNewMode] = useState("chat");
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    api.me().then(setUser).catch(() => setToken(null)).finally(() => setChecking(false));
  }, []);

  useEffect(() => { api.domains().then((d) => { if (d.length) setDomainList(d); }).catch(() => { /* keep fallback */ }); }, []);

  const domainLabel = useCallback(
    (name: string) => domainList.find((d) => d.name === name)?.label || name, [domainList]);

  const refreshThreads = useCallback(async () => {
    try { setThreads(await api.threads()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshThreads();
  }, [user, refreshThreads]);

  useEffect(() => {
    history.replaceState(null, "", current ? `#/t/${current}` : "#/");
  }, [current]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupThreads(q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads);
  }, [threads, query]);

  if (checking) return <div className="center muted">載入中…</div>;
  if (!user) return <Login onLogin={(u) => setUser(u)} />;

  const newThread = async (prompt?: string, domain?: string, mode?: string) => {
    const t = await api.createThread(domain ?? newDomain, mode ?? newMode);
    setThreads((ts) => [t, ...ts]);
    setPending(prompt ?? null);
    setCurrent(t.id);
    setSidebarOpen(false);
  };

  const removeThread = async (t: Thread) => {
    if (!confirm(`刪除對話「${t.title}」？工作區檔案也會一併刪除。`)) return;
    await api.deleteThread(t.id);
    setThreads((ts) => ts.filter((x) => x.id !== t.id));
    if (current === t.id) setCurrent(null);
  };

  const renameThread = async (t: Thread) => {
    const title = prompt("新的對話名稱", t.title);
    if (!title || title === t.title) return;
    const nt = await api.renameThread(t.id, title);
    setThreads((ts) => ts.map((x) => (x.id === t.id ? nt : x)));
  };

  const nextTheme: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
  const themeLabel: Record<Theme, string> = { auto: "◐ 自動", light: "☀ 淺色", dark: "☾ 深色" };

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand" onClick={() => { setCurrent(null); setSidebarOpen(false); }} title="回首頁">
          <span className="logo sm" />
          <span className="brand-name">{APP_NAME}</span>
        </div>
        <button className={`topbtn ${sidebarOpen ? "on" : ""}`} onClick={() => setSidebarOpen((v) => !v)}>
          對話{threads.length ? <span className="muted"> {threads.length}</span> : null}
        </button>
        <span className="topdiv" />
        <div className="mode-seg" title="一般對話＝單一助理；研究專案＝釐清→規劃→核准→研究→驗收的九階段流程">
          <button className={newMode === "chat" ? "on" : ""} onClick={() => setNewMode("chat")}>一般對話</button>
          <button className={newMode === "project" ? "on" : ""} onClick={() => setNewMode("project")}>研究專案</button>
        </div>
        <select className="domain-select" value={newDomain} title="選擇研究領域" onChange={(e) => setNewDomain(e.target.value)}>
          {domainList.map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
        </select>
        <button className="btn primary small" onClick={() => newThread()}>{newMode === "project" ? "＋ 新專案" : "＋ 新研究"}</button>
        <span className="spacer" />
        <button className="topbtn" title="共用基礎知識庫" onClick={() => setKbOpen(true)}>基礎庫</button>
        <button className="topbtn" title="切換主題" onClick={() => setTheme(nextTheme[theme])}>{themeLabel[theme]}</button>
        <span className="avatar user" title={`${user.name}\n${user.email}`}>{(user.name || user.email)[0]?.toUpperCase()}</span>
        <button className="topbtn" title="登出" onClick={() => { setToken(null); setUser(null); setThreads([]); setCurrent(null); }}>登出</button>
      </header>

      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={`drawer ${sidebarOpen ? "open" : ""}`}>
        <div className="drawer-head">
          <input className="search" placeholder="搜尋對話…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="icon" onClick={() => setSidebarOpen(false)} aria-label="關閉">✕</button>
        </div>
        <div className="thread-list">
          {threads.length === 0 && <div className="muted small pad">還沒有對話</div>}
          {groups.map(([label, list]) => (
            <div key={label} className="thread-group">
              <div className="group-label">{label}</div>
              {list.map((t) => (
                <div key={t.id} className={`thread ${t.id === current ? "active" : ""}`}
                     onClick={() => { setCurrent(t.id); setSidebarOpen(false); }}>
                  <span className="thread-title" title={t.title}>{t.title}</span>
                  {t.mode === "project" && <span className="domain-badge project">專案</span>}
                  {t.domain && t.domain !== "plasma" && <span className="domain-badge">{domainLabel(t.domain)}</span>}
                  <span className="thread-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon" title="重新命名" onClick={() => renameThread(t)}>✎</button>
                    <button className="icon" title="刪除" onClick={() => removeThread(t)}>✕</button>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {current ? (
          <Chat key={current} threadId={current} onActivity={refreshThreads}
            initialPrompt={pending} onPromptUsed={() => setPending(null)} />
        ) : (
          <div className="welcome">
            <header className="hero">
              <div className="kicker">{APP_NAME}</div>
              <h1 className="hero-title">把一個研究想法，<br />跑完一整套可驗證的流程。</h1>
              <p className="lede">描述你的研究想法，它會走完釐清、檢索證據、規劃，交由你核准後在 GPU 沙盒裡動手做，驗證後再請你驗收。每一步都看得到，關鍵決策由你把關。</p>
              <nav className="flow" aria-label="研究流程">
                {FLOW.map(([s, tip, gate]) => (
                  <span key={s} className={`flow-step${gate ? " gate" : ""}`} data-tip={tip}>{s}</span>
                ))}
              </nav>
              <button className="btn primary lg" onClick={() => newThread()}>開始新研究</button>
            </header>
            <section className="caps">
              {CAPS.map((c) => (
                <div key={c.title} className="cap-row">
                  <div className="cap-k">{c.title}</div>
                  <div className="cap-v">{c.text}</div>
                </div>
              ))}
            </section>
            <section className="examples">
              <div className="examples-title">試試這些問題</div>
              <div className="example-list">
                {EXAMPLES.map((ex) => (
                  <button key={ex.title} className="example" onClick={() => newThread(ex.text, ex.domain, "chat")}>
                    <span className="ex-t">{ex.title}</span><span className="ex-d">{ex.text}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
      {kbOpen && <KbLibrary onClose={() => setKbOpen(false)} />}
    </div>
  );
}
