#!/usr/bin/env node
/**
 * REAL Gemini verification — runs against https://generativelanguage.googleapis.com.
 *
 *   node scripts/check-gemini.mjs                  # reads GEMINI_API_KEY / GOOGLE_API_KEY / data/gemini.key
 *   GEMINI_API_KEY="AQ.xxx" node scripts/check-gemini.mjs
 *   GEMINI_BASE_URL="http://127.0.0.1:9999" node scripts/check-gemini.mjs   # for local protocol testing
 *
 * Stages: key shape -> DNS -> TCP -> TLS -> model discovery -> real
 * generateContent -> real streaming chat. Every call goes through the shipped
 * provider layer (lib/ai-core.js), so this exercises the same code the app runs.
 *
 * The key is NEVER printed — only a 4-char shape hint.
 *
 * Exit code 0 only if a real response came back from a real model.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const AI = require(path.join(ROOT, 'lib', 'ai-core.js'));

const BASE = (process.env.GEMINI_BASE_URL || '').trim();
const REMOTE = !BASE || BASE.includes('generativelanguage.googleapis.com');
const HOST = REMOTE ? 'generativelanguage.googleapis.com' : new URL(BASE).hostname;

const ok = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);
const bad = (m) => console.log('  \x1b[31m✘\x1b[0m ' + m);
const info = (m) => console.log('  · ' + m);
const head = (m) => console.log('\n\x1b[1m' + m + '\x1b[0m');

/** Load the key exactly the way the server does: env, then data/gemini.key. */
function loadKey() {
  const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.argv[2] || '').trim();
  if (envKey) return { key: envKey, source: 'environment' };
  const file = process.env.BACKEY_KEY_FILE || path.join(ROOT, 'data', 'gemini.key');
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (k) return { key: k, source: file };
  } catch { /* no key file */ }
  return { key: '', source: 'none' };
}

function hint(k) {
  if (!k) return '(none)';
  return `${k.slice(0, 3)}… (${k.length} chars, ${AI.looksLikeKey(k) ? 'shape OK' : 'SHAPE INVALID'})`;
}

let failed = false;
const fail = (m) => { failed = true; bad(m); };
const summary = { model: null, connection: null, chat: null, issue: null };

/* ---------------------------------------------------------------- 1. key */
head('1. API key');
const { key: KEY, source } = loadKey();
info('source: ' + source);
info('key: ' + hint(KEY));
if (!KEY) {
  fail('No key found. Set GEMINI_API_KEY, or save it in Settings, or pass it as an argument.');
  process.exit(1);
}
if (!AI.looksLikeKey(KEY)) fail('Key shape is invalid — check for stray spaces or quotes.');
else ok('Key shape is accepted.');
if (KEY.startsWith('AQ.')) info('Google AUTHORIZATION key — must be sent as the x-goog-api-key header (this app does).');
if (KEY.startsWith('AIza')) info('Legacy STANDARD key — Google is phasing these out.');

/* ------------------------------------------------------------- 2-4. path */
if (REMOTE) {
  head('2. DNS');
  try {
    const addrs = await dns.lookup(HOST, { all: true });
    ok(`${HOST} -> ${addrs.map((a) => a.address).slice(0, 2).join(', ')}`);
  } catch (e) {
    fail(`DNS failed: ${e.code || e.message}`);
    summary.issue = 'DNS: this machine cannot resolve Google (check DNS/VPN/firewall).';
    process.exit(1);
  }

  head('3. TCP 443');
  await new Promise((resolve) => {
    const s = net.connect(443, HOST);
    s.setTimeout(8000);
    s.on('connect', () => { ok('TCP connection established'); s.destroy(); resolve(); });
    s.on('timeout', () => { fail('TCP connect timed out (port 443 filtered?)'); s.destroy(); resolve(); });
    s.on('error', (e) => { fail(`TCP error: ${e.code || e.message}`); resolve(); });
  });

  head('4. TLS handshake');
  try {
    const r = await fetch(`https://${HOST}/`, { method: 'GET', signal: AbortSignal.timeout(10000) });
    ok(`TLS OK (HTTP ${r.status} — any status here means the network path is fine)`);
  } catch (e) {
    fail(`TLS failed: ${e.cause?.code || e.cause?.message || e.message}`);
    summary.issue = 'TLS reset by a proxy/firewall/allowlist — Google is blocked from this host.';
    console.log('\nDiagnosis: DNS and TCP work but the TLS handshake is being reset.');
    console.log('           Nothing in the app can fix this; it is the host\'s egress policy.');
    report();
    process.exit(1);
  }
} else {
  head('2-4. Network');
  info(`GEMINI_BASE_URL is set to a non-Google host (${HOST}) — skipping DNS/TCP/TLS stages.`);
}

/* ---------------------------------------------------- 5. model discovery */
head('5. Model discovery — GET /v1beta/models');
const { models: discovered, error: discErr } = await AI.listModels({ apiKey: KEY, baseUrl: BASE || undefined });
let usable = [];
if (discErr) {
  fail(`Discovery failed: ${discErr.kind}${discErr.status ? ' (HTTP ' + discErr.status + ')' : ''}` +
       (discErr.code ? ' ' + discErr.code : ''));
  info('Falling back to the configured model ids (they will NOT be verified until a call succeeds).');
  usable = AI.normalizeModels([process.env.GEMINI_MODEL || AI.DEFAULT_MODEL, ...AI.FALLBACK_MODELS]);
} else {
  ok(`Google reported ${discovered.length} models for this key.`);
  usable = AI.resolveModels({ configured: AI.MODELS, available: discovered });
  info('chat-capable, media models filtered out');
  info('selected order: ' + usable.join(', '));
  const dropped = discovered.filter((m) => !AI.chatCapable(m)).map((m) => m.id);
  if (dropped.length) info('excluded (not chat models): ' + dropped.slice(0, 6).join(', ') + (dropped.length > 6 ? ', …' : ''));
  if (!usable.length) {
    fail('Google reported models but none can generate text for this key.');
    summary.issue = 'No text-generation model is available to this key.';
    report();
    process.exit(1);
  }
  ok('Model ids come from Google, not from a guess.');
}

/* ------------------------------------------------- 6. real generateContent */
head('6. Real generateContent request');
let working = null;
for (const model of usable) {
  process.stdout.write(`  → ${model} … `);
  const res = await AI.testConnection({ apiKey: KEY, baseUrl: BASE || undefined, models: [model], connectTimeoutMs: 20000 });
  if (res.connected) { console.log('\x1b[32mOK\x1b[0m'); working = model; break; }
  console.log(`\x1b[31m${res.kind}\x1b[0m  ${res.message}`);
  if (res.status) info(`    HTTP ${res.status}${res.code ? ' ' + res.code : ''}`);
  if (res.detail) info(`    detail: ${res.detail}`);
}
if (!working) {
  fail('No model accepted a real generateContent call.');
  summary.connection = 'FAILED';
  summary.issue = 'Every model rejected the key — see the HTTP status/code above.';
  report();
  process.exit(1);
}
summary.model = working;
summary.connection = `OK (real generateContent on ${working})`;
ok(`Verified model: ${working}`);

/* ------------------------------------------------- 7. real streaming chat */
head('7. Real streaming chat request');
let streamed = '';
let chunkCount = 0;
try {
  const result = await AI.streamChat({
    apiKey: KEY,
    baseUrl: BASE || undefined,
    models: [working],
    history: [{ role: 'user', text: 'Réponds en un seul mot : quelle est la capitale du Maroc ?' }],
    onDelta: (t) => { streamed += t; chunkCount++; },
    maxAttemptsPerModel: 1
  });
  if (!result.text.trim()) {
    fail('Stream completed but returned no text.');
    summary.chat = 'FAILED (empty response)';
    summary.issue = 'Model answered with an empty body — check promptFeedback/blockReason.';
    report();
    process.exit(1);
  }
  ok(`Streamed ${chunkCount} chunk(s), ${result.text.length} chars, finishReason=${result.finishReason || 'n/a'}`);
  info('model replied: ' + JSON.stringify(result.text.slice(0, 160)));
  summary.chat = `OK (${result.text.length} chars, finishReason=${result.finishReason || 'n/a'})`;
} catch (err) {
  fail(`Streaming failed: ${err.kind || 'error'}`);
  if (err.status) info(`    HTTP ${err.status}${err.code ? ' ' + err.code : ''}`);
  if (err.detail) info(`    detail: ${err.detail}`);
  info('user would see: ' + (err.friendly || err.message));
  summary.chat = `FAILED (${err.kind}${err.status ? ', HTTP ' + err.status : ''})`;
  summary.issue = 'generateContent worked but streaming failed — see the status/code above.';
  report();
  process.exit(1);
}

report();
process.exit(failed ? 1 : 0);

/* ---------------------------------------------------------------- report */
function report() {
  head('Report');
  console.log(`  verified model : ${summary.model || '— none —'}`);
  console.log(`  connection     : ${summary.connection || 'FAILED'}`);
  console.log(`  chat (stream)  : ${summary.chat || 'FAILED'}`);
  console.log(`  remaining issue: ${summary.issue || 'none — a real Gemini response was received'}`);
  if (!failed && summary.model) {
    console.log('\n  \x1b[32mThis key returned a real response from Google.\x1b[0m');
    console.log(`  Set GEMINI_MODEL=${summary.model} (or leave it unset to keep auto-discovery).`);
  }
  if (failed) {
    console.log('\n  What each failure means:');
    console.log('    auth (401)       key invalid or revoked -> create a new key');
    console.log('    forbidden (403)  key restricted, or Generative Language API not enabled');
    console.log('    rate-limit (429) quota exceeded -> wait, or raise the project tier');
    console.log('    unreachable      this host cannot reach Google (proxy/firewall/allowlist)');
    console.log('    not-found (404)  that model id is unavailable for this key');
  }
}
