// Preload script for the DeepSeek desktop app.
//
// IMPORTANT: this runs in a *sandboxed* preload context, so it must be
// CommonJS. ESM `import` statements are not supported there and fail with
// "Cannot use import statement outside a module".
//
// Feature: in-conversation search ("Ctrl + F").
//   - The main process forwards shortcuts over IPC (dsl-find:* channels).
//   - The toolbar UI lives in a shadow root appended to the page, so the
//     remote app's CSS cannot leak into it (and vice versa).
//   - Search runs over the conversation list only (not the sidebar), and
//     matches are highlighted with the CSS Custom Highlight API, which does
//     not mutate the DOM (safe with React's reconciliation).

const { ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_TOGGLE = 'dsl-find:toggle';
const CHANNEL_STEP = 'dsl-find:step';
const CHANNEL_RESET = 'dsl-find:reset';

const HIGHLIGHT_ALL = 'dsl-find-all';
const HIGHLIGHT_ACTIVE = 'dsl-find-active';
const HIGHLIGHT_STYLE_ID = 'dsl-find-highlight-style';

const HOST_ID = 'dsl-find-bar-host';

// Single character inserted into the text stream at block/message boundaries.
// Queries come from a one-line input, so they can never contain it, which
// prevents a match from ever spanning two messages or paragraphs.
const SENTINEL = '\u0000';

const DEBOUNCE_SEARCH_MS = 140;
const DEBOUNCE_MUTATION_MS = 350;
// After an explicit jump we keep re-centering the active match when content
// shifts (infinite scroll loads older messages above the viewport), but only
// for a short settle window so we never fight the user's own scrolling.
const JUMP_SETTLE_MS = 5000;
const MAX_HIGHLIGHT_RANGES = 2000;
const MAX_MATCHES = 20000;
const PREFILL_MAX_LENGTH = 80;

const BLOCKISH_DISPLAYS = new Set([
  'inline',
  'contents',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'ruby',
]);

const MUTATION_OPTIONS = { childList: true, subtree: true, characterData: true };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  visible: false,
  matchCase: false,
  matches: [], // DOM Range[] for the current query, in document order
  activeIdx: -1,
  scope: null, // conversation element the search runs over
  chunks: null, // { node | null, text }[] pieces of the text stream
  chunkStarts: null, // stream offset where each chunk begins
  dirty: false, // page mutated since the last stream build
  pendingJumpUntil: 0, // see JUMP_SETTLE_MS
  restoreFocus: null, // element focused before the bar was opened
  searchTimer: null,
  observer: null, // watches the conversation for content changes
  themeObserver: null, // watches <body>/<html> for theme class changes
};

// Lazily created toolbar (see ensureUI).
let ui = null;

function logError(err) {
  console.error('[deepseek-linux:find]', err);
}

function guard(fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      logError(err);
    }
  };
}

function supportsHighlights() {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.highlights !== 'undefined' &&
    typeof Highlight !== 'undefined'
  );
}

// ---------------------------------------------------------------------------
// Toolbar UI (shadow DOM)
// ---------------------------------------------------------------------------

const FIND_STYLES = `
:host([data-theme='dark']) {
  --bg: #2b2b30;
  --fg: #e8e8ec;
  --muted: #97979f;
  --border: rgba(255, 255, 255, 0.16);
  --hover: rgba(255, 255, 255, 0.1);
  --checked: rgba(255, 255, 255, 0.18);
  --none: #ff7b7b;
  --focus: #6aa5ff;
}
:host([data-theme='light']) {
  --bg: #ffffff;
  --fg: #1b1b1f;
  --muted: #6f6f78;
  --border: rgba(0, 0, 0, 0.16);
  --hover: rgba(0, 0, 0, 0.07);
  --checked: rgba(0, 0, 0, 0.12);
  --none: #d93025;
  --focus: #1a73e8;
}
:host {
  color-scheme: light dark;
}
.bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 4px 6px 4px 10px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
}
input {
  box-sizing: border-box;
  width: 224px;
  padding: 4px 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  -webkit-user-select: text;
  user-select: text;
}
input::placeholder {
  color: var(--muted);
}
.counter {
  min-width: 46px;
  padding: 0 4px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.counter.is-empty {
  visibility: hidden;
}
.counter.is-none {
  color: var(--none);
}
.sep {
  width: 1px;
  align-self: stretch;
  margin: 2px 1px;
  background: var(--border);
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn:hover {
  background: var(--hover);
}
.btn:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.btn.is-on {
  background: var(--checked);
}
.btn.is-case {
  width: 30px;
  letter-spacing: 0.3px;
}
.btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
`;

const FIND_TEMPLATE = `
<div class="bar" role="search">
  <input
    type="text"
    placeholder="Find in conversation"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    aria-label="Find in conversation"
  />
  <span class="counter is-empty" aria-live="polite" aria-atomic="true"></span>
  <span class="sep" aria-hidden="true"></span>
  <button type="button" class="btn is-case" aria-pressed="false"
          title="Match case" aria-label="Match case">Aa</button>
  <button type="button" class="btn" data-action="prev"
          title="Previous match (Shift+Enter)" aria-label="Previous match">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10l5-5 5 5"/></svg>
  </button>
  <button type="button" class="btn" data-action="next"
          title="Next match (Enter)" aria-label="Next match">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>
  </button>
  <button type="button" class="btn" data-action="close"
          title="Close (Esc)" aria-label="Close">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
  </button>
</div>
`;

function ensureUI() {
  if (ui) return ui;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Inline styles so no page rule can affect the host's geometry.
  host.style.cssText =
    'all: initial; position: fixed; top: 10px; right: 14px;' +
    'z-index: 2147483647; display: none;';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${FIND_STYLES}</style>${FIND_TEMPLATE}`;

  const bar = shadow.querySelector('.bar');
  const input = shadow.querySelector('input');
  const counter = shadow.querySelector('.counter');
  const caseBtn = shadow.querySelector('.btn.is-case');
  const prevBtn = shadow.querySelector('[data-action="prev"]');
  const nextBtn = shadow.querySelector('[data-action="next"]');
  const closeBtn = shadow.querySelector('[data-action="close"]');

  // Keep focus in the query field when clicking the bar (except the input
  // itself, where normal selection behaviour must keep working).
  bar.addEventListener('mousedown', (e) => {
    if (e.composedPath().includes(input)) return;
    e.preventDefault();
  });

  input.addEventListener(
    'input',
    guard(() => scheduleSearch(DEBOUNCE_SEARCH_MS, { jump: true, fresh: true }))
  );

  caseBtn.addEventListener('click', guard(toggleMatchCase));
  prevBtn.addEventListener('click', guard(() => step(false)));
  nextBtn.addEventListener('click', guard(() => step(true)));
  closeBtn.addEventListener('click', guard(closeBar));

  document.body.appendChild(host);

  ui = { host, bar, input, counter, caseBtn };
  return ui;
}

// ---------------------------------------------------------------------------
// Theme detection (works with both OS preference and DeepSeek's own toggle)
// ---------------------------------------------------------------------------

function parseColor(str) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(
    str || ''
  );
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (alpha < 0.05) return null;
  return { r: +m[1], g: +m[2], b: +m[3] };
}

function bgLuminance(el) {
  if (!el) return null;
  const c = parseColor(getComputedStyle(el).backgroundColor);
  if (!c) return null;
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function applyTheme() {
  if (!ui) return;
  const lum =
    bgLuminance(document.body) ?? bgLuminance(document.documentElement);
  let dark;
  if (lum !== null) {
    dark = lum < 140;
  } else {
    const classes = `${document.body?.className || ''} ${document.documentElement?.className || ''}`;
    dark = /\bdark\b/.test(classes);
  }
  ui.host.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function startThemeObserver() {
  stopThemeObserver();
  const obs = new MutationObserver(
    guard(() => {
      if (state.visible) applyTheme();
    })
  );
  obs.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  state.themeObserver = obs;
}

function stopThemeObserver() {
  if (state.themeObserver) {
    state.themeObserver.disconnect();
    state.themeObserver = null;
  }
}

// ---------------------------------------------------------------------------
// Search scope discovery
//
// chat.deepseek.com is a remote SPA; we do not depend on hashed class names.
// The conversation list is the design-system element ".ds-virtual-list" that
// actually contains messages. Fallbacks keep the feature usable when the
// layout changes or the conversation is still empty.
// ---------------------------------------------------------------------------

function inFindHost(el) {
  return Boolean(ui && ui.host && (el === ui.host || ui.host.contains(el)));
}

function resolveScope() {
  // 1. The virtualized conversation list (only the one containing messages;
  //    other UI popups reuse the same design-system class).
  const lists = document.querySelectorAll('.ds-virtual-list');
  for (const list of lists) {
    if (!inFindHost(list) && list.querySelector('.ds-message')) return list;
  }

  // 2. Any message element -> nearest scroll/list container.
  const msg = document.querySelector('.ds-message');
  if (msg) return msg.closest('.ds-scroll-area') || msg.parentElement;

  // 3. Empty conversation: the main column, via the message composer's
  //    ancestor chain (skips the left sidebar, which sits further left).
  const composer = document.querySelector(
    'textarea, [contenteditable]:not([contenteditable="false"])'
  );
  if (composer) {
    const minLeft = Math.max(40, window.innerWidth * 0.08);
    let el = composer.parentElement;
    let chosen = null;
    while (el && el !== document.body && el !== document.documentElement) {
      const r = el.getBoundingClientRect();
      if (r.left > minLeft && r.width > window.innerWidth * 0.45) chosen = el;
      el = el.parentElement;
    }
    if (chosen) return chosen;
  }

  // 4. Last resort: the whole page (hidden subtrees are still filtered out).
  return document.body;
}

function ensureScope() {
  if (state.scope && document.contains(state.scope)) return;
  const hadScope = Boolean(state.scope);
  state.scope = resolveScope();
  if (hadScope) state.dirty = true; // different element -> rebuild the stream
  attachMutationObserver();
}

// ---------------------------------------------------------------------------
// Live refresh: keep highlights in sync with streaming replies and with
// older messages that get mounted while the user scrolls up.
// ---------------------------------------------------------------------------

function onDomMutation() {
  state.dirty = true;
  scheduleSearch(DEBOUNCE_MUTATION_MS, { jump: false, fresh: false });
}

function attachMutationObserver() {
  if (!state.visible || !state.scope) return;
  if (!state.observer) state.observer = new MutationObserver(onDomMutation);
  state.observer.disconnect();
  state.observer.observe(state.scope, MUTATION_OPTIONS);
}

function stopMutationObserver() {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
}

function scheduleSearch(delay, opts) {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(
    guard(() => {
      state.searchTimer = null;
      rebuild(opts);
    }),
    delay
  );
}

// ---------------------------------------------------------------------------
// Text stream construction
//
// The conversation is flattened into a single string with a position map so
// a query can match text spanning adjacent inline nodes (e.g. markdown
// emphasis), while a NUL sentinel at every block boundary prevents matches
// from ever spanning two messages/paragraphs.
// ---------------------------------------------------------------------------

function acceptTextNode(node) {
  const el = node.parentElement;
  if (!el) return false;
  if (inFindHost(el)) return false;
  const tag = el.nodeName;
  if (
    tag === 'SCRIPT' ||
    tag === 'STYLE' ||
    tag === 'NOSCRIPT' ||
    tag === 'TEMPLATE' ||
    tag === 'TEXTAREA' ||
    tag === 'INPUT' ||
    tag === 'OPTION'
  ) {
    return false;
  }
  const editable = el.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') {
    return false; // never search the message composer
  }
  if (el.closest('[aria-hidden="true"]')) return false;
  if (typeof el.checkVisibility === 'function') {
    const hidden = !el.checkVisibility({
      // Support both the current and the legacy option names.
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
    if (hidden) return false;
  }
  return true;
}

function makeDisplayGetter(cache) {
  return (el) => {
    let d = cache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el).display;
      cache.set(el, d);
    }
    return d;
  };
}

// True when a block-level box separates prevEl from nextEl in document order.
function hasBlockBoundary(prevEl, nextEl, root, getDisplay) {
  const pathFrom = (el) => {
    const out = [];
    let cur = el;
    while (cur) {
      out.push(cur);
      if (cur === root) break;
      cur = cur.parentElement;
    }
    return out;
  };
  const a = pathFrom(prevEl);
  const b = pathFrom(nextEl);

  let common = null;
  let ia = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i].contains(nextEl)) {
      common = a[i];
      ia = i;
      break;
    }
  }
  if (!common) return true; // unrelated trees -> be safe, separate them

  const ib = b.indexOf(common);
  if (ib === -1) return true;

  for (let i = 0; i < ia; i++) {
    if (!BLOCKISH_DISPLAYS.has(getDisplay(a[i]))) return true;
  }
  for (let i = 0; i < ib; i++) {
    if (!BLOCKISH_DISPLAYS.has(getDisplay(b[i]))) return true;
  }
  return false;
}

function buildChunks(root) {
  const chunks = [];
  const starts = [];
  const displayCache = new Map();
  const getDisplay = makeDisplayGetter(displayCache);
  let streamLen = 0;
  let prevParent = null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.data && acceptTextNode(node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });

  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (
      prevParent &&
      hasBlockBoundary(prevParent, parent, root, getDisplay)
    ) {
      starts.push(streamLen);
      chunks.push({ node: null, text: SENTINEL });
      streamLen += SENTINEL.length;
    }
    starts.push(streamLen);
    chunks.push({ node, text: node.data });
    streamLen += node.data.length;
    prevParent = parent;
  }

  state.chunks = chunks;
  state.chunkStarts = starts;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Map a stream offset to { node, offset } inside the text node that owns it.
function locate(offset, preferEnd) {
  const starts = state.chunkStarts;
  const chunks = state.chunks;
  if (!chunks.length) return null;

  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }

  // Landed on a sentinel (only possible for an end offset sitting right
  // before a block boundary): resolve to the adjacent real text node.
  if (!chunks[lo].node) {
    if (preferEnd) {
      while (lo > 0 && !chunks[lo].node) lo--;
      if (!chunks[lo].node) return null;
      return { node: chunks[lo].node, offset: chunks[lo].text.length };
    }
    while (lo < chunks.length - 1 && !chunks[lo].node) lo++;
    if (!chunks[lo].node) return null;
    return { node: chunks[lo].node, offset: 0 };
  }

  return { node: chunks[lo].node, offset: offset - starts[lo] };
}

function makeRange(startOffset, endOffset) {
  const s = locate(startOffset, false);
  const e = locate(endOffset, true);
  if (!s || !e) return null;
  try {
    const range = new Range();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  } catch {
    return null; // nodes detached between mutations
  }
}

function computeMatches(query) {
  if (!query || !state.chunks || !state.chunks.length) return [];
  const stream = state.chunks.map((c) => c.text).join('');
  let re;
  try {
    re = new RegExp(escapeRegExp(query), state.matchCase ? 'g' : 'gi');
  } catch {
    return [];
  }
  const out = [];
  let m;
  while ((m = re.exec(stream)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const range = makeRange(m.index, m.index + m[0].length);
    if (range) out.push(range);
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Highlight rendering (CSS Custom Highlight API -- zero DOM mutation)
// ---------------------------------------------------------------------------

function ensureHighlightStyles() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent =
    `::highlight(${HIGHLIGHT_ALL}){background:rgba(255,187,64,.55);}` +
    `::highlight(${HIGHLIGHT_ACTIVE}){background:#ff8b2e;color:#151517;}`;
  (document.head || document.documentElement).appendChild(style);
}

function renderHighlights() {
  if (!supportsHighlights()) return;
  const paintable =
    state.matches.length > MAX_HIGHLIGHT_RANGES
      ? state.matches.slice(0, MAX_HIGHLIGHT_RANGES)
      : state.matches;
  CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...paintable));
  const active = state.activeIdx >= 0 ? state.matches[state.activeIdx] : null;
  if (active) {
    CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(active));
  } else {
    CSS.highlights.delete(HIGHLIGHT_ACTIVE);
  }
}

function clearHighlights() {
  if (!supportsHighlights()) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_ACTIVE);
}

function updateCounter() {
  if (!ui) return;
  const { counter } = ui;
  const query = ui.input.value;
  if (!query) {
    counter.textContent = '';
    counter.className = 'counter is-empty';
  } else if (!state.matches.length) {
    counter.textContent = 'No results';
    counter.className = 'counter is-none';
  } else {
    counter.textContent = `${state.activeIdx + 1}/${state.matches.length}`;
    counter.className = 'counter';
  }
}

// ---------------------------------------------------------------------------
// Jumping to matches
// ---------------------------------------------------------------------------

// Nearest ancestor (optionally including el itself) that scrolls vertically.
function findScrollable(el, includeSelf) {
  let cur = includeSelf ? el : el.parentElement;
  while (cur && cur !== document.documentElement) {
    if (cur.scrollHeight > cur.clientHeight + 2) {
      const overflowY = getComputedStyle(cur).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        return cur;
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

function viewRectFor(scope) {
  const scroller = findScrollable(scope, true);
  if (scroller) return scroller.getBoundingClientRect();
  return { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
}

function jumpToActive() {
  const range = state.matches[state.activeIdx];
  if (!range) return;

  let rect;
  try {
    rect = range.getBoundingClientRect();
  } catch {
    return;
  }
  // Detached/stale ranges collapse to an all-zero box.
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) return;

  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
  const scroller = startEl ? findScrollable(startEl, false) : null;

  const margin = 6;
  if (scroller) {
    const view = scroller.getBoundingClientRect();
    if (rect.top < view.top + margin || rect.bottom > view.bottom - margin) {
      scroller.scrollTop +=
        rect.top - view.top - Math.max(0, (view.height - rect.height) / 2);
    }
    if (rect.left < view.left + margin || rect.right > view.right - margin) {
      scroller.scrollLeft +=
        rect.left - view.left - Math.max(0, (view.width - rect.width) / 2);
    }
    return;
  }

  // No scrollable ancestor: fall back to the document itself.
  const doc = document.scrollingElement || document.documentElement;
  if (rect.top < margin || rect.bottom > window.innerHeight - margin) {
    doc.scrollTop +=
      rect.top - Math.max(0, (window.innerHeight - rect.height) / 2);
  }
}

// Index of the match closest to the current viewport (used for new queries,
// mirroring how browsers land on the nearest result instead of the first).
function pickNearestIdx() {
  if (!state.matches.length) return -1;
  const view = viewRectFor(state.scope || document.body);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < state.matches.length; i++) {
    let b;
    try {
      b = state.matches[i].getBoundingClientRect();
    } catch {
      continue;
    }
    const dist =
      b.bottom < view.top
        ? view.top - b.bottom
        : b.top > view.bottom
          ? b.top - view.bottom
          : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Jump intent: tracks that the user explicitly asked to move to a match, so
// content shifts caused by that very jump can be corrected (see rebuild()).
// ---------------------------------------------------------------------------

function markJumpIntent() {
  state.pendingJumpUntil = Date.now() + JUMP_SETTLE_MS;
}

function clearJumpIntent() {
  state.pendingJumpUntil = 0;
}

function isMatchInView(range) {
  if (!range) return false;
  let rect;
  try {
    rect = range.getBoundingClientRect();
  } catch {
    return false;
  }
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
    return false;
  }
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
  const scroller = startEl ? findScrollable(startEl, false) : null;
  const view = scroller
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight };
  const margin = 6;
  return rect.top >= view.top + margin && rect.bottom <= view.bottom - margin;
}

// ---------------------------------------------------------------------------
// Search orchestration
// ---------------------------------------------------------------------------

// Rebuild the stream (if needed) and (re)compute matches.
//   jump:  scroll to the selected match
//   fresh: choose the match nearest to the viewport (new/changed query)
function rebuild({ jump = false, fresh = false } = {}) {
  if (!ui) return;
  if (jump) markJumpIntent();
  if (state.dirty || !state.chunks) {
    ensureScope();
    state.dirty = false;
    if (state.scope) {
      buildChunks(state.scope);
    } else {
      state.chunks = null;
      state.chunkStarts = null;
    }
  }

  const query = ui.input.value;
  state.matches = computeMatches(query);

  if (!state.matches.length) {
    state.activeIdx = -1;
  } else if (fresh) {
    state.activeIdx = pickNearestIdx();
  } else if (state.activeIdx < 0) {
    state.activeIdx = 0;
  } else if (state.activeIdx >= state.matches.length) {
    state.activeIdx = state.matches.length - 1;
  }

  renderHighlights();
  updateCounter();
  if (state.activeIdx >= 0) {
    if (jump) {
      jumpToActive();
    } else if (
      Date.now() < state.pendingJumpUntil &&
      !isMatchInView(state.matches[state.activeIdx])
    ) {
      // Content shifted under the active match right after a jump (older
      // history mounted above); re-center it once more.
      jumpToActive();
    }
  }
}

function renderActive({ jump }) {
  renderHighlights();
  updateCounter();
  if (jump) jumpToActive();
}

function step(forward) {
  if (!state.visible || !ui) return;
  if (state.dirty) rebuild({ jump: false, fresh: false });
  const n = state.matches.length;
  if (!n) return;
  if (state.activeIdx < 0) {
    state.activeIdx = forward ? 0 : n - 1;
  } else {
    state.activeIdx = (state.activeIdx + (forward ? 1 : -1) + n) % n;
  }
  markJumpIntent();
  renderActive({ jump: true });
}

function toggleMatchCase() {
  if (!ui) return;
  state.matchCase = !state.matchCase;
  ui.caseBtn.setAttribute('aria-pressed', String(state.matchCase));
  ui.caseBtn.classList.toggle('is-on', state.matchCase);
  state.dirty = true; // stream is unchanged, but force a clean recompute
  scheduleSearch(0, { jump: true, fresh: true });
}

function captureRestoreFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || inFindHost(el)) return null;
  return el;
}

function show() {
  ensureUI();
  ensureHighlightStyles();

  const firstOpen = !state.visible;
  if (firstOpen) {
    // Prefill from the page's current selection (like Firefox), but only
    // when there is no previous query to restore.
    if (!ui.input.value) {
      const sel = String(window.getSelection() || '');
      if (sel.length > 0 && sel.length <= PREFILL_MAX_LENGTH) {
        ui.input.value = sel;
      }
    }
    state.restoreFocus = captureRestoreFocus();
    state.visible = true;
    ui.host.style.display = 'block';
    applyTheme();
    startThemeObserver();
  }

  ensureScope();
  attachMutationObserver();
  ui.input.focus();
  ui.input.select();
  rebuild({ jump: true, fresh: true });
}

function closeBar() {
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
  stopMutationObserver();
  stopThemeObserver();
  clearHighlights();
  if (ui) ui.host.style.display = 'none';

  if (state.visible && state.restoreFocus) {
    try {
      state.restoreFocus.focus({ preventScroll: true });
    } catch {
      // The previous element may have been removed by the page.
    }
  }
  state.visible = false;
  state.restoreFocus = null;
  state.dirty = false;
  // The stream references the conversation's nodes; drop it so the next
  // open always rebuilds against whatever is on screen by then.
  state.chunks = null;
  state.chunkStarts = null;
  clearJumpIntent();
  // The query is intentionally kept so Ctrl+F can restore it later.
}

// Ctrl+F: open the bar; when it is already open, re-focus the field (or
// select its text) instead of closing -- closing happens via Esc / the X.
function toggle() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', guard(toggle), {
      once: true,
    });
    return;
  }
  if (!state.visible) {
    show();
    return;
  }
  if (ui.host.contains(document.activeElement)) {
    ui.input.select();
  } else {
    ui.input.focus();
    ui.input.select();
  }
}

function reset() {
  closeBar();
}

// ---------------------------------------------------------------------------
// Keyboard handling
//
// Registered (capture phase) before any page script runs, so for keys we
// handle inside the bar this listener fires first and can stop the event
// from ever reaching DeepSeek's own document-level handlers.
//
// Ctrl+F / F3 / Ctrl+G never reach the DOM at all: the main process intercepts
// them in `before-input-event` and forwards them over IPC.
// ---------------------------------------------------------------------------

window.addEventListener(
  'keydown',
  (e) => {
    if (!state.visible || !ui) return;
    if (!e.composedPath().includes(ui.host)) return;
    if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeBar();
    }
  },
  true
);

// If the user scrolls on their own, stop re-centering the active match.
window.addEventListener('wheel', clearJumpIntent, { passive: true });
window.addEventListener('touchmove', clearJumpIntent, { passive: true });

// ---------------------------------------------------------------------------
// IPC (main -> renderer only; no ipcMain handlers are required)
// ---------------------------------------------------------------------------

ipcRenderer.on(CHANNEL_TOGGLE, guard(toggle));
ipcRenderer.on(CHANNEL_STEP, (_event, payload) => {
  step(Boolean(!payload || payload.forward !== false));
});
ipcRenderer.on(CHANNEL_RESET, guard(reset));
