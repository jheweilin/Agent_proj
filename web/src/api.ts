export type User = { id: string; email: string; name: string; is_admin: boolean; is_faculty: boolean };
export type DomainChoice = { name: string; label: string };
export type ModelChoice = { id: string; label: string };
export type AgentSlot = { key: string; label: string; modes: string[] };
export type ModelsInfo = {
  models: ModelChoice[]; default_model: string; agents: AgentSlot[];
  defaults: { effort: string; max_iterations: number };
};
export type ThreadConfig = { models?: Record<string, string>; effort?: string; max_iterations?: number };
export type LabMember = { user_id: string; name: string; email: string; role: string };
export type Lab = {
  id: string; name: string; role: string; owner_id: string; created_at: string;
  join_code?: string; member_count?: number; members?: LabMember[];
  // L2 specialty profile (公開名片)
  summary?: string; keywords?: string[]; is_public?: boolean;
  profile_draft?: string; profile_status?: string;  // owner only
  example_cards?: ExampleCard[];  // auto-generated home examples tailored to the lab's field
};
export type ExampleCard = { title: string; text: string };
export type DirectoryLab = {
  id: string; name: string; summary: string; keywords: string[]; member_count: number; is_member: boolean;
};
export type Grant = {
  id: string; status: string; scope: string; scope_ref: string[]; note: string;
  grantor_lab_id: string; grantee_lab_id: string; grantor_name: string; grantee_name: string; created_at: string;
};
export type Thread = { id: string; title: string; domain: string; mode: string; config?: ThreadConfig; suggest_project?: boolean | null; promote_dismissed?: boolean; shared?: boolean; is_owner?: boolean; created_at: string; updated_at: string; active_run_id: string | null };

export type ToolResult = {
  is_error: boolean; preview: string; output?: string; images?: string[]; ui?: any; seconds?: number;
};
export type ToolProgress = { status?: string; stage?: string; percent?: number; elapsed?: number; queue_position?: number };
export type ToolBlock = { type: "tool"; id: string; name: string; input?: any; result?: ToolResult | null; progress?: ToolProgress | null };
export type Block = { type: "text"; text: string } | { type: "thinking"; text: string } | ToolBlock;
export type Attachment = { path: string; name: string; size: number; mime: string };

export type Item =
  | { kind: "user"; id: number; text: string; created_at: string }
  | { kind: "assistant"; id: number; run_id: string; blocks: Block[]; attachments: Attachment[]; created_at: string };

export type Usage = {
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number;
  cache_creation_input_tokens: number; requests: number;
};
export type RunInfo = {
  id: string; status: string; error: string | null; model: string; usage: Usage | Record<string, never>;
  created_at: string; started_at: string | null; finished_at: string | null; steps?: number;
};
export type ToolDetail = {
  id: string; name: string; input: any;
  result: { is_error: boolean; text: string; images: string[] } | null;
};
export type Job = {
  job_id: string; name: string; command: string; started_at: string; status: string;
  exit_code: string | null; log_path: string;
};
export type ThreadStatus = {
  run: RunInfo | null;
  sandbox: { state: string; name?: string; gpu?: { name: string; mem_used_mb: number; mem_total_mb: number; util_pct: number } };
  comsol: { status: string; comsol_available?: boolean; queue_size?: number; running_job?: string | null; error?: string } | null;
  jobs: Job[];
  todo: string | null;
  model: string;
  kb?: { docs: number; chunks: number } | null;
};
export type FileEntry = { name: string; path: string; dir: boolean; size: number; mtime: number };
export type KbDoc = {
  id: string; source: string; chunks: number; created_at: string;
  // knowledge-flywheel metadata (lab KB); defaults upload/reference/approved for plain uploads
  origin?: string; kind?: string; status?: string; tags?: string[];
  source_thread_id?: string | null; submitted_by?: string | null; submitted_by_name?: string;
  // retained original file (base/lab KB)
  title?: string; size?: number; mime?: string; has_file?: boolean;
};

export type ProjectStage = { name: string; label: string };
export type Grade = { level: string; passed: number; total: number; summary: string };
export type PlanStep = { title: string; detail: string; source: string; enabled?: boolean };
export type PlanTool = { name: string; why: string; enabled?: boolean };
export type Nomination = { lab_id: string; lab_name: string; status: string; source?: string; doc_id?: string; detail?: string };
export type Project = {
  stage: string; status: string; stages: ProjectStage[];
  grade?: Grade | null; plan_steps?: PlanStep[]; plan_tools?: PlanTool[]; nomination?: Nomination | null;
};

// injected pipeline messages carry a machine marker so the UI renders them as stage cards / notes
export type PipeParsed =
  | { kind: "evidence"; body: string }
  | { kind: "note"; note: string; body: string }
  | null;
export function parsePipe(text: string): PipeParsed {
  const nl = text.indexOf("\n");
  if (text.startsWith("[[pa:evidence]]")) return { kind: "evidence", body: nl >= 0 ? text.slice(nl + 1) : "" };
  const m = /^\[\[pa:note:([a-z_]+)\]\]/.exec(text);
  if (m) return { kind: "note", note: m[1], body: nl >= 0 ? text.slice(nl + 1) : "" };
  return null;
}

const TOKEN_KEY = "pa_token";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: any, isForm = false): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  const r = await fetch(path, { method, headers, body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : msg; } catch { /* ignore */ }
    if (r.status === 401) setToken(null);
    throw new ApiError(r.status, msg);
  }
  return r.json();
}

export const api = {
  register: (email: string, password: string, name: string) =>
    req<{ token: string; user: User }>("POST", "/api/auth/register", { email, password, name }),
  login: (email: string, password: string) => req<{ token: string; user: User }>("POST", "/api/auth/login", { email, password }),
  me: () => req<User>("GET", "/api/me"),
  domains: () => req<DomainChoice[]>("GET", "/api/domains"),
  models: () => req<ModelsInfo>("GET", "/api/models"),
  threads: () => req<Thread[]>("GET", "/api/threads"),
  createThread: (domain?: string, mode?: string, config?: ThreadConfig) =>
    req<Thread>("POST", "/api/threads",
      { ...(domain ? { domain } : {}), ...(mode ? { mode } : {}), ...(config ? { config } : {}) }),
  thread: (id: string) => req<Thread>("GET", `/api/threads/${id}`),
  renameThread: (id: string, title: string) => req<Thread>("PATCH", `/api/threads/${id}`, { title }),
  deleteThread: (id: string) => req<{ ok: boolean }>("DELETE", `/api/threads/${id}`),
  messages: (id: string) => req<{ items: Item[]; runs: RunInfo[]; project: Project | null }>("GET", `/api/threads/${id}/messages`),
  send: (id: string, text: string, uploads: string[]) =>
    req<{ run_id: string }>("POST", `/api/threads/${id}/messages`, { text, uploads }),
  stop: (runId: string) => req<{ ok: boolean }>("POST", `/api/runs/${runId}/stop`),
  approve: (id: string, planSteps?: PlanStep[], planTools?: PlanTool[]) =>
    req<{ ok: boolean; stage: string; status: string; run_id?: string }>("POST", `/api/threads/${id}/approve`,
      (planSteps || planTools) ? { ...(planSteps ? { plan_steps: planSteps } : {}), ...(planTools ? { plan_tools: planTools } : {}) } : undefined),
  promote: (id: string) =>
    req<{ ok: boolean; run_id?: string }>("POST", `/api/threads/${id}/promote`),
  dismissPromote: (id: string) =>
    req<{ ok: boolean }>("POST", `/api/threads/${id}/dismiss-promote`),
  reject: (id: string, feedback: string) =>
    req<{ ok: boolean; stage: string; status: string; run_id?: string }>("POST", `/api/threads/${id}/reject`, { feedback }),
  toolDetail: (id: string, toolId: string) => req<ToolDetail>("GET", `/api/threads/${id}/tools/${toolId}`),
  shareThread: (id: string, shared: boolean) =>
    req<{ ok: boolean; shared: boolean }>("POST", `/api/threads/${id}/share`, { shared }),
  status: (id: string) => req<ThreadStatus>("GET", `/api/threads/${id}/status`),
  files: (id: string, path: string) =>
    req<{ path: string; entries: FileEntry[] }>("GET", `/api/threads/${id}/files?path=${encodeURIComponent(path)}`),
  upload: (id: string, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return req<{ paths: string[] }>("POST", `/api/threads/${id}/upload`, fd, true);
  },
  kbBase: () => req<{ enabled: boolean; can_manage: boolean; documents: KbDoc[] }>("GET", "/api/kb/base"),
  kbBaseUpload: (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return req<{ ingested: { source: string; chunks: number }[] }>("POST", "/api/kb/base/upload", fd, true);
  },
  kbBaseDelete: (id: string) => req<{ ok: boolean }>("DELETE", `/api/kb/base/documents/${id}`),

  labs: () => req<{ labs: Lab[]; can_create: boolean }>("GET", "/api/labs"),
  createLab: (name: string) => req<Lab>("POST", "/api/labs", { name }),
  joinLab: (join_code: string) => req<Lab>("POST", "/api/labs/join", { join_code }),
  lab: (id: string) => req<Lab>("GET", `/api/labs/${id}`),
  addLabMember: (id: string, email: string) => req<{ ok: boolean }>("POST", `/api/labs/${id}/members`, { email }),
  removeLabMember: (id: string, memberId: string) =>
    req<{ ok: boolean }>("DELETE", `/api/labs/${id}/members/${memberId}`),
  regenLabCode: (id: string) => req<{ join_code: string }>("POST", `/api/labs/${id}/regenerate-code`),
  labKb: (id: string) => req<{ enabled: boolean; documents: KbDoc[] }>("GET", `/api/labs/${id}/kb`),
  labKbUpload: (id: string, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return req<{ ingested: { source: string; chunks: number }[] }>("POST", `/api/labs/${id}/kb/upload`, fd, true);
  },
  labKbDelete: (id: string, docId: string) => req<{ ok: boolean }>("DELETE", `/api/labs/${id}/kb/documents/${docId}`),
  // knowledge flywheel: nominate a finished project → lab KB (pending); owner reviews the queue
  nominate: (threadId: string, labId: string) =>
    req<{ ok: boolean; status: string; lab_id: string; lab_name: string }>("POST", `/api/threads/${threadId}/nominate`, { lab_id: labId }),
  labKbPending: (id: string) => req<{ enabled: boolean; documents: KbDoc[] }>("GET", `/api/labs/${id}/kb/pending`),
  labKbReview: (id: string, docId: string, action: "approve" | "reject") =>
    req<{ ok: boolean }>("POST", `/api/labs/${id}/kb/pending/${docId}/${action}`),
  // L2 專長名錄
  labNotifications: () => req<{ pending: number; requests: number; total: number }>("GET", "/api/labs/notifications"),
  labDirectory: () => req<{ labs: DirectoryLab[] }>("GET", "/api/labs/directory"),
  setLabProfile: (id: string, body: { summary: string; keywords: string[]; is_public: boolean }) =>
    req<Lab>("PUT", `/api/labs/${id}/profile`, body),
  draftLabProfile: (id: string) => req<{ ok: boolean; status: string }>("POST", `/api/labs/${id}/profile/draft`),
  // L3 申請授權
  labKbTags: (id: string, docId: string, tags: string[]) =>
    req<{ ok: boolean }>("PUT", `/api/labs/${id}/kb/documents/${docId}/tags`, { tags }),
  requestGrant: (granteeLabId: string, grantorLabId: string, note: string) =>
    req<{ ok: boolean }>("POST", `/api/labs/${granteeLabId}/grants/request`, { grantor_lab_id: grantorLabId, note }),
  labGrants: (id: string) => req<{ incoming: Grant[]; outgoing: Grant[] }>("GET", `/api/labs/${id}/grants`),
  actGrant: (grantId: string, action: "approve" | "reject" | "revoke", body?: { scope: string; scope_ref: string[] }) =>
    req<{ ok: boolean; status: string }>("POST", `/api/grants/${grantId}/${action}`, body),
  // unified KB document view / manage (original file retained for base + lab uploads)
  kbDocText: (docId: string) => req<{ text: string; source: string }>("GET", `/api/kb/documents/${docId}/text`),
  kbDocEdit: (docId: string, body: { title?: string; tags?: string[] }) =>
    req<{ ok: boolean }>("PATCH", `/api/kb/documents/${docId}`, body),
  kbDocReplace: (docId: string, file: File) => {
    const fd = new FormData(); fd.append("file", file);
    return req<{ ok: boolean }>("POST", `/api/kb/documents/${docId}/replace`, fd, true);
  },
};

export function kbDocFileUrl(docId: string, download = false) {
  const t = encodeURIComponent(getToken() || "");
  return `/api/kb/documents/${docId}/file?token=${t}${download ? "&download=1" : ""}`;
}

export function fileUrl(threadId: string, path: string, download = false) {
  const t = encodeURIComponent(getToken() || "");
  return `/api/threads/${threadId}/file?path=${encodeURIComponent(path)}&token=${t}${download ? "&download=1" : ""}`;
}

export async function fetchText(threadId: string, path: string, maxBytes = 1_000_000): Promise<{ text: string; truncated: boolean }> {
  const r = await fetch(fileUrl(threadId, path));
  if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const truncated = buf.byteLength > maxBytes;
  const text = new TextDecoder("utf-8").decode(truncated ? buf.slice(0, maxBytes) : buf);
  return { text, truncated };
}

export function eventsUrl(runId: string) {
  return `/api/runs/${runId}/events?token=${encodeURIComponent(getToken() || "")}`;
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTokens(n: number | undefined) {
  if (!n) return "0";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtDuration(sec: number) {
  if (!isFinite(sec) || sec < 0) return "-";
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

export function modelName(m: string) {
  const x = m.toLowerCase();
  const tier = x.includes("opus") ? "Opus" : x.includes("sonnet") ? "Sonnet"
    : x.includes("haiku") ? "Haiku" : x.includes("fable") ? "Fable" : "";
  if (!tier) return m;
  const mm = x.match(/(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/);
  const ver = mm ? (mm[2] ? `${mm[1]}.${mm[2]}` : mm[1]) : "";
  return `Claude ${tier}${ver ? " " + ver : ""}`;
}

export function zipUrl(threadId: string, paths: string[], name = "results") {
  const q = paths.map((p) => `path=${encodeURIComponent(p)}`).join("&");
  return `/api/threads/${threadId}/zip?${q}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken() || "")}`;
}
