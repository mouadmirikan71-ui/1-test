/**
 * End-to-end tests for the secure backend (server.mjs).
 *
 * Boots the REAL server as a child process, pointed at a protocol-faithful
 * Gemini stand-in, and drives it over real HTTP exactly like the browser does.
 *
 * Covers the full flow the app relies on:
 *   health -> save key -> verify -> connection test -> chat (SSE) -> error/retry
 * and asserts the API key never leaves the server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGemini } from './fake-gemini.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.mjs');
const KEY = 'AQ.TESTKEYnotarealkey0000000000000000000000';
const KEY_SECRET_PART = 'TESTKEYnotarealkey0000000000000000000000';

async function waitForHealth(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/health', { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('server did not become healthy');
}

/** Read a text/event-stream response into [{event, data}]. */
async function readSse(res) {
  const events = [];
  let name = '';
  const dataLines = [];
  const flush = () => {
    if (!dataLines.length) { name = ''; return; }
    events.push({ event: name, data: JSON.parse(dataLines.join('\n')) });
    dataLines.length = 0;
    name = '';
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    buf += dec.decode(step.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line === '') { flush(); continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
  }
  flush();
  return events;
}

/** Shared fixture: one fake Gemini + one real server per test. */
async function boot(opts = {}) {
  const gemini = await startFakeGemini();
  const dir = await mkdtemp(path.join(tmpdir(), 'backey-key-'));
  const keyFile = path.join(dir, 'gemini.key');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const logs = [];

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      GEMINI_BASE_URL: opts.baseUrl || gemini.url,
      BACKEY_KEY_FILE: keyFile,
      BACKEY_KEY_PERSIST: opts.persist === false ? '0' : '1',
      GEMINI_MODEL: 'gemini-3.8-flash',
      GEMINI_FALLBACK_MODELS: 'gemini-2.5-flash',
      ...(opts.env || {}),
      ...(opts.envKey ? { GEMINI_API_KEY: opts.envKey } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base);
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  }

  return {
    base, gemini, child, keyFile, dir,
    logs: () => logs.join(''),
    async close() {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      await gemini.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/* ------------------------------------------------------------------ */

test('health reports proxy mode and exposes no key material', async () => {
  const fx = await boot();
  try {
    const j = await (await fetch(fx.base + '/api/health')).json();
    assert.equal(j.ok, true);
    assert.equal(j.proxy, true);
    assert.equal(j.keyConfigured, false);
    assert.equal(j.model, 'gemini-3.8-flash');
    assert.deepEqual(j.fallbacks, ['gemini-2.5-flash']);
  } finally { await fx.close(); }
});

test('chat is refused with a friendly no-key error before a key exists', async () => {
  const fx = await boot();
  try {
    const res = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'salut' }] })
    });
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.equal(j.error.kind, 'no-key');
    assert.equal(typeof j.error.message, 'string');
    assert.equal(fx.gemini.state.requests.length, 0, 'must not call Gemini without a key');
  } finally { await fx.close(); }
});

test('an obviously malformed key is rejected without any network call', async () => {
  const fx = await boot();
  try {
    const res = await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'nope nope' })
    });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.equal(fx.gemini.state.requests.length, 0);
  } finally { await fx.close(); }
});

test('a key Google rejects is NOT stored', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ status: 403, googleStatus: 'PERMISSION_DENIED' });
    const res = await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.equal(j.connected, false);
    assert.equal(j.kind, 'forbidden');
    assert.ok(!JSON.stringify(j).includes(KEY_SECRET_PART), 'response must not echo the key');
    const st = await (await fetch(fx.base + '/api/key')).json();
    assert.equal(st.configured, false, 'a rejected key must not be kept');
  } finally { await fx.close(); }
});

test('FULL FLOW: save key -> verified -> status -> test -> streaming chat -> history', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['Bonjour ', 'Yassine ', '!'] });

    /* 1. save the key (server verifies it against Gemini for real) */
    const save = await (await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    })).json();
    assert.equal(save.ok, true, 'key should be accepted');
    assert.equal(save.connected, true);
    assert.ok(!JSON.stringify(save).includes(KEY_SECRET_PART));

    /* 2. status says connected, still without any key material */
    const st = await (await fetch(fx.base + '/api/key')).json();
    assert.equal(st.configured, true);
    assert.equal(st.mode, 'proxy');
    assert.equal(JSON.stringify(st).includes(KEY_SECRET_PART), false);

    /* 3. the key was persisted to a 0600 file, and never into the browser */
    const info = await stat(fx.keyFile);
    assert.equal(info.mode & 0o777, 0o600, 'key file must be owner-only');
    assert.equal((await readFile(fx.keyFile, 'utf8')).trim(), KEY);

    /* 4. explicit connection test */
    const t = await (await fetch(fx.base + '/api/test', { method: 'POST' })).json();
    assert.equal(t.connected, true);
    assert.ok(!JSON.stringify(t).includes(KEY_SECRET_PART));

    /* 5. a real streaming chat turn, with conversation history */
    fx.gemini.reset();
    fx.gemini.setFallback({ stream: ['La ', 'limite ', 'vaut ', '1/2.'] });
    const res = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [
        { role: 'user', text: 'Je bloque sur ∞ − ∞' },
        { role: 'model', text: 'On factorise par le terme dominant.' },
        { role: 'user', text: 'Montre-moi un exemple' }
      ] })
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const events = await readSse(res);
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes('meta'), 'meta event expected: ' + kinds.join(','));
    assert.ok(kinds.filter((k) => k === 'delta').length >= 4, 'deltas expected');
    assert.equal(kinds[kinds.length - 1], 'done');

    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('');
    assert.equal(text, 'La limite vaut 1/2.');

    /* the whole conversation reached Gemini, in the documented shape */
    const upstream = fx.gemini.generationRequests[0]; // skip the /models discovery call
    assert.equal(upstream.headerKey, KEY, 'server must authenticate with x-goog-api-key');
    assert.ok(!/key=/.test(upstream.query), 'key must not be a query parameter');
    const body = JSON.parse(upstream.body);
    assert.equal(body.contents.length, 3);
    assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);

    /* no key material anywhere in the SSE payload */
    assert.ok(!JSON.stringify(events).includes(KEY_SECRET_PART));
  } finally { await fx.close(); }
});

test('a transient 429 is retried server-side and the user only sees the answer', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['Réponse '] });
    await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });

    fx.gemini.reset();
    fx.gemini.script(
      { status: 429, googleStatus: 'RESOURCE_EXHAUSTED' },
      { status: 503, googleStatus: 'UNAVAILABLE' },
      { stream: ['Ça ', 'marche.'] }
    );

    const res = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'q' }] })
    });
    const events = await readSse(res);
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('');
    assert.equal(text, 'Ça marche.');
    assert.equal(events[events.length - 1].event, 'done');
    assert.equal(fx.gemini.generationRequests.length, 3, 'two failures then success');
    assert.ok(!events.some((e) => e.event === 'error'), 'recovered errors must stay invisible');
  } finally { await fx.close(); }
});

test('model fallback is invisible: primary fails, fallback answers', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['ok'] });
    await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });

    fx.gemini.reset();
    fx.gemini.setFallback({ status: 503, googleStatus: 'UNAVAILABLE' });
    fx.gemini.script(
      { status: 503 }, { status: 503 }, { status: 503 },
      { stream: ['Depuis ', 'le ', 'modèle ', 'de secours'] }
    );

    const events = await readSse(await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'q' }] })
    }));
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('');
    assert.equal(text, 'Depuis le modèle de secours');
    const meta = events.find((e) => e.event === 'meta');
    assert.equal(meta.data.model, 'gemini-2.5-flash');
    assert.ok(!events.some((e) => e.event === 'error'));
  } finally { await fx.close(); }
});

test('a hard failure yields one friendly message and no raw API detail', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['ok'] });
    await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });

    fx.gemini.reset();
    fx.gemini.setFallback({ status: 403, googleStatus: 'PERMISSION_DENIED', rawMessage: 'API key not valid. Secret value leaked: ' + KEY_SECRET_PART });

    const events = await readSse(await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'q' }] })
    }));
    const err = events.find((e) => e.event === 'error');
    assert.ok(err, 'an error event is expected');
    assert.equal(err.data.kind, 'forbidden');
    assert.equal(typeof err.data.message, 'string');
    assert.ok(err.data.message.length > 5);
    const raw = JSON.stringify(events);
    assert.ok(!raw.includes('PERMISSION_DENIED'), 'Google error enum must not reach the UI');
    assert.ok(!raw.includes('API key not valid'), 'raw upstream message must not reach the UI');
    assert.equal(fx.gemini.generationRequests.length, 1, '403 must not be retried');
  } finally { await fx.close(); }
});

test('the API key never appears in server logs', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['ok'] });
    await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });
    await fetch(fx.base + '/api/test', { method: 'POST' });
    await readSse(await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'q' }] })
    }));
    await new Promise((r) => setTimeout(r, 150));
    const logs = fx.logs();
    assert.ok(logs.length > 0, 'the server should have logged something');
    assert.ok(!logs.includes(KEY), 'full key must never be logged');
    assert.ok(!logs.includes(KEY_SECRET_PART), 'no part of the key may be logged');
  } finally { await fx.close(); }
});

test('empty and malformed chat payloads are rejected cleanly', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['ok'] });
    await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });
    fx.gemini.reset(); // the key verification itself used one request

    const empty = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [] })
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.kind, 'empty');

    const blank = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: '    ' }, null, 42] })
    });
    assert.equal(blank.status, 400);

    const broken = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{not json'
    });
    assert.equal(broken.status, 400);
    assert.equal(fx.gemini.state.requests.length, 0);
  } finally { await fx.close(); }
});

test('disconnecting mid-stream aborts the upstream request', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['ok'] });
    await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });

    fx.gemini.reset();
    const many = [];
    for (let i = 0; i < 400; i++) many.push('chunk' + i + ' ');
    fx.gemini.setFallback({ stream: many, delayMs: 8 });

    const ac = new AbortController();
    const res = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'long answer please' }] }),
      signal: ac.signal
    });
    const reader = res.body.getReader();
    await reader.read();
    await reader.read();
    ac.abort();

    await new Promise((r) => setTimeout(r, 500));
    const logs = fx.logs();
    assert.ok(/aborted/i.test(logs), 'server should record the client abort; logs=' + logs.slice(-300));
  } finally { await fx.close(); }
});

test('static hosting: index.html and the shared provider layer are served', async () => {
  const fx = await boot();
  try {
    const html = await fetch(fx.base + '/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const text = await html.text();
    assert.ok(text.includes('id="chatText"'));
    assert.ok(text.includes('lib/ai-core.js'), 'the UI must load the shared provider layer');
    assert.ok(text.includes('apiKeyInput'), 'the API key field must be present');
    assert.ok(!text.includes(KEY_SECRET_PART), 'index.html must never contain a real key');

    const js = await fetch(fx.base + '/lib/ai-core.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.ok((await js.text()).includes('x-goog-api-key'));

    assert.equal((await fetch(fx.base + '/nope')).status, 404);
    assert.equal((await fetch(fx.base + '/../server.mjs')).status, 404);
  } finally { await fx.close(); }
});

test('DELETE /api/key removes the stored key', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ stream: ['ok'] });
    await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });
    assert.equal((await (await fetch(fx.base + '/api/key')).json()).configured, true);
    const del = await fetch(fx.base + '/api/key', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await (await fetch(fx.base + '/api/key')).json()).configured, false);
  } finally { await fx.close(); }
});

test('a key from the environment is "configured" but NOT "verified" until Google accepts it', async () => {
  const fx = await boot({ envKey: KEY });
  try {
    const h = await (await fetch(fx.base + '/api/health')).json();
    assert.equal(h.keyConfigured, true);
    assert.equal(h.keyVerified, false, 'the mere presence of a key is not proof of a connection');
    const st = await (await fetch(fx.base + '/api/key')).json();
    assert.equal(st.configured, true);
    assert.equal(st.verified, false);

    // a rejected key must not flip the status to verified
    fx.gemini.setFallback({ status: 403, googleStatus: 'PERMISSION_DENIED' });
    const bad = await (await fetch(fx.base + '/api/test', { method: 'POST' })).json();
    assert.equal(bad.connected, false);
    assert.equal((await (await fetch(fx.base + '/api/health')).json()).keyVerified, false);

    // a real accepted call does
    fx.gemini.setFallback({ stream: ['ok'] });
    const good = await (await fetch(fx.base + '/api/test', { method: 'POST' })).json();
    assert.equal(good.connected, true);
    assert.equal((await (await fetch(fx.base + '/api/health')).json()).keyVerified, true);
  } finally { await fx.close(); }
});

test('an env-provided key cannot be overwritten or removed through the API', async () => {
  const fx = await boot({ envKey: KEY });
  try {
    const save = await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    });
    assert.equal(save.status, 409);
    const del = await fetch(fx.base + '/api/key', { method: 'DELETE' });
    assert.equal(del.status, 409);
    assert.equal((await (await fetch(fx.base + '/api/key')).json()).configured, true);
  } finally { await fx.close(); }
});

test('REGRESSION: a key is KEPT when Google is unreachable, and reported as saved-but-unverified', async () => {
  const fx = await boot({ baseUrl: 'http://127.0.0.1:59999' }); // nothing listening -> connect refused
  try {
    const r = await (await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    })).json();

    assert.equal(r.saved, true, 'the key must be stored even though Google was unreachable');
    assert.equal(r.connected, false);
    assert.equal(r.verified, false, 'but it must NOT be claimed as verified');
    assert.equal(r.kind, 'unreachable');

    const st = await (await fetch(fx.base + '/api/key')).json();
    assert.equal(st.configured, true, 'the key must survive the failed verification');
    assert.equal(st.verified, false);

    await new Promise((r2) => setTimeout(r2, 120));
    assert.ok(/NOT verified/.test(fx.logs()), 'developer logs must explain why: ' + fx.logs());
  } finally { await fx.close(); }
});

test('a key Google actually rejects is still discarded', async () => {
  const fx = await boot();
  try {
    fx.gemini.setFallback({ status: 403, googleStatus: 'PERMISSION_DENIED' });
    const r = await (await fetch(fx.base + '/api/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY })
    })).json();
    assert.equal(r.saved, false);
    assert.equal(r.connected, false);
    assert.equal((await (await fetch(fx.base + '/api/key')).json()).configured, false);
  } finally { await fx.close(); }
});

/* ------------------------------------------------------------------ *
 * Key custody: the browser must never be offered a key when a backend
 * owns it.
 * ------------------------------------------------------------------ */

test('CUSTODY: /api/health forbids browser-side keys by default', async () => {
  const fx = await boot({ envKey: KEY });
  try {
    const h = await (await fetch(fx.base + '/api/health')).json();
    assert.equal(h.allowDirect, false, 'a deployed backend must not let the browser hold the key');
  } finally { await fx.close(); }
});

test('CUSTODY: BACKEY_ALLOW_DIRECT=1 opts in explicitly (backendless static host)', async () => {
  const fx = await boot({ envKey: KEY, env: { BACKEY_ALLOW_DIRECT: '1' } });
  try {
    const h = await (await fetch(fx.base + '/api/health')).json();
    assert.equal(h.allowDirect, true);
  } finally { await fx.close(); }
});

test('CUSTODY: no endpoint ever returns any part of the key', async () => {
  const fx = await boot({ envKey: KEY });
  try {
    const secret = KEY.slice(6);
    for (const [p, m] of [['/api/health', 'GET'], ['/api/key', 'GET']]) {
      const r = await fetch(fx.base + p, { method: m });
      const body = await r.text();
      assert.ok(!body.includes(secret), `${p} leaked key material: ${body}`);
      assert.ok(!body.includes(KEY), `${p} leaked the full key`);
    }
  } finally { await fx.close(); }
});

/* ------------------------------------------------------------------ *
 * Production guards — previously only asserted by reading the code.
 * ------------------------------------------------------------------ */

test('GUARD: an oversized request body is rejected with 413', async () => {
  const fx = await boot({ envKey: KEY });
  try {
    const huge = JSON.stringify({ history: [{ role: 'user', text: 'x'.repeat(1024 * 1024 + 100) }] });
    const res = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: huge
    });
    assert.equal(res.status, 413, 'expected 413 for a >1MB body, got ' + res.status);
    const j = await res.json();
    assert.equal(j.error.kind, 'invalid-request');
    assert.ok(!JSON.stringify(j).includes(KEY.slice(6)), 'error body must not leak the key');
  } finally { await fx.close(); }
});

test('GUARD: the concurrency cap sheds load with 429 instead of queueing forever', async () => {
  const fx = await boot({ envKey: KEY, env: { BACKEY_MAX_CONCURRENT: '1' } });
  try {
    fx.gemini.setFallback({ hangMs: 1200, stream: ['slow'] });
    const body = JSON.stringify({ history: [{ role: 'user', text: 'hi' }] });
    const first = fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body
    });
    await new Promise((r) => setTimeout(r, 250)); // let it take the only slot
    const second = await fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body
    });
    assert.equal(second.status, 429, 'second concurrent request should be shed');
    const j = await second.json();
    assert.equal(j.error.kind, 'busy');
    assert.ok(typeof j.error.message === 'string' && j.error.message.length > 5);
    await first; // drain
  } finally { await fx.close(); }
});

test('GUARD: the concurrency slot is released after a failure, not leaked', async () => {
  const fx = await boot({ envKey: KEY, env: { BACKEY_MAX_CONCURRENT: '1' } });
  try {
    fx.gemini.setFallback({ status: 403, googleStatus: 'PERMISSION_DENIED' });
    const body = JSON.stringify({ history: [{ role: 'user', text: 'hi' }] });
    const post = () => fetch(fx.base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body
    });
    for (let i = 0; i < 3; i++) {
      const r = await post();
      await r.text();
      assert.notEqual(r.status, 429, `request ${i + 1} was shed — the slot leaked`);
    }
  } finally { await fx.close(); }
});

test('GUARD: static serving is allowlisted — no source, no traversal, no dotfiles', async () => {
  const fx = await boot({ envKey: KEY });
  try {
    const allowed = ['/', '/index.html', '/lib/ai-core.js'];
    for (const p of allowed) {
      const r = await fetch(fx.base + p);
      assert.equal(r.status, 200, `${p} should be served, got ${r.status}`);
    }
    const denied = [
      '/server.mjs', '/package.json', '/.gitignore', '/data/gemini.key',
      '/../package.json', '/..%2fpackage.json', '/%2e%2e/server.mjs',
      '/test/server.test.mjs', '/README.md'
    ];
    for (const p of denied) {
      const r = await fetch(fx.base + p);
      assert.notEqual(r.status, 200, `${p} must not be served (got ${r.status})`);
    }
    // and the served app must not carry key material
    const html = await (await fetch(fx.base + '/')).text();
    assert.ok(!html.includes(KEY.slice(6)), 'served HTML leaked key material');
  } finally { await fx.close(); }
});
