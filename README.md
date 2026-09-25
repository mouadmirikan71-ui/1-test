# Backey — 2BAC study app with a real Gemini AI tutor

The UI is unchanged. The chat behind it is now a real, streaming, production-grade
Google Gemini assistant — no demo replies, no canned text.

---

## Quick start

```bash
node server.mjs          # -> http://localhost:8787
```

Then open the app, go to **Profil → Assistant IA**, paste your Gemini API key and
press **Enregistrer la clé**. The key is verified against Google immediately and
the status flips to **Connectée**. That's it — the chat works from then on.

No `npm install` is needed: the project has **zero dependencies** (Node ≥ 18).

### Other ways to supply the key

```bash
# 1. environment variable (recommended for servers / CI)
GEMINI_API_KEY="AQ.your-key" node server.mjs

# 2. from the Settings screen  ->  stored in ./data/gemini.key (chmod 600, gitignored)
```

If both exist, the environment variable wins and the Settings field becomes read-only
(the server tells you so instead of silently overwriting it).

---

## Architecture

```
index.html ──► window.BackeyAI  (lib/ai-core.js)  ──► POST /api/chat ──► server.mjs ──► Gemini API
                    │                                                       │
                    └── direct mode (file://, no server) ────────────────────┘
```

| File | Role |
|---|---|
| `index.html` | UI only. Renders messages, owns the transcript, calls the service layer. |
| `lib/ai-core.js` | **The AI provider/service layer.** The only code that knows the Gemini protocol: endpoints, auth, request/response shapes, streaming, retry policy, model fallback, error classification, Markdown rendering. Shared by the browser *and* the server (UMD, zero deps). |
| `server.mjs` | Secure backend proxy. Holds the key, relays tokens over SSE, enforces limits, redacts logs. Zero deps. |
| `test/` | The suite, including a protocol-faithful Gemini stand-in and a small DOM shim that runs the real UI code. |

The chat UI never talks to Gemini directly. Two transports exist in the service layer:

* **`streamViaProxy()`** — browser → `/api/chat` → server → Gemini. **The key never
  reaches the browser.** This is used whenever the app is served by `server.mjs`.
* **`streamChat()`** — browser → Gemini directly, for when `index.html` is opened as a
  local file with no backend. The key then stays in that browser only, and the
  Settings screen says so explicitly.

---

## Security

* The key is **masked** in the field, revealed for at most 4 s on request, and cleared after saving.
* In proxy mode the key is stored **server-side only** (`data/gemini.key`, mode `0600`, gitignored).
  It is never returned by any endpoint, never written to the DOM, never put in `localStorage`,
  and never included in a chat message.
* A key Google rejects is **not stored** — the save fails and the status stays *Non connectée*.
* Logs are passed through `redact()`, which strips anything key-shaped. Tests assert this.
* Model output is HTML-escaped **before** any Markdown tag is produced, so a response can
  never inject markup or script. Only `http(s)` links are turned into anchors.
* `data/`, `*.key` and `.env*` are gitignored.

### Key custody in production

The intended production topology is:

```
Chat UI  ->  Production backend (this server)  ->  Google Gemini API
```

The key lives only on the backend. The browser is never offered a
"direct to Google" mode, because a single failed `/api/health` probe would
otherwise silently move the key into `localStorage`.

The backend publishes the rule in `/api/health`:

| `allowDirect` | Meaning |
|---|---|
| `false` (default) | a backend holds the key; the browser must never store one |
| `true` | backendless static host; set explicitly with `BACKEY_ALLOW_DIRECT=1` |

The UI follows it, and `setLocalKey()` refuses to write at all when it is
`false`. The probe distinguishes three cases, because they are not the same:

| `/api/health` result | Mode | Key may live in the browser? |
|---|---|---|
| `200` with `{proxy:true}` | proxy | no |
| `404` — no backend deployed | direct | yes (only option) |
| network error, or `5xx` / bad payload | proxy | **no** |

The last row is the one that matters: a deployed-but-unhealthy backend must not
cause the key to leak into the browser. That behaviour is covered by tests, and
the test is mutation-checked (reverting the rule makes it fail).

### Deploying

```bash
GEMINI_API_KEY="AQ.your-key" PORT=8787 node server.mjs
```

The host must be able to open outbound TLS to `generativelanguage.googleapis.com:443`.
Verify from the production host itself:

```bash
node scripts/check-gemini.mjs
```

Exit code `0` means a real response came back from Google. Until then the pill
stays *Non connectée* by design — it is never set from key presence alone.

---

## Chat capabilities

Send · real Gemini answers · **streaming** (token by token) · conversation history
(persisted, survives reload) · **New Chat** · **Stop generation** · **Regenerate** ·
**Copy** · Markdown + code blocks · maths notation cleanup · loading states ·
friendly errors with **Retry**.

## Reliability

Implemented in `lib/ai-core.js`, invisible to the user:

* **Exponential backoff with jitter** on 408 / 429 / 5xx and network failures;
  `Retry-After` is honoured when Google sends it.
* **Bounded retries** — max 3 attempts per model, max 3 models ⇒ at most 9 upstream
  calls per turn. There is no code path that can loop forever.
* **Silent model fallback**: `gemini-3.8-flash` → `gemini-3.7-flash` → `gemini-3.5-flash`
  (all three are current stable ids; `gemini-2.5-flash` was dropped — Google retires it 2026-10-20).
  It only happens *before* the first token, so an answer is never duplicated.
* **Never retried**: 400 / 401 / 402 / 403 and safety blocks — a different model
  cannot fix credentials or a policy refusal.
* **Watchdogs**: 20 s to first byte, 45 s of stream silence, 180 s hard cap per turn.
* If the stream breaks mid-answer, the partial text is **kept and marked
  "interrompu"** rather than restarted.
* Duplicate clicks, empty input, cancelled requests and client disconnects are all
  handled; a disconnect cancels the upstream call so quota is not wasted.

Errors shown to the user are short French sentences only — never raw API bodies,
JSON, Google error enums or stack traces.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Server-side key (takes precedence) |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Primary model |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.7-flash,gemini-3.5-flash` | Comma-separated fallbacks |
| `BACKEY_ALLOW_DIRECT` | `0` | `1` only for a backendless static host; lets the browser hold the key |
| `BACKEY_KEY_FILE` | `./data/gemini.key` | Where a saved key is stored |
| `BACKEY_KEY_PERSIST` | `1` | `0` keeps a saved key in memory only |
| `BACKEY_MAX_CONCURRENT` | `6` | Concurrent chat turns |
| `GEMINI_BASE_URL` | official endpoint | Only for tests / self-hosted gateways |

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Proxy alive, key present (boolean only), models |
| `GET` | `/api/key` | `{configured, source}` — never the key |
| `POST` | `/api/key` | Save + verify a key |
| `DELETE` | `/api/key` | Remove the stored key |
| `POST` | `/api/test` | Real connection test against Gemini |
| `POST` | `/api/chat` | Streaming answer over SSE (`meta` / `delta` / `done` / `error` / `aborted`) |

---

## Diagnostics

If the chat cannot reach Gemini, run this on the machine that runs the server:

```bash
node scripts/check-gemini.mjs                 # uses GEMINI_API_KEY / GOOGLE_API_KEY / data/gemini.key
GEMINI_API_KEY="AQ.your-key" node scripts/check-gemini.mjs
```

It runs the **real** calls through the shipped provider layer and stops at the
first stage that fails:

```
1. API key            shape + key type (AQ. auth key vs legacy AIza standard key)
2. DNS                can the host be resolved
3. TCP 443            can a socket be opened
4. TLS                is the TLS handshake allowed  <-- proxies/firewalls die here
5. Model discovery    real GET /v1beta/models, media models filtered out
6. generateContent    real request, per model, until one succeeds
7. Streaming chat     real streamGenerateContent?alt=sse, prints the reply
```

It ends with an explicit report — verified model, connection result, chat result,
and the exact remaining issue. Exit code 0 only if a real response came back:

```
Report
  verified model : gemini-3.8-flash
  connection     : OK (real generateContent on gemini-3.8-flash)
  chat (stream)  : OK (31 chars, finishReason=STOP)
  remaining issue: none — a real Gemini response was received
```

Set `GEMINI_BASE_URL` to point it at another endpoint for protocol testing
without touching Google.

A `TLS ... ECONNRESET` with DNS and TCP both passing means an egress
allowlist/firewall is blocking Google — not a bug in this app.

### Model selection is discovered, never invented

The model ids in the config are only a **preference**. Before a request the
server calls the documented `GET /v1beta/models?pageSize=200` and keeps only the
models that key can actually run, in this order:

1. configured ids that Google actually reports, in configured order
2. the remaining discovered chat models, `flash` before `pro`
3. if discovery itself fails, the configured list unchanged (never worse)

Media/specialist models (`*-tts`, `*embedding*`, `imagen-*`, `veo-*`, …) are
filtered out. The list is cached for 10 minutes per key and invalidated when the
key changes. This is what makes a stale or mistyped model id self-heal instead of
404-ing on every turn; `/api/health` reports `models`, `modelsDiscovered` and
`modelDiscoveryError` so you can see what was resolved.

### Connection status is never faked

The Settings pill has three distinct states:

| Pill | Meaning |
|---|---|
| **Non connectée** | no key stored |
| **Clé enregistrée** | key stored, but Google has not confirmed it yet |
| **Connectée** | a real Gemini request succeeded |

`Connectée` is only ever set after Google actually answers — on a successful
connection test or after a real chat reply. A key is discarded **only** when
Google itself rejects the credential (401/403/invalid key). A DNS failure, a TLS
reset or a 5xx proves nothing about the key, so the key is kept and reported as
unverified instead of being thrown away.

### Developer logs vs user messages

Every stage of a request is traced, redacted of any key material:

```
[backey] discovered 9 models, will use: gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash
[backey] chat request: 1 turns, 44 chars, models: gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash
[backey] chat:request      {"model":"gemini-3.8-flash","attempt":1,"of":3,"url":"...:streamGenerateContent?alt=sse"}
[backey] chat:first-token  {"model":"gemini-3.8-flash","attempt":1,"httpStatus":200}
[backey] chat:done         {"model":"gemini-3.8-flash","attempts":1,"chars":23,"finishReason":"STOP","ms":19}
```

Failures name the real cause, including the HTTP status and Google's enum:

```
[backey] chat:http-error {"model":"gemini-3.8-flash","attempt":1,"status":404,"kind":"not-found","code":"NOT_FOUND","retryable":false}
[backey] chat:fallback   {"from":"gemini-3.8-flash","attempt":1,"kind":"not-found"}
[backey] chat failed     {"kind":"not-found","status":404,"code":"NOT_FOUND","detail":null}
[backey] chat failed     {"kind":"unreachable","status":null,"code":null,"detail":"fetch failed | ECONNRESET"}
```

Event types: `start`, `request`, `http-error`, `transport-error`, `retry`,
`fallback`, `first-token`, `done` (and `test-*` for the connection test).

The UI only ever receives a short French sentence — never a raw body, JSON,
Google error enum or stack trace. Every error kind reachable from an HTTP status
is covered by a test, so a kind can no longer silently fall through to the
generic "Une erreur est survenue." message.

## Tests

```bash
npm test
```

The suite runs the **real** `lib/ai-core.js`, `server.mjs` and the real inline script
from `index.html`. It uses a local stand-in that speaks the actual Gemini wire
protocol (`:streamGenerateContent?alt=sse`, `x-goog-api-key`, the documented
`GenerateContentResponse` shape), so retries, backoff, fallback, aborts, timeouts and
error mapping are genuinely exercised.

That stand-in lives in `test/` only — it is never referenced by the app, and the app
always defaults to `https://generativelanguage.googleapis.com`.

## Reference

* `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
* `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
* Auth header: `x-goog-api-key` — required by the current `AQ.` authorization keys
  (those keys are rejected when the key is sent as a `?key=` query parameter).
