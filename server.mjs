#!/usr/bin/env node
/**
 * Backey — secure backend for the Gemini-powered chat.
 *
 * Zero dependencies (Node >= 18, uses the built-in fetch/streams).
 *
 *   node server.mjs            -> http://localhost:8787
 *   PORT=3000 node server.mjs
 *
 * The Gemini API key lives ONLY on this server:
 *   1. process.env.GEMINI_API_KEY  (or GOOGLE_API_KEY)   <- recommended
 *   2. a key saved from Settings -> ./data/gemini.key (chmod 600, gitignored)
 *
 * The browser never receives, stores or sees the key: it only talks to /api/*.
 * The key is never logged (see redact()) and never echoed by any endpoint.
 */

import http from 'node:http';
import { readFile, writeFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AI = require('./lib/ai-core.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.GEMINI_BASE_URL || AI.OFFICIAL_BASE_URL).replace(/\/+$/, '');
const KEY_FILE = process.env.BACKEY_KEY_FILE
  ? path.resolve(process.env.BACKEY_KEY_FILE)
  : path.join(__dirname, 'data', 'gemini.key');
const PERSIST = process.env.BACKEY_KEY_PERSIST !== '0';
const MAX_CONCURRENT = parseInt(process.env.BACKEY_MAX_CONCURRENT || '6', 10);
/**
 * Key custody. When a backend is deployed the key lives ONLY here, so the
 * browser must never be offered a "direct to Google" mode: a transient
 * /api/health failure would otherwise silently move the key into localStorage.
 * Opt in with BACKEY_ALLOW_DIRECT=1 only for a backendless static host.
 */
const ALLOW_DIRECT = process.env.BACKEY_ALLOW_DIRECT === '1';
const BODY_LIMIT = 1024 * 1024;

const MODELS = [process.env.GEMINI_MODEL || AI.DEFAULT_MODEL]
  .concat(process.env.GEMINI_FALLBACK_MODELS
    ? String(process.env.GEMINI_FALLBACK_MODELS).split(',').map((s) => s.trim()).filter(Boolean)
    : AI.FALLBACK_MODELS);

/* ------------------------------------------------------------------ *
 * Logging — secrets are redacted before anything reaches the console
 * ------------------------------------------------------------------ */

function log(...args) {
  console.log('[backey]', ...args.map((a) => (typeof a === 'string' ? AI.redact(a) : a)));
}
function logError(...args) {
  console.error('[backey]', ...args.map((a) => (typeof a === 'string' ? AI.redact(a) : a)));
}

/* ------------------------------------------------------------------ *
 * Key storage
 * ------------------------------------------------------------------ */

let runtimeKey = null;
let runtimeSource = null;
/**
 * `configured` (a key exists) is NOT the same as `verified` (Google accepted it).
 * A key loaded from env or from disk at boot has not been verified yet, so the
 * UI must not claim a connection until a real call succeeds.
 */
let keyVerified = false;
function markVerified() { keyVerified = true; }
function markUnverified() { keyVerified = false; }

function envKey() {
  const k = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

async function readKeyFile() {
  try {
    if (!existsSync(KEY_FILE)) return null;
    const raw = await readFile(KEY_FILE, 'utf8');
    const k = String(raw).trim();
    return k && AI.looksLikeKey(k) ? k : null;
  } catch {
    return null;
  }
}

/** Resolve the active key. Never returned to a client, never logged. */
async function resolveKey() {
  const fromEnv = envKey();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  if (runtimeKey) return { key: runtimeKey, source: runtimeSource || 'session' };
  const fromFile = await readKeyFile();
  if (fromFile) return { key: fromFile, source: 'file' };
  return { key: null, source: 'none' };
}

async function saveKey(key) {
  runtimeKey = key;
  runtimeSource = 'session';
  markUnverified(); // a freshly stored key is not proven until Google accepts it
  if (!PERSIST) return { persisted: false };
  try {
    await mkdir(path.dirname(KEY_FILE), { recursive: true });
    await writeFile(KEY_FILE, key, { mode: 0o600 });
    try { await chmod(KEY_FILE, 0o600); } catch { /* best effort */ }
    return { persisted: true };
  } catch (err) {
    logError('key file write failed:', err && err.code ? err.code : 'unknown');
    return { persisted: false };
  }
}

async function clearKey() {
  runtimeKey = null;
  runtimeSource = null;
  markUnverified();
  if (!PERSIST) return;
  try { if (existsSync(KEY_FILE)) await unlink(KEY_FILE); } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const MSG_SAVED_UNVERIFIED =
  'Clé enregistrée. Vérification impossible : Google est injoignable depuis ce serveur.';

/**
 * Developer logs get the REAL reason (kind, HTTP status, Google enum, transport
 * detail). The UI only ever receives the friendly strings from ai-core.
 * Everything is passed through redact() so no key material can leak.
 */
function logFailure(where, err) {
  if (err && err.name === 'AiError') {
    logError(`${where} failed`, JSON.stringify({
      kind: err.kind, status: err.status, code: err.code, detail: err.detail || null
    }));
  } else {
    logError(`${where} failed`, AI.redact(String((err && err.message) || err || 'unknown')).slice(0, 300));
  }
}

/* ------------------------------------------------------------------ *
 * Model discovery. The configured ids are only a *preference*: the
 * models actually used are the ones GET /v1beta/models says this key
 * can run, so a stale or wrong id self-heals instead of 404-ing.
 * ------------------------------------------------------------------ */

const modelCache = { at: 0, keyFp: '', models: null, error: null };
const MODEL_CACHE_MS = 10 * 60 * 1000;

async function resolveActiveModels(key) {
  const fp = String(key).slice(0, 4) + ':' + String(key).length; // never the key itself
  if (modelCache.models && modelCache.keyFp === fp && (Date.now() - modelCache.at) < MODEL_CACHE_MS) {
    return AI.resolveModels({ configured: MODELS, available: modelCache.models });
  }
  const { models, error } = await AI.listModels({ apiKey: key, baseUrl: BASE_URL });
  if (error) {
    modelCache.error = { kind: error.kind, status: error.status, code: error.code, detail: error.detail };
    logError('model discovery failed', JSON.stringify(modelCache.error));
    return MODELS; // configured list, unchanged
  }
  modelCache.models = models;
  modelCache.keyFp = fp;
  modelCache.at = Date.now();
  modelCache.error = null;
  const active = AI.resolveModels({ configured: MODELS, available: models });
  log(`discovered ${models.length} models, will use: ${active.join(', ')}`);
  return active;
}

function invalidateModels() { modelCache.models = null; modelCache.at = 0; }

/** Structured provider trace -> developer logs only. Never reaches the UI. */
function trace(where) {
  return (e) => {
    if (e.type === 'delta') return;
    const d = Object.assign({}, e);
    delete d.type;
    log(`${where}:${e.type}`, JSON.stringify(AI.redact(d)));
  };
}

/* ------------------------------------------------------------------ *
 * SSE to the browser
 * ------------------------------------------------------------------ */

function sseInit(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(':ok\n\n');
}

function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseEnd(res) {
  if (!res.writableEnded && !res.destroyed) res.end();
}

/* ------------------------------------------------------------------ *
 * Request handlers
 * ------------------------------------------------------------------ */

let inFlight = 0;

async function handleTest(req, res) {
  const { key } = await resolveKey();
  if (!key) return sendJson(res, 200, { connected: false, kind: 'no-key', message: AI.FRIENDLY['no-key'] });

  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) ac.abort(); };
  req.on('close', onClose);
  res.on('close', onClose);
  let out;
  const active = await resolveActiveModels(key);
  try {
    out = await AI.testConnection({
      apiKey: key, baseUrl: BASE_URL, models: active, signal: ac.signal, onEvent: trace('test')
    });
  } catch (err) {
    logFailure('test', err);
    out = { connected: false, kind: 'network', message: AI.FRIENDLY.network };
  } finally {
    req.off('close', onClose);
    res.off('close', onClose);
  }
  log('connection test ->', out.connected ? 'connected' : `not connected (${out.kind})`);
  if (out.connected) markVerified(); else markUnverified();
  // Deliberately no key material, no raw upstream body, no stack trace.
  return sendJson(res, 200, {
    connected: !!out.connected,
    kind: out.kind,
    message: out.message,
    model: out.model || null
  });
}

async function handleChat(req, res) {
  const payload = await readJson(req);
  if (payload === null) return sendJson(res, 400, { error: { kind: 'invalid-request', message: AI.FRIENDLY['invalid-request'] } });

  const history = Array.isArray(payload.history) ? payload.history : [];
  if (!history.length) {
    return sendJson(res, 400, { error: { kind: 'empty', message: AI.FRIENDLY.empty } });
  }
  if (inFlight >= MAX_CONCURRENT) {
    return sendJson(res, 429, { error: { kind: 'busy', message: AI.FRIENDLY.busy } });
  }

  const { key } = await resolveKey();
  if (!key) {
    return sendJson(res, 409, { error: { kind: 'no-key', message: AI.FRIENDLY['no-key'] } });
  }

  // Sanitize: strings only, bounded size. Nothing else reaches the model.
  const clean = [];
  for (const m of history.slice(-AI.LIMITS.maxMessages)) {
    if (!m || typeof m !== 'object') continue;
    const text = typeof m.text === 'string' ? m.text : '';
    if (!text.trim()) continue;
    clean.push({ role: m.role === 'model' ? 'model' : 'user', text: text.slice(0, AI.LIMITS.maxCharsPerMessage) });
  }
  if (!clean.length) {
    return sendJson(res, 400, { error: { kind: 'empty', message: AI.FRIENDLY.empty } });
  }

  const ac = new AbortController();
  let clientGone = false;
  /**
   * Detect the client going away (tab closed, navigated away, Stop pressed) on
   * BOTH streams: `res` 'close' is the reliable signal for a premature
   * disconnect, so we must cancel the upstream call instead of letting it run
   * and burn quota for an answer nobody will read.
   */
  const onClose = () => {
    if (res.writableEnded) return;
    clientGone = true;
    ac.abort();
  };
  req.on('close', onClose);
  res.on('close', onClose);

  inFlight++;
  sseInit(res);
  let sent = 0;

  try {
    const activeModels = await resolveActiveModels(key);
    log(`chat request: ${clean.length} turns, ${JSON.stringify(clean).length} chars, models: ${activeModels.join(',')}`);
    const result = await AI.streamChat({
      apiKey: key,
      baseUrl: BASE_URL,
      models: activeModels,
      history: clean,
      signal: ac.signal,
      onEvent: trace('chat'),
      onMeta: (meta) => sseSend(res, 'meta', { model: meta.model }),
      onDelta: (text) => {
        if (clientGone) return;
        sent += text.length;
        sseSend(res, 'delta', { t: text });
      }
    });

    sseSend(res, 'done', {
      ok: true,
      chars: sent,
      interrupted: !!result.interrupted,
      finishReason: result.finishReason || null
    });
    log('chat ok', JSON.stringify({ model: result.model, chars: sent, attempts: result.attempts, interrupted: !!result.interrupted }));
    markVerified(); // a real answer is the strongest possible proof of a working key
  } catch (err) {
    if (err && err.name === 'AiError' && err.kind === 'aborted') {
      log('chat aborted by client', JSON.stringify({ chars: sent }));
      sseSend(res, 'aborted', { chars: sent });
    } else {
      logFailure('chat', err);
      const kind = (err && err.name === 'AiError' && err.kind) || 'unknown';
      sseSend(res, 'error', { kind, message: AI.friendly(kind) });
    }
  } finally {
    inFlight--;
    req.off('close', onClose);
    res.off('close', onClose);
    sseEnd(res);
  }
}

async function handleKeyStatus(_req, res) {
  const { source } = await resolveKey();
  const configured = source !== 'none';
  // Only booleans + a coarse source. No part of the key is ever returned.
  sendJson(res, 200, {
    configured,
    verified: configured && keyVerified,
    source,
    mode: 'proxy'
  });
}

async function handleKeySave(req, res) {
  if (envKey()) {
    return sendJson(res, 409, { ok: false, message: 'La clé est déjà fournie par le serveur (variable d’environnement).' });
  }
  const payload = await readJson(req);
  if (payload === null) return sendJson(res, 400, { ok: false, message: AI.FRIENDLY['invalid-key'] });
  const raw = typeof payload.key === 'string' ? payload.key : '';
  const key = raw.trim();
  if (!key) return sendJson(res, 400, { ok: false, message: AI.FRIENDLY['no-key'] });
  if (!AI.looksLikeKey(key)) return sendJson(res, 400, { ok: false, message: AI.FRIENDLY['invalid-key'] });

  const saved = await saveKey(key);
  // Verify for real before telling the user it works.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  const onClose = () => ac.abort();
  req.on('close', onClose);
  let test;
  try {
    invalidateModels();
    test = await AI.testConnection({
      apiKey: key, baseUrl: BASE_URL, models: await resolveActiveModels(key),
      signal: ac.signal, onEvent: trace('verify')
    });
  } catch (err) {
    logFailure('save/test', err);
    test = { connected: false, kind: 'network', message: AI.FRIENDLY.network };
  } finally {
    clearTimeout(timer);
    req.off('close', onClose);
  }

  if (!test.connected) {
    /*
     * Only throw the key away when GOOGLE ITSELF said the credential is bad.
     * A DNS failure, a TLS reset or a 5xx proves nothing about the key, and
     * discarding it would make saving impossible whenever the host cannot reach
     * Google — which is exactly the "status stuck on Non connectée" symptom.
     */
    if (AI.isCredentialFailure(test.kind, test.code)) {
      await clearKey();
      log('key rejected by Google ->', JSON.stringify({
        kind: test.kind, code: test.code || null, status: test.status || null
      }));
      return sendJson(res, 200, {
        ok: false, saved: false, connected: false, verified: false,
        kind: test.kind, message: test.message
      });
    }
    log('key stored but NOT verified ->', JSON.stringify({ reason: test.kind, detail: test.detail || null }));
    return sendJson(res, 200, {
      ok: true, saved: true, connected: false, verified: false,
      kind: test.kind, message: MSG_SAVED_UNVERIFIED
    });
  }
  log('key saved and verified', JSON.stringify({ persisted: !!saved.persisted, model: test.model }));
  markVerified();
  return sendJson(res, 200, {
    ok: true, saved: true, connected: true, verified: true,
    message: test.message, model: test.model
  });
}

/* ------------------------------------------------------------------ *
 * Static files (whitelisted, traversal-safe)
 * ------------------------------------------------------------------ */

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/lib/ai-core.js': ['lib/ai-core.js', 'application/javascript; charset=utf-8'],
  '/favicon.ico': [null, null]
};

async function handleStatic(req, res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  if (!entry[0]) { res.writeHead(204); return res.end(); }
  const file = path.join(__dirname, entry[0]);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': entry[1],
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = '/'; }

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET,POST,DELETE,OPTIONS' });
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname === '/api/health') {
        const { source } = await resolveKey();
        return sendJson(res, 200, {
          ok: true, proxy: true,
          keyConfigured: source !== 'none',
          /**
           * Key custody signal. false = a backend is deployed and holds the key,
           * so the UI must never fall back to storing it in the browser.
           */
          allowDirect: ALLOW_DIRECT,
          models: modelCache.models ? AI.resolveModels({ configured: MODELS, available: modelCache.models }) : MODELS,
          modelsDiscovered: !!modelCache.models,
          modelDiscoveryError: modelCache.error,
          keyVerified: source !== 'none' && keyVerified,
          model: MODELS[0], fallbacks: MODELS.slice(1), discovered: modelCache.models ? modelCache.models.length : 0
        });
      }
      if (pathname === '/api/key' && req.method === 'GET') return await handleKeyStatus(req, res);
      if (pathname === '/api/key' && req.method === 'POST') return await handleKeySave(req, res);
      if (pathname === '/api/key' && req.method === 'DELETE') {
        if (envKey()) return sendJson(res, 409, { ok: false, message: 'La clé vient d’une variable d’environnement serveur.' });
        await clearKey();
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/test' && req.method === 'POST') return await handleTest(req, res);
      if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
      return sendJson(res, 404, { error: { kind: 'not-found', message: AI.FRIENDLY.unknown } });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return await handleStatic(req, res, pathname);
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (err) {
    logError('unhandled', err && err.name ? err.name : 'error');
    if (!res.headersSent) {
      sendJson(res, err && err.status === 413 ? 413 : 500, {
        error: { kind: 'server', message: AI.FRIENDLY.server }
      });
    } else if (!res.writableEnded) {
      try { sseSend(res, 'error', { kind: 'server', message: AI.FRIENDLY.server }); } catch { /* ignore */ }
      sseEnd(res);
    }
  }
});

server.headersTimeout = 65000;
server.requestTimeout = 300000;

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`model: ${MODELS[0]}  fallbacks: ${MODELS.slice(1).join(', ') || 'none'}`);
  log(`key source: ${envKey() ? 'env' : (existsSync(KEY_FILE) ? 'file' : 'none (paste it in Profil › Assistant IA)')}`);
  log(`upstream: ${BASE_URL}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
