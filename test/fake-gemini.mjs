/**
 * TEST HARNESS ONLY — not part of the application, never imported by index.html
 * or by server.mjs at runtime.
 *
 * A local stand-in that speaks the *real* Gemini wire protocol so the shipped
 * provider layer (lib/ai-core.js) and backend (server.mjs) can be exercised
 * end-to-end without network access:
 *
 *   POST /v1beta/models/{model}:generateContent
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse   -> text/event-stream
 *   auth via the "x-goog-api-key" header
 *
 * Every response shape mirrors the documented GenerateContentResponse.
 */
import http from 'node:http';

/** A canned response chunk in the documented shape. */
function chunk(text, opts) {
  const o = opts || {};
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text }] },
      index: 0,
      ...(o.finishReason ? { finishReason: o.finishReason } : {})
    }],
    modelVersion: 'test-model'
  };
}

/** What GET /v1beta/models reports: the configured ids plus decoys. */
const DEFAULT_MODEL_LIST = [
  { id: 'gemini-2.5-flash' },
  { id: 'gemini-3.5-flash' },
  { id: 'gemini-3.7-flash' },
  { id: 'gemini-3.8-flash' },
  { id: 'gemini-3.8-flash-lite' },
  { id: 'gemini-3.0-pro' },
  { id: 'gemini-2.5-flash-preview-tts', methods: ['generateContent'] },
  { id: 'gemini-embedding-001', methods: ['embedContent'] },
  { id: 'imagen-3.0-generate-002', methods: ['predict'] }
];

export function startFakeGemini() {
  const state = {
    requests: [],
    /** queue of behaviours, consumed one per request */
    script: [],
    /** default behaviour once the script is exhausted */
    fallback: { stream: ['Hello ', 'from ', 'Gemini.'], finishReason: 'STOP' },
    /** what GET /v1beta/models returns; null => use DEFAULT_MODEL_LIST */
    modelList: null,
    /** force the discovery call itself to fail */
    modelsError: null
  };

  function nextBehaviour(req) {
    if (state.script.length) return state.script.shift();
    return state.fallback;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => resolve(b));
    });

    const modelMatch = /\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/.exec(url.pathname);

    state.requests.push({
      path: url.pathname,
      query: url.search,
      method: req.method,
      model: modelMatch ? decodeURIComponent(modelMatch[1]) : null,
      action: modelMatch ? modelMatch[2] : null,
      headerKey: req.headers['x-goog-api-key'] || null,
      body
    });

    /* GET /v1beta/models — real model-discovery endpoint (documented shape). */
    if (/^\/v1beta\/models\/?$/.test(url.pathname) && req.method === 'GET') {
      if (state.modelsError) {
        res.writeHead(state.modelsError.status || 500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: state.modelsError.status || 500, message: 'boom', status: 'INTERNAL' } }));
      }
      const list = (state.modelList || DEFAULT_MODEL_LIST).map((m) => ({
        name: 'models/' + m.id,
        displayName: m.id,
        supportedGenerationMethods: m.methods || ['generateContent', 'streamGenerateContent']
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: list }));
    }

    if (!modelMatch) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 404, message: 'unknown endpoint', status: 'NOT_FOUND' } }));
    }

    const behaviour = nextBehaviour({ model: modelMatch[1], action: modelMatch[2] });

    if (behaviour.hangMs) {
      // simulate an unresponsive upstream; the client watchdog must fire
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(':holding\n\n');
      setTimeout(() => { try { res.end(); } catch { /* ignore */ } }, behaviour.hangMs);
      return;
    }

    if (behaviour.status && behaviour.status >= 400) {
      const headers = { 'content-type': 'application/json' };
      if (behaviour.retryAfter != null) headers['retry-after'] = String(behaviour.retryAfter);
      res.writeHead(behaviour.status, headers);
      return res.end(JSON.stringify(behaviour.body || {
        error: {
          code: behaviour.status,
          message: behaviour.rawMessage || 'simulated upstream failure',
          status: behaviour.googleStatus || 'INTERNAL'
        }
      }));
    }

    if (behaviour.streamAbortAfter != null) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = behaviour.stream || [];
      let i = 0;
      const tick = () => {
        if (i < behaviour.streamAbortAfter && i < parts.length) {
          res.write(`data: ${JSON.stringify(chunk(parts[i]))}\n\n`);
          i++;
          setTimeout(tick, behaviour.delayMs || 1);
        } else {
          try { res.destroy(); } catch { /* ignore */ }
        }
      };
      tick();
      return;
    }

    const parts = behaviour.stream || [];

    if (modelMatch[2] === 'generateContent') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(chunk(parts.join('') || 'ok', { finishReason: behaviour.finishReason || 'STOP' })));
    }

    // streamGenerateContent?alt=sse  ->  Server-Sent Events
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store'
    });
    let i = 0;
    const tick = () => {
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify(chunk(parts[i]))}\n\n`);
        i++;
        setTimeout(tick, behaviour.delayMs || 1);
      } else {
        res.write(`data: ${JSON.stringify(chunk('', { finishReason: behaviour.finishReason || 'STOP' }))}\n\n`);
        res.end();
      }
    };
    tick();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        state,
        /** queue behaviours, consumed in order */
        script(...b) { state.script.push(...b); },
        setFallback(b) { state.fallback = b; },
        reset() { state.requests.length = 0; state.script.length = 0; },
        setModelList(l) { state.modelList = l; },
        setModelsError(e) { state.modelsError = e; },
        /** only the content-generation calls, ignoring model discovery */
        get generationRequests() { return state.requests.filter((r) => r.action); },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}
