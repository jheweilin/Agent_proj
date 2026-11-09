import httpx, json
c = httpx.Client(base_url="http://127.0.0.1:8600", timeout=30)
tok = c.post("/api/auth/login", json={"email": "e2e-test@plasma.local", "password": "e2e-test-password"}).json()["token"]
H = {"Authorization": f"Bearer {tok}"}
ts = c.get("/api/threads", headers=H).json()
smilei = next(t for t in ts if "SMILEI" in t["title"])
st = c.get(f"/api/threads/{smilei['id']}/status", headers=H).json()
print(json.dumps({k: st[k] for k in ("sandbox", "comsol")}, ensure_ascii=False))
print("run:", {k: st["run"][k] for k in ("status", "steps", "model", "started_at", "finished_at")})
print("jobs:", [(j["job_id"], j["status"], j["exit_code"]) for j in st["jobs"]], "todo:", bool(st["todo"]))
msgs = c.get(f"/api/threads/{smilei['id']}/messages", headers=H).json()
tool = next(b for it in msgs["items"] if it["kind"] == "assistant" for b in it["blocks"] if b["type"] == "tool")
d = c.get(f"/api/threads/{smilei['id']}/tools/{tool['id']}", headers=H).json()
print("tool detail:", d["name"], len(d["result"]["text"]), "chars")
print(smilei["id"])
