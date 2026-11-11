import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken, setToken, DomainChoice, ExampleCard, Lab, Thread, ThreadConfig, User } from "./api";
import { APP_LOCKUP } from "./brand";
import Chat, { EXAMPLES } from "./Chat";
import KbLibrary from "./KbLibrary";
import LabLibrary from "./LabLibrary";
import LabDirectory from "./LabDirectory";
import Login from "./Login";
import NewThreadModal from "./NewThreadModal";
import SharedView from "./SharedView";

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

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [current, setCurrent] = useState<string | null>(() => location.hash.match(/^#\/t\/([0-9a-f-]{36})$/)?.[1] ?? null);
  const [sharedId, setSharedId] = useState<string | null>(() => location.hash.match(/^#\/v\/([0-9a-f-]{36})$/)?.[1] ?? null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const [domainList, setDomainList] = useState<DomainChoice[]>(
    [{ name: "plasma", label: "電漿物理" }, { name: "general", label: "通用研究" }]);
  const [kbOpen, setKbOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [dirOpen, setDirOpen] = useState(false);
  const [labNotif, setLabNotif] = useState(0);  // pending nominations + grant requests awaiting me as a lab owner
  const [newOpen, setNewOpen] = useState(false);
  const [myLabs, setMyLabs] = useState<Lab[]>([]);        // my labs (for field-tailored home example cards)
  const [exampleSrc, setExampleSrc] = useState<string | null>(null);  // selected example source (lab id or "generic")
  const [draft, setDraft] = useState("");                 // landing composer text (starts a new chat on send)

  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    api.me().then(setUser).catch(() => setToken(null)).finally(() => setChecking(false));
  }, []);

  useEffect(() => { api.domains().then((d) => { if (d.length) setDomainList(d); }).catch(() => { /* keep fallback */ }); }, []);
  useEffect(() => { if (!user) { setMyLabs([]); return; } api.labs().then((r) => setMyLabs(r.labs)).catch(() => {}); }, [user]);
  // lab-library badge: items awaiting me as a lab owner; refresh on login, when the modal closes, and periodically
  useEffect(() => {
    if (!user) { setLabNotif(0); return; }
    const refresh = () => api.labNotifications().then((n) => setLabNotif(n.total)).catch(() => {});
    refresh();
    const id = setInterval(refresh, 45000);
    return () => clearInterval(id);
  }, [user, labOpen]);

  const refreshThreads = useCallback(async () => {
    try { setThreads(await api.threads()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshThreads();
  }, [user, refreshThreads]);

  useEffect(() => {
    if (sharedId) return;  // a shared-view route owns the hash; don't overwrite it
    history.replaceState(null, "", current ? `#/t/${current}` : "#/");
  }, [current, sharedId]);

  // react to hash navigation (e.g. opening a shared link, or browser back)
  useEffect(() => {
    const onHash = () => setSharedId(location.hash.match(/^#\/v\/([0-9a-f-]{36})$/)?.[1] ?? null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupThreads(q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads);
  }, [threads, query]);

  if (checking) return <div className="center muted">載入中…</div>;
  if (!user) return <Login onLogin={(u) => setUser(u)} />;
  if (sharedId) return <SharedView threadId={sharedId} onExit={() => { setSharedId(null); setCurrent(null); location.hash = "#/"; }} />;

  const createThread = async (opts: { domain: string; mode: string; config?: ThreadConfig }, prompt?: string) => {
    const t = await api.createThread(opts.domain, opts.mode, opts.config);
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

  // home example cards: generic set + one source per lab that has field-tailored cards; user can switch
  const genericCards: ExampleCard[] = EXAMPLES.map((e) => ({ title: e.title, text: e.text }));
  const labSources = myLabs.filter((l) => (l.example_cards?.length ?? 0) > 0);
  const exampleSources = [{ key: "generic", label: "通用", cards: genericCards },
    ...labSources.map((l) => ({ key: l.id, label: l.name, cards: l.example_cards! }))];
  const activeExampleKey = exampleSrc ?? (labSources[0]?.id ?? "generic");
  const activeExamples = exampleSources.find((s) => s.key === activeExampleKey)?.cards ?? genericCards;
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "夜深了" : hour < 12 ? "早安" : hour < 18 ? "午安" : "晚安";
  const startChat = () => { const t = draft.trim(); if (t) createThread({ domain: "research", mode: "chat" }, t); };

  return (
    <div className="layout">
      <header className="topbar">
        <button className={`drawer-ico-btn ${sidebarOpen ? "on" : ""}`} onClick={() => setSidebarOpen((v) => !v)}
                title="開啟／收合對話列表" aria-label="對話列表">☰</button>
        <div className="brand" onClick={() => { setCurrent(null); setSidebarOpen(false); }} title="回首頁">
          <span className="logo sm" />
          <span className="brand-name">{APP_LOCKUP}</span>
        </div>
        <span className="spacer" />
        <button className="topbtn" title="共用基礎知識庫" onClick={() => setKbOpen(true)}>基礎庫</button>
        <button className="topbtn" title="實驗室共用知識庫" onClick={() => setLabOpen(true)}>
          實驗室庫{labNotif > 0 && <span className="topbtn-badge">{labNotif}</span>}
        </button>
        <button className="topbtn" title="跨實驗室專長名錄" onClick={() => setDirOpen(true)}>名錄</button>
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
        <button className="drawer-new" onClick={() => { setNewOpen(true); setSidebarOpen(false); }}>＋ 新研究</button>
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
            <div className="welcome-new">
              <h1 className="greet">{greeting}，{user.name} 👋</h1>
              <section className="examples">
                <div className="examples-title">
                  試試這些問題
                  {exampleSources.length > 1 && (
                    <span className="example-src">
                      {exampleSources.map((sc) => (
                        <button key={sc.key} className={"src-chip" + (sc.key === activeExampleKey ? " on" : "")}
                                onClick={() => setExampleSrc(sc.key)}>{sc.label}</button>
                      ))}
                    </span>
                  )}
                </div>
                <div className="example-list">
                  {activeExamples.map((ex) => (
                    <button key={ex.title} className="example"
                            onClick={() => createThread({ domain: "research", mode: "chat" }, ex.text)}>
                      <span className="ex-t">{ex.title}</span><span className="ex-d">{ex.text}</span>
                    </button>
                  ))}
                </div>
              </section>
              <div className="composer-box landing">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startChat(); } }}
                  rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                  placeholder="描述你的研究問題，開始一個新對話…" />
                <div className="composer-bar">
                  <span className="muted small hint">Enter 送出 · Shift+Enter 換行</span>
                  <button className="btn ghost small" onClick={() => setNewOpen(true)}
                          title="建立完整的九階段研究專案（釐清→規劃→研究→驗證→審查）">開新研究專案</button>
                  <span className="spacer" />
                  <button className="btn primary" onClick={startChat} disabled={!draft.trim()}>送出</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
      {kbOpen && <KbLibrary onClose={() => setKbOpen(false)} />}
      {labOpen && <LabLibrary user={user} onClose={() => setLabOpen(false)} />}
      {dirOpen && <LabDirectory onClose={() => setDirOpen(false)} />}
      {newOpen && <NewThreadModal domains={domainList} defaultDomain={domainList[0]?.name ?? "plasma"}
        defaultMode="chat" onClose={() => setNewOpen(false)}
        onCreate={(o) => { setNewOpen(false); createThread(o); }} />}
    </div>
  );
}
