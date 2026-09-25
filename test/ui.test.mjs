/**
 * UI integration tests: boots the real backend + a Gemini stand-in, then runs
 * the REAL inline script from index.html inside a small DOM shim and drives the
 * actual controls (send, stop, regenerate, copy, new chat, settings).
 *
 * Nothing about the chat behaviour is re-implemented here — this executes the
 * shipped code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startFakeGemini } from './fake-gemini.mjs';
import { createDom, settle } from './dom-stub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const KEY = 'AQ.TESTKEYnotarealkey0000000000000000000000';
const KEY_SECRET_PART = 'TESTKEYnotarealkey0000000000000000000000';

async function bootApp({ fallback, baseUrl, breakHealth, healthStatus } = {}) {
  const gemini = await startFakeGemini();
  if (fallback) gemini.setFallback(fallback);

  const dir = await mkdtemp(path.join(tmpdir(), 'backey-ui-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      GEMINI_BASE_URL: baseUrl || gemini.url,
      BACKEY_KEY_FILE: path.join(dir, 'gemini.key'),
      GEMINI_MODEL: 'gemini-3.8-flash', GEMINI_FALLBACK_MODELS: 'gemini-2.5-flash'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 60));
  }

  let html, aiCore, inline, window, document;
  try {
    html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
    aiCore = await readFile(path.join(ROOT, 'lib', 'ai-core.js'), 'utf8');
    inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

    const boundFetch = (url, init) => {
      const u = String(url).startsWith('http') ? url : base + url;
      // simulate a deployed-but-unreachable backend: no HTTP answer at all
      if (breakHealth && /\/api\/health/.test(u)) return Promise.reject(new TypeError('fetch failed'));
      // simulate a deployed backend whose health check is failing (5xx)
      if (healthStatus && /\/api\/health/.test(u)) {
        return Promise.resolve(new Response('{"error":"boom"}', {
          status: healthStatus, headers: { 'content-type': 'application/json' }
        }));
      }
      return fetch(u, init);
    };
    const dom = createDom(html, { location: { protocol: 'http:' }, fetch: boundFetch });
    window = dom.window;
    document = dom.document;
    window.console = console;
    window.__copied = null;

    const ctx = vm.createContext(window);
    vm.runInContext(aiCore, ctx, { filename: 'lib/ai-core.js' });
    assert.ok(window.BackeyAI, 'the provider layer must be exposed as window.BackeyAI');
    vm.runInContext(inline, ctx, { filename: 'index.html:inline' });
  } catch (e) {
    child.kill('SIGKILL');
    await gemini.close();
    await rm(dir, { recursive: true, force: true });
    throw e;
  }

  await settle(250); // let initChat() probe the backend

  return {
    base, gemini, document, window, child,
    logs: () => logs.join(''),
    el: (id) => document.getElementById(id),
    async close() {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      await gemini.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function botBubbles(doc) {
  return doc.getElementById('msgs').querySelectorAll('.msg.bot');
}
function meBubbles(doc) {
  return doc.getElementById('msgs').querySelectorAll('.msg.me');
}

async function saveKey(app) {
  app.el('apiKeyInput').value = KEY;
  app.el('saveKeyBtn').click();
  await settle(400);
}

/* ------------------------------------------------------------------ */

test('settings: saving the key shows Connected and keeps the key out of the DOM', async () => {
  const app = await bootApp({ fallback: { stream: ['ok'] } });
  try {
    assert.equal(app.el('keyStatusTxt').textContent, 'Non connectée', 'starts disconnected');

    await saveKey(app);

    assert.equal(app.el('keyStatusTxt').textContent, 'Connectée');
    assert.ok(app.el('keyStatus').classList.contains('ok'));
    assert.equal(app.el('apiKeyInput').value, '', 'field is cleared after saving');
    assert.equal(app.el('apiKeyInput').type, 'password', 'field stays masked');
    assert.equal(app.el('removeKeyBtn').hidden, false, 'a remove option appears once saved');

    // the key must not be written into the page or into the browser store
    assert.ok(!JSON.stringify(app.window.__store).includes(KEY_SECRET_PART), 'never in localStorage');
    assert.equal(app.window.localStorage.getItem('backey-key-v1'), null);
  } finally { await app.close(); }
});

test('settings: a rejected key leaves the status Not Connected', async () => {
  const app = await bootApp({ fallback: { status: 403, googleStatus: 'PERMISSION_DENIED' } });
  try {
    await saveKey(app);
    assert.equal(app.el('keyStatusTxt').textContent, 'Non connectée');
    assert.ok(app.el('keyStatus').classList.contains('ko'));
  } finally { await app.close(); }
});

test('settings: Test API Connection reports a real result', async () => {
  const app = await bootApp({ fallback: { stream: ['ok'] } });
  try {
    app.el('apiKeyInput').value = KEY;
    app.el('testKeyBtn').click();
    await settle(400);
    assert.equal(app.el('keyStatusTxt').textContent, 'Connectée');
  } finally { await app.close(); }
});

test('chat: send -> real streamed Gemini answer appears in the transcript', async () => {
  const app = await bootApp({ fallback: { stream: ['La ', 'limite ', 'vaut ', '**1/2**.'] } });
  try {
    await saveKey(app);
    app.gemini.reset();
    app.gemini.setFallback({ stream: ['La ', 'limite ', 'vaut ', '**1/2**.'] });

    const before = botBubbles(app.document).length;
    app.el('chatText').value = 'Calcule lim x→+∞ de √(x²+3x) − x';
    app.gemini.setFallback({ stream: ['La ', 'limite ', 'vaut ', '**1/2**.'], delayMs: 40 });
    app.el('sendBtn').click();

    // setSendIcon('stop') runs synchronously before the first await
    assert.equal(app.el('sendIcon').getAttribute('href'), '#i-stop', 'send becomes Stop while generating');

    await settle(90);
    const mid = botBubbles(app.document);
    assert.equal(mid.length, before + 1, 'a placeholder bubble appears immediately');
    assert.ok(mid[mid.length - 1].innerHTML.includes('caret') || mid[mid.length - 1].innerHTML.includes('typing'),
      'a loading indicator is shown while streaming');

    await settle(800);

    const bots = botBubbles(app.document);
    assert.equal(bots.length, before + 1, 'one new assistant bubble');
    const last = bots[bots.length - 1].querySelector('.bubble');
    assert.ok(last.textContent.includes('La limite vaut'), 'got: ' + last.textContent);
    assert.ok(last.innerHTML.includes('<strong>1/2</strong>'), 'markdown must be rendered');

    assert.equal(meBubbles(app.document).length, 1, 'the user message is shown');
    assert.ok(meBubbles(app.document)[0].textContent.includes('√(x²+3x)'));
    assert.equal(app.el('sendIcon').getAttribute('href'), '#i-send', 'back to Send afterwards');

    // the turn was persisted
    const saved = JSON.parse(app.window.localStorage.getItem('backey-chat-v1'));
    assert.equal(saved.length, 2);
    assert.deepEqual(saved.map((m) => m.role), ['user', 'model']);

    // copy / regenerate actions were attached to the answer
    assert.equal(bots[bots.length - 1].querySelectorAll('.act-btn').length, 2);
  } finally { await app.close(); }
});

test('chat: empty input is ignored, nothing is sent', async () => {
  const app = await bootApp({ fallback: { stream: ['ok'] } });
  try {
    await saveKey(app);
    app.gemini.reset();
    app.el('chatText').value = '    ';
    app.el('sendBtn').click();
    await settle(200);
    assert.equal(app.gemini.state.requests.length, 0);
    assert.equal(botBubbles(app.document).length, 1, 'only the greeting');
  } finally { await app.close(); }
});

test('chat: double-clicking send cannot start two turns', async () => {
  const app = await bootApp();
  try {
    await saveKey(app);
    app.gemini.reset();
    app.gemini.setFallback({ stream: ['un ', 'deux ', 'trois ', 'quatre ', 'cinq '], delayMs: 40 });

    app.el('chatText').value = 'question';
    app.el('sendBtn').click();
    assert.equal(app.el('sendIcon').getAttribute('href'), '#i-stop', 'first click starts a turn');

    // a second click while generating is Stop, never a second turn
    app.el('chatText').value = 'question bis';
    app.el('sendBtn').click();
    await settle(500);

    assert.ok(app.gemini.generationRequests.length <= 1,
      'at most one upstream call, got ' + app.gemini.generationRequests.length);
    assert.equal(meBubbles(app.document).length, 1, 'exactly one user bubble');
    assert.ok(botBubbles(app.document).length <= 2, 'no duplicated assistant bubble');
    assert.equal(app.el('sendIcon').getAttribute('href'), '#i-send', 'control returned to Send');
  } finally { await app.close(); }
});

test('chat: New Chat resets the transcript and the history', async () => {
  const app = await bootApp({ fallback: { stream: ['réponse'] } });
  try {
    await saveKey(app);
    app.el('chatText').value = 'salut';
    app.el('sendBtn').click();
    await settle(500);
    assert.equal(botBubbles(app.document).length, 2);

    app.el('menuBtn').click();
    assert.ok(app.el('chatMenu').classList.contains('show'), 'menu opens');
    app.el('newChatBtn').click();
    await settle(150);

    assert.equal(botBubbles(app.document).length, 1, 'only the greeting remains');
    assert.equal(meBubbles(app.document).length, 0);
    assert.deepEqual(JSON.parse(app.window.localStorage.getItem('backey-chat-v1')), []);
    assert.ok(!app.el('chatMenu').classList.contains('show'), 'menu closed after action');
  } finally { await app.close(); }
});

test('chat: regenerate replaces the last answer without resending the question', async () => {
  const app = await bootApp();
  try {
    await saveKey(app);
    app.gemini.reset();
    app.gemini.setFallback({ stream: ['première version'] });

    app.el('chatText').value = 'ma question';
    app.el('sendBtn').click();
    await settle(500);
    assert.equal(botBubbles(app.document).length, 2);
    assert.equal(app.gemini.generationRequests.length, 1);

    app.gemini.setFallback({ stream: ['seconde version'] });
    const bots = botBubbles(app.document);
    bots[bots.length - 1].querySelectorAll('.act-btn')[1].click(); // regenerate
    await settle(500);

    assert.equal(botBubbles(app.document).length, 2, 'replaced, not appended');
    assert.equal(meBubbles(app.document).length, 1, 'question not duplicated');
    const last = botBubbles(app.document)[1].querySelector('.bubble');
    assert.ok(last.textContent.includes('seconde version'), 'got: ' + last.textContent);
    assert.equal(app.gemini.generationRequests.length, 2);
    // history still holds exactly one user turn + one model turn
    const saved = JSON.parse(app.window.localStorage.getItem('backey-chat-v1'));
    assert.deepEqual(saved.map((m) => m.role), ['user', 'model']);
  } finally { await app.close(); }
});

test('chat: copy puts the plain-text answer on the clipboard', async () => {
  const app = await bootApp({ fallback: { stream: ['**Gras** et `code`'] } });
  try {
    await saveKey(app);
    app.el('chatText').value = 'q';
    app.el('sendBtn').click();
    await settle(500);

    const bots = botBubbles(app.document);
    bots[bots.length - 1].querySelectorAll('.act-btn')[0].click(); // copy
    await settle(120);
    assert.equal(app.window.__copied, 'Gras et code');
  } finally { await app.close(); }
});

test('chat: Stop generation halts the stream and keeps what arrived', async () => {
  const app = await bootApp();
  try {
    await saveKey(app);
    app.gemini.reset();
    const many = [];
    for (let i = 0; i < 200; i++) many.push('mot' + i + ' ');
    app.gemini.setFallback({ stream: many, delayMs: 12 });

    app.el('chatText').value = 'une longue réponse';
    app.el('sendBtn').click();
    await settle(140);
    assert.equal(app.el('sendIcon').getAttribute('href'), '#i-stop');

    app.el('sendBtn').click(); // now acts as Stop
    await settle(400);

    assert.equal(app.el('sendIcon').getAttribute('href'), '#i-send', 'button restored');
    const bots = botBubbles(app.document);
    const txt = bots[bots.length - 1].querySelector('.bubble').textContent;
    assert.ok(txt.startsWith('mot0 '), 'partial answer kept: ' + txt.slice(0, 40));
    assert.ok(txt.length < many.join('').length, 'and it is not the full answer');
    assert.ok(!txt.includes('caret'), 'streaming caret removed');
  } finally { await app.close(); }
});

test('chat: a hard failure shows one friendly message with a retry action', async () => {
  const app = await bootApp();
  try {
    await saveKey(app);
    app.gemini.reset();
    app.gemini.setFallback({ status: 403, googleStatus: 'PERMISSION_DENIED', rawMessage: 'API key not valid ' + KEY_SECRET_PART });

    app.el('chatText').value = 'q';
    app.el('sendBtn').click();
    await settle(600);

    const bots = botBubbles(app.document);
    const bubble = bots[bots.length - 1].querySelector('.bubble');
    assert.ok(bubble.classList.contains('err'), 'error styling');
    const text = bubble.textContent;
    assert.ok(text.length > 5);
    assert.ok(!text.includes('PERMISSION_DENIED'), 'no raw Google enum');
    assert.ok(!text.includes(KEY_SECRET_PART), 'no key material');
    assert.ok(!text.includes('{'), 'no JSON in the UI');
    assert.ok(bubble.querySelector('.retry-btn'), 'a retry control is offered');

    // retrying recovers once the upstream is healthy again
    app.gemini.setFallback({ stream: ['ça remarche'] });
    bubble.querySelector('.retry-btn').click();
    await settle(600);
    const after = botBubbles(app.document);
    assert.ok(after[after.length - 1].querySelector('.bubble').textContent.includes('ça remarche'));
  } finally { await app.close(); }
});

test('chat: without a key the user is told where to add one', async () => {
  const app = await bootApp({ fallback: { stream: ['ok'] } });
  try {
    assert.equal(app.el('keyStatusTxt').textContent, 'Non connectée');
    app.el('chatText').value = 'bonjour';
    app.el('sendBtn').click();
    await settle(400);

    assert.equal(app.gemini.state.requests.length, 0, 'no upstream call without a key');
    const bots = botBubbles(app.document);
    const bubble = bots[bots.length - 1].querySelector('.bubble');
    assert.ok(bubble.classList.contains('err'));
    assert.ok(bubble.textContent.toLowerCase().includes('clé'), 'got: ' + bubble.textContent);
  } finally { await app.close(); }
});

test('chat history survives a reload and is re-rendered', async () => {
  const app = await bootApp({ fallback: { stream: ['réponse persistée'] } });
  let persisted;
  try {
    await saveKey(app);
    app.el('chatText').value = 'question persistée';
    app.el('sendBtn').click();
    await settle(500);
    persisted = app.window.localStorage.getItem('backey-chat-v1');
    assert.ok(persisted);
  } finally { await app.close(); }

  // second app instance reusing the same stored transcript
  const gemini = await startFakeGemini();
  const dir = await mkdtemp(path.join(tmpdir(), 'backey-ui2-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      GEMINI_BASE_URL: gemini.url, BACKEY_KEY_FILE: path.join(dir, 'gemini.key')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  try {
    const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
    const aiCore = await readFile(path.join(ROOT, 'lib', 'ai-core.js'), 'utf8');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
    const { window, document } = createDom(html, {
      location: { protocol: 'http:' },
      fetch: (u, i) => fetch(String(u).startsWith('http') ? u : base + u, i)
    });
    window.console = console;
    window.localStorage.setItem('backey-chat-v1', persisted);
    const ctx = vm.createContext(window);
    vm.runInContext(aiCore, ctx);
    vm.runInContext(inline, ctx);
    await settle(300);

    assert.equal(meBubbles(document).length, 1, 'the old question is back');
    assert.ok(meBubbles(document)[0].textContent.includes('question persistée'));
    const bots = botBubbles(document);
    assert.equal(bots.length, 2, 'greeting + restored answer');
    assert.ok(bots[1].textContent.includes('réponse persistée'));
    assert.equal(gemini.state.requests.length, 0, 'restoring history must not call Gemini');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    await gemini.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the API key never reaches the DOM, localStorage or the transcript', async () => {
  const app = await bootApp({ fallback: { stream: ['ok'] } });
  try {
    await saveKey(app);
    app.el('chatText').value = 'q';
    app.el('sendBtn').click();
    await settle(500);

    const serialized = JSON.stringify(app.window.__store) + app.el('msgs').innerHTML;
    assert.ok(!serialized.includes(KEY), 'no key in stored state or transcript');
    assert.ok(!serialized.includes(KEY_SECRET_PART));
    assert.ok(!app.logs().includes(KEY_SECRET_PART), 'no key in server logs');
  } finally { await app.close(); }
});

test('REGRESSION: an unreachable upstream still saves the key and says so honestly', async () => {
  const app = await bootApp({ baseUrl: 'http://127.0.0.1:59999' });
  try {
    app.el('apiKeyInput').value = KEY;
    app.el('saveKeyBtn').click();
    await settle(900);

    // must NOT be stuck on "Non connectée", and must NOT claim "Connectée"
    assert.equal(app.el('keyStatusTxt').textContent, 'Clé enregistrée');
    assert.ok(app.el('keyStatus').classList.contains('wait'));
    assert.ok(!app.el('keyStatus').classList.contains('ok'));
    assert.equal(app.el('apiKeyInput').value, '', 'field cleared because the key was kept');
    assert.ok(app.el('keyHint').innerHTML.includes('Tester la connexion'), 'user is told how to verify');
  } finally { await app.close(); }
});

test('CUSTODY: an unreachable backend never pushes the key into the browser', async () => {
  // Backend deployed, but /api/health gives no HTTP answer at all.
  const app = await bootApp({ fallback: { stream: ['ok'] }, breakHealth: true });
  try {
    assert.equal(app.window.BackeyAI ? 1 : 1, 1);
    const before = app.window.localStorage.getItem('backey-key-v1');
    assert.equal(before, null, 'nothing stored to begin with');

    await saveKey(app);
    await settle(300);

    // The decisive assertion: the key must NOT have been written to the browser.
    assert.equal(app.window.localStorage.getItem('backey-key-v1'), null,
      'the key leaked into localStorage while the backend was unreachable');
    assert.ok(!JSON.stringify(app.window.__store).includes(KEY_SECRET_PART),
      'key material found in the browser store');

    // and the UI must be honest rather than claiming a connection
    assert.notEqual(app.el('keyStatusTxt').textContent, 'Connectée',
      'falsely reported Connectée with an unreachable backend');
  } finally { await app.close(); }
});

test('CUSTODY: an unhealthy backend (health 5xx) never pushes the key into the browser', async () => {
  // Backend is present but its health check fails — the dangerous middle case.
  const app = await bootApp({ fallback: { stream: ['ok'] }, healthStatus: 503 });
  try {
    await saveKey(app);
    await settle(300);

    assert.equal(app.window.localStorage.getItem('backey-key-v1'), null,
      'the key leaked into localStorage while the backend was unhealthy');
    assert.ok(!JSON.stringify(app.window.__store).includes(KEY_SECRET_PART),
      'key material found in the browser store');
    assert.notEqual(app.el('keyStatusTxt').textContent, 'Connectée',
      'falsely reported Connectée with an unhealthy backend');
  } finally { await app.close(); }
});

test('CUSTODY: a plain static host (health 404) may still keep the key locally', async () => {
  // No backend at all: browser-side direct mode is the only option that works.
  const app = await bootApp({ fallback: { stream: ['ok'] }, healthStatus: 404 });
  try {
    await saveKey(app);
    await settle(300);
    assert.equal(app.window.localStorage.getItem('backey-key-v1'), KEY,
      'a backendless static host must still be able to store the key');
  } finally { await app.close(); }
});

/* ------------------------------------------------------------------ *
 * Design preservation: new CSS must not silently restyle existing UI.
 * A second definition of an existing selector overrides it, because both
 * sit at top level with equal specificity.
 * ------------------------------------------------------------------ */

test('DESIGN: no CSS selector is defined twice (no silent overrides)', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // track nesting so @keyframes stops (0%, 100%, ...) are not read as selectors
  const counts = new Map();
  let depth = 0;
  let buf = '';
  for (const ch of style) {
    if (ch === '{') {
      const sel = buf.trim();
      if (depth === 0 && sel && !sel.startsWith('@')) {
        for (const part of sel.split(',')) {
          const p = part.trim();
          if (p) counts.set(p, (counts.get(p) || 0) + 1);
        }
      }
      buf = '';
      depth++;
    } else if (ch === '}') { buf = ''; depth = Math.max(0, depth - 1); }
    else if (depth === 0) buf += ch;
  }

  // `body` is defined twice in the original app, before any AI work — that is
  // pre-existing and must not be "fixed" here. Anything else is a regression.
  const PRE_EXISTING = new Set(['body']);
  const dupes = [...counts].filter(([s, n]) => n > 1 && !PRE_EXISTING.has(s)).map(([s]) => s);
  assert.deepEqual(dupes, [], 'these selectors are defined more than once and silently override earlier UI: ' + dupes);
});

test('DESIGN: the pre-existing 2BAC badge keeps its original gradient styling', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  // the original pill: purple gradient, white text, glow
  const m = /\.pill\s*\{([^}]*)\}/.exec(html);
  assert.ok(m, 'the original .pill rule is gone');
  assert.ok(/var\(--grad\)/.test(m[1]), 'the 2BAC badge lost its gradient background');
  assert.ok(/color:\s*#fff/.test(m[1]), 'the 2BAC badge lost its white text');
  // and the badge markup is still there, unmodified
  assert.ok(/class="pill">2BAC</.test(html), 'the 2BAC badge markup changed');
  // the AI status pill must use its OWN class, not the shared one
  assert.ok(/class="keypill" id="keyStatus"/.test(html),
    'the key status pill must not reuse the .pill class');
});

test('DESIGN: only long messages opt into toast wrapping', async () => {
  const app = await bootApp({ fallback: { stream: ['ok'] } });
  try {
    const toast = app.el('toast');

    // a short pre-existing toast (New Chat) keeps its original one-line styling
    app.el('newChatBtn').click();
    await settle(200);
    assert.ok(toast.textContent.includes('Nouvelle discussion'), 'toast did not fire');
    assert.equal(toast.classList.contains('wrap'), false,
      'a short toast must not be restyled — pre-existing UI must be untouched');

    // an invalid key produces a 74-char message that must be allowed to wrap
    app.el('apiKeyInput').value = 'nope';
    app.el('saveKeyBtn').click();
    await settle(300);
    assert.ok(toast.textContent.length > 42, 'expected a long message, got: ' + toast.textContent);
    assert.equal(toast.classList.contains('wrap'), true,
      'a long message must wrap instead of running off a phone screen');

    // and it must switch back rather than stick
    app.el('newChatBtn').click();
    await settle(200);
    assert.equal(toast.classList.contains('wrap'), false, 'wrap class must not persist');
  } finally { await app.close(); }
});
