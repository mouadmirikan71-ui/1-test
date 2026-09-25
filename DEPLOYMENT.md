# Deploying Backey

Production topology:

```
Chat UI (browser)  →  this backend (server.mjs)  →  Google Gemini API  →  streamed back
```

The Gemini key exists **only** in the backend process. The browser never sees it,
never stores it, and never talks to Google directly.

No application code needs to change to deploy. This directory adds deployment
configuration only:

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the runtime image. Contains no secrets. |
| `.dockerignore` | Keeps `.git`, `data/`, `*.key` and `.env*` out of the build context. |
| `railway.json` | Railway build + health-check + restart policy. |
| `.env.example` | Reference for every variable. Committed as a template; never holds a real key. |

---

## Platform requirements

The backend is a **persistent** Node HTTP server, not a serverless function.
Whatever you deploy to must provide:

| Requirement | Value |
|---|---|
| Runtime | Node.js **18+** (image uses 20) |
| Process model | long-running; must not be recycled per request |
| Outbound | TCP 443 + **completing TLS** to `generativelanguage.googleapis.com` |
| Secrets | environment variables, injected at runtime |
| Request duration | up to **5 minutes** per chat stream (`requestTimeout = 300000`) |
| Streaming | SSE must not be buffered by the proxy |
| Health check | `GET /api/health` |
| Dependencies | **none** — there is no `npm install` step |

### Serverless platforms are not suitable

Vercel Functions, Netlify Functions and AWS Lambda cap request duration
(commonly 10–60 s) and are built around short request/response cycles. A chat
stream here can run for five minutes and would be truncated mid-answer. This is
an architectural mismatch, not a tuning problem.

### Suitable

Railway (the config in this repo targets it), Render, Fly.io, Google Cloud Run
(raise `--timeout` to 300s), or any VPS.

---

## Deploy to Railway

### 1. Push the branch

```bash
git clone -b arena/01a0d7cf-1-test https://github.com/mouadmirikan71-ui/1-test.git
cd 1-test
```

### 2. Create the service

```bash
railway login
railway init            # or link an existing project
railway up              # builds from the Dockerfile
```

Or in the dashboard: **New Project → Deploy from GitHub repo**, select this
branch. `railway.json` makes it use the `Dockerfile` automatically.

### 3. Set the secret

This is the only required variable.

```bash
railway variables --set "GEMINI_API_KEY=AQ.your-real-key"
```

Or dashboard → service → **Variables** → add `GEMINI_API_KEY`.

Railway stores it encrypted and injects it at runtime. It is not in Git, not in
the image, and not in the frontend bundle.

### 4. Generate the domain

Service → **Settings → Networking → Generate Domain**.

---

## Verify — the only acceptable success condition

### Step 1. Confirm egress from the deployed environment

Run this **on the deployed host**, not on your laptop:

```bash
railway run node -e 'require("tls").connect(443,"generativelanguage.googleapis.com",{servername:"generativelanguage.googleapis.com"}).on("secureConnect",()=>{console.log("EGRESS OK");process.exit(0)}).on("error",e=>{console.log("BLOCKED",e.code);process.exit(1)})'
```

If this does not print `EGRESS OK`, stop. The host's firewall or a
TLS-inspecting proxy is blocking Google, and nothing in this application can
fix that. See [Troubleshooting](#troubleshooting).

### Step 2. Real Gemini verification

```bash
railway run node scripts/check-gemini.mjs
```

On a VPS or in a container:

```bash
docker compose run --rm backey node scripts/check-gemini.mjs
```

**Success looks exactly like this, and exits `0`:**

```
5. Model discovery — GET /v1beta/models
  ✔ Google reported N models for this key.
  · selected order: gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash
  ✔ Model ids come from Google, not from a guess.

6. Real generateContent request
  → gemini-3.8-flash … OK
  ✔ Verified model: gemini-3.8-flash

7. Real streaming chat request
  ✔ Streamed N chunk(s), M chars, finishReason=STOP
  · model replied: "Rabat"

Report
  verified model : gemini-3.8-flash
  connection     : OK (real generateContent on gemini-3.8-flash)
  chat (stream)  : OK (M chars, finishReason=STOP)
  remaining issue: none — a real Gemini response was received
```

The exit code is the contract:

```bash
node scripts/check-gemini.mjs && echo "REAL GEMINI CONFIRMED" || echo "NOT WORKING"
```

### Step 3. Backend health

```bash
curl -s https://your-domain/api/health
```

Expect `keyConfigured: true` and `allowDirect: false`.

`keyVerified` starts `false` and flips to `true` only after Google actually
answers.

### Step 4. Real chat from the browser

Open the domain, send a message, and confirm:

1. The reply streams in progressively (not all at once) — that proves SSE.
2. The Settings pill reads **Connectée**.
3. Server logs show `chat:done` with a real `finishReason`.

`Connectée` is never set from key presence. All three code paths that set it
require a successful Google response.

---

## Reverse proxy / SSE

The backend already sends `x-accel-buffering: no` and
`cache-control: no-store, no-transform`, which nginx honours automatically.

**Caddy** streams by default:

```
your-domain.com {
    reverse_proxy 127.0.0.1:8787
}
```

**nginx** needs buffering disabled and a timeout that covers a 5-minute stream:

```nginx
location /api/chat {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    chunked_transfer_encoding on;
}
```

Managed platforms handle this for you, except Cloud Run, where you must raise
the request timeout:

```bash
gcloud run deploy backey --image=YOUR_IMAGE --timeout=300s --min-instances=1
```

---

## Where the key can and cannot appear

| Location | Key present? |
|---|---|
| Backend process memory | **yes** — the only place |
| Environment secret store | **yes** — encrypted at rest |
| Frontend JavaScript / HTML | no |
| Git repository | no — `.gitignore` covers `.env*`, `data/`, `*.key` |
| Docker image layers | no — `.dockerignore` excludes them from the build context |
| `GET /api/key` response | no — returns booleans and a coarse source label only |
| Server logs | no — every log line passes through `redact()`, which strips `AQ.`/`AIza` patterns, `x-goog-api-key` values and `?key=` |

Two runtime guarantees reinforce this:

- With `GEMINI_API_KEY` set, `POST` and `DELETE /api/key` return **409**. The
  browser cannot replace or delete the server's key.
- `/api/health` reports `allowDirect: false`, so a failed health probe can never
  cause the UI to fall back to storing a key in `localStorage`.

Because the env key makes the server refuse writes, the container needs **no
writable filesystem**.

---

## Troubleshooting

`node scripts/check-gemini.mjs` stops at a numbered stage. The stage is the
diagnosis:

| Stage | Meaning | Action |
|---|---|---|
| 1. API key | shape invalid | check for stray spaces or quotes in the secret |
| 2. DNS | cannot resolve Google | fix DNS / resolver |
| 3. TCP 443 | port filtered | open outbound 443 |
| 4. TLS | handshake reset | egress allowlist or TLS inspection — see below |
| 5. Discovery | key rejected or no models | 401/403 → key invalid, restricted, or Generative Language API not enabled |
| 6. generateContent | model unavailable | 404 → that model id is not available to this key; 429 → quota |
| 7. Streaming | stream failed | check proxy buffering and timeouts |

**Stage 4 is the common failure.** DNS and TCP succeed but the handshake is
reset. That means something between the host and Google is inspecting SNI and
dropping the connection. It is not fixable in this application.

What to check with whoever controls the network:

- outbound allowlist must include `*.googleapis.com:443`
- deep packet inspection / TLS interception must be disabled for that host
- if a forward proxy is required, set `HTTPS_PROXY` in the service environment

---

## Alternative platforms

The `Dockerfile` is portable. Only the secret injection differs.

**Render** — new Web Service, point at the repo, Runtime **Docker**, add
`GEMINI_API_KEY` under Environment. Confirm the plan's idle timeout exceeds
5 minutes.

**Fly.io**:

```bash
fly launch --no-deploy --copy-config
fly secrets set GEMINI_API_KEY=AQ.your-real-key
fly deploy
```

**VPS with systemd** — see the `EnvironmentFile` pattern in `.env.example`. Put
the key in a file with mode `0600` owned by the service user, and terminate TLS
with Caddy or nginx in front of `127.0.0.1:8787`.

---

## Before going live

- [ ] Egress check prints `EGRESS OK` from the deployed host
- [ ] `node scripts/check-gemini.mjs` exits `0` with a real model named
- [ ] `GET /api/health` shows `keyConfigured: true` and `allowDirect: false`
- [ ] Browser chat streams a real answer and the pill shows **Connectée**
- [ ] No key material appears in `railway logs` / server output
- [ ] The key has been rotated if it was ever pasted into chat, email or a ticket
