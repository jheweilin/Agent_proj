import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken, setToken, DomainChoice, Thread, User } from "./api";
import { APP_NAME } from "./brand";
import Chat, { EXAMPLES } from "./Chat";
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
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand" onClick={() => { setCurrent(null); setSidebarOpen(false); }}>
          <span className="logo" />
          <div>
            <div className="brand-name">{APP_NAME}</div>
            <div className="brand-sub">可驗證的研究流程</div>
          </div>
        </div>
        <div className="mode-seg" title="一般對話＝單一助理；研究專案＝釐清→規劃→核准→研究→驗收的九階段流程">
          <button className={newMode === "chat" ? "on" : ""} onClick={() => setNewMode("chat")}>一般對話</button>
          <button className={newMode === "project" ? "on" : ""} onClick={() => setNewMode("project")}>研究專案</button>
        </div>
        <div className="new-chat">
          <select className="domain-select" value={newDomain} title="選擇研究領域"
                  onChange={(e) => setNewDomain(e.target.value)}>
            {domainList.map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
          </select>
          <button className="btn primary block" onClick={() => newThread()}>
            {newMode === "project" ? "＋ 新專案" : "＋ 新對話"}
          </button>
        </div>
        <input className="search" placeholder="搜尋對話…" value={query} onChange={(e) => setQuery(e.target.value)} />
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
        <div className="user-box">
          <span className="avatar user">{(user.name || user.email)[0]?.toUpperCase()}</span>
          <div className="small user-info">{user.name}<div className="muted">{user.email}</div></div>
          <button className="icon" title="切換主題" onClick={() => setTheme(nextTheme[theme])}>{themeLabel[theme]}</button>
          <button className="icon" title="登出" onClick={() => { setToken(null); setUser(null); setThreads([]); setCurrent(null); }}>登出</button>
        </div>
      </aside>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <main className="main">
        <button className="menu-btn" onClick={() => setSidebarOpen(true)} aria-label="開啟選單">☰</button>
        {current ? (
          <Chat key={current} threadId={current} onActivity={refreshThreads}
            initialPrompt={pending} onPromptUsed={() => setPending(null)} />
        ) : (
          <div className="welcome">
            <div className="welcome-hero">
              <span className="logo big" />
              <h1>{APP_NAME}</h1>
              <p className="lede">描述你的研究想法，它會走完釐清 → 檢索證據 → 規劃 →（你核准）→ 研究 →（你驗收）的流程，在 GPU 沙盒裡動手做，並交出可追溯的結果。</p>
            </div>
            <div className="cap-grid">
              {CAPS.map((c) => (
                <div key={c.title} className="cap"><span className="cap-icon">{c.icon}</span><strong>{c.title}</strong><span className="muted small">{c.text}</span></div>
              ))}
            </div>
            <div className="examples-title">試試這些問題</div>
            <div className="example-grid">
              {EXAMPLES.map((ex) => (
                <button key={ex.title} className="example" onClick={() => newThread(ex.text, "plasma", "chat")}>
                  <strong>{ex.title}</strong><span>{ex.text}</span>
                </button>
              ))}
            </div>
            <button className="btn primary" onClick={() => newThread()}>開始新對話</button>
          </div>
        )}
      </main>
    </div>
  );
}
