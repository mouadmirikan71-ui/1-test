/**
 * TEST HARNESS ONLY — a deliberately small DOM shim so the REAL inline script
 * from index.html can be executed in Node and driven like a user would.
 *
 * It is not a browser and makes no claim to be one; it implements just enough
 * of the DOM for this app's code paths (element tree, ids/classes, events,
 * innerHTML, localStorage, fetch, rAF).
 */

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'use', 'circle', 'path', 'rect', 'stop', 'ellipse', 'source']);

function parseAttrs(str) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1].toLowerCase()] = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
  }
  return attrs;
}

let uid = 0;

class ClassList {
  constructor(el) { this.el = el; }
  get _set() {
    return new Set(String(this.el.attrs.class || '').split(/\s+/).filter(Boolean));
  }
  _write(s) { this.el.attrs.class = [...s].join(' '); }
  add(...c) { const s = this._set; c.forEach((x) => x && s.add(x)); this._write(s); }
  remove(...c) { const s = this._set; c.forEach((x) => s.delete(x)); this._write(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const s = this._set;
    const on = force === undefined ? !s.has(c) : !!force;
    if (on) s.add(c); else s.delete(c);
    this._write(s);
    return on;
  }
}

class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.tag = String(tag).toLowerCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    for (const k of Object.keys(attrs)) {
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
    }
    this._text = '';
    this.listeners = {};
    this.classList = new ClassList(this);
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 600;
    this.offsetWidth = 100;
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.type = this.attrs.type || '';
    if (this.tag === 'input' && this.attrs.id) this.value = '';
    this._uid = ++uid;
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }

  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.children.indexOf(ref) : -1;
    c.parentNode = this;
    if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i !== -1) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  setAttribute(k, v) {
    this.attrs[String(k).toLowerCase()] = String(v);
    if (k === 'class') { /* keep classList in sync via attrs */ }
    if (String(k).startsWith('data-')) {
      this.dataset[String(k).slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    }
  }
  getAttribute(k) { const v = this.attrs[String(k).toLowerCase()]; return v === undefined ? null : v; }
  hasAttribute(k) { return String(k).toLowerCase() in this.attrs; }

  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }

  set innerHTML(v) {
    this.children = [];
    this._text = '';
    const nodes = parseHtml(String(v));
    nodes.forEach((n) => this.appendChild(n));
  }
  get innerHTML() { return this.children.map(serialize).join(''); }

  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    if (!this.listeners[t]) return;
    this.listeners[t] = this.listeners[t].filter((f) => f !== fn);
  }
  dispatch(type, props = {}) {
    const ev = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() { ev._stopped = true; },
      ...props
    };
    let node = this;
    while (node) {
      ev.currentTarget = node;
      for (const fn of (node.listeners[type] || []).slice()) fn(ev);
      if (ev._stopped) break;
      node = node.parentNode;
    }
    return ev;
  }
  click() { this.dispatch('click'); }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const all = [];
    const walk = (n) => { n.children.forEach((c) => { all.push(c); walk(c); }); };
    walk(this);
    return matchSelector(all, sel);
  }
  closest(sel) {
    let n = this;
    while (n) { if (matchSelector([n], sel).length) return n; n = n.parentNode; }
    return null;
  }
  animate() { return { finished: Promise.resolve(), cancel() {} }; }
  scrollTo() {}
  focus() {}
  contains(n) {
    let cur = n;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  }
}

function serialize(n) {
  if (n instanceof TextNode) return n.textContent;
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  const inner = n._text || n.children.map(serialize).join('');
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

class TextNode {
  constructor(t) { this.textContent = t; this.children = []; this.parentNode = null; }
}

/** Tiny HTML parser: enough for this document and for innerHTML assignments. */
export function parseHtml(html) {
  const roots = [];
  const stack = [];
  const push = (n) => {
    if (stack.length) stack[stack.length - 1].appendChild(n);
    else roots.push(n);
  };
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) { // closing tag
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === m[1].toLowerCase()) { stack.length = i; break; }
      }
      continue;
    }
    if (m[2]) { // opening tag
      const el = new El(m[2], parseAttrs(m[3] || ''));
      push(el);
      const selfClosed = m[4] === '/' || VOID.has(el.tag);
      if (!selfClosed) stack.push(el);
      continue;
    }
    if (m[5] != null) {
      const t = m[5];
      if (t.trim() || stack.length) push(new TextNode(t));
    }
  }
  return roots;
}

/* ---------------- selector engine (tag, .class, #id, [attr], [a=b], descendant, comma) ---------------- */

function matchSimple(el, sel) {
  if (!(el instanceof El)) return false;
  const re = /([a-zA-Z0-9-]+)|\.([a-zA-Z0-9_-]+)|#([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9_-]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\]/g;
  let m;
  let matched = false;
  while ((m = re.exec(sel))) {
    matched = true;
    if (m[1] && el.tag !== m[1].toLowerCase()) return false;
    if (m[2] && !el.classList.contains(m[2])) return false;
    if (m[3] && el.id !== m[3]) return false;
    if (m[4]) {
      const v = el.getAttribute(m[4]);
      if (v === null) return false;
      if (m[5] && m[5].startsWith('=') && v !== m[6]) return false;
    }
  }
  return matched;
}

function matchSelector(elements, selector) {
  const out = [];
  const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  for (const g of groups) {
    const parts = g.split(/\s+/);
    for (const el of elements) {
      if (!matchSimple(el, parts[parts.length - 1])) continue;
      // walk ancestors for descendant combinators
      let ok = true;
      let node = el.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        let found = false;
        while (node) {
          if (node instanceof El && matchSimple(node, parts[i])) { found = true; node = node.parentNode; break; }
          node = node.parentNode;
        }
        if (!found) { ok = false; break; }
      }
      if (ok && !out.includes(el)) out.push(el);
    }
  }
  return out;
}

/* ---------------- window / document ---------------- */

export function createDom(html, opts = {}) {
  const roots = parseHtml(html);
  const body = roots.find((r) => r instanceof El && r.tag === 'body') || roots[0];
  const documentEl = roots.find((r) => r instanceof El && r.tag === 'html') || body;

  const all = [];
  (function walk(n) { (n.children || []).forEach((c) => { all.push(c); if (c.children) walk(c); }); })(documentEl);

  const store = new Map();
  const rafQueue = [];

  const document = {
    documentElement: documentEl,
    body,
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    getElementById(id) { return all.find((e) => e instanceof El && e.id === id) || null; },
    querySelector(sel) { return matchSelector(all, sel)[0] || null; },
    querySelectorAll(sel) { return matchSelector(all, sel); },
    addEventListener(t, fn) { (document._l[t] = document._l[t] || []).push(fn); },
    removeEventListener() {},
    execCommand: () => true,
    _l: {},
    dispatch(type, props = {}) {
      const ev = { type, target: body, currentTarget: document, preventDefault() {}, stopPropagation() {}, ...props };
      for (const fn of (document._l[type] || []).slice()) fn(ev);
      return ev;
    }
  };
  // re-scan when new nodes are appended
  const origAppend = El.prototype.appendChild;
  El.prototype.appendChild = function (c) {
    const r = origAppend.call(this, c);
    all.push(c);
    (function walk(n) { (n.children || []).forEach((x) => { all.push(x); walk(x); }); })(c);
    return r;
  };

  const timers = new Set();
  const window = {
    document,
    location: opts.location || { protocol: 'http:' },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    isSecureContext: true,
    addEventListener(t, fn) { (window._l[t] = window._l[t] || []).push(fn); },
    _l: {},
    dispatch(type, props = {}) {
      const ev = { type, preventDefault() {}, stopPropagation() {}, ...props };
      for (const fn of (window._l[type] || []).slice()) fn(ev);
    },
    navigator: {
      clipboard: { writeText: async (t) => { window.__copied = t; } }
    },
    performance: { now: () => Date.now() },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t; },
    clearTimeout: (t) => { timers.delete(t); clearTimeout(t); },
    requestAnimationFrame: (fn) => { const t = setTimeout(() => fn(Date.now()), 0); timers.add(t); return t; },
    cancelAnimationFrame: (t) => { timers.delete(t); clearTimeout(t); },
    AbortController: globalThis.AbortController,
    TextDecoder: globalThis.TextDecoder,
    fetch: opts.fetch || globalThis.fetch,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    },
    __store: store,
    __all: all,
    __rafQueue: rafQueue
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  return { window, document, El, TextNode };
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
