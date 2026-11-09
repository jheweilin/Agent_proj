"""End-to-end test client: python e2e.py "<prompt>" [thread_id]"""
import json, sys, time, httpx
B = "http://127.0.0.1:8600"
EMAIL, PW = "e2e-test@plasma.local", "e2e-test-password"
c = httpx.Client(base_url=B, timeout=60)
r = c.post("/api/auth/login", json={"email": EMAIL, "password": PW})
if r.status_code != 200:
    r = c.post("/api/auth/register", json={"email": EMAIL, "password": PW, "name": "E2E 測試"})
tok = r.json()["token"]; H = {"Authorization": f"Bearer {tok}"}
tid = sys.argv[2] if len(sys.argv) > 2 else c.post("/api/threads", json={}, headers=H).json()["id"]
import os
ups = []
for f in [x for x in os.environ.get("UPLOADS", "").split(",") if x]:
    with open(f, "rb") as fh:
        ups += c.post(f"/api/threads/{tid}/upload", files={"files": (os.path.basename(f), fh)}, headers=H).json()["paths"]
print("uploaded", ups)
run = c.post(f"/api/threads/{tid}/messages", json={"text": sys.argv[1], "uploads": ups}, headers=H).json()["run_id"]
print("thread", tid, "run", run, flush=True)
t0 = time.time(); text = []; tools = []; thinking = 0
with httpx.stream("GET", f"{B}/api/runs/{run}/events", params={"token": tok}, timeout=None) as s:
    for line in s.iter_lines():
        if not line.startswith("data: "): continue
        ev = json.loads(line[6:]); t = ev["type"]
        if t == "text_delta": text.append(ev["text"])
        elif t == "thinking_delta": thinking += len(ev["text"])
        elif t == "tool_input": print(f"[{time.time()-t0:6.1f}s] TOOL {ev['name']} {json.dumps(ev['input'], ensure_ascii=False)[:220]}", flush=True)
        elif t == "tool_result": print(f"[{time.time()-t0:6.1f}s]   -> {'ERR' if ev['is_error'] else 'ok'} {ev['seconds']}s {str(ev['preview'])[:300]!r}", flush=True)
        elif t in ("status", "error", "attachments"): print(f"[{time.time()-t0:6.1f}s] {t.upper()} {ev.get('text') or ev.get('message') or ev.get('files')}", flush=True)
        elif t == "run_end": print(f"[{time.time()-t0:6.1f}s] END {ev['status']} usage={ev.get('usage')}", flush=True); break
print("thinking chars:", thinking)
print("=== FINAL TEXT ===\n" + "".join(text)[-3500:])
th = c.get(f"/api/threads/{tid}", headers=H).json(); print("title:", th["title"])
