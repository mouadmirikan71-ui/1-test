/**
 * Unit + integration tests for the AI provider layer (lib/ai-core.js).
 *
 * These run the REAL shipped code against a protocol-faithful local Gemini
 * stand-in (test/fake-gemini.mjs). Nothing here is mocked inside the app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFakeGemini } from './fake-gemini.mjs';

const require = createRequire(import.meta.url);
const AI = require('../lib/ai-core.js');

const KEY = 'AQ.testkey0000000000000000000000000000000';
const noSleep = async () => {};
const noRand = () => 0;

/* ------------------------------------------------------------------ */
test('official endpoint, v1beta, x-goog-api-key header, no key in the URL', async () => {
  const g = await startFakeGemini();
  try {
    const out = await AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'bonjour' }],
      sleep: noSleep, random: noRand
    });
    assert.equal(out.text, 'Hello from Gemini.');
    assert.equal(g.state.requests.length, 1);
    const r = g.state.requests[0];
    assert.equal(r.path, '/v1beta/models/gemini-3.8-flash:streamGenerateContent');
    assert.equal(r.query, '?alt=sse');
    assert.equal(r.headerKey, KEY, 'auth must go through the x-goog-api-key header');
    assert.ok(!/key=/.test(r.query), 'the API key must never be a query parameter');
    assert.ok(!r.path.includes(KEY) && !r.query.includes(KEY), 'key must not leak into the URL');
    const body = JSON.parse(r.body);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'bonjour' }] }]);
    assert.ok(body.systemInstruction.parts[0].text.length > 20);
    assert.equal(body.generationConfig.maxOutputTokens, 2048);
  } finally { await g.close(); }
});

test('streaming delivers every chunk in order', async () => {
  const g = await startFakeGemini();
  try {
    g.script({ stream: ['Li', 'mite', 's ', 'de ', 'fonctions'], finishReason: 'STOP' });
    const seen = [];
    const out = await AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }],
      onDelta: (t) => seen.push(t),
      sleep: noSleep, random: noRand
    });
    assert.deepEqual(seen, ['Li', 'mite', 's ', 'de ', 'fonctions']);
    assert.equal(out.text, 'Limites de fonctions');
    assert.equal(out.finishReason, 'STOP');
    assert.equal(out.interrupted, false);
  } finally { await g.close(); }
});

test('429 RESOURCE_EXHAUSTED is retried with backoff, then succeeds', async () => {
  const g = await startFakeGemini();
  try {
    g.script(
      { status: 429, googleStatus: 'RESOURCE_EXHAUSTED' },
      { status: 429, googleStatus: 'RESOURCE_EXHAUSTED' },
      { stream: ['OK après quota'] }
    );
    const waits = [];
    const out = await AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }],
      sleep: async (ms) => { waits.push(ms); }, random: noRand
    });
    assert.equal(out.text, 'OK après quota');
    assert.equal(g.state.requests.length, 3);
    assert.equal(waits.length, 2);
    assert.ok(waits[1] > waits[0], 'backoff must grow between retries');
  } finally { await g.close(); }
});

test('honours Retry-After when the upstream sends it', async () => {
  const g = await startFakeGemini();
  try {
    g.setFallback({ stream: ['done'] });
    // craft a 429 that carries Retry-After by using a custom behaviour
    g.script({ status: 429, googleStatus: 'RESOURCE_EXHAUSTED', retryAfter: 3 });
    const waits = [];
    await AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }],
      sleep: async (ms) => { waits.push(ms); }, random: noRand
    });
    assert.equal(waits.length, 1);
  } finally { await g.close(); }
});

test('invisible model fallback: primary keeps failing -> secondary answers', async () => {
  const g = await startFakeGemini();
  try {
    g.script(
      { status: 503, googleStatus: 'UNAVAILABLE' },
      { status: 503, googleStatus: 'UNAVAILABLE' },
      { status: 503, googleStatus: 'UNAVAILABLE' },
      { stream: ['Réponse du modèle de secours'] }
    );
    let reportedModel = null;
    const out = await AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash', 'gemini-2.5-flash'],
      history: [{ role: 'user', text: 'q' }],
      onMeta: (m) => { reportedModel = m.model; },
      sleep: noSleep, random: noRand
    });
    assert.equal(out.text, 'Réponse du modèle de secours');
    assert.equal(out.model, 'gemini-2.5-flash');
    assert.equal(reportedModel, 'gemini-2.5-flash', 'onMeta must only fire once the answer really starts');
    assert.equal(g.state.requests[3].model, 'gemini-2.5-flash');
  } finally { await g.close(); }
});

test('403 / 401 are never retried and never fall back', async () => {
  for (const status of [401, 403]) {
    const g = await startFakeGemini();
    try {
      g.setFallback({ status, googleStatus: status === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED' });
      await assert.rejects(
        AI.streamChat({
          apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash', 'gemini-2.5-flash'],
          history: [{ role: 'user', text: 'q' }], sleep: noSleep, random: noRand
        }),
        (err) => {
          assert.equal(err.name, 'AiError');
          assert.equal(err.status, status);
          assert.equal(typeof err.friendly, 'string');
          assert.ok(err.friendly.length > 0);
          // raw upstream text must never be attached
          assert.ok(!JSON.stringify(err).includes('simulated upstream failure'));
          return true;
        }
      );
      assert.equal(g.state.requests.length, 1, 'credentials errors must not be retried');
    } finally { await g.close(); }
  }
});

test('retries are bounded — no infinite loop when everything fails', async () => {
  const g = await startFakeGemini();
  try {
    g.setFallback({ status: 503, googleStatus: 'UNAVAILABLE' });
    await assert.rejects(AI.streamChat({
      apiKey: KEY, baseUrl: g.url,
      models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash'],
      history: [{ role: 'user', text: 'q' }], sleep: noSleep, random: noRand
    }));
    // 3 models x maxAttemptsPerModel(3) = 9 requests, and not one more
    assert.equal(g.state.requests.length, AI.LIMITS.maxAttemptsPerModel * 3);
  } finally { await g.close(); }
});

test('a key that is rejected by every model surfaces a friendly error', async () => {
  const g = await startFakeGemini();
  try {
    g.setFallback({ status: 400, googleStatus: 'INVALID_ARGUMENT' });
    await assert.rejects(AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }], sleep: noSleep, random: noRand
    }), (err) => {
      assert.equal(err.kind, 'invalid-request');
      assert.equal(err.friendly, AI.FRIENDLY['invalid-request']);
      return true;
    });
    assert.equal(g.state.requests.length, 1);
  } finally { await g.close(); }
});

test('mid-stream network failure keeps the partial answer instead of duplicating it', async () => {
  const g = await startFakeGemini();
  try {
    g.script({ stream: ['Première ', 'partie ', 'perdue'], streamAbortAfter: 2, delayMs: 1 });
    const out = await AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }], sleep: noSleep, random: noRand
    });
    assert.equal(out.text, 'Première partie ');
    assert.equal(out.interrupted, true, 'must be flagged as interrupted');
    assert.equal(g.state.requests.length, 1, 'must NOT restart and duplicate the answer');
  } finally { await g.close(); }
});

test('user abort (Stop generation) stops the request and reports aborted', async () => {
  const g = await startFakeGemini();
  try {
    g.script({ stream: ['a', 'b', 'c', 'd', 'e', 'f'], delayMs: 25 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    await assert.rejects(AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }],
      signal: ac.signal, sleep: noSleep, random: noRand
    }), (err) => {
      assert.equal(err.kind, 'aborted');
      return true;
    });
    assert.equal(g.state.requests.length, 1, 'an abort must never trigger a retry');
  } finally { await g.close(); }
});

test('idle watchdog fires when the upstream goes silent', async () => {
  const g = await startFakeGemini();
  try {
    g.script({ hangMs: 4000 });
    const started = Date.now();
    await assert.rejects(AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }],
      idleTimeoutMs: 120, maxAttemptsPerModel: 1,
      sleep: noSleep, random: noRand
    }));
    assert.ok(Date.now() - started < 3000, 'must not wait for the hung upstream');
  } finally { await g.close(); }
});

test('empty / whitespace-only history is rejected before any request', async () => {
  const g = await startFakeGemini();
  try {
    for (const h of [[], [{ role: 'user', text: '   ' }], null]) {
      await assert.rejects(AI.streamChat({
        apiKey: KEY, baseUrl: g.url, history: h, sleep: noSleep, random: noRand
      }), (err) => assert.equal(err.kind, 'empty') || true);
    }
    assert.equal(g.state.requests.length, 0);
  } finally { await g.close(); }
});

test('missing or malformed key is caught before hitting the network', async () => {
  const g = await startFakeGemini();
  try {
    await assert.rejects(AI.streamChat({ apiKey: '', baseUrl: g.url, history: [{ role: 'user', text: 'q' }] }),
      (e) => assert.equal(e.kind, 'no-key') || true);
    await assert.rejects(AI.streamChat({ apiKey: 'not a key!!', baseUrl: g.url, history: [{ role: 'user', text: 'q' }] }),
      (e) => assert.equal(e.kind, 'invalid-key') || true);
    assert.equal(g.state.requests.length, 0);
  } finally { await g.close(); }
});

/* ------------------------------------------------------------------ */
test('buildContents: role mapping, trimming, oldest-first eviction, user-first', () => {
  const c = AI.buildContents([
    { role: 'model', text: 'orphan model turn' },
    { role: 'user', text: 'salut' },
    { role: 'model', text: 'bonjour' },
    { role: 'user', text: '   ' },
    { role: 'user', text: 'limites ?' }
  ]);
  assert.equal(c[0].role, 'user', 'leading model turn must be dropped');
  assert.deepEqual(c[0].parts, [{ text: 'salut' }]);
  assert.equal(c.length, 3, 'blank message must be dropped');
  assert.equal(c[c.length - 1].parts[0].text, 'limites ?');
});

test('buildContents caps the number of turns', () => {
  const many = [];
  for (let i = 0; i < 80; i++) many.push({ role: i % 2 ? 'model' : 'user', text: 'm' + i });
  const c = AI.buildContents(many);
  assert.ok(c.length <= AI.LIMITS.maxMessages);
  assert.equal(c[c.length - 1].parts[0].text, 'm79');
});

test('normalizeModels de-duplicates and rejects junk model ids', () => {
  assert.deepEqual(AI.normalizeModels(['a-b', 'a-b', '../evil', '', 'ok.model_1']), ['a-b', 'ok.model_1']);
  assert.deepEqual(AI.normalizeModels([]), [AI.DEFAULT_MODEL]);
});

/* ------------------------------------------------------------------ */
test('SSE parser handles CRLF, comments, multi-line data and blank-line framing', () => {
  const events = [];
  const p = new AI.SseParser((data, name) => events.push([name || '', data]));
  p.push(':keep-alive\r\n');
  p.push('event: delta\r\ndata: {"t":"a"}\r\n\r\n');
  p.push('data: {"t":');
  p.push('"b"}\n\n');
  p.push('data: line1\ndata: line2\n\n');
  p.end();
  assert.deepEqual(events, [['delta', '{"t":"a"}'], ['', '{"t":"b"}'], ['', 'line1\nline2']]);
});

test('extractText reads candidates[].content.parts[].text', () => {
  const obj = { candidates: [{ content: { parts: [{ text: 'x' }, { text: 'y' }] } }] };
  assert.equal(AI.extractText(obj), 'xy');
  assert.equal(AI.extractText({}), '');
  assert.equal(AI.extractText(null), '');
});

/* ------------------------------------------------------------------ */
test('classify maps Gemini statuses to the documented retry policy', () => {
  assert.equal(AI.classify(429, {}).kind, 'rate-limit');
  assert.equal(AI.classify(429, {}).retryable, true);
  assert.equal(AI.classify(503, {}).kind, 'unavailable');
  assert.equal(AI.classify(503, {}).retryable, true);
  assert.equal(AI.classify(500, {}).retryable, true);
  assert.equal(AI.classify(504, {}).kind, 'timeout');
  assert.equal(AI.classify(403, {}).retryable, false);
  assert.equal(AI.classify(401, {}).kind, 'auth');
  assert.equal(AI.classify(400, {}).retryable, false);
  assert.equal(AI.classify(418, {}).retryable, false);
});

test('computeBackoff grows exponentially and stays bounded', () => {
  const d = [0, 1, 2, 3, 4, 5, 6, 7].map((a) => AI.computeBackoff(a, { random: noRand }));
  for (let i = 1; i < 5; i++) assert.ok(d[i] > d[i - 1], `delay should grow at attempt ${i}`);
  assert.ok(d[7] <= AI.TIMING.backoffMaxMs, 'must be capped');
  assert.ok(AI.computeBackoff(50, { random: noRand }) <= AI.TIMING.backoffMaxMs);
});

test('redact() strips key material out of strings destined for logs', () => {
  const k = 'AQ.TESTKEYnotarealkey0000000000000000000000';
  const secret = 'TESTKEYnotarealkey0000000000000000000000';
  assert.ok(AI.redact(`key=${k}`).includes('[REDACTED]'), 'must actually redact');
  assert.ok(!AI.redact(`key=${k}`).includes(secret));
  assert.ok(!AI.redact('AIzaSyABCDEFGHIJKLMNOPQRSTUVWX').includes('ABCDEFGHIJKLMNOP'));
  assert.ok(!AI.redact(`?key=${k}&x=1`).includes(secret));
  assert.ok(!AI.redact(`"x-goog-api-key": "${k}"`).includes(secret));
});

test('looksLikeKey accepts current Google key formats and rejects junk', () => {
  assert.equal(AI.looksLikeKey('AQ.TESTKEYnotarealkey0000000000000000000000'), true);
  assert.equal(AI.looksLikeKey('AIzaSyAbcdefghijklmnopqrstuvwxyz0123456789'), true);
  assert.equal(AI.looksLikeKey('short'), false);
  assert.equal(AI.looksLikeKey('has space inside the key value'), false);
  assert.equal(AI.looksLikeKey('<script>alert(1)</script>aaaaaaaaaaaa'), false);
  assert.equal(AI.looksLikeKey(null), false);
});

/* ------------------------------------------------------------------ */
test('renderMarkdown escapes HTML — model output cannot inject markup', () => {
  const out = AI.renderMarkdown('<img src=x onerror=alert(1)> **bold** <script>alert(2)</script>');
  assert.ok(!/<img/i.test(out));
  assert.ok(!/<script/i.test(out));
  assert.ok(out.includes('&lt;img'));
  assert.ok(out.includes('<strong>bold</strong>'));
});

test('renderMarkdown renders code fences, lists, headings and links safely', () => {
  const md = '# Titre\n\n- item 1\n- item 2\n\n```python\nprint("<b>")\n```\n\n[site](https://example.com) and [bad](javascript:alert(1))';
  const out = AI.renderMarkdown(md);
  assert.ok(out.includes('md-code'), 'code fence');
  assert.ok(out.includes('&lt;b&gt;'), 'code content escaped');
  assert.ok(out.includes('<ul class="md-list">'));
  assert.ok(out.includes('md-h'));
  assert.ok(out.includes('href="https://example.com"'));
  assert.ok(!/href="javascript:/i.test(out), 'javascript: URLs must not become links');
});

test('texToPlain makes LaTeX readable in a chat bubble', () => {
  const s = AI.texToPlain('\\lim_{x \\to +\\infty} \\frac{x^2 + 1}{x} \\leq \\sqrt{2}');
  assert.ok(s.includes('lim'));
  assert.ok(s.includes('→'));
  assert.ok(s.includes('∞'));
  assert.ok(s.includes('≤'));
  assert.ok(s.includes('√'));
  assert.ok(!/\\(frac|leq|to|infty|sqrt)/.test(s), 'no leftover LaTeX commands');
  assert.ok(s.includes('x²'));
});

test('markdownToText gives a clean plain-text copy', () => {
  const t = AI.markdownToText('**Gras** et `code`\n- un\n- deux');
  assert.ok(!t.includes('**'));
  assert.ok(!t.includes('`'));
  assert.ok(t.includes('• un'));
});

/* ------------------------------------------------------------------ */
test('testConnection reports connected on 200', async () => {
  const g = await startFakeGemini();
  try {
    g.setFallback({ stream: ['ok'] });
    const r = await AI.testConnection({ apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'] });
    assert.equal(r.connected, true);
    assert.equal(r.model, 'gemini-3.8-flash');
    assert.equal(g.state.requests[0].action, 'generateContent');
    const body = JSON.parse(g.state.requests[0].body);
    assert.equal(body.generationConfig.maxOutputTokens, 1, 'the probe must be as cheap as possible');
  } finally { await g.close(); }
});

test('testConnection reports a friendly failure for a bad key', async () => {
  const g = await startFakeGemini();
  try {
    g.setFallback({ status: 403, googleStatus: 'PERMISSION_DENIED' });
    const r = await AI.testConnection({ apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'] });
    assert.equal(r.connected, false);
    assert.equal(r.kind, 'forbidden');
    assert.equal(r.message, AI.FRIENDLY.forbidden);
    assert.ok(!String(r.message).includes('simulated upstream failure'));
  } finally { await g.close(); }
});

test('testConnection falls through a 404 model id to the fallback model', async () => {
  const g = await startFakeGemini();
  try {
    g.script({ status: 404, googleStatus: 'NOT_FOUND' }, { stream: ['ok'] });
    const r = await AI.testConnection({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-9.9-nope', 'gemini-2.5-flash']
    });
    assert.equal(r.connected, true);
    assert.equal(r.model, 'gemini-2.5-flash');
  } finally { await g.close(); }
});

test('testConnection refuses an obviously bad key without a network call', async () => {
  const g = await startFakeGemini();
  try {
    const r = await AI.testConnection({ apiKey: 'nope', baseUrl: g.url });
    assert.equal(r.connected, false);
    assert.equal(r.kind, 'invalid-key');
    assert.equal(g.state.requests.length, 0);
  } finally { await g.close(); }
});

test('isCredentialFailure only fires when Google itself rejected the credential', () => {
  // these prove the key is bad -> safe to discard it
  assert.equal(AI.isCredentialFailure('auth'), true);
  assert.equal(AI.isCredentialFailure('forbidden'), true);
  assert.equal(AI.isCredentialFailure('invalid-key'), true);
  assert.equal(AI.isCredentialFailure('invalid-request', 'INVALID_ARGUMENT'), true);
  // these prove nothing about the key -> the key must be KEPT
  assert.equal(AI.isCredentialFailure('unreachable'), false);
  assert.equal(AI.isCredentialFailure('network'), false);
  assert.equal(AI.isCredentialFailure('timeout'), false);
  assert.equal(AI.isCredentialFailure('rate-limit'), false);
  assert.equal(AI.isCredentialFailure('server'), false);
  assert.equal(AI.isCredentialFailure('unavailable'), false);
});

test('an unreachable host is reported as "unreachable", not a vague network error', async () => {
  await assert.rejects(AI.streamChat({
    apiKey: KEY, baseUrl: 'http://127.0.0.1:59999', models: ['gemini-3.8-flash'],
    history: [{ role: 'user', text: 'q' }],
    sleep: noSleep, random: noRand, maxAttemptsPerModel: 1
  }), (err) => {
    assert.equal(err.kind, 'unreachable');
    assert.equal(err.friendly, AI.FRIENDLY.unreachable);
    assert.ok(!/réessaie/i.test(err.friendly), 'retrying will not help, so do not suggest it');
    assert.ok(err.detail && err.detail.length > 0, 'the real reason must survive for developer logs');
    assert.ok(/ECONNREFUSED|ECONNRESET/.test(err.detail),
      'the log detail must contain the real socket error, not just "fetch failed". got: ' + err.detail);
    assert.ok(!err.detail.includes(KEY), 'the detail must be redacted');
    return true;
  });
});

test('testConnection reports unreachable (not "bad key") when Google cannot be reached', async () => {
  const r = await AI.testConnection({ apiKey: KEY, baseUrl: 'http://127.0.0.1:59999', models: ['gemini-3.8-flash'] });
  assert.equal(r.connected, false);
  assert.equal(r.kind, 'unreachable');
  assert.equal(AI.isCredentialFailure(r.kind, r.code), false, 'must not be mistaken for a rejected key');
  assert.ok(r.detail, 'developer detail preserved');
});

test('REGRESSION: every error kind reachable from an HTTP status has a friendly message', () => {
  // A missing entry here is what turned a Gemini 404 into "Une erreur est survenue."
  const seen = new Set();
  for (let status = 400; status <= 599; status++) {
    seen.add(AI.classify(status, {}).kind);
    seen.add(AI.classify(status, { error: { status: 'INVALID_ARGUMENT' } }).kind);
  }
  const missing = [...seen].filter((k) => !(k in AI.FRIENDLY));
  assert.deepEqual(missing, [], 'these kinds would silently degrade to the generic message: ' + missing);
  // and none of them may BE the generic fallback
  for (const k of seen) {
    assert.notEqual(AI.friendly(k), AI.FRIENDLY.unknown, `kind "${k}" resolves to the generic message`);
  }
});

test('a Gemini 404 (model unavailable) surfaces a specific message, not the generic one', async () => {
  const g = await startFakeGemini();
  try {
    g.setFallback({ status: 404, googleStatus: 'NOT_FOUND' });
    await assert.rejects(AI.streamChat({
      apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'],
      history: [{ role: 'user', text: 'q' }], sleep: noSleep, random: noRand, maxAttemptsPerModel: 1
    }), (err) => {
      assert.equal(err.kind, 'not-found');
      assert.notEqual(err.friendly, AI.FRIENDLY.unknown);
      assert.ok(/modèle/i.test(err.friendly), 'got: ' + err.friendly);
      return true;
    });
  } finally { await g.close(); }
});

/* ------------------------------------------------------------------ *
 * Model discovery — the app must never invent a model id.
 * ------------------------------------------------------------------ */

test('listModels parses GET /v1beta/models into chat-capable ids', async () => {
  const g = await startFakeGemini();
  try {
    const { models, error } = await AI.listModels({ apiKey: KEY, baseUrl: g.url });
    assert.equal(error, null);
    assert.ok(models.length >= 5, 'expected the fixture model list, got ' + models.length);
    // the media/specialist decoys must be reported but must NOT be chat-capable
    for (const decoy of ['gemini-2.5-flash-preview-tts', 'gemini-embedding-001', 'imagen-3.0-generate-002']) {
      const m = models.find((x) => x.id === decoy);
      assert.ok(m, 'fixture should report ' + decoy);
      assert.equal(AI.chatCapable(m), false, decoy + ' must not be chat-capable');
    }
    // and a real chat model must be
    const flash = models.find((x) => x.id === 'gemini-3.8-flash');
    assert.equal(AI.chatCapable(flash), true);
    assert.ok(models.every((m) => !/^models\//.test(m.id)), 'the "models/" prefix must be stripped');
    assert.deepEqual(models[0].methods, ['generateContent', 'streamGenerateContent']);
  } finally { await g.close(); }
});

test('resolveModels keeps configured ids that exist and drops media models', async () => {
  const g = await startFakeGemini();
  try {
    const { models } = await AI.listModels({ apiKey: KEY, baseUrl: g.url });
    const active = AI.resolveModels({ configured: AI.MODELS, available: models });
    assert.ok(active.length > 0 && active.length <= AI.LIMITS.maxModels);
    assert.ok(!active.some((id) => /tts|embedding|imagen/.test(id)), 'media models leaked in: ' + active);
    // every resolved id is one Google actually reported
    active.forEach((id) => assert.ok(models.some((m) => m.id === id), 'invented model id: ' + id));
  } finally { await g.close(); }
});

test('REGRESSION: a configured model the key cannot use is replaced, not 404-ed forever', async () => {
  const g = await startFakeGemini();
  try {
    const { models } = await AI.listModels({ apiKey: KEY, baseUrl: g.url });
    // "gemini-9.9-nonexistent" is a stale/invented id — discovery must drop it
    const active = AI.resolveModels({ configured: ['gemini-9.9-nonexistent', 'gemini-2.5-flash'], available: models });
    assert.equal(active[0], 'gemini-2.5-flash');
    assert.ok(!active.includes('gemini-9.9-nonexistent'));
  } finally { await g.close(); }
});

test('discovery failing must not make things worse: configured models are used', async () => {
  const g = await startFakeGemini();
  try {
    g.setModelsError({ status: 500 });
    const { models, error } = await AI.listModels({ apiKey: KEY, baseUrl: g.url });
    assert.deepEqual(models, []);
    assert.ok(error);
    assert.deepEqual(AI.resolveModels({ configured: AI.MODELS, available: models }), AI.normalizeModels(AI.MODELS));
  } finally { await g.close(); }
});

test('the key is sent as a header on discovery too, never as a query parameter', async () => {
  const g = await startFakeGemini();
  try {
    await AI.listModels({ apiKey: KEY, baseUrl: g.url });
    const r = g.state.requests[0];
    assert.equal(r.headerKey, KEY);
    assert.ok(!/key=/.test(r.query), 'key leaked into the query string: ' + r.query);
    assert.equal(r.method, 'GET');
  } finally { await g.close(); }
});

/* ------------------------------------------------------------------ *
 * The client must not discard the server's own message.
 * ------------------------------------------------------------------ */

test('REGRESSION: streamViaProxy keeps the server-supplied message instead of degrading', async () => {
  const serverMsg = 'Ce modèle est temporairement indisponible, réessaie dans un instant.';
  const fakeFetch = async () => new Response(
    'event: error\ndata: ' + JSON.stringify({ kind: 'not-a-kind-the-client-knows', message: serverMsg }) + '\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
  await assert.rejects(
    AI.streamViaProxy({ fetchImpl: fakeFetch, history: [{ role: 'user', text: 'q' }], sleep: noSleep }),
    (err) => {
      assert.equal(err.friendly, serverMsg, 'got: ' + err.friendly);
      assert.notEqual(err.friendly, AI.FRIENDLY.unknown, 'degraded to the generic message');
      return true;
    }
  );
});

test('a server message that looks like a raw API error is refused', () => {
  const bad = ['{"error":{"code":429}}', 'TypeError: x is not a function\n    at Foo.bar (a.js:1)', ''];
  bad.forEach((m) => {
    const e = AI.AiError('rate-limit', { message: m });
    assert.equal(e.friendly, AI.FRIENDLY['rate-limit'], 'leaked through: ' + m);
  });
  const e2 = AI.AiError('unknown', { message: 'B'.repeat(500) });
  assert.equal(e2.friendly, AI.FRIENDLY.unknown, 'over-long message accepted');
});

test('REGRESSION: testConnection message always matches its own kind', async () => {
  // A 404 used to report kind:"not-found" with the "reformule ton message" text.
  const cases = [
    { status: 404, googleStatus: 'NOT_FOUND',       expect: 'not-found' },
    { status: 403, googleStatus: 'PERMISSION_DENIED', expect: 'forbidden' },
    { status: 429, googleStatus: 'RESOURCE_EXHAUSTED', expect: 'rate-limit' },
    { status: 400, googleStatus: 'INVALID_ARGUMENT', expect: 'invalid-request' }
  ];
  for (const c of cases) {
    const g = await startFakeGemini();
    try {
      g.setFallback({ status: c.status, googleStatus: c.googleStatus });
      const out = await AI.testConnection({
        apiKey: KEY, baseUrl: g.url, models: ['gemini-3.8-flash'], fetchImpl: fetch
      });
      assert.equal(out.connected, false);
      assert.equal(out.kind, c.expect, `status ${c.status} -> kind`);
      assert.equal(out.message, AI.FRIENDLY[c.expect],
        `kind "${out.kind}" carried the wrong message: ${out.message}`);
    } finally { await g.close(); }
  }
});

test('REGRESSION: every error kind written in the source has a friendly message', async () => {
  // The HTTP-status guard is not enough: kinds are also produced directly.
  const { readFile } = await import('node:fs/promises');
  const files = ['lib/ai-core.js', 'server.mjs'];
  const kinds = new Set();
  for (const f of files) {
    const src = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    // direct AiError(...) calls, object-literal kinds, assignments, and the
    // ternary form used by normalizeTransportError
    for (const m of src.matchAll(/AiError\('([a-z-]+)'/g)) kinds.add(m[1]);
    for (const m of src.matchAll(/kind: '([a-z-]+)'/g)) kinds.add(m[1]);
    for (const m of src.matchAll(/kind = '([a-z-]+)'/g)) kinds.add(m[1]);
    // only ternaries that actually assign a kind, not every ternary in the file
    // (?!=) so "err.kind === 'x'" is not mistaken for an assignment
    for (const m of src.matchAll(/\bkind\s*=(?!=)[^;\n]*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) {
      kinds.add(m[1]); kinds.add(m[2]);
    }
  }
  const NON_ERROR = new Set(['ok']); // success marker, never passed to AiError
  const errs = [...kinds].filter((k) => !NON_ERROR.has(k));
  const missing = errs.filter((k) => !(k in AI.FRIENDLY));
  assert.deepEqual(missing, [], 'kinds with no user-facing message: ' + missing);
  // sanity: the guard really did scan the interesting kinds
  assert.ok(errs.includes('not-found'), 'guard missed not-found');
  assert.ok(errs.includes('unreachable'), 'guard missed the ternary kind');
  assert.ok(errs.length >= 15, 'guard scanned too few kinds: ' + errs.length);
});
