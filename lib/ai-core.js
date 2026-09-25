/*!
 * Backey — AI provider/service layer (shared).
 *
 * Single source of truth used by BOTH:
 *   - the Node backend  (server.mjs  -> lib/ai-core.js)
 *   - the browser UI    (index.html  -> <script src="lib/ai-core.js">, exposes window.BackeyAI)
 *
 * This layer is the ONLY place that knows about the Google Gemini API: endpoints,
 * auth header, request/response shapes, retry policy, model fallback and error
 * classification. The chat UI never talks to Gemini directly, it only consumes
 * this service (through the backend proxy whenever one is available).
 *
 * Contract implemented (official Gemini API, generateContent family):
 *   POST {base}/v1beta/models/{model}:generateContent
 *   POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse   (SSE)
 *   auth: "x-goog-api-key" header  (required by the current "AQ." auth keys;
 *         those keys are rejected with 404 when sent as ?key= query param)
 *
 * Zero dependencies. No mock/demo responses: every byte of model text returned
 * here comes from the HTTP response of the configured Gemini endpoint.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  if (root) { root.BackeyAI = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */

  var OFFICIAL_BASE_URL = 'https://generativelanguage.googleapis.com';
  var API_VERSION = 'v1beta';

  /**
   * Preference only — these are NOT trusted. The models actually used are the
   * ones GET /v1beta/models reports for this key (see resolveModels); this list
   * only decides which of them to try first, and is the last resort when
   * discovery itself is unreachable.
   *
   * Ids are current as of 2026-09 and were chosen for longevity:
   *   gemini-3.8-flash  stable, released 2026-09-02
   *   gemini-3.7-flash  stable, released 2026-08-13
   *   gemini-3.5-flash  stable, released 2026-05-19, no shutdown before 2027-05-19
   * gemini-2.5-flash was dropped from this list: Google retires it 2026-10-20.
   */
  var DEFAULT_MODEL = 'gemini-3.8-flash';
  var FALLBACK_MODELS = ['gemini-3.7-flash', 'gemini-3.5-flash'];

  var MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{1,120}$/;

  var LIMITS = {
    maxMessages: 24,        // conversation turns forwarded to the model
    maxCharsPerMessage: 8000,
    maxTotalChars: 24000,
    maxAttemptsPerModel: 3, // bounded -> retries can never loop forever
    maxModels: 3
  };

  var TIMING = {
    backoffBaseMs: 700,
    backoffMaxMs: 8000,
    backoffJitter: 0.25,
    idleTimeoutMs: 45000,   // max silence between stream chunks
    totalTimeoutMs: 180000, // hard cap for a single user turn
    connectTimeoutMs: 20000 // max wait for response headers
  };

  var SYSTEM_INSTRUCTION =
    "Tu es Backey, un professeur particulier bienveillant pour un élève de 2ème Bac " +
    "Sciences Physiques (Maroc). Réponds en français, de façon claire, pédagogique et " +
    "progressive : explique la méthode avant le résultat, détaille les étapes de calcul, " +
    "utilise la notation mathématique du programme marocain et termine souvent par une " +
    "petite question ou un mini-exercice pour vérifier la compréhension. Sois concis : " +
    "des phrases courtes, des listes quand c'est utile. Utilise du Markdown léger " +
    "(gras, listes, code entre backticks) uniquement quand cela aide vraiment.";

  /* ------------------------------------------------------------------ *
   * User-facing messages (never leak raw API errors / JSON / stack traces)
   * ------------------------------------------------------------------ */

  var FRIENDLY = {
    'no-key': 'Ajoute ta clé API Gemini dans Profil › Assistant IA pour discuter avec moi.',
    'invalid-key': 'Cette clé API ne semble pas valide. Vérifie-la dans Profil › Assistant IA.',
    'network': 'La connexion a été interrompue. Réessaie.',
    'unreachable': "Le serveur n'arrive pas à joindre Google. Vérifie la connexion Internet du serveur.",
    'timeout': 'La réponse prend trop de temps. Réessaie.',
    'rate-limit': 'Je suis très sollicité en ce moment. Réessaie dans quelques instants.',
    'unavailable': 'Petit souci technique de mon côté. Réessaie.',
    'server': 'Petit souci technique de mon côté. Réessaie.',
    'auth': 'Clé API refusée. Ajoute une clé valide dans Profil › Assistant IA.',
    'forbidden': "Cette clé n'a pas accès à l'API Gemini. Vérifie-la dans Profil › Assistant IA.",
    'not-found': "Ce modèle Gemini n'est pas disponible avec cette clé. Essaie une autre clé ou un autre modèle.",
    'invalid-request': "Je n'ai pas pu traiter ce message. Essaie de le reformuler.",
    'client': "Je n'ai pas pu traiter cette demande. Réessaie.",
    'blocked': 'Je ne peux pas répondre à cette demande.',
    'empty-response': 'Je n\'ai pas réussi à formuler de réponse. Réessaie.',
    'aborted': 'Génération arrêtée.',
    'empty': 'Écris d\'abord un message.',
    'busy': 'Une réponse est déjà en cours. Termine-la ou arrête-la d\'abord.',
    'unknown': 'Une erreur est survenue. Réessaie.',
    'test-ok': 'Connexion réussie, tout fonctionne.',
    'test-fail': 'Connexion impossible. Vérifie ta clé API.',
    'saving': 'Clé enregistrée.'
  };

  /** Never-retryable kinds: another model or another attempt will not help. */
  var NON_RETRYABLE_KINDS = {
    'no-key': 1, 'invalid-key': 1, 'auth': 1, 'forbidden': 1,
    'invalid-request': 1, 'client': 1, 'blocked': 1, 'empty': 1, 'aborted': 1
  };

  /**
   * Did Google actually tell us the CREDENTIAL is bad? Only then is it safe to
   * throw a key away. A DNS failure or a TLS reset proves nothing about the key,
   * so a key must never be discarded because of them.
   */
  function isCredentialFailure(kind, code) {
    if (kind === 'auth' || kind === 'forbidden' || kind === 'invalid-key' || kind === 'no-key') return true;
    if (kind === 'invalid-request') {
      // 400 is ambiguous: only treat it as a key problem when Google says so
      return !code || code === 'INVALID_ARGUMENT' || code === 'FAILED_PRECONDITION';
    }
    return false;
  }

  /**
   * Sanitise a message that came from our own server so it can be shown to the
   * user as-is. Strips markup and caps the length; a message that fails the
   * shape check is ignored and the kind's own string is used instead.
   */
  function sanitiseMessage(msg) {
    if (typeof msg !== 'string') return null;
    var clean = msg.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 300) return null;
    // reject anything that looks like a raw API error, JSON or stack trace
    if (/^[\[{]|"kind"|"error"|stack|at [A-Za-z0-9_$.]+\(|^[A-Z][a-z]+Error:/.test(clean)) return null;
    return clean;
  }

  function AiError(kind, opts) {
    var o = opts || {};
    var e = new Error(FRIENDLY[kind] || FRIENDLY.unknown);
    e.name = 'AiError';
    e.kind = FRIENDLY[kind] ? kind : 'unknown';
    e.friendly = FRIENDLY[e.kind];
    // A trusted caller (our own backend) may supply the exact sentence to show.
    // This keeps the UI accurate even if the client's own table is stale.
    var override = sanitiseMessage(o.message);
    if (override) { e.message = override; e.friendly = override; }
    e.retryable = !!o.retryable;
    e.status = typeof o.status === 'number' ? o.status : null;
    e.code = typeof o.code === 'string' ? o.code : null; // coarse Google enum, never shown to users
    e.model = o.model || null;
    /** Short, redacted technical reason — developer logs only, never the UI. */
    e.detail = typeof o.detail === 'string' ? o.detail : null;
    return e;
  }

  /** Map an HTTP status (+ optional Google error body) to a safe internal kind. */
  function classify(status, payload) {
    var code = (payload && payload.error && payload.error.status) || null;
    var kind, retryable = false;
    switch (status) {
      case 400: kind = 'invalid-request'; break;
      case 401: kind = 'auth'; break;
      case 403: kind = 'forbidden'; break;
      case 404: kind = 'not-found'; break;
      case 408: kind = 'timeout'; retryable = true; break;
      case 429: kind = 'rate-limit'; retryable = true; break;
      case 500: kind = 'server'; retryable = true; break;
      case 501: kind = 'client'; break;
      case 503: kind = 'unavailable'; retryable = true; break;
      case 504: kind = 'timeout'; retryable = true; break;
      default:
        if (status >= 500) { kind = 'server'; retryable = true; }
        else if (status >= 400) { kind = 'client'; }
        else { kind = 'unknown'; }
    }
    return { kind: kind, retryable: retryable, code: code, status: status };
  }

  function friendly(kind) { return FRIENDLY[kind] || FRIENDLY.unknown; }

  /* ------------------------------------------------------------------ *
   * Key handling — the key is never logged, never returned, never derived-from
   * ------------------------------------------------------------------ */

  /** Loose shape check. Deliberately permissive so Google can evolve formats. */
  function looksLikeKey(value) {
    if (typeof value !== 'string') return false;
    var k = value.trim();
    if (k.length < 20 || k.length > 200) return false;
    if (/\s/.test(k)) return false;            // no spaces / newlines
    if (/["'`<>]/.test(k)) return false;       // no quoting or markup
    return /^[A-Za-z0-9._~\-+/=]+$/.test(k);
  }

  /** Strip anything that looks like an API key out of a string before logging. */
  function redact(value) {
    if (typeof value !== 'string') return value;
    return value
      .replace(/\bAQ\.[A-Za-z0-9._~\-+/=]{8,}/g, '[REDACTED]')
      .replace(/\bAIza[A-Za-z0-9._~\-+/=]{8,}/g, '[REDACTED]')
      .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
      .replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]');
  }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function intOr(v, d) { return (typeof v === 'number' && isFinite(v) && v > 0) ? v : d; }

  function trimSlash(s) { return String(s).replace(/\/+$/, ''); }

  function isAborted(signal) { return !!(signal && signal.aborted); }

  /** Exponential backoff + jitter, honouring Retry-After when present. Bounded. */
  function computeBackoff(attempt, opts) {
    var o = opts || {};
    var base = intOr(o.baseMs, TIMING.backoffBaseMs);
    var max = intOr(o.maxMs, TIMING.backoffMaxMs);
    var jitter = typeof o.jitter === 'number' ? o.jitter : TIMING.backoffJitter;
    var rand = o.random || Math.random;
    var n = Math.max(0, Math.min(10, attempt | 0));
    var delay = Math.min(max, base * Math.pow(2, n));
    delay = delay * (1 + jitter * rand());
    if (typeof o.retryAfterSec === 'number' && isFinite(o.retryAfterSec)) {
      delay = Math.max(delay, Math.min(max, o.retryAfterSec * 1000));
    }
    return Math.round(Math.min(max * (1 + jitter), delay));
  }

  /** Parse a Retry-After header (delta-seconds form) into seconds, or null. */
  function retryAfterSeconds(headers) {
    try {
      var raw = headers && (headers.get ? headers.get('retry-after') : null);
      if (!raw) return null;
      var n = parseInt(raw, 10);
      if (isFinite(n) && n >= 0 && n <= 120) return n;
      return null;
    } catch (e) { return null; }
  }

  function normalizeModels(input) {
    var list = [];
    var src = Array.isArray(input) ? input
      : (typeof input === 'string' ? [input] : [DEFAULT_MODEL].concat(FALLBACK_MODELS));
    for (var i = 0; i < src.length && list.length < LIMITS.maxModels; i++) {
      var m = typeof src[i] === 'string' ? src[i].trim() : '';
      if (m && MODEL_ID_RE.test(m) && list.indexOf(m) === -1) list.push(m);
    }
    if (!list.length) list.push(DEFAULT_MODEL);
    return list;
  }

  /* ------------------------------------------------------------------ *
   * Gemini request building
   * ------------------------------------------------------------------ */

  /** Convert UI history into the Gemini `contents` array (stateless REST API). */
  function buildContents(history) {
    var src = Array.isArray(history) ? history : [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var m = src[i] || {};
      var role = m.role === 'model' ? 'model' : 'user';
      var text = typeof m.text === 'string' ? m.text : (typeof m.content === 'string' ? m.content : '');
      text = String(text).replace(/\r\n/g, '\n').trim();
      if (!text) continue;
      if (text.length > LIMITS.maxCharsPerMessage) text = text.slice(-LIMITS.maxCharsPerMessage);
      out.push({ role: role, parts: [{ text: text }] });
    }
    // keep the most recent turns, then drop any leading model turn
    if (out.length > LIMITS.maxMessages) out = out.slice(out.length - LIMITS.maxMessages);
    while (out.length && out[0].role === 'model') out.shift();

    // global character budget (oldest first to be trimmed)
    var total = 0;
    for (var j = 0; j < out.length; j++) total += out[j].parts[0].text.length;
    while (out.length > 1 && total > LIMITS.maxTotalChars) {
      total -= out[0].parts[0].text.length;
      out.shift();
      while (out.length && out[0].role === 'model') out.shift();
    }
    return out;
  }

  function buildRequestBody(contents, opts) {
    var o = opts || {};
    var body = {
      contents: contents,
      generationConfig: {
        temperature: typeof o.temperature === 'number' ? o.temperature : 0.7,
        topP: typeof o.topP === 'number' ? o.topP : 0.95,
        maxOutputTokens: intOr(o.maxOutputTokens, 2048)
      }
    };
    var sys = typeof o.systemInstruction === 'string' ? o.systemInstruction : SYSTEM_INSTRUCTION;
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    return body;
  }

  function streamUrl(base, model) {
    return trimSlash(base) + '/' + API_VERSION + '/models/' + encodeURIComponent(model) +
      ':streamGenerateContent?alt=sse';
  }
  function generateUrl(base, model) {
    return trimSlash(base) + '/' + API_VERSION + '/models/' + encodeURIComponent(model) + ':generateContent';
  }

  /* ------------------------------------------------------------------ *
   * SSE parsing (incremental, tolerant of CRLF and multi-line data fields)
   * ------------------------------------------------------------------ */

  function SseParser(onEvent) {
    this._buf = '';
    this._data = [];
    this._event = '';
    this._onEvent = onEvent;
  }
  SseParser.prototype.push = function (chunk) {
    this._buf += String(chunk);
    var idx;
    while ((idx = this._buf.search(/\r\n|\n|\r/)) !== -1) {
      var line = this._buf.slice(0, idx);
      var sep = this._buf.charAt(idx);
      var skip = 1;
      if (sep === '\r' && this._buf.charAt(idx + 1) === '\n') skip = 2;
      this._buf = this._buf.slice(idx + skip);
      this._line(line);
    }
    // guard against an unbounded buffer when the server never terminates lines
    if (this._buf.length > 4 * 1024 * 1024) this._buf = '';
  };
  SseParser.prototype._line = function (line) {
    if (line === '') { this._flush(); return; }
    if (line.charAt(0) === ':') return; // SSE comment / keep-alive
    var colon = line.indexOf(':');
    var field = colon === -1 ? line : line.slice(0, colon);
    var value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charAt(0) === ' ') value = value.slice(1);
    if (field === 'data') this._data.push(value);
    else if (field === 'event') this._event = value;
  };
  SseParser.prototype._flush = function () {
    if (!this._data.length) { this._event = ''; return; }
    var payload = this._data.join('\n');
    var name = this._event;
    this._data = [];
    this._event = '';
    if (payload === '[DONE]') return;
    this._onEvent(payload, name);
  };
  SseParser.prototype.end = function () {
    if (this._buf.length) { this._line(this._buf); this._buf = ''; }
    this._flush();
  };

  /* ------------------------------------------------------------------ *
   * Response shape helpers
   * ------------------------------------------------------------------ */

  function extractText(obj) {
    var out = '';
    var cands = obj && obj.candidates;
    if (!Array.isArray(cands)) return out;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i] || {};
      var parts = (c.content && c.content.parts) || c.parts;
      if (!Array.isArray(parts)) continue;
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j] || {};
        if (typeof p.text === 'string') out += p.text;
      }
    }
    return out;
  }

  function finishReasonOf(obj) {
    var c = obj && obj.candidates;
    if (!Array.isArray(c) || !c.length) return null;
    return (c[0] && c[0].finishReason) || null;
  }

  function blockReasonOf(obj) {
    var pf = obj && obj.promptFeedback;
    return (pf && pf.blockReason) || null;
  }

  /** Google sends a full GenerateContentResponse per SSE event, not a delta. */
  function chunkToDelta(obj) { return extractText(obj); }

  /* ------------------------------------------------------------------ *
   * Core streaming call: retries + backoff + invisible model fallback
   * ------------------------------------------------------------------ */

  /**
   * @param {object} o
   *   apiKey, history|contents, models, systemInstruction, baseUrl, fetchImpl,
   *   signal, onDelta(text, full), onMeta({model}),
   *   maxAttemptsPerModel, idleTimeoutMs, connectTimeoutMs, totalTimeoutMs
   * @returns {Promise<{text:string, model:string, finishReason:string|null,
   *                    interrupted:boolean, attempts:number}>}
   */
  async function streamChat(o) {
    var opts = o || {};
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw AiError('network', { retryable: false });

    var apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    if (!apiKey) throw AiError('no-key');
    if (!looksLikeKey(apiKey)) throw AiError('invalid-key');

    var base = trimSlash(opts.baseUrl || OFFICIAL_BASE_URL);
    var models = normalizeModels(opts.models);
    var maxPerModel = Math.max(1, Math.min(LIMITS.maxAttemptsPerModel,
      intOr(opts.maxAttemptsPerModel, LIMITS.maxAttemptsPerModel)));
    var idleMs = intOr(opts.idleTimeoutMs, TIMING.idleTimeoutMs);
    var connectMs = intOr(opts.connectTimeoutMs, TIMING.connectTimeoutMs);
    var totalMs = intOr(opts.totalTimeoutMs, TIMING.totalTimeoutMs);
    var sleepFn = opts.sleep || sleep;
    var nowFn = opts.now || Date.now;
    var rand = opts.random || Math.random;

    var contents = buildContents(opts.history || opts.contents);
    if (!contents.length) throw AiError('empty');
    var body = buildRequestBody(contents, opts);

    var emitted = '';
    var attempts = 0;
    var startedAt = nowFn();
    var lastErr = null;
    var metaSent = false;

    /* Structured trace for developer logs. Never contains the API key. */
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    function ev(type, data) {
      if (!onEvent) return;
      var d = data || {};
      d.type = type;
      try { onEvent(d); } catch (e) { /* logging must never break a request */ }
    }
    ev('start', { models: models, turns: contents.length, base: base });

    for (var mi = 0; mi < models.length; mi++) {
      var model = models[mi];
      var hasMoreModels = mi < models.length - 1;

      for (var attempt = 0; attempt < maxPerModel; attempt++) {
        if (isAborted(opts.signal)) throw AiError('aborted');
        if (nowFn() - startedAt > totalMs) throw AiError('timeout', { retryable: true });

        attempts++;
        ev('request', { model: model, attempt: attempt + 1, of: maxPerModel, url: streamUrl(base, model) });
        var res = null;
        var result = null;
        try {
          res = await openStream({
            fetchImpl: fetchImpl, base: base, model: model, apiKey: apiKey, body: body,
            signal: opts.signal, connectMs: connectMs, idleMs: idleMs,
            remainingMs: Math.max(1000, totalMs - (nowFn() - startedAt))
          });
        } catch (err) {
          lastErr = normalizeTransportError(err, model, 'connect');
          ev('transport-error', { model: model, attempt: attempt + 1, kind: lastErr.kind, detail: lastErr.detail });
          if (lastErr.kind === 'aborted') throw lastErr;
          var decision = decide(lastErr, {
            attempt: attempt, maxPerModel: maxPerModel, emitted: emitted,
            hasMoreModels: hasMoreModels
          });
          if (decision === 'partial') {
            return { text: emitted, model: model, finishReason: null, interrupted: true, attempts: attempts };
          }
          if (decision === 'retry') { await sleepFn(computeBackoff(attempt, { random: rand })); continue; }
          if (decision === 'next-model') {
            ev('fallback', { from: model, attempt: attempt + 1, kind: lastErr && lastErr.kind });
            break;
          }
          throw lastErr;
        }

        // HTTP-level failure
        if (!res.ok) {
          var payload = await readErrorPayload(res);
          var cls = classify(res.status, payload);
          lastErr = AiError(cls.kind, {
            retryable: cls.retryable, status: res.status, code: cls.code, model: model
          });
          ev('http-error', {
            model: model, attempt: attempt + 1, status: res.status,
            kind: cls.kind, code: cls.code, retryable: cls.retryable
          });
          res.finish(); // the error body was already drained by readErrorPayload()

          if (lastErr.kind === 'auth' || lastErr.kind === 'forbidden' || lastErr.kind === 'no-key') {
            throw lastErr; // a different model cannot fix credentials
          }
          var d2 = decide(lastErr, {
            attempt: attempt, maxPerModel: maxPerModel, emitted: emitted,
            hasMoreModels: hasMoreModels,
            retryAfterSec: retryAfterSeconds(res.headers)
          });
          if (d2 === 'retry') {
            await sleepFn(computeBackoff(attempt, { random: rand, retryAfterSec: retryAfterSeconds(res.headers) }));
            continue;
          }
          if (d2 === 'next-model') {
            ev('fallback', { from: model, attempt: attempt + 1, kind: lastErr && lastErr.kind });
            break;
          }
          throw lastErr;
        }

        if (!metaSent) {
          metaSent = true;
          ev('first-token', { model: model, attempt: attempt + 1, httpStatus: res.status });
          if (opts.onMeta) { try { opts.onMeta({ model: model }); } catch (e) { /* ignore */ } }
        }

        // consume the stream
        try {
          result = await consumeStream(res, {
            onDelta: opts.onDelta,
            emit: function (t) { emitted += t; }
          });
        } catch (err) {
          lastErr = normalizeTransportError(err, model, 'stream');
          if (lastErr.kind === 'aborted') throw lastErr;
          var d3 = decide(lastErr, {
            attempt: attempt, maxPerModel: maxPerModel, emitted: emitted, hasMoreModels: hasMoreModels
          });
          if (d3 === 'partial') {
            return { text: emitted, model: model, finishReason: null, interrupted: true, attempts: attempts };
          }
          if (d3 === 'retry') { await sleepFn(computeBackoff(attempt, { random: rand })); continue; }
          if (d3 === 'next-model') {
            ev('fallback', { from: model, attempt: attempt + 1, kind: lastErr && lastErr.kind });
            break;
          }
          throw lastErr;
        }

        if (result.apiError) {
          var ce = classify(result.apiError.code || 500, result.apiError.payload);
          lastErr = AiError(ce.kind, { retryable: ce.retryable, status: ce.status, code: ce.code, model: model });
          var d4 = decide(lastErr, {
            attempt: attempt, maxPerModel: maxPerModel, emitted: emitted, hasMoreModels: hasMoreModels
          });
          if (d4 === 'partial') {
            return { text: emitted, model: model, finishReason: null, interrupted: true, attempts: attempts };
          }
          if (d4 === 'retry') { await sleepFn(computeBackoff(attempt, { random: rand })); continue; }
          if (d4 === 'next-model') { break; }
          throw lastErr;
        }

        if (result.blockReason) throw AiError('blocked', { model: model });

        if (!emitted) {
          if (result.finishReason === 'SAFETY') throw AiError('blocked', { model: model });
          lastErr = AiError('empty-response', { retryable: true, model: model });
          var d5 = decide(lastErr, {
            attempt: attempt, maxPerModel: maxPerModel, emitted: emitted, hasMoreModels: hasMoreModels
          });
          if (d5 === 'retry') { await sleepFn(computeBackoff(attempt, { random: rand })); continue; }
          if (d5 === 'next-model') {
            ev('fallback', { from: model, attempt: attempt + 1, kind: lastErr && lastErr.kind });
            break;
          }
          throw lastErr;
        }

        ev('done', {
          model: model, attempts: attempts, chars: emitted.length,
          finishReason: result.finishReason, ms: nowFn() - startedAt
        });
        return {
          text: emitted,
          model: model,
          finishReason: result.finishReason,
          interrupted: false,
          attempts: attempts
        };
      }
    }

    throw lastErr || AiError('unknown');
  }

  /**
   * Decide what to do after a failure. Returns 'retry' | 'next-model' | 'partial' | 'throw'.
   * 'partial' keeps text already shown to the user instead of duplicating it.
   */
  function decide(err, ctx) {
    if (!err) return 'throw';
    if (err.kind === 'aborted') return 'throw';
    if (NON_RETRYABLE_KINDS[err.kind]) return 'throw';

    // Text already on screen: never restart, that would duplicate the answer.
    if (ctx.emitted) {
      return (err.kind === 'network' || err.kind === 'timeout' || err.kind === 'server' ||
              err.kind === 'unavailable') ? 'partial' : 'throw';
    }
    if (err.retryable && ctx.attempt < ctx.maxPerModel - 1) return 'retry';
    if (ctx.hasMoreModels) return 'next-model';
    return 'throw';
  }

  /**
   * Turn a transport failure into a safe AiError.
   * @param phase 'connect' = we never got an HTTP response (DNS/TCP/TLS/refused)
   *                     -> the host is genuinely unreachable, retrying won't help
   *              'stream'  = the connection dropped mid-answer -> transient
   * The original message is kept as a SHORT, redacted `detail` for developer logs
   * only — it never reaches the UI.
   */
  function normalizeTransportError(err, model, phase) {
    if (err && err.name === 'AiError') return err;
    var name = (err && err.name) || '';
    /*
     * Node's fetch reports only "fetch failed" and hides the real reason
     * (ECONNRESET, ENOTFOUND, a TLS error…) in err.cause. Unwrap it, otherwise
     * the developer logs are useless.
     */
    var msg = String((err && err.message) || '');
    var cause = err && err.cause;
    var causeMsg = cause ? String(cause.code || cause.message || cause) : '';
    var combined = (msg + (causeMsg ? ' | ' + causeMsg : '')).trim();
    var detail = redact(combined).replace(/\s+/g, ' ').slice(0, 200);

    if (name === 'AbortError' || /aborted/i.test(msg)) return AiError('aborted', { model: model });
    if (/idle timeout/i.test(combined)) return AiError('timeout', { retryable: true, model: model, detail: detail });
    if (/total timeout/i.test(combined)) return AiError('timeout', { retryable: true, model: model, detail: detail });

    var transport = name === 'TypeError' ||
      /fetch failed|network|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|unexpected eof|\bssl\b|\btls\b|certificate|handshake/i.test(combined);
    var kind = (phase !== 'stream' && transport) ? 'unreachable' : 'network';
    return AiError(kind, { retryable: true, model: model, detail: detail });
  }

  async function readErrorPayload(res) {
    try {
      var raw = await res.text();
      if (!raw) return null;
      return JSON.parse(String(raw).slice(0, 4000));
    } catch (e) { return null; }
  }

  async function openStream(cfg) {
    var ctrl = new AbortController();
    var settled = false;
    var failWith = null;
    var idleTimer = null;
    var totalTimer = null;

    function onExternalAbort() {
      if (settled) return;
      failWith = 'aborted';
      ctrl.abort();
    }
    /**
     * The caller's abort listener must stay attached for the WHOLE streaming
     * phase, not just until the headers arrive — otherwise "Stop generation"
     * would not cancel a response that is already streaming.
     */
    function detach() {
      if (cfg.signal && cfg.signal.removeEventListener) {
        cfg.signal.removeEventListener('abort', onExternalAbort);
      }
    }
    if (cfg.signal) {
      if (cfg.signal.aborted) { failWith = 'aborted'; ctrl.abort(); }
      else if (cfg.signal.addEventListener) cfg.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    var connectTimer = setTimeout(function () {
      if (settled) return;
      failWith = 'connect timeout';
      ctrl.abort();
    }, cfg.connectMs);

    var res;
    try {
      res = await cfg.fetchImpl(streamUrl(cfg.base, cfg.model), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'x-goog-api-key': cfg.apiKey   // required by the current "AQ." auth keys
        },
        body: JSON.stringify(cfg.body),
        signal: ctrl.signal
      });
    } catch (e) {
      detach();
      throw e;
    }
    clearTimeout(connectTimer);

    // Headers arrived. Watchdogs are only needed while we actually consume a
    // body: arming them on an error response would keep timers (and the event
    // loop) alive long after the attempt is over.
    if (res.ok) {
      idleTimer = setTimeout(function () {
        failWith = 'idle timeout';
        ctrl.abort();
      }, cfg.idleMs);
      totalTimer = setTimeout(function () {
        failWith = 'total timeout';
        ctrl.abort();
      }, cfg.remainingMs);
    }

    var wrapped = {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      body: res.body,
      text: function () { return res.text(); },
      /** Reset the idle watchdog each time a chunk lands. */
      touch: function () {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(function () { failWith = 'idle timeout'; ctrl.abort(); }, cfg.idleMs);
        }
      },
      /** Release every timer and listener once the attempt is over (success OR failure). */
      finish: function () {
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (totalTimer) clearTimeout(totalTimer);
        connectTimer = idleTimer = totalTimer = null;
        detach();
      },
      abortCause: function () { return failWith; },
      cancel: function () {
        try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* ignore */ }
        this.finish();
      }
    };
    return wrapped;
  }

  async function consumeStream(res, cfg) {
    var finish = null;
    var blockReason = null;
    var apiError = null;

    var parser = new SseParser(function (payload) {
      var obj;
      try { obj = JSON.parse(payload); } catch (e) { return; }
      if (!obj || typeof obj !== 'object') return;
      if (obj.error) {
        apiError = { code: obj.error.code || 500, payload: obj };
        return;
      }
      var br = blockReasonOf(obj);
      if (br) blockReason = br;
      var fr = finishReasonOf(obj);
      if (fr) finish = fr;
      var text = chunkToDelta(obj);
      if (text) { cfg.emit(text); if (cfg.onDelta) cfg.onDelta(text, ''); }
    });

    var decoder = new TextDecoder();
    var reader = null;
    var accumulator = makeJsonAccumulator();
    function feed(chunkText, isSse) {
      if (isSse) parser.push(chunkText);
      else accumulator(chunkText, function (obj) { parser.push(obj + '\n\n'); });
    }
    try {
      if (!res.body || !res.body.getReader) {
        // Very old runtimes / non-streaming body: fall back to a buffered read.
        parseBufferedJson(await res.text(), parser);
      } else {
        reader = res.body.getReader();
        var contentType = '';
        try { contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || ''; } catch (e) {}
        var isSse = /text\/event-stream/i.test(contentType) || contentType === '';

        while (true) {
          var step = await reader.read();
          if (step.done) break;
          res.touch();
          feed(decoder.decode(step.value, { stream: true }), isSse);
        }
        var tail = decoder.decode();
        if (tail) feed(tail, isSse);
      }
      parser.end();
    } finally {
      if (reader) { try { reader.releaseLock(); } catch (e) { /* ignore */ } }
      res.finish();
    }

    var cause = res.abortCause && res.abortCause();
    if (cause && !apiError) {
      var e = new Error(cause);
      e.name = (cause === 'aborted') ? 'AbortError' : 'Error';
      throw e;
    }
    return { finishReason: finish, blockReason: blockReason, apiError: apiError };
  }

  /**
   * Handle the non-SSE chunked JSON-array form of streamGenerateContent.
   * Per-call state: safe for concurrent streams.
   */
  function makeJsonAccumulator() {
    var acc = '';
    return function (chunk, emit) {
      acc += chunk;
      var objs = [];
      var depth = 0, start = -1, inStr = false, esc = false;
      for (var i = 0; i < acc.length; i++) {
        var ch = acc.charAt(i);
        if (inStr) {
          if (esc) { esc = false; }
          else if (ch === '\\') { esc = true; }
          else if (ch === '"') { inStr = false; }
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') { if (depth === 0) start = i; depth++; }
        else if (ch === '}') {
          depth--;
          if (depth === 0 && start !== -1) { objs.push(acc.slice(start, i + 1)); start = -1; }
        }
      }
      acc = start > 0 ? acc.slice(start) : '';
      for (var k = 0; k < objs.length; k++) emit(objs[k]);
    };
  }

  function parseBufferedJson(raw, parser) {
    var acc = makeJsonAccumulator();
    acc(raw, function (obj) { parser.push(obj + '\n\n'); });
    parser.end();
  }

  /* ------------------------------------------------------------------ *
   * Non-streaming call — used by "Test API connection"
   * ------------------------------------------------------------------ */

  async function testConnection(o) {
    var opts = o || {};
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) return { connected: false, kind: 'network', message: FRIENDLY['network'] };

    var apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    if (!apiKey) return { connected: false, kind: 'no-key', message: FRIENDLY['no-key'] };
    if (!looksLikeKey(apiKey)) return { connected: false, kind: 'invalid-key', message: FRIENDLY['invalid-key'] };

    var base = trimSlash(opts.baseUrl || OFFICIAL_BASE_URL);
    var models = normalizeModels(opts.models);
    var connectMs = intOr(opts.connectTimeoutMs, TIMING.connectTimeoutMs);
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    function ev(type, data) {
      if (!onEvent) return;
      var d = data || {}; d.type = type;
      try { onEvent(d); } catch (e) { /* logging must never break a request */ }
    }
    ev('test-start', { models: models, base: base });
    var body = {
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 }
    };

    for (var mi = 0; mi < models.length; mi++) {
      var model = models[mi];
      var ctrl = new AbortController();
      var onAbort = function () { ctrl.abort(); };
      if (opts.signal) {
        if (opts.signal.aborted) ctrl.abort();
        else if (opts.signal.addEventListener) opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      var timer = setTimeout(function () { ctrl.abort(); }, connectMs);
      var res = null;
      try {
        ev('test-request', { model: model, of: models.length, url: generateUrl(base, model) });
        res = await fetchImpl(generateUrl(base, model), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
        ev('test-response', { model: model, status: res.status });
      } catch (err) {
        clearTimeout(timer);
        if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onAbort);
        if (isAborted(opts.signal)) return { connected: false, kind: 'aborted', message: FRIENDLY.aborted };
        if (mi === models.length - 1) {
          // keep the real technical reason for the developer logs
          var te = normalizeTransportError(err, model, 'connect');
          return { connected: false, kind: te.kind, message: te.friendly, detail: te.detail };
        }
        continue;
      }
      clearTimeout(timer);
      if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onAbort);

      // Any authenticated answer (including an empty candidate) proves the key works.
      if (res.ok) {
        try { await res.text(); } catch (e) { /* ignore */ }
        return { connected: true, kind: 'ok', message: FRIENDLY['test-ok'], model: model };
      }

      var payload = await readErrorPayload(res);
      var cls = classify(res.status, payload);
      // 404 on a specific model id is not a credential problem: try the fallback.
      if (cls.kind === 'not-found' && mi < models.length - 1) continue;
      return {
        connected: false,
        kind: cls.kind,
        code: cls.code,
        status: res.status,
        message: friendly(cls.kind)
      };
    }
    return { connected: false, kind: 'unknown', message: FRIENDLY.unknown };
  }

  /* ------------------------------------------------------------------ *
   * Transport through the secure backend proxy (preferred path).
   * The browser never sees the API key on this path.
   * ------------------------------------------------------------------ */

  /**
   * @param {object} o  { url, history, signal, onDelta, onMeta, onActivity,
   *                      idleTimeoutMs, fetchImpl }
   * @returns {Promise<{text:string, model:string|null, interrupted:boolean}>}
   */
  async function streamViaProxy(o) {
    var opts = o || {};
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw AiError('network');

    var history = buildContents(opts.history || []).map(function (c) {
      return { role: c.role, text: c.parts[0].text };
    });
    if (!history.length) throw AiError('empty');

    var idleMs = intOr(opts.idleTimeoutMs, TIMING.idleTimeoutMs);
    var ctrl = new AbortController();
    var idleTimer = null;
    var timedOut = false;

    function touch() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { timedOut = true; ctrl.abort(); }, idleMs);
    }
    function onExternal() { ctrl.abort(); }
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else if (opts.signal.addEventListener) opts.signal.addEventListener('abort', onExternal, { once: true });
    }
    touch();

    var text = '';
    var model = null;
    var interrupted = false;
    var err = null;
    var aborted = false;

    var parser = new SseParser(function (data, name) {
      var obj = null;
      try { obj = JSON.parse(data); } catch (e) { return; }
      if (name === 'delta') {
        var t = (obj && typeof obj.t === 'string') ? obj.t : '';
        if (t) { text += t; if (opts.onDelta) opts.onDelta(t, text); }
      } else if (name === 'meta') {
        model = (obj && obj.model) || null;
        if (opts.onMeta) opts.onMeta({ model: model });
      } else if (name === 'done') {
        interrupted = !!(obj && obj.interrupted);
      } else if (name === 'error') {
        // Prefer the sentence our own server already built: the client must not
        // silently degrade to the generic string if its table is stale.
        err = AiError((obj && obj.kind) || 'unknown', {
          status: obj && typeof obj.status === 'number' ? obj.status : null,
          message: obj && obj.message
        });
      } else if (name === 'aborted') {
        aborted = true;
      }
      touch();
    });

    var res;
    try {
      res = await fetchImpl(opts.url || '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
        body: JSON.stringify({ history: history }),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(idleTimer);
      if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onExternal);
      if (isAborted(opts.signal)) throw AiError('aborted');
      throw AiError(timedOut ? 'timeout' : 'network', { retryable: true });
    }

    if (!res || !res.ok) {
      var kind = 'server';
      var status = res ? res.status : 0;
      var srvMsg = null;
      try {
        var payload = await res.json();
        if (payload && payload.error && payload.error.kind) kind = payload.error.kind;
        if (payload && payload.error && payload.error.message) srvMsg = payload.error.message;
      } catch (e) { /* non-JSON error body */ }
      if (kind === 'server') {
        if (status === 409) kind = 'no-key';
        else if (status === 429) kind = 'busy';
        else if (status === 400) kind = 'invalid-request';
        else if (status >= 500) kind = 'server';
      }
      clearTimeout(idleTimer);
      if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onExternal);
      throw AiError(kind, { status: status, message: srvMsg });
    }

    try {
      if (res.body && res.body.getReader) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        while (true) {
          var step = await reader.read();
          if (step.done) break;
          touch();
          parser.push(decoder.decode(step.value, { stream: true }));
        }
        parser.push(decoder.decode());
      } else {
        parser.push(await res.text());
      }
      parser.end();
    } catch (e) {
      clearTimeout(idleTimer);
      if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onExternal);
      if (isAborted(opts.signal)) throw AiError('aborted');
      // Keep whatever already reached the screen instead of discarding it.
      if (text) return { text: text, model: model, interrupted: true };
      throw AiError(timedOut ? 'timeout' : 'network', { retryable: true });
    }

    clearTimeout(idleTimer);
    if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onExternal);

    if (isAborted(opts.signal) || (aborted && !text)) throw AiError('aborted');
    if (err && !text) throw err;
    if (timedOut && !text) throw AiError('timeout', { retryable: true });
    return { text: text, model: model, interrupted: interrupted || (!!err && !!text) || timedOut };
  }

  /* ------------------------------------------------------------------ *
   * Model discovery — never guess a model id, ask Google which ones the
   * key can actually use (GET /v1beta/models).
   * ------------------------------------------------------------------ */

  /** Media/specialist models that cannot answer a chat turn. */
  var MODEL_EXCLUDE_RE = /(tts|speech|imagen|veo|embedding|embed|rerank|transcribe|-live|image|nano-banana|aqa|preview-image)/i;

  /** GET /v1beta/models with the documented x-goog-api-key header. */
  async function listModels(o) {
    var opts = o || {};
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) return { models: [], error: AiError('network') };
    var apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    if (!apiKey) return { models: [], error: AiError('no-key') };
    if (!looksLikeKey(apiKey)) return { models: [], error: AiError('invalid-key') };

    var base = trimSlash(opts.baseUrl || OFFICIAL_BASE_URL);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, intOr(opts.timeoutMs, 15000));
    var onAbort = function () { ctrl.abort(); };
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else if (opts.signal.addEventListener) opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    var res;
    try {
      res = await fetchImpl(base + '/' + API_VERSION + '/models?pageSize=200', {
        headers: { 'x-goog-api-key': apiKey },
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onAbort);
      if (isAborted(opts.signal)) return { models: [], error: AiError('aborted') };
      return { models: [], error: normalizeTransportError(e, null, 'connect') };
    }
    clearTimeout(timer);
    if (opts.signal && opts.signal.removeEventListener) opts.signal.removeEventListener('abort', onAbort);

    if (!res.ok) {
      var payload = await readErrorPayload(res);
      var cls = classify(res.status, payload);
      return { models: [], error: AiError(cls.kind, { status: res.status, code: cls.code }) };
    }
    var body;
    try { body = JSON.parse(await res.text()); } catch (e) { return { models: [], error: AiError('server') }; }

    var list = (body && body.models) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var id = String(m.name || '').replace(/^models\//, '');
      if (!id || !MODEL_ID_RE.test(id)) continue;
      out.push({
        id: id,
        displayName: m.displayName || id,
        methods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : []
      });
    }
    return { models: out, error: null };
  }

  function chatCapable(m) {
    var methods = m.methods || [];
    var canGenerate = methods.length === 0 ||
      methods.indexOf('streamGenerateContent') !== -1 ||
      methods.indexOf('generateContent') !== -1;
    return canGenerate && !MODEL_EXCLUDE_RE.test(m.id);
  }

  function modelRank(id) {
    if (/flash-lite/.test(id)) return 2;
    if (/flash/.test(id)) return 1;
    if (/pro/.test(id)) return 3;
    return 4;
  }

  /**
   * Order the models to try: configured ones the key really has first, then the
   * remaining discovered chat models (flash before pro). Falls back to the
   * configured list when discovery was impossible, so an offline model list can
   * never make the app worse than before.
   */
  function resolveModels(opts) {
    var o = opts || {};
    var configured = normalizeModels(o.configured);
    var available = (Array.isArray(o.available) ? o.available : []).filter(chatCapable);
    var ids = available.map(function (m) { return m.id; });
    var out = [];

    configured.forEach(function (id) {
      if (ids.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id);
    });
    ids.slice()
      .sort(function (a, b) { return (modelRank(a) - modelRank(b)) || a.localeCompare(b); })
      .forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });

    if (!out.length) out = configured.slice();
    return out.slice(0, LIMITS.maxModels);
  }

  /* ------------------------------------------------------------------ *
   * Markdown / LaTeX -> safe HTML (escaped first, whitelisted tags only)
   * ------------------------------------------------------------------ */

  var SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'x': 'ˣ' };
  var SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };

  var TEX_SYMBOLS = [
    ['\\cdot', '·'], ['\\times', '×'], ['\\div', '÷'], ['\\pm', '±'], ['\\mp', '∓'],
    ['\\leqslant', '≤'], ['\\leq', '≤'], ['\\le', '≤'], ['\\geqslant', '≥'], ['\\geq', '≥'], ['\\ge', '≥'],
    ['\\neq', '≠'], ['\\ne', '≠'], ['\\approx', '≈'], ['\\equiv', '≡'], ['\\sim', '~'],
    ['\\infty', '∞'], ['\\to', '→'], ['\\rightarrow', '→'], ['\\longrightarrow', '⟶'],
    ['\\Rightarrow', '⇒'], ['\\Leftarrow', '⇐'], ['\\Leftrightarrow', '⇔'], ['\\iff', '⇔'],
    ['\\in', '∈'], ['\\notin', '∉'], ['\\subset', '⊂'], ['\\subseteq', '⊆'], ['\\cup', '∪'], ['\\cap', '∩'],
    ['\\emptyset', '∅'], ['\\forall', '∀'], ['\\exists', '∃'],
    ['\\alpha', 'α'], ['\\beta', 'β'], ['\\gamma', 'γ'], ['\\Delta', 'Δ'], ['\\delta', 'δ'],
    ['\\epsilon', 'ε'], ['\\varepsilon', 'ε'], ['\\theta', 'θ'], ['\\lambda', 'λ'], ['\\mu', 'μ'],
    ['\\pi', 'π'], ['\\rho', 'ρ'], ['\\sigma', 'σ'], ['\\tau', 'τ'], ['\\phi', 'φ'], ['\\omega', 'ω'],
    ['\\sum', 'Σ'], ['\\prod', 'Π'], ['\\int', '∫'], ['\\partial', '∂'], ['\\nabla', '∇'],
    ['\\sqrt', '√'], ['\\lim', 'lim'], ['\\ln', 'ln'], ['\\log', 'log'],
    ['\\sin', 'sin'], ['\\cos', 'cos'], ['\\tan', 'tan'], ['\\exp', 'exp'],
    ['\\left', ''], ['\\right', ''], ['\\,', ' '], ['\\;', ' '], ['\\:', ' '], ['\\!', ''], ['\\ ', ' '],
    ['\\{', '{'], ['\\}', '}'], ['\\%', '%'], ['\\$', '$'], ['\\&', '&'], ['\\#', '#'], ['\\_', '_']
  ];

  function mapChars(str, table) {
    var out = '';
    for (var i = 0; i < str.length; i++) out += table[str.charAt(i)] || str.charAt(i);
    return out;
  }

  /** Light LaTeX -> readable plain text so maths reads well in a chat bubble. */
  function texToPlain(input) {
    var s = String(input);

    // \dfrac{a}{b} / \frac{a}{b} / \tfrac{a}{b}  ->  a/b   (one nesting level)
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    // \sqrt[3]{x} -> ³√(x) ; \sqrt{x} -> √(x)
    s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, function (_m, n, x) {
      return mapChars(n, SUP) + '√(' + x + ')';
    });
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
    // x^{2} / x^2  and  x_{1} / x_1
    s = s.replace(/\^\{([^{}]*)\}/g, function (_m, g) { return mapChars(g, SUP); });
    s = s.replace(/\^([0-9a-zA-Z])/g, function (_m, g) { return mapChars(g, SUP); });
    s = s.replace(/_\{([^{}]*)\}/g, function (_m, g) { return mapChars(g, SUB); });
    s = s.replace(/_([0-9a-zA-Z])/g, function (_m, g) { return mapChars(g, SUB); });

    for (var i = 0; i < TEX_SYMBOLS.length; i++) {
      s = s.split(TEX_SYMBOLS[i][0]).join(TEX_SYMBOLS[i][1]);
    }
    // remove remaining math delimiters
    s = s.replace(/\$\$?/g, '').replace(/\\\(|\\\)|\\\[|\\\]/g, '');
    // tidy double spaces produced by the substitutions
    s = s.replace(/[ \t]{2,}/g, ' ');
    return s;
  }

  var CODE_TOKEN = '\u0000CB';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inlineFormat(escaped) {
    var s = escaped;
    // inline code
    s = s.replace(/`([^`\n]+)`/g, function (_m, c) { return '<code class="md-i">' + c + '</code>'; });
    // bold / italic / strike
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    // markdown links (http/https only) + bare urls
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, label, href) {
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_m, pre, href) {
      return pre + '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + href + '</a>';
    });
    return s;
  }

  /**
   * Minimal, dependency-free Markdown renderer.
   * Everything is HTML-escaped before any tag is produced, so model output can
   * never inject markup or script.
   */
  function renderMarkdown(src) {
    if (src === null || src === undefined) return '';
    var text = String(src).replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';

    // 1. pull fenced code blocks out
    var blocks = [];
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g, function (_m, lang, code) {
      var safe = escapeHtml(code.replace(/\n$/, ''));
      var label = lang ? '<span class="md-lang">' + escapeHtml(lang) + '</span>' : '';
      blocks.push('<div class="md-code">' + label + '<pre><code>' + safe + '</code></pre></div>');
      return '\n' + CODE_TOKEN + (blocks.length - 1) + '\u0001\n';
    });

    // 2. maths cleanup outside code, then escape
    text = texToPlain(text);
    text = escapeHtml(text);

    // 3. block-level parsing
    var lines = text.split('\n');
    var html = [];
    var list = null; // 'ul' | 'ol'
    var para = [];

    function closeList() { if (list) { html.push('</' + list + '>'); list = null; } }
    function flushPara() {
      if (para.length) {
        html.push('<p>' + para.map(inlineFormat).join('<br>') + '</p>');
        para = [];
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var codeAt = line.indexOf(CODE_TOKEN);
      if (codeAt !== -1) {
        var id = parseInt(line.slice(codeAt + CODE_TOKEN.length), 10);
        flushPara(); closeList();
        if (!isNaN(id) && blocks[id] !== undefined) html.push(blocks[id]);
        continue;
      }
      var trimmed = line.trim();
      if (!trimmed) { flushPara(); closeList(); continue; }

      var h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (h) { flushPara(); closeList(); html.push('<p class="md-h">' + inlineFormat(h[2]) + '</p>'); continue; }

      if (/^(---|\*\*\*|___)$/.test(trimmed)) { flushPara(); closeList(); html.push('<hr class="md-hr">'); continue; }

      var q = /^&gt;\s?(.*)$/.exec(trimmed);
      if (q) { flushPara(); closeList(); html.push('<p class="md-q">' + inlineFormat(q[1]) + '</p>'); continue; }

      var ol = /^(\d{1,3})[.)]\s+(.*)$/.exec(trimmed);
      if (ol) {
        flushPara();
        if (list !== 'ol') { closeList(); html.push('<ol class="md-list">'); list = 'ol'; }
        html.push('<li>' + inlineFormat(ol[2]) + '</li>');
        continue;
      }
      var ul = /^[-*+•]\s+(.*)$/.exec(trimmed);
      if (ul) {
        flushPara();
        if (list !== 'ul') { closeList(); html.push('<ul class="md-list">'); list = 'ul'; }
        html.push('<li>' + inlineFormat(ul[1]) + '</li>');
        continue;
      }

      closeList();
      para.push(trimmed);
    }
    flushPara(); closeList();

    var out = html.join('');
    // drop the wrapper <p> when the whole message is a single paragraph
    return out;
  }

  /** Plain-text version of a markdown answer (for the Copy button). */
  function markdownToText(src) {
    var s = String(src == null ? '' : src);
    s = s.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g, function (_m, _l, code) { return '\n' + code.replace(/\n$/, '') + '\n'; });
    s = texToPlain(s);
    s = s.replace(/`([^`\n]+)`/g, '$1')
         .replace(/\*\*([^*\n]+)\*\*/g, '$1')
         .replace(/__([^_\n]+)__/g, '$1')
         .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
         .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1$2')
         .replace(/~~([^~\n]+)~~/g, '$1')
         .replace(/^(#{1,6})\s+/gm, '')
         .replace(/^[-*+•]\s+/gm, '• ')
         .replace(/^\s*>\s?/gm, '')
         .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  return {
    // config
    OFFICIAL_BASE_URL: OFFICIAL_BASE_URL,
    API_VERSION: API_VERSION,
    DEFAULT_MODEL: DEFAULT_MODEL,
    FALLBACK_MODELS: FALLBACK_MODELS,
    LIMITS: LIMITS,
    TIMING: TIMING,
    SYSTEM_INSTRUCTION: SYSTEM_INSTRUCTION,
    FRIENDLY: FRIENDLY,

    // errors
    AiError: AiError,
    classify: classify,
    friendly: friendly,
    isRetryableKind: function (k) { return !NON_RETRYABLE_KINDS[k]; },
    isCredentialFailure: isCredentialFailure,

    // keys
    looksLikeKey: looksLikeKey,
    redact: redact,

    // gemini protocol
    buildContents: buildContents,
    buildRequestBody: buildRequestBody,
    streamUrl: streamUrl,
    generateUrl: generateUrl,
    SseParser: SseParser,
    extractText: extractText,
    finishReasonOf: finishReasonOf,
    blockReasonOf: blockReasonOf,
    computeBackoff: computeBackoff,
    normalizeModels: normalizeModels,

    // service
    streamChat: streamChat,
    streamViaProxy: streamViaProxy,
    testConnection: testConnection,
    listModels: listModels,
    resolveModels: resolveModels,
    chatCapable: chatCapable,

    // presentation
    renderMarkdown: renderMarkdown,
    markdownToText: markdownToText,
    texToPlain: texToPlain,
    escapeHtml: escapeHtml
  };
});
