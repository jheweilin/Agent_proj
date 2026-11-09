import { FormEvent, useState } from "react";
import { api, setToken, User } from "./api";
import { APP_NAME } from "./brand";

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = mode === "login" ? await api.login(email, password) : await api.register(email, password, name);
      setToken(r.token);
      onLogin(r.user);
    } catch (err: any) {
      setError(err.message || "失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand center-row">
          <span className="logo" />
          <div>
            <div className="brand-name">{APP_NAME}</div>
            <div className="brand-sub">可驗證的研究流程</div>
          </div>
        </div>
        <div className="tabs">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>登入</button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>註冊</button>
        </div>
        {mode === "register" && (
          <label>名稱<input value={name} onChange={(e) => setName(e.target.value)} placeholder="顯示名稱" /></label>
        )}
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>密碼<input type="password" required minLength={mode === "register" ? 8 : 1} value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"}
          placeholder={mode === "register" ? "至少 8 個字元" : ""} /></label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary block" disabled={busy}>{busy ? "處理中…" : mode === "login" ? "登入" : "建立帳號"}</button>
      </form>
    </div>
  );
}
