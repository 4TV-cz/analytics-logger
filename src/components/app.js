'use strict';

// One grid over the capture: a row per HTTP request (any traffic), with the
// analytics events the request carried (Mux, GA, mParticle …) expandable
// underneath it. Charles-style domain tree, full request/response detail,
// replay, rewrite, export; a Mux playback timeline below the grid.

// ── Persisted UI preferences ───────────────────────────────────────────────
// One blob for every view setting that should survive a reload. Saves are
// debounced because column and panel drags fire continuously.
// Shared by the restore guards and the drag clamps: if these disagree, a
// restored width can be narrower than one you are allowed to drag to.
const MIN_COL_WIDTH = 40;
const MIN_DETAIL_WIDTH = 280;
const UI_STATE_KEY = 'analyticsLogger.uiState';

const uiState = loadUiState();

function loadUiState() {
  const defaults = {
    hiddenColumns: [],
    columnWidths: {},
    detailWidth: null,
    sortBy: null,
    sortDir: 'asc',
    autoscroll: true,
    groupByDomain: false,
    theme: 'dark',
    timelineCollapsed: false,
    hiddenProviders: [],
    consoleHeight: null,
    consoleCollapsed: false,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
    return { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return defaults;
  }
}

let saveUiTimer = null;
function saveUiState() {
  clearTimeout(saveUiTimer);
  saveUiTimer = setTimeout(() => {
    try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState)); } catch {}
  }, 200);
}

// The stylesheet keys every colour off this attribute; dark is the absence of
// it. The same value is read by the inline script in index.html so the theme is
// in place before first paint.
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

function setTheme(theme, { persist = true } = {}) {
  applyTheme(theme);
  if (persist) {
    uiState.theme = theme === 'light' ? 'light' : 'dark';
    saveUiState();
  }
}

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const rowsEl = $('rows');
const headColsEl = $('head-cols');
const headRowEl = $('head-row');
const gridEl = $('grid');
const emptyEl = $('empty');
const toastEl = $('toast');
const detailEl = $('detail');
const detailBodyEl = $('detail-body');
const detailTitleEl = $('detail-title');
const detailModeEl = $('detail-mode');
const searchHitsEl = $('search-hits');
const statRequestsEl = $('stat-requests');
const statEventsEl = $('stat-events');
const statShownEl = $('stat-shown');
const statDomainsEl = $('stat-domains');
const statSizeEl = $('stat-size');
const statRewritesEl = $('stat-rewrites');
const statRewritesItemEl = $('stat-rewrites-item');
const statRewritesSepEl = $('stat-rewrites-sep');
const autoscrollEl = $('autoscroll');
const groupByDomainEl = $('group-by-domain');
const expandCollapseAllBtn = $('expand-collapse-all');
const filterEl = $('filter');
const providerBtnEl = $('provider-btn');
const providerMenuEl = $('provider-menu');
const deepSearchEl = $('deep-search');
const deepSearchClearEl = $('deep-search-clear');
const deepSearchBadgeEl = $('deep-search-badge');
const clearBtn = $('clear');
const configBtn = $('config-btn');
const configModalEl = $('config-modal');
const cfgPortEl = $('cfg-port');
const cfgUrlPrefixEl = $('cfg-url-prefix');
const cfgRoutesEl = $('cfg-routes');
const cfgClearViewPatternEl = $('cfg-clear-view-pattern');
const cfgClearViewUrlEl = $('cfg-clear-view-url');
const cfgRewriteResponseUrlsEl = $('cfg-rewrite-response-urls');
const cfgRewriteM3u8UrlsEl = $('cfg-rewrite-m3u8-urls');
const cfgMaxLogFilesEl = $('cfg-max-log-files');
const cfgMaxLogMbEl = $('cfg-max-log-mb');
const cfgThemeEl = $('cfg-theme');
const cfgErrorEl = $('cfg-error');
const confirmModalEl = $('confirm-modal');
const confirmTitleEl = $('confirm-title');
const confirmMessageEl = $('confirm-message');
const confirmOkBtn = $('confirm-ok');
const confirmCancelBtn = $('confirm-cancel');
const columnsModalEl = $('columns-modal');
const colContextMenuEl = $('col-context-menu');
const colListEl = $('col-list');
const colsErrorEl = $('cols-error');
const contextMenuEl = $('context-menu');
const detailCtxMenuEl = $('detail-context-menu');
const dcmCopyNameEl = $('dcm-copy-name');
const dcmCopyValueEl = $('dcm-copy-value');

// ── Small helpers ──────────────────────────────────────────────────────────

// Hoisted: this was allocating a fresh map object for every escaped character,
// and it runs once per cell per rendered row.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

function formatKB(bytes) {
  if (bytes == null) return '';
  return (bytes / 1024).toFixed(2);
}

function formatBytes(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// 24-hour wall clock, no milliseconds. One definition so every place that
// shows a time cannot drift in locale or format.
function formatClock(d) {
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return formatClock(d) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatMs(ms) {
  const d = new Date(ms);
  return formatClock(d) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function statusClass(s, err) {
  if (err) return 'status-err';
  if (s == null) return 'muted';
  return 'status-' + Math.floor(s / 100);
}

let toastTimer = null;
function showToast(message, kind = 'ok', sub = '') {
  toastEl.innerHTML = escapeHtml(message) + (sub ? '<div class="t-sub">' + escapeHtml(sub) + '</div>' : '');
  toastEl.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, sub ? 4000 : 1800);
}

let confirmResolver = null;

function confirmDialog({ title = 'Confirm', message = '', okText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
  confirmTitleEl.textContent = title;
  confirmMessageEl.textContent = message;
  confirmOkBtn.textContent = okText;
  confirmCancelBtn.textContent = cancelText;
  confirmOkBtn.classList.toggle('danger', !!danger);
  confirmOkBtn.classList.toggle('primary', !danger);
  confirmModalEl.classList.add('open');
  confirmOkBtn.focus();
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function closeConfirm(result) {
  confirmModalEl.classList.remove('open');
  const r = confirmResolver;
  confirmResolver = null;
  if (r) r(result);
}

confirmOkBtn.onclick = () => closeConfirm(true);
confirmCancelBtn.onclick = () => closeConfirm(false);
confirmModalEl.addEventListener('click', (e) => { if (e.target === confirmModalEl) closeConfirm(false); });

// The server rejects any non-GET without this header, so a cross-site form
// post cannot reconfigure or wipe the capture. Every mutating fetch uses it.
const UI_HEADER = { 'X-Proxy-UI': '1' };

async function call(path, method) {
  try {
    const r = await fetch(path, { method, headers: UI_HEADER });
    const j = await r.json().catch(() => ({}));
    if (j && typeof j.listening === 'boolean') applyState(j);
    return j;
  } catch (err) {
    console.error('control call failed', err);
  }
}

// ── Data ───────────────────────────────────────────────────────────────────
let allItems = [];          // request summaries, in arrival order
// Bumped by every change to allItems' membership. Derived caches (domain count,
// row models) key off it instead of re-deriving on every render.
let itemsVersion = 0;
let eventRows = [];         // decoded analytics events, in arrival order
const eventById = new Map();
let providers = [];         // [{id,label}] from the server, in display order
let columnsByProvider = {}; // provider id -> curated columns [{key,label,width,num,combo}]
let lastDiskBytes = null;

const eventsByFile = new Map(); // file -> that request's event rows
let selectedFile = null;
let selectedEventId = null;  // the event the timeline pointed at, if any
let selectedEntry = null;
// Which tab of the detail panel is showing: the request, or its decoded
// events. Remembered across row clicks.
let detailMode = 'request';

// ── Server state / switches ────────────────────────────────────────────────
let state = { listening: false, recording: true, forwarding: true, port: null };
let lastClearViewAt;   // undefined until the first state snapshot arrives

function setSwitch(id, on, label) {
  const sw = $(id);
  sw.classList.toggle('on', on);
  sw.classList.toggle('off', !on);
  sw.setAttribute('aria-checked', String(on));
  sw.querySelector('.switch-label').textContent = label;
}

function applyState(s) {
  if (!s) return;
  state = s;
  setSwitch('toggle-proxy', !!s.listening, s.listening ? `proxy :${s.port}` : 'proxy off');
  setSwitch('toggle-rec', !!s.recording, s.recording ? 'recording' : 'paused');
  setSwitch('toggle-fwd', !!s.forwarding, s.forwarding ? 'forwarding' : 'not forwarding');
  if (typeof s.diskBytes === 'number') lastDiskBytes = s.diskBytes;
  // undefined means "no snapshot seen yet", which is what distinguishes the
  // initial state push from a clear-view that just happened.
  if (lastClearViewAt === undefined) {
    lastClearViewAt = s.clearViewAt || null;
  } else if (s.clearViewAt && s.clearViewAt !== lastClearViewAt) {
    lastClearViewAt = s.clearViewAt;
    // The proxy has already deleted the log files; empty the views to match.
    resetCapture();
    showToast('Session cleared', 'ok', 'Logs deleted by a ' + (s.clearViewPattern || '/session/clear') + ' request');
  }
  updateStats();
}

$('toggle-proxy').onclick = () => call(state.listening ? '/api/proxy/stop' : '/api/proxy/start', 'POST');
$('toggle-rec').onclick = () => call(state.recording ? '/api/recording/stop' : '/api/recording/start', 'POST');
$('toggle-fwd').onclick = () => call(state.forwarding ? '/api/forwarding/stop' : '/api/forwarding/start', 'POST');

// One button for both halves of starting over: the capture on disk and what the
// views are showing.
clearBtn.onclick = async () => {
  const ok = await confirmDialog({
    title: 'Clear',
    message: 'Delete ALL log files from disk and empty the view? This cannot be undone.',
    okText: 'Clear',
    danger: true,
  });
  if (!ok) return;
  const j = await call('/api/logs/clear', 'POST');
  if (j && typeof j.deleted === 'number') resetCapture();
};

function resetCapture() {
  setItems([]);
  ingestEventRows([], true);
  closeDetail();
  renderView();
}

// ── Response rewrites ──────────────────────────────────────────────────────
// While a rule exists for a method+URL, the proxy answers those requests from a
// stored log entry instead of calling the upstream. The browser keeps the rule
// set so every matching row can be flagged, whenever it was captured.
let rewriteRules = new Map();       // key ("GET https://…") -> rule

function rewriteKeyFor(it) {
  const url = it.upstream || it.url || '';
  if (!url) return '';
  return String(it.method || 'GET').toUpperCase() + ' ' + url;
}

// Reports whether anything actually changed, so callers can skip a re-render.
function applyRewrites(items) {
  const next = new Map((items || []).map((r) => [r.key, r]));
  const before = [...rewriteRules.values()].map((r) => r.key + '|' + r.file).sort().join('\n');
  const after = [...next.values()].map((r) => r.key + '|' + r.file).sort().join('\n');
  rewriteRules = next;
  updateRewriteStat();
  return before !== after;
}

function updateRewriteStat() {
  const n = rewriteRules.size;
  statRewritesEl.textContent = n;
  statRewritesItemEl.style.display = n ? '' : 'none';
  statRewritesSepEl.style.display = n ? '' : 'none';
}

// Two different things worth saying, on the same chip: this response *was*
// served from a stored entry, or this URL *will be* on the next request. A
// third, unrelated one: forwarding was off and the proxy answered itself.
function rewriteFlagHtml(it) {
  if (it.forwarded === false) {
    return '<span class="nf-flag" title="Not forwarded: the proxy answered this request itself (forwarding was off)">NF</span>';
  }
  if (it.rewrittenFrom) {
    return '<span class="rw-flag served" title="Response served from ' + escapeHtml(it.rewrittenFrom) + ' instead of the upstream">RW</span>';
  }
  const rule = rewriteRules.get(rewriteKeyFor(it));
  if (!rule) return '';
  // Whether the served body is the captured one or a hand-edited one is worth
  // saying: it is the difference between a snapshot and a fixture.
  const source = allItems.find((x) => x.file === rule.file);
  const edited = source ? source.responseEdited : false;
  return '<span class="rw-flag" title="Rewritten: requests to this URL are answered from '
    + escapeHtml(rule.file) + (edited ? ' (edited body)' : '') + '">RW</span>';
}

// ── Filtering (shared) ─────────────────────────────────────────────────────
// Parsed form of the filter box. Supports three kinds of term, space separated:
//   foo        include — the row must contain "foo"
//   -foo       exclude — the row must NOT contain "foo"
//   /re/  -/re/  regex, optionally negated (trailing "i" flag allowed)
// A malformed regex is reported rather than silently matching nothing.
let filterTerms = [];
let filterError = '';
let deepSearchFiles = null;
let deepSearchQuery = '';

function parseFilter(raw) {
  const terms = [];
  let error = '';
  // Split on spaces that are not inside a /regex/.
  const tokens = raw.match(/(?:-?\/(?:\\.|[^/\\])*\/[a-z]*|\S+)/g) || [];
  for (const token of tokens) {
    const negate = token.startsWith('-');
    const value = negate ? token.slice(1) : token;
    if (!value) continue;
    const re = value.match(/^\/(.*)\/([a-z]*)$/);
    if (re) {
      try {
        // Always case-insensitive, matching how plain substring terms behave.
        terms.push({ negate, regex: new RegExp(re[1], 'i') });
      } catch (err) {
        error = 'bad regex: ' + err.message;
      }
    } else {
      terms.push({ negate, text: value.toLowerCase() });
    }
  }
  return { terms, error };
}

function setFilterText(raw) {
  const parsed = parseFilter(raw.trim());
  filterTerms = parsed.terms;
  filterError = parsed.error;
  filterEl.classList.toggle('invalid', !!filterError);
  filterEl.title = filterError || 'Space-separated terms. -term excludes, /regex/ matches.';
}

// `hay` is the original-case haystack, `hayLower` its lowercased twin.
function matchesTerms(hay, hayLower) {
  for (const term of filterTerms) {
    const hit = term.regex ? term.regex.test(hay) : hayLower.includes(term.text);
    if (hit === term.negate) return false;
  }
  return true;
}

// Debounced: each keystroke re-filters and re-renders the whole capture, so
// typing a word used to do that once per character.
let filterDebounce = null;
filterEl.addEventListener('input', () => {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => {
    setFilterText(filterEl.value);
    renderView();
  }, 120);
});
autoscrollEl.addEventListener('change', () => {
  uiState.autoscroll = autoscrollEl.checked;
  saveUiState();
});

// ── Deep search ────────────────────────────────────────────────────────────
deepSearchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runDeepSearch();
  else if (e.key === 'Escape') clearDeepSearch();
});
deepSearchClearEl.addEventListener('click', clearDeepSearch);

async function runDeepSearch() {
  const q = deepSearchEl.value.trim();
  if (!q) { clearDeepSearch(); return; }
  deepSearchBadgeEl.textContent = 'searching...';
  deepSearchBadgeEl.classList.remove('on', 'off');
  deepSearchBadgeEl.style.display = 'inline-flex';
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await r.json();
    deepSearchFiles = new Set(data.files);
    deepSearchQuery = q;
    deepSearchBadgeEl.textContent = 'search: "' + q + '" — ' + data.files.length + ' match' + (data.files.length === 1 ? '' : 'es') + (data.truncated ? ' (truncated)' : '') + ' [' + data.durationMs + 'ms]';
    deepSearchBadgeEl.classList.add('on');
    deepSearchClearEl.style.display = 'inline-block';
    // Jump straight to the first hit: expand the tree down to it if grouping is
    // on, then open it with the match highlighted in the body.
    const target = firstVisibleItem(allItems.filter(matchesFilters));
    if (target && groupByDomain) expandTreeToItem(target);
    renderView();
    if (target) revealItem(target, { forceJsonBody: true });
  } catch (err) {
    deepSearchBadgeEl.textContent = 'search failed';
    deepSearchBadgeEl.classList.add('off');
  }
}

function clearDeepSearch() {
  deepSearchFiles = null;
  deepSearchQuery = '';
  deepSearchEl.value = '';
  deepSearchClearEl.style.display = 'none';
  deepSearchBadgeEl.style.display = 'none';
  renderView();
}

// ═══════════════════════════════════════════════════════════════════════════
// The grid
// ═══════════════════════════════════════════════════════════════════════════

let sortBy = null;
let sortDir = 'asc';
let groupByDomain = false;
// Collapsed, not expanded: groups open by default, so a tree that has just been
// switched on shows its requests instead of a wall of folders — and a domain
// that turns up mid-capture opens too, rather than hiding new traffic behind a
// row nobody thought to click.
const collapsedGroups = new Set();

// Single source of truth for the table: the head, the colgroup and every row
// cell are generated from this list, so hiding a column just drops it here.
// `width: null` means the column takes the remaining space.
const COLUMNS = [
  { key: 'idx', label: '#', title: 'Arrival order', sort: 'idx', width: 55, num: true },
  { key: 'timestamp', label: 'Time', title: 'Time the request was received', sort: 'timestamp', width: 120 },
  { key: 'method', label: 'Method', title: 'HTTP method', sort: 'method', width: 80 },
  { key: 'status', label: 'Status', title: 'Response status code', sort: 'status', width: 75 },
  { key: 'provider', label: 'Provider', title: 'Analytics provider that decoded this request', sort: 'provider', width: 100 },
  { key: 'events', label: 'Events', title: 'Decoded analytics events in this request (open the row and pick the Events tab for their properties)', sort: 'events', width: 260 },
  { key: 'durationMs', label: 'ms', title: 'Upstream round-trip in milliseconds', sort: 'durationMs', width: 70, num: true },
  { key: 'reqBytes', label: 'Req (KB)', title: 'Request body size', sort: 'reqBytes', width: 90, num: true },
  { key: 'resBytes', label: 'Res (KB)', title: 'Response body size', sort: 'resBytes', width: 90, num: true },
  { key: 'url', label: 'URL', title: 'Upstream URL', sort: 'url', width: null },
];

const knownColumnKeys = new Set(COLUMNS.map((c) => c.key));
const hiddenColumns = new Set(
  Array.isArray(uiState.hiddenColumns) ? uiState.hiddenColumns.filter((k) => knownColumnKeys.has(k)) : []
);
// Restore any widths the user dragged to previously.
for (const col of COLUMNS) {
  const w = uiState.columnWidths?.[col.key];
  if (typeof w === 'number' && w >= MIN_COL_WIDTH) col.width = w;
}

function saveHiddenColumns() {
  uiState.hiddenColumns = [...hiddenColumns];
  saveUiState();
}

function visibleColumns() {
  return COLUMNS.filter((c) => !hiddenColumns.has(c.key));
}

function providerLabel(id) {
  return (providers.find((p) => p.id === id) || {}).label || id || '';
}

// Splits a URL into the pieces of a Charles-style structure tree:
// origin (scheme://host) -> one folder per intermediate path segment -> leaf.
// The leaf keeps the query string, e.g. "adjacent?size=20".
function splitTreePath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const origin = u.protocol + '//' + u.host;
    const rawPath = u.pathname || '/';
    const segs = rawPath.split('/').filter(Boolean);
    const search = u.search || '';
    // A path ending in "/" has no name of its own — the request sits directly
    // in the folder, shown as "/" the way Charles does.
    if (segs.length === 0 || rawPath.endsWith('/')) {
      return { origin, dirs: segs, leaf: '/' + search };
    }
    return { origin, dirs: segs.slice(0, -1), leaf: segs[segs.length - 1] + search };
  } catch {
    return { origin: '(no host)', dirs: [], leaf: rawUrl || '/' };
  }
}

function makeTreeNode(label, key) {
  return { label, key, items: [], children: new Map() };
}

// Children keep insertion (first-seen) order, matching Charles; leaves live on
// the folder that contains them, so identical paths stay as separate rows.
function buildDomainTree(items) {
  const root = makeTreeNode('', '');
  for (const it of items) {
    const { origin, dirs, leaf } = splitTreePath(it.upstream || it.url || '');
    it._leaf = leaf;
    let cur = root.children.get(origin);
    if (!cur) {
      cur = makeTreeNode(origin, origin);
      root.children.set(origin, cur);
    }
    for (const dir of dirs) {
      let child = cur.children.get(dir);
      if (!child) {
        child = makeTreeNode(dir, cur.key + '/' + dir);
        cur.children.set(dir, child);
      }
      cur = child;
    }
    cur.items.push(it);
  }
  return root;
}

// Count, most recent request, and distinct methods for a node's whole subtree.
// Memoised on the node: the tree is rebuilt each render, so entries cannot go
// stale, and scrolling redraws the same rows repeatedly.
function subtreeStats(node) {
  if (node.stats) return node.stats;
  let count = node.items.length;
  let latest = node.items.length ? node.items[node.items.length - 1] : null;
  const methods = new Set();
  for (const it of node.items) if (it.method) methods.add(it.method);

  for (const child of node.children.values()) {
    const s = subtreeStats(child);
    count += s.count;
    if (s.latest && (!latest || (s.latest.timestamp || '') > (latest.timestamp || ''))) latest = s.latest;
    for (const m of s.methods) methods.add(m);
  }
  node.stats = { count, latest, methods };
  return node.stats;
}

// Tree indentation lives in the URL column, not the narrow "#" column, so deep
// paths stay readable.
function treeIndentPx(depth) {
  return 6 + depth * 14;
}

// Aggregate cell for one folder row. `last` is the most recent request beneath it.
function groupCellHtml(col, node, depth, expanded, last, methodLabel, count) {
  switch (col.key) {
    case 'idx': return '<td class="muted num"></td>';
    case 'timestamp': return '<td>' + (last ? formatTime(last.timestamp) : '') + '</td>';
    case 'method': return '<td class="method muted">' + escapeHtml(methodLabel) + '</td>';
    case 'status': return '<td class="' + (last ? statusClass(last.status, last.error) : 'muted') + '">'
      + (last ? (last.error ? 'ERR' : (last.status ?? '')) : '') + '</td>';
    case 'provider': return '<td></td>';
    case 'events': return '<td></td>';
    case 'durationMs': return '<td class="num">' + (last && last.durationMs != null ? last.durationMs : '') + '</td>';
    case 'reqBytes': return '<td class="num">' + (last ? formatKB(last.reqBytes) : '') + '</td>';
    case 'resBytes': return '<td class="num">' + (last ? formatKB(last.resBytes) : '') + '</td>';
    case 'url': return '<td class="url" style="padding-left: ' + treeIndentPx(depth) + 'px" title="' + escapeHtml(node.key) + '">'
      + '<span class="chevron">' + (expanded ? '▼' : '▶') + '</span>'
      + escapeHtml(node.label)
      + '<span class="group-count">×' + count + '</span>'
      + '</td>';
  }
  return '<td></td>';
}

function groupRowHtml(node, depth, expanded, cols) {
  const { count, latest, methods } = subtreeStats(node);
  const methodLabel = methods.size === 0 ? '' : (methods.size === 1 ? [...methods][0] : (methods.size + ' methods'));
  const cls = 'group-row' + (depth === 0 ? ' host-row' : '');
  const cells = (cols || visibleColumns())
    .map((c) => groupCellHtml(c, node, depth, expanded, latest, methodLabel, count))
    .join('');
  return '<tr class="' + cls + '" data-group-key="' + escapeHtml(node.key) + '">' + cells + '</tr>';
}

// Pushes lightweight descriptors, not HTML: markup is built on demand for the
// rows actually on screen, so a huge capture costs one small object per row.
function emitTreeNode(node, depth, out) {
  const expanded = !collapsedGroups.has(node.key);
  out.push({ node, depth, expanded, file: null });
  if (!expanded) return;
  for (const child of node.children.values()) {
    emitTreeNode(child, depth + 1, out);
  }
  for (const it of sortItems(node.items)) {
    out.push({ item: it, indent: treeIndentPx(depth + 1), file: it.file });
  }
}

function topLevelTreeRoots(root) {
  return Array.from(root.children.values());
}

// Mirrors emitTreeNode's tree walk to collect every group key at every depth.
function collectAllGroupKeys(node, keys) {
  keys.add(node.key);
  for (const child of node.children.values()) collectAllGroupKeys(child, keys);
}

// First row as the user sees it — tree order when grouping, sort order when not.
function firstVisibleItem(filtered) {
  if (!filtered.length) return null;
  if (!groupByDomain) return sortItems(filtered)[0] || null;
  for (const node of topLevelTreeRoots(buildDomainTree(filtered))) {
    const found = firstLeafInTreeOrder(node);
    if (found) return found;
  }
  return null;
}

// Mirrors emitTreeNode: child folders before the folder's own leaves.
function firstLeafInTreeOrder(node) {
  for (const child of node.children.values()) {
    const found = firstLeafInTreeOrder(child);
    if (found) return found;
  }
  return sortItems(node.items)[0] || null;
}

// Re-opens every folder above an item, so a search hit is never left buried in
// a group the user had collapsed.
function expandTreeToItem(it) {
  const { origin, dirs } = splitTreePath(it.upstream || it.url || '');
  let key = origin;
  collapsedGroups.delete(key);
  for (const dir of dirs) {
    key += '/' + dir;
    collapsedGroups.delete(key);
  }
}

async function revealItem(it, opts) {
  const index = rowModels.findIndex((r) => r.file === it.file);
  if (index === -1) return;
  scrollToRowIndex(index, { center: true });
  renderWindow();
  const tr = [...rowsEl.querySelectorAll('tr[data-file]')].find((r) => r.dataset.file === it.file);
  await openDetail(it.file, tr, opts);
}

groupByDomainEl.addEventListener('change', () => {
  groupByDomain = groupByDomainEl.checked;
  uiState.groupByDomain = groupByDomain;
  saveUiState();
  collapsedGroups.clear();     // every switch-on starts fully expanded
  renderView();
});

// Derived once per item, when it enters the list. Recomputing this per render
// meant re-parsing every URL in the capture on every captured request.
function itemHost(it) {
  if (it._host === undefined) {
    const url = it.upstream || it.url || '';
    try { it._host = new URL(url).host; } catch { it._host = url.split('/')[0] || ''; }
  }
  return it._host;
}

// Lowercased haystack for the filter box, likewise cached per item so typing
// does not rebuild it for every row on every keystroke.
function itemHaystack(it) {
  if (it._hay === undefined) {
    it._hay = [it.method, it.url, it.status, it.error, it.upstream, it.provider].filter(Boolean).join(' ');
    it._hayLower = it._hay.toLowerCase();
  }
  return it;
}

// A text term also matches a request through any of its decoded events, so a
// property value (a view id, an error message) finds the beacon carrying it.
function matchesTermsWithEvents(it) {
  itemHaystack(it);
  if (matchesTerms(it._hay, it._hayLower)) return true;
  for (const r of eventsByFile.get(it.file) || []) {
    if (matchesTerms(r._hay, r._hayLower)) return true;
  }
  return false;
}

let domainCountCache = { version: -1, value: 0 };

function uniqueDomainCount() {
  // Keyed on itemsVersion rather than array identity, because appending a row
  // mutates allItems in place rather than replacing it.
  if (domainCountCache.version === itemsVersion) return domainCountCache.value;
  const set = new Set();
  for (const it of allItems) set.add(itemHost(it));
  set.delete('');
  domainCountCache = { version: itemsVersion, value: set.size };
  return set.size;
}

function matchesFilters(it) {
  if (deepSearchFiles && !deepSearchFiles.has(it.file)) return false;
  if (hiddenProviders.has(it.provider || 'other')) return false;
  if (filterTerms.length && !matchesTermsWithEvents(it)) return false;
  return true;
}

function cmp(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function sortItems(items) {
  if (!sortBy) return items;
  const dir = sortDir === 'asc' ? 1 : -1;
  const pick = (it) => {
    if (sortBy === 'idx') return it.seq;
    if (sortBy === 'url') return it.upstream || it.url;
    return it[sortBy];
  };
  return items.slice().sort((a, b) => cmp(pick(a), pick(b)) * dir);
}

// In tree mode `treeIndent` is set and the URL cell shows only the leaf name —
// the ancestors already spell out origin and path.
function itemCellHtml(col, it, treeIndent) {
  switch (col.key) {
    case 'idx': return '<td class="muted num">' + (it.seq ?? '') + '</td>';
    case 'timestamp': return '<td>' + formatTime(it.timestamp) + '</td>';
    case 'method': return '<td class="method">' + escapeHtml(it.method || '') + '</td>';
    case 'status': return '<td class="' + statusClass(it.status, it.error) + '">'
      + (it.error ? 'ERR' : (it.status ?? '')) + '</td>';
    case 'provider': return '<td>' + providerChipHtml(it.provider) + '</td>';
    case 'events': {
      // Only analytics providers decode real events; "other" traffic gets a
      // placeholder row for the API, which is nothing to show here.
      if (!hasAnalytics(it)) return '<td></td>';
      const rows = eventsByFile.get(it.file) || [];
      const n = it.events ?? rows.length;
      if (!n) return '<td class="muted"></td>';
      const names = rows.map((r) => r.event || 'event');
      const shown = names.slice(0, MAX_EVENT_CHIPS).map(eventChipHtml).join('');
      const more = n > MAX_EVENT_CHIPS ? '<span class="ev-more">+' + (n - MAX_EVENT_CHIPS) + '</span>' : '';
      return '<td class="events-cell" title="' + escapeHtml(names.join(', ')) + '"><span class="ev-chips">' + shown + more + '</span></td>';
    }
    case 'durationMs': return '<td class="num">' + (it.durationMs ?? '') + '</td>';
    case 'reqBytes': return '<td class="num">' + formatKB(it.reqBytes) + '</td>';
    case 'resBytes': return '<td class="num">' + formatKB(it.resBytes) + '</td>';
    case 'url': {
      const fullUrl = it.upstream || it.url || '';
      const inTree = treeIndent != null;
      const style = inTree ? ' style="padding-left: ' + treeIndent + 'px"' : '';
      const label = inTree ? (it._leaf ?? fullUrl) : fullUrl;
      return '<td class="url"' + style + ' title="' + escapeHtml(fullUrl) + '">'
        + rewriteFlagHtml(it) + escapeHtml(label) + '</td>';
    }
  }
  return '<td></td>';
}

function rowItemHtml(it, { extraClass = '', treeIndent = null, cols = null } = {}) {
  const sel = it.file === selectedFile ? ' selected' : '';
  const cls = (extraClass + sel).trim();
  const cells = (cols || visibleColumns()).map((c) => itemCellHtml(c, it, treeIndent)).join('');
  return '<tr data-file="' + escapeHtml(it.file) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + cells + '</tr>';
}

// Whether a request carries decoded analytics events at all. Only analytics
// providers do; "other" traffic gets a placeholder row for the API.
function hasAnalytics(it) {
  return !!it.provider && it.provider !== 'other';
}

function toggleGroup(groupRow) {
  const key = groupRow.dataset.groupKey;
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  renderView({ autoscroll: false });
}

// ── Row model + virtualised rendering ──────────────────────────────────────
// Both the flat list and the domain tree flatten to the same ordered array of
// { html, file } — group rows carry file: null. Rendering only ever touches the
// slice inside the viewport, so a capture of thousands of rows costs the same
// as a screenful.
let rowModels = [];
let rowHeight = 0;          // measured once from a real row
let scrollFrame = null;

// Event chips shown inline in the Events column before it falls back to "+N".
const MAX_EVENT_CHIPS = 4;
// Below this, rendering everything is cheaper than the bookkeeping.
const VIRTUAL_THRESHOLD = 150;
const OVERSCAN = 12;

function buildRowModels(filtered) {
  if (!groupByDomain) {
    return sortItems(filtered).map((it) => ({ item: it, file: it.file }));
  }
  const out = [];
  for (const node of topLevelTreeRoots(buildDomainTree(filtered))) emitTreeNode(node, 0, out);
  return out;
}

// Markup for one row, built only when that row is about to be shown. The
// column list is threaded in from the caller so it is computed once per render
// rather than rebuilt for every row.
function rowHtmlAt(index, cols) {
  const m = rowModels[index];
  if (!m) return '';
  if (m.node) return groupRowHtml(m.node, m.depth, m.expanded, cols);
  if (m.indent != null) return rowItemHtml(m.item, { extraClass: 'child-row', treeIndent: m.indent, cols });
  return rowItemHtml(m.item, { cols });
}

function spacerRow(height, colCount) {
  return '<tr class="spacer" style="height:' + height + 'px"><td colspan="' + colCount + '"></td></tr>';
}

// Measures from a single throwaway row. Doing this by rendering the entire list
// and reading one row out of it meant the first draw of a large capture built
// markup for every row, only to discard it on the very next render.
function measureRowHeight(cols) {
  if (rowHeight || !rowModels.length) return;
  rowsEl.innerHTML = rowHtmlAt(0, cols);
  const probe = rowsEl.querySelector('tr');
  if (probe && probe.offsetHeight) rowHeight = probe.offsetHeight;
}

function isVirtualised() {
  return rowModels.length > VIRTUAL_THRESHOLD && rowHeight > 0;
}

// Renders the slice of rowModels currently in view, padded above and below so
// the scrollbar still reflects the full list.
function renderWindow() {
  const total = rowModels.length;
  if (!total) { rowsEl.innerHTML = ''; return; }

  const cols = visibleColumns();
  measureRowHeight(cols);

  if (!isVirtualised()) {
    let all = '';
    for (let i = 0; i < total; i++) all += rowHtmlAt(i, cols);
    rowsEl.innerHTML = all;
    return;
  }

  const viewHeight = gridEl.clientHeight || 600;
  const first = Math.max(0, Math.floor(gridEl.scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(total, first + Math.ceil(viewHeight / rowHeight) + OVERSCAN * 2);

  let html = '';
  if (first > 0) html += spacerRow(first * rowHeight, cols.length);
  for (let i = first; i < last; i++) html += rowHtmlAt(i, cols);
  if (last < total) html += spacerRow((total - last) * rowHeight, cols.length);
  rowsEl.innerHTML = html;
}

// Scrolls so the row at `index` is in view, without disturbing the position if
// it already is.
function scrollToRowIndex(index, { center = false } = {}) {
  if (!isVirtualised()) {
    const tr = rowsEl.querySelectorAll('tr')[index];
    if (tr) tr.scrollIntoView({ block: center ? 'center' : 'nearest' });
    return;
  }
  const top = index * rowHeight;
  const viewHeight = gridEl.clientHeight;
  if (center) {
    gridEl.scrollTop = Math.max(0, top - viewHeight / 2 + rowHeight / 2);
  } else if (top < gridEl.scrollTop) {
    gridEl.scrollTop = top;
  } else if (top + rowHeight > gridEl.scrollTop + viewHeight) {
    gridEl.scrollTop = top + rowHeight - viewHeight;
  }
}

gridEl.addEventListener('scroll', () => {
  if (!isVirtualised()) return;
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    renderWindow();
  });
});

function renderGrid({ autoscroll = true } = {}) {
  const filtered = allItems.filter(matchesFilters);
  lastShown = { shown: filtered.length, total: allItems.length };

  if (filtered.length === 0) {
    rowModels = [];
    rowsEl.innerHTML = '';
    emptyEl.textContent = allItems.length === 0 ? 'No requests yet. Waiting...' : 'No requests match the filter.';
    emptyEl.style.display = 'flex';
    return;
  }
  emptyEl.style.display = 'none';

  rowModels = buildRowModels(filtered);

  const naturalOrder = !sortBy || (sortBy === 'idx' && sortDir === 'asc');
  const stickToBottom = autoscroll && autoscrollEl.checked && naturalOrder
    && !filterTerms.length && !hiddenProviders.size && !groupByDomain;

  // Scroll first, then render once: setting scrollTop afterwards forced a
  // layout and a second window build for every captured request.
  if (stickToBottom) {
    measureRowHeight(visibleColumns());
    if (isVirtualised()) {
      gridEl.scrollTop = Math.max(0, rowModels.length * rowHeight - gridEl.clientHeight);
    }
  }
  renderWindow();
  if (stickToBottom && !isVirtualised()) gridEl.scrollTop = gridEl.scrollHeight;
}

// ── Header: sorting, column menu, resize ───────────────────────────────────
function renderHead() {
  const cols = visibleColumns();
  headColsEl.innerHTML = cols
    .map((c) => '<col' + (c.width != null ? ' style="width:' + c.width + 'px"' : '') + ' />')
    .join('');
  headRowEl.innerHTML = cols
    .map((c) => '<th data-col="' + c.key + '" data-sort="' + c.sort + '" title="' + escapeHtml(c.title) + '"'
      + (c.num ? ' class="num"' : '') + '>'
      + escapeHtml(c.label) + '<span class="arrow"></span><span class="resize-handle"></span></th>')
    .join('');

  headRowEl.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortBy === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortBy = key;
        sortDir = 'asc';
      }
      uiState.sortBy = sortBy;
      uiState.sortDir = sortDir;
      saveUiState();
      updateSortArrows();
      renderView();
    });
    th.addEventListener('contextmenu', (e) => showColContextMenu(e, th.dataset.col));
  });

  bindColumnResize(cols);
  updateSortArrows();
}

function updateSortArrows() {
  headRowEl.querySelectorAll('th[data-sort] .arrow').forEach((a) => { a.textContent = ''; });
  if (sortBy) {
    const th = headRowEl.querySelector('th[data-sort="' + sortBy + '"] .arrow');
    if (th) th.textContent = sortDir === 'asc' ? ' ▲' : ' ▼';
  }
}

let colMenuTargetKey = null;

function applyColumnChange() {
  saveHiddenColumns();
  renderHead();
  renderView({ autoscroll: false });
  if (columnsModalEl.classList.contains('open')) renderColumnList();
}

function setColumnHidden(key, hidden) {
  if (hidden) {
    if (visibleColumns().length <= 1) {
      colsErrorEl.textContent = 'At least one column must stay visible.';
      return false;
    }
    hiddenColumns.add(key);
  } else {
    hiddenColumns.delete(key);
  }
  colsErrorEl.textContent = '';
  applyColumnChange();
  return true;
}

// Every menu closes all the others before opening, so two can never be on
// screen at once.
function hideOtherMenus(keep) {
  if (keep !== colContextMenuEl) hideColContextMenu();
  if (keep !== contextMenuEl) hideContextMenu();
  if (keep !== detailCtxMenuEl) hideDetailCtxMenu();
}

function showColContextMenu(e, key) {
  e.preventDefault();
  e.stopPropagation();
  hideOtherMenus(colContextMenuEl);
  colMenuTargetKey = key;
  const col = COLUMNS.find((c) => c.key === key);
  const hideItem = colContextMenuEl.querySelector('[data-action="hide-col"]');
  hideItem.textContent = col ? 'Hide "' + col.label + '"' : 'Hide this column';
  hideItem.classList.toggle('disabled', visibleColumns().length <= 1);
  colContextMenuEl.querySelector('[data-action="show-all-cols"]')
    .classList.toggle('disabled', hiddenColumns.size === 0);
  colContextMenuEl.style.left = e.clientX + 'px';
  colContextMenuEl.style.top = e.clientY + 'px';
  colContextMenuEl.classList.add('open');
}

function hideColContextMenu() {
  colContextMenuEl.classList.remove('open');
  colMenuTargetKey = null;
}

colContextMenuEl.addEventListener('click', (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item || item.classList.contains('disabled')) return;
  const action = item.dataset.action;
  const key = colMenuTargetKey;
  hideColContextMenu();
  if (action === 'hide-col' && key) setColumnHidden(key, true);
  else if (action === 'show-all-cols') { hiddenColumns.clear(); applyColumnChange(); }
  else if (action === 'choose-cols') openColumnsDialog();
});

function renderColumnList() {
  colListEl.innerHTML = COLUMNS.map((c) => {
    const checked = hiddenColumns.has(c.key) ? '' : ' checked';
    return '<label class="col-item"><input type="checkbox" data-col="' + c.key + '"' + checked + ' /> '
      + escapeHtml(c.label) + '<span class="col-item-hint">' + escapeHtml(c.title) + '</span></label>';
  }).join('');
}

function openColumnsDialog() {
  colsErrorEl.textContent = '';
  renderColumnList();
  columnsModalEl.classList.add('open');
}

function closeColumnsDialog() {
  columnsModalEl.classList.remove('open');
}

colListEl.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox][data-col]');
  if (!cb) return;
  if (!setColumnHidden(cb.dataset.col, !cb.checked)) cb.checked = true; // rejected — put it back
});

$('cols-close').onclick = closeColumnsDialog;
$('cols-show-all').onclick = () => {
  hiddenColumns.clear();
  colsErrorEl.textContent = '';
  applyColumnChange();
};
columnsModalEl.addEventListener('click', (e) => { if (e.target === columnsModalEl) closeColumnsDialog(); });

document.addEventListener('click', (e) => {
  if (colContextMenuEl.classList.contains('open') && !colContextMenuEl.contains(e.target)) hideColContextMenu();
});
document.addEventListener('contextmenu', (e) => {
  if (colContextMenuEl.classList.contains('open') && !e.target.closest('#head-row th')) hideColContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && colContextMenuEl.classList.contains('open')) hideColContextMenu();
});
window.addEventListener('blur', hideColContextMenu);
gridEl.addEventListener('scroll', hideColContextMenu);

// Re-bound after every renderHead(). Widths are written back onto the column
// definitions so a resize survives showing or hiding another column.
function bindColumnResize(cols) {
  const colEls = headColsEl.querySelectorAll('col');
  let activeCol = null;
  let activeDef = null;
  let startX = 0;
  let startW = 0;

  function onMove(e) {
    if (!activeCol) return;
    const w = Math.max(MIN_COL_WIDTH, startW + (e.clientX - startX));
    activeCol.style.width = w + 'px';
    if (activeDef) {
      activeDef.width = w;
      uiState.columnWidths[activeDef.key] = w;
      saveUiState();
    }
  }
  function onUp() {
    headRowEl.querySelectorAll('.resize-handle.dragging').forEach((h) => h.classList.remove('dragging'));
    document.body.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    activeCol = null;
    activeDef = null;
  }
  headRowEl.querySelectorAll('th .resize-handle').forEach((handle, i) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const col = colEls[i];
      if (!col) return;
      activeCol = col;
      activeDef = cols[i] || null;
      startX = e.clientX;
      startW = handle.closest('th').getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('click', (e) => e.stopPropagation());
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Decoded events (shown under their request)
// ═══════════════════════════════════════════════════════════════════════════

// Providers unticked in the toolbar dropdown: their requests are hidden.
// Stored as the exclusions so a provider added later starts visible.
const hiddenProviders = new Set(Array.isArray(uiState.hiddenProviders) ? uiState.hiddenProviders : []);

function eventClass(ev) {
  if (!ev) return '';
  if (ev === 'error' || ev === 'aderror') return 'err';
  if (ev.startsWith('ad')) return 'ad';
  if (ev === 'viewstart' || ev === 'viewend') return 'view';
  if (ev === 'playerready' || ev === 'hb') return 'life';
  return '';
}

function eventChipHtml(ev) {
  const cls = eventClass(ev);
  return '<span class="ev' + (cls ? ' ' + cls : '') + '">' + escapeHtml(ev || '') + '</span>';
}

function providerChipHtml(id) {
  if (!id) return '';
  return '<span class="prov ' + escapeHtml(id) + '">' + escapeHtml(providerLabel(id)) + '</span>';
}

function eventTime(row) {
  const ms = row.viewerTime || (row.ts ? Date.parse(row.ts) : NaN);
  return Number.isFinite(ms) ? formatMs(ms) : '';
}

function propText(v) {
  if (v == null || v === '') return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// Lowercased "event request provider key value key value …" blob, computed
// once per row at ingest so the filter is a substring (or regex) test.
function eventHaystack(r) {
  const parts = [r.event, r.provider];
  for (const [k, v] of Object.entries(r.props || {})) { parts.push(k); if (v != null) parts.push(propText(v)); }
  return parts.filter((p) => p != null && p !== '').join(' ');
}

// ── Provider dropdown: a checkbox per provider ─────────────────────────────
function setProviderHidden(id, hidden) {
  if (hidden) hiddenProviders.add(id);
  else hiddenProviders.delete(id);
  uiState.hiddenProviders = [...hiddenProviders];
  saveUiState();
  renderProviderMenu();
  renderView();
}

function renderProviderMenu() {
  const visible = providers.filter((p) => !hiddenProviders.has(p.id));
  providerBtnEl.textContent = (visible.length === providers.length
    ? 'All providers'
    : visible.length === 0 ? 'No providers' : visible.map((p) => p.label).join(', ')) + ' ▾';
  providerBtnEl.classList.toggle('filtering', visible.length !== providers.length);
  providerMenuEl.innerHTML = '<div class="dropdown-actions">'
    + '<button type="button" data-all="1">All</button><button type="button" data-all="0">None</button></div>'
    + providers.map((p) => '<label class="dropdown-item"><input type="checkbox" data-provider="' + escapeHtml(p.id) + '"'
      + (hiddenProviders.has(p.id) ? '' : ' checked') + ' /> ' + providerChipHtml(p.id) + '</label>').join('');
}

providerBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  providerMenuEl.classList.toggle('open');
});
providerMenuEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const all = e.target.closest('button[data-all]');
  if (all) {
    hiddenProviders.clear();
    if (all.dataset.all === '0') for (const p of providers) hiddenProviders.add(p.id);
    setProviderHidden('', false);   // persist + re-render with the new set
  }
});
providerMenuEl.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-provider]');
  if (cb) setProviderHidden(cb.dataset.provider, !cb.checked);
});
document.addEventListener('click', () => providerMenuEl.classList.remove('open'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') providerMenuEl.classList.remove('open'); });


function refreshProviderFilter() {
  for (const id of hiddenProviders) if (!providers.some((p) => p.id === id)) hiddenProviders.delete(id);
  renderProviderMenu();
}

// ── Event rows: ingest / drop ──────────────────────────────────────────────
function prepareRow(r) {
  r._hay = eventHaystack(r);
  r._hayLower = r._hay.toLowerCase();
  return r;
}

function ingestEventRows(rows, replace) {
  if (replace) { eventRows = []; eventById.clear(); eventsByFile.clear(); }
  let added = 0;
  for (const r of rows || []) {
    if (eventById.has(r.id)) continue;
    prepareRow(r);
    eventById.set(r.id, r);
    eventRows.push(r);
    if (!eventsByFile.has(r.file)) eventsByFile.set(r.file, []);
    eventsByFile.get(r.file).push(r);
    added++;
  }
  return added;
}

function dropEventRows(files) {
  const before = eventRows.length;
  eventRows = eventRows.filter((r) => {
    if (!files.has(r.file)) return true;
    eventById.delete(r.id);
    return false;
  });
  for (const f of files) eventsByFile.delete(f);
  return eventRows.length !== before;
}

// An entry rewritten in place (its response body was edited): swap its rows
// without disturbing the order.
function replaceEventRows(file, rows) {
  const first = eventRows.findIndex((r) => r.file === file);
  const prepared = (rows || []).map(prepareRow);
  if (first === -1) { ingestEventRows(prepared, false); return; }
  let last = first;
  while (last + 1 < eventRows.length && eventRows[last + 1].file === file) last += 1;
  for (let i = first; i <= last; i++) eventById.delete(eventRows[i].id);
  eventRows.splice(first, last - first + 1, ...prepared);
  eventsByFile.set(file, prepared);
  for (const r of prepared) eventById.set(r.id, r);
}

// ── Playback timeline (Mux) ─────────────────────────────────────────────────
// Map an event to the playback state it begins. `null` = no state change
// (heartbeats, play/seeked/rebufferend which are confirmed by a following
// playing event, ad impressions, etc.).
function stateOf(ev) {
  switch (ev) {
    case 'playerready':
    case 'viewstart': return 'startup';
    case 'playing': return 'playing';
    case 'pause': return 'paused';
    case 'seeking': return 'seek';
    case 'rebufferstart': return 'rebuffering';
    case 'adbreakstart':
    case 'adplay':
    case 'adplaying': return 'ad';
    case 'adbreakend':
    case 'adended': return 'playing';
    case 'error':
    case 'aderror': return 'failure';
    case 'ended':
    case 'viewend': return 'end';
    default: return null;
  }
}

const STATE_LABELS = {
  startup: 'Starting Up', seek: 'Seek Latency', rebuffering: 'Rebuffering',
  playing: 'Video Playing', ad: 'Ad Playing', paused: 'Paused',
  failure: 'Playback Failure', end: 'Ended',
};

// Split a flat event list into views. A new view starts at each `viewstart`
// (and at the very first event, so a leading playerready is kept with view 1).
function splitViews(arr) {
  const evs = arr.filter((r) => r.viewerTime != null).slice().sort((a, b) => a.viewerTime - b.viewerTime);
  const views = [];
  let cur = null;
  for (const r of evs) {
    if (!cur || r.event === 'viewstart') {
      cur = { rows: [], viewId: null, start: r.viewerTime };
      views.push(cur);
    }
    cur.rows.push(r);
    if (!cur.viewId && r.props.view_id) cur.viewId = r.props.view_id;
  }
  return views;
}

function buildTimeline(arr) {
  const evs = arr.filter((r) => r.viewerTime != null).slice().sort((a, b) => a.viewerTime - b.viewerTime);
  if (!evs.length) return null;
  const t0 = evs[0].viewerTime;
  const t1 = evs[evs.length - 1].viewerTime;
  const span = Math.max(1, t1 - t0);
  let st = 'startup';
  let segStart = t0;
  const segments = [];
  for (const r of evs) {
    const ns = stateOf(r.event);
    if (ns && ns !== st) {
      if (r.viewerTime > segStart) segments.push({ state: st, start: segStart, end: r.viewerTime });
      st = ns;
      segStart = r.viewerTime;
    }
  }
  if (t1 > segStart) segments.push({ state: st, start: segStart, end: t1 });
  const ticks = evs.map((r) => ({ t: r.viewerTime, event: r.event, id: r.id }));
  return { segments, ticks, t0, t1, span };
}

function fmtRel(ms) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const decimals = s < 600 ? 1 : 0;
  return m + ':' + r.toFixed(decimals).padStart(decimals ? 4 : 2, '0');
}

function niceStep(totalSec) {
  const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const t of targets) if (totalSec / t <= 8) return t;
  return Math.ceil(totalSec / 8);
}

let lastViewSig = '';

const timelineEl = $('timeline');

function renderTimeline() {
  const views = splitViews(eventRows);
  // Only Mux beacons carry a viewer clock; without any there is nothing to draw.
  timelineEl.hidden = !views.length;
  if (timelineEl.hidden) return;
  const sel = $('tl-view');

  // (re)build the selector only when the set of views changes, so it doesn't
  // flicker or fight the user's current choice on every update.
  const sig = views.map((v) => v.start + ':' + v.rows.length).join('|');
  if (sig !== lastViewSig) {
    lastViewSig = sig;
    const prev = sel.value;
    let opts = '<option value="latest">Latest view</option>';
    views.forEach((v, i) => {
      opts += '<option value="' + i + '">View ' + (i + 1) + ' · ' + formatClock(new Date(v.start)) + ' · ' + v.rows.length + ' ev</option>';
    });
    sel.innerHTML = opts;
    sel.value = (prev && [...sel.options].some((o) => o.value === prev)) ? prev : 'latest';
  }

  const track = $('tl-track');
  const ticksEl = $('tl-ticks');
  const axisEl = $('tl-axis');
  track.innerHTML = '';
  ticksEl.innerHTML = '';
  axisEl.innerHTML = '';

  if (!views.length) { $('tl-info').textContent = 'no playback events'; return; }

  const choice = sel.value;
  const v = choice === 'latest' ? views[views.length - 1] : (views[Number(choice)] || views[views.length - 1]);
  const data = buildTimeline(v.rows);
  if (!data) { $('tl-info').textContent = 'no playback events'; return; }

  const { segments, ticks, t0, span } = data;
  let segHtml = '';
  for (const s of segments) {
    if (s.state === 'end') continue;
    const dur = ((s.end - s.start) / 1000).toFixed(1);
    segHtml += '<div class="tl-seg s-' + s.state + '" style="left:' + ((s.start - t0) / span * 100) + '%;width:' + Math.max((s.end - s.start) / span * 100, 0.2) + '%" data-tip="'
      + escapeHtml(STATE_LABELS[s.state] + '|' + fmtRel(s.start - t0) + ' – ' + fmtRel(s.end - t0) + '  (' + dur + 's)') + '"></div>';
  }
  track.innerHTML = segHtml;
  let tickHtml = '';
  for (const tk of ticks) {
    const cls = eventClass(tk.event);
    tickHtml += '<div class="tl-tick' + (cls ? ' ev-' + cls : '') + (tk.id === selectedEventId ? ' selected' : '') + '" style="left:' + ((tk.t - t0) / span * 100) + '%" data-id="' + escapeHtml(tk.id) + '" data-tip="' + escapeHtml(tk.event + '|' + fmtRel(tk.t - t0)) + '"></div>';
  }
  ticksEl.innerHTML = tickHtml;
  const totalSec = span / 1000;
  const step = niceStep(totalSec);
  let axisHtml = '';
  for (let s = 0; s <= totalSec + 1e-6; s += step) {
    axisHtml += '<div class="tl-axis-label" style="left:' + (totalSec ? s / totalSec * 100 : 0) + '%">' + fmtRel(s * 1000) + '</div>';
  }
  axisEl.innerHTML = axisHtml;
  const vidLabel = v.viewId ? ' · view_id ' + String(v.viewId).slice(0, 8) + '…' : '';
  $('tl-info').textContent = ticks.length + ' events · ' + fmtRel(span) + ' span' + vidLabel;
}

function updateTickSelection() {
  document.querySelectorAll('#tl-ticks .tl-tick').forEach((t) => {
    t.classList.toggle('selected', t.dataset.id === selectedEventId);
  });
}

$('tl-view').addEventListener('change', renderTimeline);
// Collapsible like the console: the header stays, the track folds away.
(function initTimelineCollapse() {
  const setCollapsed = (on) => {
    timelineEl.classList.toggle('collapsed', on);
    uiState.timelineCollapsed = on;
    saveUiState();
  };
  setCollapsed(!!uiState.timelineCollapsed);
  $('timeline-toggle').addEventListener('click', () => setCollapsed(!timelineEl.classList.contains('collapsed')));
})();
$('tl-ticks').addEventListener('click', (e) => {
  const tick = e.target.closest('.tl-tick');
  if (!tick) return;
  const row = eventById.get(tick.dataset.id);
  if (row) revealEvent(row);
});

(function initTimelineTooltip() {
  const wrap = $('tl-track-wrap');
  const tip = $('tl-tooltip');
  wrap.addEventListener('mousemove', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.style.display = 'none'; return; }
    const [main, sub] = target.dataset.tip.split('|');
    tip.innerHTML = '<span class="t-state">' + escapeHtml(main) + '</span>' +
      (sub ? '<br><span class="t-sub">' + escapeHtml(sub) + '</span>' : '');
    tip.style.display = 'block';
    const r = wrap.getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 12, wrap.clientWidth - tip.offsetWidth - 4);
    tip.style.left = Math.max(0, x) + 'px';
    tip.style.top = Math.max(0, e.clientY - r.top - tip.offsetHeight - 8) + 'px';
  });
  wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
})();

// ═══════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════

let lastShown = { shown: 0, total: 0 };

function renderView(opts = {}) {
  renderGrid(opts);
  updateStats();
  updateExpandCollapseBtn();
  renderTimeline();
}

function updateStats() {
  statRequestsEl.textContent = allItems.length;
  statEventsEl.textContent = eventRows.length;
  const { shown, total } = lastShown;
  statShownEl.textContent = shown !== total ? `${shown} of ${total}` : String(shown);
  statDomainsEl.textContent = uniqueDomainCount();
  statSizeEl.textContent = lastDiskBytes != null ? formatBytes(lastDiskBytes) : '—';
}

function updateExpandCollapseBtn() {
  if (!groupByDomain) { expandCollapseAllBtn.style.display = 'none'; return; }
  expandCollapseAllBtn.style.display = '';
  const anyCollapsed = collapsedGroups.size > 0;
  expandCollapseAllBtn.textContent = anyCollapsed ? '▶ all' : '▼ all';
  expandCollapseAllBtn.title = anyCollapsed ? 'Expand all groups' : 'Collapse all groups';
}

expandCollapseAllBtn.onclick = () => {
  if (collapsedGroups.size === 0) {
    // Collapse all: walk the current filtered tree and collect every key. Only
    // the groups that exist right now — a domain seen afterwards opens, which
    // is the same bias as the default.
    const root = buildDomainTree(allItems.filter(matchesFilters));
    for (const node of topLevelTreeRoots(root)) collectAllGroupKeys(node, collapsedGroups);
  } else {
    collapsedGroups.clear();
  }
  renderView({ autoscroll: false });
};

// One delegated listener each, instead of re-binding handlers to every row —
// necessary since rows come and go as the window scrolls.
rowsEl.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || tr.classList.contains('spacer')) return;
  if (tr.classList.contains('group-row')) { toggleGroup(tr); return; }
  if (tr.dataset.file) openDetail(tr.dataset.file, tr);
});
rowsEl.addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-file]');
  if (tr) showRowContextMenu(e, tr);
});

// ── Keyboard navigation ────────────────────────────────────────────────────

// Indices into rowModels that are actual requests, skipping group rows.
function selectableRowIndices() {
  const out = [];
  for (let i = 0; i < rowModels.length; i++) if (rowModels[i].file) out.push(i);
  return out;
}

// Moves the selection by `delta` rows, opening the detail panel as it goes so
// j/k browses the capture the way arrow keys browse a mail client. Works off
// the row model rather than the DOM, since the target row may be outside the
// rendered window.
function moveSelection(delta) {
  const indices = selectableRowIndices();
  if (!indices.length) return;
  const current = indices.findIndex((i) => rowModels[i].file === selectedFile);
  const next = current === -1
    ? (delta > 0 ? 0 : indices.length - 1)
    : Math.min(indices.length - 1, Math.max(0, current + delta));

  const modelIndex = indices[next];
  const file = rowModels[modelIndex].file;
  scrollToRowIndex(modelIndex);
  renderWindow();                        // bring the row into the DOM if it was not
  const tr = [...rowsEl.querySelectorAll('tr[data-file]')].find((r) => r.dataset.file === file);
  openDetail(file, tr);
}

// From the timeline: opens the request the event belongs to, on its Events
// tab, scrolled to that event.
function revealEvent(row) {
  const it = allItems.find((x) => x.file === row.file);
  if (it && groupByDomain) { expandTreeToItem(it); renderView({ autoscroll: false }); }
  const index = rowModels.findIndex((m) => m.file === row.file);
  if (index !== -1) { scrollToRowIndex(index, { center: true }); renderWindow(); }
  const tr = [...rowsEl.querySelectorAll('tr[data-file]')].find((r) => r.dataset.file === row.file);
  detailMode = 'events';
  openDetail(row.file, tr, { eventId: row.id });
}

// True while the user is typing, so single-letter shortcuts stay out of the way.
function isTypingTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function anyModalOpen() {
  return confirmModalEl.classList.contains('open')
    || configModalEl.classList.contains('open')
    || columnsModalEl.classList.contains('open');
}

document.addEventListener('keydown', (e) => {
  if (anyModalOpen()) return;

  // "/" focuses the filter even though it is a printable character, matching
  // less/vim; everything else defers to whatever the user is typing into.
  if (e.key === '/' && !isTypingTarget(e.target)) {
    e.preventDefault();
    filterEl.focus();
    filterEl.select();
    return;
  }
  // F3 works regardless of focus, the way browsers treat find-next.
  if (e.key === 'F3') {
    e.preventDefault();
    stepSearchHit(e.shiftKey ? -1 : 1);
    return;
  }
  if (isTypingTarget(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return; }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); return; }
  if (e.key === 'n') { e.preventDefault(); stepSearchHit(1); return; }
  if (e.key === 'N') { e.preventDefault(); stepSearchHit(-1); return; }
  if (e.key === 'Enter' && !selectedFile) {
    e.preventDefault();
    moveSelection(1);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Detail panel
// ═══════════════════════════════════════════════════════════════════════════

function closeDetail() {
  editingRes = false;
  detailEl.classList.remove('open');
  rowsEl.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
  selectedFile = null;
  selectedEventId = null;
  selectedEntry = null;
  searchHits = [];
  searchHitIndex = -1;
  updateSearchHitBadge();
  updateTickSelection();
}

$('detail-close').onclick = closeDetail;
$('search-next-hit').onclick = () => stepSearchHit(1);
$('search-prev-hit').onclick = () => stepSearchHit(-1);
$('detail-expand').onclick = () => {
  detailBodyEl.querySelectorAll('.node.collapsed').forEach((n) => n.classList.remove('collapsed'));
};
$('detail-collapse').onclick = () => {
  detailBodyEl.querySelectorAll('.node').forEach((n) => n.classList.add('collapsed'));
};
detailModeEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  detailMode = btn.dataset.mode;
  redrawDetail();
});
document.addEventListener('keydown', (e) => {
  if (confirmModalEl.classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); return; }
    if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); return; }
    return;
  }
  if (e.key !== 'Escape') return;
  if (columnsModalEl.classList.contains('open')) { closeColumnsDialog(); return; }
  if (configModalEl.classList.contains('open')) { closeConfig(); return; }
  // Leaving the editor comes before closing the panel: Escape should undo the
  // smaller thing first.
  if (editingRes) { editingRes = false; redrawDetail(); return; }
  if (detailEl.classList.contains('open')) { closeDetail(); return; }
});

function selectedItem() {
  return selectedFile ? allItems.find((x) => x.file === selectedFile) || null : null;
}

// Re-draws the panel from what is already in hand. Every path that changes
// what the panel should show goes through here.
function redrawDetail() {
  detailModeEl.querySelectorAll('button[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === detailMode));
  const it = selectedItem();
  const analytics = !!it && hasAnalytics(it);
  detailEl.classList.toggle('has-events', analytics);
  if (analytics && detailMode === 'events') {
    detailBodyEl.className = 'props';
    detailBodyEl.innerHTML = renderEventsTab(it);
    const target = selectedEventId && detailBodyEl.querySelector('[data-event-id="' + CSS.escape(selectedEventId) + '"]');
    if (target) target.scrollIntoView({ block: 'start' });
  } else if (selectedEntry) {
    detailBodyEl.className = 'split';
    detailBodyEl.innerHTML = renderSplitDetail(selectedEntry);
  } else {
    detailBodyEl.className = '';
    detailBodyEl.textContent = 'Loading...';
    return;
  }
  highlightInDetail(deepSearchQuery);
}

function kvHtml(k, v) {
  return '<div class="kv"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(propText(v)) + '</div></div>';
}

// "Events" tab: every decoded event of the request, each with its properties —
// curated columns first, the rest alphabetically.
function renderEventsTab(it) {
  const rows = eventsByFile.get(it.file) || [];
  let html = '<div class="section-title">' + providerLabel(it.provider) + ' · request #' + it.seq + ' · ' + rows.length + ' event' + (rows.length === 1 ? '' : 's') + '</div>';
  for (const r of rows) {
    const curatedKeys = (columnsByProvider[r.provider] || []).map((c) => c.key);
    const all = Object.keys(r.props || {});
    const rest = all.filter((k) => !curatedKeys.includes(k)).sort();
    const ordered = [...curatedKeys.filter((k) => k in r.props), ...rest];
    html += '<div class="event-block' + (r.id === selectedEventId ? ' current' : '') + '" data-event-id="' + escapeHtml(r.id) + '">'
      + '<div class="event-head">' + eventChipHtml(r.event) + '<span class="event-head-meta">event ' + (r.idx + 1) + (r.viewerTime ? ' · ' + eventTime(r) : '') + ' · ' + ordered.length + ' properties</span></div>';
    for (const k of ordered) html += kvHtml(k, r.props[k]);
    html += '</div>';
  }
  return html;
}

// `tr` is optional: with virtualisation the selected row may be outside the
// rendered window, in which case the highlight comes from the row markup on
// the next render instead. `eventId` points the Events tab at one event.
async function openDetail(file, tr = null, { forceJsonBody = false, eventId = null } = {}) {
  rowsEl.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
  if (tr) tr.classList.add('selected');
  const sameEntry = file === selectedFile && selectedEntry;
  selectedFile = file;
  selectedEventId = eventId;
  if (!sameEntry) selectedEntry = null;
  editingRes = false;          // a different entry is never the one being edited
  detailEl.classList.add('open');
  updateTickSelection();

  detailTitleEl.textContent = file;
  redrawDetail();
  if (sameEntry) return;

  try {
    const r = await fetch('/api/entry?file=' + encodeURIComponent(file));
    const text = await r.text();
    if (file !== selectedFile) return;   // the user has moved on
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('request' in parsed || 'response' in parsed)) {
        selectedEntry = parsed;
        // Arriving from a deep search: show the JSON body, since that's what
        // the match will be sitting in.
        if (forceJsonBody && getContentType(parsed.response?.headers).toLowerCase().includes('json')) {
          detailTabs.res = 'body';
        }
        redrawDetail();
      } else {
        detailBodyEl.className = '';
        detailBodyEl.innerHTML = buildJsonTree(parsed);
        highlightInDetail(deepSearchQuery);
      }
    } catch {
      detailBodyEl.className = '';
      detailBodyEl.textContent = text;
    }
  } catch (err) {
    detailBodyEl.className = '';
    detailBodyEl.textContent = 'Error loading: ' + err.message;
  }
}

async function ensureSelectedEntry() {
  if (selectedEntry) return selectedEntry;
  if (!selectedFile) return null;
  try {
    const r = await fetch('/api/entry?file=' + encodeURIComponent(selectedFile));
    const text = await r.text();
    selectedEntry = JSON.parse(text);
    return selectedEntry;
  } catch {
    return null;
  }
}

detailBodyEl.addEventListener('click', (e) => {
  // JSON tree expand/collapse
  const toggle = e.target.closest('.toggle');
  if (toggle) {
    const node = toggle.closest('.node');
    if (node) node.classList.toggle('collapsed');
    return;
  }
  // Editor controls
  const btn = e.target.closest('.section-btn');
  if (btn && selectedEntry) {
    const act = btn.dataset.act;
    if (act === 'edit-start') { editingRes = true; redrawDetail(); }
    else if (act === 'edit-cancel') { editingRes = false; redrawDetail(); }
    else if (act === 'edit-save') saveResponseEdit();
    else if (act === 'edit-revert') revertResponseEdit();
    return;
  }
  // Section tab switch. Blocked for the response while editing, so an edit
  // cannot be lost to a stray click — Save or Cancel are the ways out.
  const tab = e.target.closest('.section-tab');
  if (tab && selectedEntry && !tab.classList.contains('disabled')) {
    detailTabs[tab.dataset.side] = tab.dataset.tab;
    redrawDetail();
  }
});

// Keeps a field roughly as wide as its content while it is typed into.
detailBodyEl.addEventListener('input', (e) => {
  const el = e.target;
  if (el.classList && el.classList.contains('edit-val') && el.tagName === 'INPUT') {
    el.style.width = editFieldWidth(el.value) + 'ch';
  }
});

async function saveResponseEdit() {
  const data = selectedEntry?.response;
  const original = editableJsonBody(data);
  if (!original) return;
  let edited;
  try {
    edited = collectEditedBody(original);
  } catch (err) {
    showToast(err.message, 'err');
    return;
  }
  try {
    const r = await fetch('/api/entry/body?file=' + encodeURIComponent(selectedFile), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...UI_HEADER },
      body: JSON.stringify({ body: edited }),
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(result.error || ('HTTP ' + r.status), 'err'); return; }
    selectedEntry.response.bodyEdited = edited;
    editingRes = false;
    redrawDetail();
    showToast('Saved — served when this URL is rewritten');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'err');
  }
}

async function revertResponseEdit() {
  if (!selectedFile) return;
  try {
    const r = await fetch('/api/entry/body?file=' + encodeURIComponent(selectedFile), {
      method: 'DELETE', headers: UI_HEADER,
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(result.error || ('HTTP ' + r.status), 'err'); return; }
    if (selectedEntry?.response) delete selectedEntry.response.bodyEdited;
    editingRes = false;
    redrawDetail();
    showToast('Edit discarded');
  } catch (err) {
    showToast('Revert failed: ' + err.message, 'err');
  }
}

// img load/error do not bubble, so these listen in the capture phase — one
// listener that keeps working across every re-render of the detail panel.
detailBodyEl.addEventListener('load', (e) => {
  const img = e.target;
  if (!img.classList || !img.classList.contains('body-image-img')) return;
  const meta = img.parentElement && img.parentElement.querySelector('.body-image-meta');
  if (!meta || !img.naturalWidth) return;
  const dims = img.naturalWidth + '×' + img.naturalHeight;
  meta.textContent = meta.textContent ? meta.textContent + ' · ' + dims : dims;
}, true);

detailBodyEl.addEventListener('error', (e) => {
  const img = e.target;
  if (!img.classList || !img.classList.contains('body-image-img')) return;
  const box = img.parentElement;
  img.remove();
  if (box) box.insertAdjacentHTML('afterbegin', '<span class="body-empty">image could not be decoded</span>');
}, true);

(function setupSplitResize() {
  let startY = 0;
  let startReqH = 0;
  let activeReq = null;
  let activeHandle = null;
  function onMove(e) {
    if (!activeReq) return;
    const containerH = detailBodyEl.getBoundingClientRect().height;
    const newH = startReqH + (e.clientY - startY);
    const min = 60;
    const max = Math.max(min, containerH - min - 5);
    activeReq.style.flex = '0 0 ' + Math.max(min, Math.min(max, newH)) + 'px';
  }
  function onUp() {
    if (activeHandle) activeHandle.classList.remove('dragging');
    document.body.classList.remove('row-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    activeReq = null;
    activeHandle = null;
  }
  detailBodyEl.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.detail-split-handle');
    if (!handle) return;
    const req = detailBodyEl.querySelector('.detail-section.req');
    if (!req) return;
    e.preventDefault();
    activeReq = req;
    activeHandle = handle;
    startY = e.clientY;
    startReqH = req.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.classList.add('row-dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  detailBodyEl.addEventListener('dblclick', (e) => {
    const handle = e.target.closest('.detail-split-handle');
    if (!handle) return;
    const req = detailBodyEl.querySelector('.detail-section.req');
    if (req) req.style.flex = '';
  });
})();

(function setupResize() {
  const handle = $('detail-resize');
  let startX = 0;
  let startW = 0;
  function onMove(e) {
    const dx = startX - e.clientX;
    const min = MIN_DETAIL_WIDTH;
    const max = Math.max(min, window.innerWidth - 200);
    const w = Math.max(min, Math.min(max, startW + dx));
    detailEl.style.width = w + 'px';
    detailEl.style.maxWidth = 'none';
    uiState.detailWidth = w;
    saveUiState();
  }
  function onUp() {
    handle.classList.remove('dragging');
    document.body.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = detailEl.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    detailEl.style.width = '';
    detailEl.style.maxWidth = '';
    uiState.detailWidth = null;
    saveUiState();
  });
})();

// ── JSON tree ──────────────────────────────────────────────────────────────

// Returns true for non-empty objects/arrays that need a toggle.
function isComplex(v) {
  if (v === null || typeof v !== 'object') return false;
  return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0;
}

// Inline HTML for primitive / empty values (no toggle).
function buildLeafHtml(value) {
  if (value === null) return '<span class="tok-null">null</span>';
  const t = typeof value;
  if (t === 'boolean') return '<span class="tok-bool">' + value + '</span>';
  if (t === 'number')  return '<span class="tok-num">'  + value + '</span>';
  if (t === 'string')  return '<span class="tok-str">'  + escapeHtml(JSON.stringify(value)) + '</span>';
  if (Array.isArray(value)) return '<span class="tok-empty">[]</span>';
  if (t === 'object')  return '<span class="tok-empty">{}</span>';
  return escapeHtml(String(value));
}

// Renders one entry (key + value) as a block div.
// For complex values the toggle sits at the START of the line via negative margin.
//
// `path` is null for the read-only tree. Passing one (the array of keys/indices
// that reach this value, starting from []) switches leaves to input fields —
// keys stay plain text either way, which is what keeps an edit from renaming
// anything.
function buildEntryHtml(key, value, addComma, path = null) {
  const comma   = addComma ? '<span class="punc">,</span>' : '';
  const keyHtml = key !== null
    ? '<span class="tok-key">' + escapeHtml(JSON.stringify(key)) + '</span><span class="punc">: </span>'
    : '';

  if (!isComplex(value)) {
    const leaf = path ? buildEditLeafHtml(value, path) : buildLeafHtml(value);
    return '<div class="entry">' + keyHtml + leaf + comma + '</div>';
  }

  const isArr  = Array.isArray(value);
  const open   = isArr ? '[' : '{';
  const close  = isArr ? ']' : '}';
  const count  = isArr ? value.length : Object.keys(value).length;
  const noun   = isArr ? (count === 1 ? ' item' : ' items') : (count === 1 ? ' key' : ' keys');

  let children = '';
  if (isArr) {
    for (let i = 0; i < value.length; i++) {
      children += buildEntryHtml(null, value[i], i < value.length - 1, path ? path.concat(i) : null);
    }
  } else {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      children += buildEntryHtml(keys[i], value[keys[i]], i < keys.length - 1, path ? path.concat(keys[i]) : null);
    }
  }

  // .entry.node: toggle has negative margin = -padding-left so it lands at
  // the entry's left edge while the key/bracket stay at the content start.
  return '<div class="entry node ' + (isArr ? 'arr' : 'obj') + '">'
    + '<span class="toggle">▼</span>'
    + keyHtml
    + '<span class="bracket">' + open + '</span>'
    + '<span class="summary"> ' + count + noun + ' </span>'
    + '<div class="children">' + children + '</div>'
    + '<span class="close-line"><span class="bracket">' + close + '</span>' + comma + '</span>'
    + '</div>';
}

function buildJsonTree(value) {
  return '<div class="tree">' + buildEntryHtml(null, value, false) + '</div>';
}

// ── Response body editing ──────────────────────────────────────────────────
// Only values are editable, and only in place: there is no field for a key
// anywhere in this editor, so a saved body always has the keys it was captured
// with. The server re-checks that before storing it.

let editingRes = false;
// Rebuilt on every edit render: input id -> the path of keys/indices that
// reaches its value. Kept out of the DOM so no escaping question arises.
let editFieldPaths = [];

// A leaf as an input. Types are preserved rather than inferred on save: a
// string stays a string even if it looks like a number. null and empty
// objects/arrays are left read-only — there is no type to edit them back into.
function buildEditLeafHtml(value, path) {
  const eid = editFieldPaths.push(path) - 1;
  const attrs = ' data-eid="' + eid + '"';
  if (typeof value === 'boolean') {
    return '<select class="edit-val"' + attrs + ' data-type="boolean">'
      + '<option value="true"' + (value ? ' selected' : '') + '>true</option>'
      + '<option value="false"' + (value ? '' : ' selected') + '>false</option>'
      + '</select>';
  }
  if (typeof value === 'number') {
    return '<input class="edit-val tok-num"' + attrs + ' data-type="number"'
      + ' style="width:' + editFieldWidth(String(value)) + 'ch" value="' + escapeHtml(String(value)) + '" />';
  }
  if (typeof value === 'string') {
    return '<input class="edit-val tok-str"' + attrs + ' data-type="string"'
      + ' style="width:' + editFieldWidth(value) + 'ch" value="' + escapeHtml(value) + '" />';
  }
  return buildLeafHtml(value);
}

function editFieldWidth(text) {
  return Math.min(80, Math.max(4, text.length + 2));
}

function buildEditTree(value) {
  editFieldPaths = [];
  return '<div class="tree editing">' + buildEntryHtml(null, value, false, []) + '</div>';
}

// The object/array a response body can be edited as, or null when it has none
// (binary, plain text, or an already-edited body that is somehow neither).
function editableJsonBody(data) {
  if (!data) return null;
  const raw = data.bodyEdited !== undefined ? data.bodyEdited : data.body;
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

function setAtPath(root, path, value) {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
  node[path[path.length - 1]] = value;
}

// Reads every input back into a copy of the original body. Walking the original
// rather than rebuilding from the DOM is what guarantees the result keeps its
// shape — the inputs only ever overwrite leaves that already exist.
function collectEditedBody(original) {
  let next = JSON.parse(JSON.stringify(original));
  for (const el of detailBodyEl.querySelectorAll('.edit-val')) {
    const path = editFieldPaths[Number(el.dataset.eid)];
    if (!path) continue;
    let value;
    if (el.dataset.type === 'boolean') {
      value = el.value === 'true';
    } else if (el.dataset.type === 'number') {
      const text = el.value.trim();
      value = Number(text);
      if (!text || !Number.isFinite(value)) {
        throw new Error((path.join('.') || 'value') + ' is not a number');
      }
    } else {
      value = el.value;
    }
    if (!path.length) next = value;
    else setAtPath(next, path, value);
  }
  return next;
}

// ── Detail panel tabs ──────────────────────────────────────────────────────

// Persists the selected tab per section across row clicks.
let detailTabs = { req: 'body', res: 'body' };

function getContentType(headers) {
  if (!headers) return '';
  const ct = headers['content-type'] || headers['Content-Type'] || '';
  return String(ct).split(';')[0].trim();
}

const JSON_START_RE = /^\s*[\[{]/;
const IMAGE_CT_RE = /^image\//i;

// Bodies the browser can paint itself. Binary images arrive as bodyBase64
// (the proxy stores anything non-textual that way); SVG counts as text and so
// stays in `body` as a string. Returns null when there is nothing to show, so
// the caller can fall back to the usual text rendering.
function buildImageHtml(data, ct) {
  let src = null;
  if (data.bodyBase64) {
    src = 'data:' + ct + ';base64,' + data.bodyBase64;
  } else if (typeof data.body === 'string' && data.body) {
    src = 'data:' + ct + ';charset=utf-8,' + encodeURIComponent(data.body);
  }
  if (!src) return null;
  // Dimensions are appended by the load handler above — they aren't known until
  // the image decodes.
  const size = data.bodyBytes != null ? formatBytes(data.bodyBytes) : '';
  return '<div class="body-image">'
    + '<img class="body-image-img" src="' + escapeHtml(src) + '" alt="response image preview" />'
    + '<div class="body-image-meta">' + escapeHtml(size) + '</div>'
    + '</div>';
}

function buildBodyHtml(data) {
  // An edited body replaces the captured one here, because it is what a rewrite
  // rule would actually serve. The original is still in the Raw tab.
  if (data.bodyEdited !== undefined) return buildJsonTree(data.bodyEdited);
  const ct = getContentType(data.headers);
  if (IMAGE_CT_RE.test(ct)) {
    const img = buildImageHtml(data, ct);
    if (img) return img;
    return '<span class="body-empty">empty body</span>';
  }
  const raw = data.body;
  // body may be stored as an already-parsed object/array — render as tree directly
  if (raw !== null && raw !== undefined && raw !== '' && typeof raw !== 'string') {
    return buildJsonTree(raw);
  }
  // body is a string (or empty/absent) — check bodyBase64 fallback
  let text = raw || '';
  if (!text && data.bodyBase64) {
    try { text = atob(data.bodyBase64); } catch { text = ''; }
  }
  if (!text) return '<span class="body-empty">empty body</span>';
  if (ct.includes('json') || JSON_START_RE.test(text)) {
    try { return buildJsonTree(JSON.parse(text)); } catch {}
  }
  return '<pre class="body-raw">' + escapeHtml(text) + '</pre>';
}

function buildSectionBody(entry, side, tab) {
  const data = side === 'req' ? entry?.request : entry?.response;
  if (!data) return '<div class="detail-section-body"><span class="body-empty">No data</span></div>';
  let inner;
  if (side === 'res' && editingRes && tab === 'body') inner = buildEditTree(editableJsonBody(data));
  else if (tab === 'raw')     inner = buildJsonTree(data);
  else if (tab === 'headers') inner = buildJsonTree(data.headers || {});
  else                   inner = buildBodyHtml(data);
  return '<div class="detail-section-body">' + inner + '</div>';
}

// The response section grows an editor: Edit while a JSON body is on screen,
// Save/Cancel while editing, and a marker plus Revert once an edit is stored.
function editControlsHtml(data, activeTab) {
  if (editingRes) {
    return '<span class="section-edit">'
      + '<button class="section-btn primary" data-act="edit-save">Save</button>'
      + '<button class="section-btn" data-act="edit-cancel">Cancel</button>'
      + '</span>';
  }
  const edited = data && data.bodyEdited !== undefined;
  // This response was itself served from a rewrite rule — the body on screen
  // never came from the upstream, which is worth saying plainly.
  const from = data && data.rewrittenFrom;
  const notForwarded = data && data.forwarded === false;
  const canEdit = activeTab === 'body' && !!editableJsonBody(data);
  if (!canEdit && !edited && !from && !notForwarded) return '';
  return '<span class="section-edit">'
    + (notForwarded ? '<span class="edited-chip" title="Forwarding was off: the proxy answered this request itself and the upstream never saw it">not forwarded</span>' : '')
    + (from ? '<span class="edited-chip" title="Not from the upstream: this response was served from ' + escapeHtml(from) + '">rewritten</span>' : '')
    + (edited ? '<span class="edited-chip" title="This response body was edited; a rewrite of this URL serves the edited version">edited</span>' : '')
    + (from && data.rewrittenEdited ? '<span class="edited-chip" title="The body served here was hand-edited, not the captured one">edited</span>' : '')
    + (canEdit ? '<button class="section-btn" data-act="edit-start" title="Edit the values in this JSON body">Edit</button>' : '')
    + (edited ? '<button class="section-btn" data-act="edit-revert" title="Discard the edit and go back to the captured body">Revert</button>' : '')
    + '</span>';
}

function sectionHeadHtml(label, side, ct, activeTab, data) {
  const tabsDisabled = side === 'res' && editingRes;
  const tabs = ['body', 'headers', 'raw'].map(t =>
    '<button class="section-tab' + (t === activeTab ? ' active' : '') + (tabsDisabled ? ' disabled' : '')
    + '" data-side="' + side + '" data-tab="' + t + '">'
    + t.charAt(0).toUpperCase() + t.slice(1) + '</button>'
  ).join('');
  return '<div class="detail-section-head">'
    + '<span class="section-label">' + label + '</span>'
    + (ct ? '<span class="section-format">' + escapeHtml(ct) + '</span>' : '')
    + (side === 'res' ? editControlsHtml(data, activeTab) : '')
    + '<span class="section-tabs">' + tabs + '</span>'
    + '</div>';
}

function renderSplitDetail(entry) {
  const req = entry?.request ?? null;
  const res = entry?.response ?? null;
  return ''
    + '<div class="detail-section req">'
    + sectionHeadHtml('Request',  'req', getContentType(req?.headers), detailTabs.req, req)
    + buildSectionBody(entry, 'req', detailTabs.req)
    + '</div>'
    + '<div class="detail-split-handle" title="Drag to resize (double-click to reset)"></div>'
    + '<div class="detail-section res">'
    + sectionHeadHtml('Response', 'res', getContentType(res?.headers), detailTabs.res, res)
    + buildSectionBody(entry, 'res', detailTabs.res)
    + '</div>';
}

// ── Search hits inside the detail panel ────────────────────────────────────

// Every marked occurrence in the currently rendered detail panel, in document
// order, plus which one is currently focused.
let searchHits = [];
let searchHitIndex = -1;

// Wraps every occurrence of `term` under `root` in a .search-hit span. Text
// nodes are collected up front because splitting them mutates the tree the
// walker is traversing.
function markSearchHits(root, term) {
  if (!root || !term) return [];
  const needle = term.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  const marks = [];
  for (const textNode of textNodes) {
    let current = textNode;
    let idx = current.nodeValue.toLowerCase().indexOf(needle);
    while (idx !== -1) {
      const hit = current.splitText(idx);
      const rest = hit.splitText(term.length);
      const mark = document.createElement('span');
      mark.className = 'search-hit';
      mark.textContent = hit.nodeValue;
      hit.parentNode.replaceChild(mark, hit);
      marks.push(mark);
      current = rest;
      idx = current.nodeValue.toLowerCase().indexOf(needle);
    }
  }
  return marks;
}

// Reveals a hit (un-collapsing any JSON nodes above it), scrolls to it and
// selects it so it can be copied straight away.
function focusSearchHit(index) {
  if (!searchHits.length) return;
  searchHitIndex = (index + searchHits.length) % searchHits.length;
  searchHits.forEach((m, i) => m.classList.toggle('current', i === searchHitIndex));
  const mark = searchHits[searchHitIndex];
  for (let el = mark.parentElement; el && el !== detailBodyEl; el = el.parentElement) {
    el.classList.remove('collapsed');
  }
  mark.scrollIntoView({ block: 'center' });
  const range = document.createRange();
  range.selectNodeContents(mark);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  updateSearchHitBadge();
}

function stepSearchHit(delta) {
  if (!searchHits.length) return;
  focusSearchHit(searchHitIndex + delta);
}

function updateSearchHitBadge() {
  if (!searchHits.length) {
    searchHitsEl.style.display = 'none';
    return;
  }
  searchHitsEl.style.display = '';
  searchHitsEl.textContent = (searchHitIndex + 1) + ' / ' + searchHits.length;
}

// Response body first — that's where a deep-search hit is usually interesting —
// but every section is marked so cycling can walk the whole panel.
function highlightInDetail(term) {
  searchHits = [];
  searchHitIndex = -1;
  if (!term) { updateSearchHitBadge(); return; }
  const res = detailBodyEl.querySelector('.detail-section.res .detail-section-body');
  const req = detailBodyEl.querySelector('.detail-section.req .detail-section-body');
  if (res || req) {
    searchHits = [...markSearchHits(res, term), ...markSearchHits(req, term)];
  } else {
    searchHits = markSearchHits(detailBodyEl, term);
  }
  if (searchHits.length) focusSearchHit(0);
  else updateSearchHitBadge();
}

// ═══════════════════════════════════════════════════════════════════════════
// Context menus
// ═══════════════════════════════════════════════════════════════════════════

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function entryRequestUrl(entry) {
  return entry?.request?.upstream?.url || entry?.request?.url || '';
}

// The proxy stores a JSON body already parsed, so `body` is an object as often
// as it is a string. Everything that puts a body into text — cURL, fetch(),
// "copy body" — needs the text form, or it gets "[object Object]".
function entryBody(entry, side) {
  const part = entry?.[side];
  if (!part) return '';
  if (part.body != null && part.body !== '') {
    return typeof part.body === 'string' ? part.body : JSON.stringify(part.body);
  }
  if (part.bodyBase64) {
    try { return atob(part.bodyBase64); } catch { return ''; }
  }
  return '';
}

// Must mirror HOP_BY_HOP in src/scripts/proxy.js, plus the three that
// buildUpstreamHeaders drops separately — otherwise a copied cURL command
// sends headers the proxy itself would have stripped, and reproduces something
// different from what Replay does.
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length', 'accept-encoding',
]);

function buildCurl(entry) {
  const method = entry?.request?.method || 'GET';
  const url = entryRequestUrl(entry);
  const headers = entry?.request?.headers || {};
  const body = entryBody(entry, 'request');
  const parts = ['curl', '-X', method, shellQuote(url)];
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    parts.push('-H', shellQuote(k + ': ' + v));
  }
  if (body) parts.push('--data-raw', shellQuote(body));
  return parts.join(' ');
}

function buildFetch(entry) {
  const method = entry?.request?.method || 'GET';
  const url = entryRequestUrl(entry);
  const headers = {};
  for (const [k, v] of Object.entries(entry?.request?.headers || {})) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const init = { method, headers };
  const body = entryBody(entry, 'request');
  if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
  return 'fetch(' + JSON.stringify(url) + ', ' + JSON.stringify(init, null, 2) + ')';
}

function selectedRowItem() {
  if (!selectedFile) return null;
  return allItems.find((x) => x.file === selectedFile) || null;
}

function selectedRowUrl() {
  const it = selectedRowItem();
  return it ? (it.upstream || it.url || '') : '';
}

function showRowContextMenu(e, tr) {
  e.preventDefault();
  hideOtherMenus(contextMenuEl);
  if (tr && tr.dataset.file) {
    // Right-clicking a row other than the selected one selects it first, so the
    // menu always acts on the row under the cursor.
    if (tr.dataset.file !== selectedFile) {
      openDetail(tr.dataset.file, tr);
    }
  }
  const hasRow = !!selectedFile;
  contextMenuEl.querySelectorAll('.context-menu-item').forEach((el) => {
    el.classList.toggle('disabled', !hasRow);
  });
  // One item, two jobs: it turns the rewrite on, or off again if this URL
  // already has one.
  const rwItem = contextMenuEl.querySelector('[data-action="rewrite"]');
  if (rwItem) {
    const on = hasRow && rewriteRules.has(rewriteKeyFor(selectedRowItem() || {}));
    rwItem.textContent = on ? 'Stop rewriting response' : 'Rewrite response';
    rwItem.title = on
      ? 'Go back to calling the upstream for this URL'
      : 'Answer later requests for this URL with this stored response instead of calling the upstream';
  }
  contextMenuEl.classList.add('open');
  const menuW = contextMenuEl.offsetWidth;
  const menuH = contextMenuEl.offsetHeight;
  const x = Math.min(e.clientX, window.innerWidth - menuW - 4);
  const y = Math.min(e.clientY, window.innerHeight - menuH - 4);
  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
}

function hideContextMenu() {
  contextMenuEl.classList.remove('open');
}

// `label` names what was copied so the toast is specific. Every copy path goes
// through here, so the confirmation is consistent and failures are visible.
async function copyToClipboard(text, label = 'Copied') {
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  showToast(ok ? label : 'Copy failed', ok ? 'ok' : 'err');
  return ok;
}

async function deleteSelectedEntry() {
  if (!selectedFile) return;
  const ok = await confirmDialog({
    title: 'Delete log entry',
    message: 'Delete ' + selectedFile + ' from disk? This cannot be undone.',
    okText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const file = selectedFile;
  try {
    const r = await fetch('/api/entry?file=' + encodeURIComponent(file), { method: 'DELETE', headers: UI_HEADER });
    if (!r.ok) return;
  } catch { return; }
  // The event stream reports the deletion too; applying it here as well keeps
  // the UI immediate, and the second application is a no-op.
  applyStoreChange({ type: 'deleted', file });
}

// Adds the rule if the selected row's URL has none, removes it if it has. The
// server answers with the whole rule set either way, so the UI never has to
// guess what the proxy is actually matching on.
async function toggleRewriteForSelection() {
  const it = selectedRowItem();
  if (!it) return;
  const key = rewriteKeyFor(it);
  const existing = rewriteRules.get(key);
  try {
    const r = existing
      ? await fetch('/api/rewrites?key=' + encodeURIComponent(key), { method: 'DELETE', headers: UI_HEADER })
      : await fetch('/api/rewrites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...UI_HEADER },
          body: JSON.stringify({ file: it.file }),
        });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(data.error || ('HTTP ' + r.status), 'err'); return; }
    applyRewrites(data.items);
    renderView({ autoscroll: false });
    showToast(existing ? 'Rewrite removed' : 'Rewriting this URL from ' + it.file);
  } catch (err) {
    showToast('Rewrite failed: ' + err.message, 'err');
  }
}

contextMenuEl.addEventListener('click', async (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item || item.classList.contains('disabled')) return;
  const action = item.dataset.action;
  hideContextMenu();
  if (action === 'copy-url') {
    const url = selectedRowUrl();
    if (url) await copyToClipboard(url, 'URL copied');
    return;
  }
  if (action === 'open-url') {
    const url = selectedRowUrl();
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (action === 'copy-file') {
    if (selectedFile) await copyToClipboard(selectedFile, 'File name copied');
    return;
  }
  if (action === 'delete') {
    await deleteSelectedEntry();
    return;
  }
  if (action === 'rewrite') {
    await toggleRewriteForSelection();
    return;
  }
  if (action === 'replay') {
    if (!selectedFile) return;
    showToast('Replaying…');
    try {
      const r = await fetch('/api/replay?file=' + encodeURIComponent(selectedFile), {
        method: 'POST', headers: UI_HEADER,
      });
      const data = await r.json();
      if (!r.ok) showToast(data.error || ('HTTP ' + r.status), 'err');
      else if (data.ok) showToast('Replayed — ' + data.status);
      else showToast('Replay failed: ' + data.error, 'err');
    } catch (err) {
      showToast('Replay failed: ' + err.message, 'err');
    }
    return;
  }
  if (action === 'copy-curl' || action === 'copy-fetch' || action === 'copy-req-body' || action === 'copy-res-body') {
    const entry = await ensureSelectedEntry();
    if (!entry) return;
    const labels = {
      'copy-curl': 'cURL copied',
      'copy-fetch': 'fetch() copied',
      'copy-req-body': 'Request body copied',
      'copy-res-body': 'Response body copied',
    };
    let text = '';
    if (action === 'copy-curl') text = buildCurl(entry);
    else if (action === 'copy-fetch') text = buildFetch(entry);
    else if (action === 'copy-req-body') text = entryBody(entry, 'request');
    else if (action === 'copy-res-body') text = entryBody(entry, 'response');
    if (text) await copyToClipboard(text, labels[action]);
    else showToast('Nothing to copy', 'err');
  }
});

document.addEventListener('click', (e) => {
  if (!contextMenuEl.classList.contains('open')) return;
  if (!contextMenuEl.contains(e.target)) hideContextMenu();
});
document.addEventListener('contextmenu', (e) => {
  if (contextMenuEl.classList.contains('open') && !contextMenuEl.contains(e.target) && !e.target.closest('#rows tr')) {
    hideContextMenu();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && contextMenuEl.classList.contains('open')) hideContextMenu();
});
window.addEventListener('blur', hideContextMenu);

// ── Detail-panel JSON context menu ─────────────────────────────────────────

let detailCtxEntry = null; // the .entry (or .kv) element that was right-clicked

// Reconstruct the VALUE of an .entry node as compact JSON by walking the DOM.
// For leaf entries returns the raw JSON token text; for complex nodes recurses.
function domEntryValueJson(entryEl) {
  if (!entryEl.classList.contains('node')) {
    // Leaf — find the value span
    for (const cls of ['tok-str', 'tok-num', 'tok-bool', 'tok-null', 'tok-empty']) {
      const span = entryEl.querySelector(':scope > .' + cls);
      if (span) return span.textContent; // already JSON-encoded
    }
    return 'null';
  }
  // Complex node — walk .children
  const isArr = entryEl.classList.contains('arr');
  const childrenEl = entryEl.querySelector(':scope > .children');
  if (!childrenEl) return isArr ? '[]' : '{}';
  const parts = [];
  for (const child of childrenEl.children) {
    if (!child.classList.contains('entry')) continue;
    if (isArr) {
      parts.push(domEntryValueJson(child));
    } else {
      const keySpan = child.querySelector(':scope > .tok-key');
      if (keySpan) parts.push(keySpan.textContent + ':' + domEntryValueJson(child));
    }
  }
  return (isArr ? '[' : '{') + parts.join(',') + (isArr ? ']' : '}');
}

// Returns { name: string|null, value: string|null } for a given .entry element
// (or a .kv row of the event properties list).
function detailCtxData(entryEl) {
  if (entryEl.classList.contains('kv')) {
    return {
      name: entryEl.querySelector('.k')?.textContent ?? null,
      value: entryEl.querySelector('.v')?.textContent ?? null,
    };
  }
  // Key name (unquoted)
  const keySpan = entryEl.querySelector(':scope > .tok-key');
  let name = null;
  if (keySpan) {
    try { name = JSON.parse(keySpan.textContent); }
    catch { name = keySpan.textContent.replace(/^"|"$/g, ''); }
  }

  // Value for clipboard
  let value = null;
  if (!entryEl.classList.contains('node')) {
    const strSpan = entryEl.querySelector(':scope > .tok-str');
    if (strSpan) {
      try { value = String(JSON.parse(strSpan.textContent)); } // unquoted
      catch { value = strSpan.textContent; }
    } else {
      for (const cls of ['tok-num', 'tok-bool', 'tok-null', 'tok-empty']) {
        const span = entryEl.querySelector(':scope > .' + cls);
        if (span) { value = span.textContent; break; }
      }
    }
  } else {
    // Complex — compact JSON
    value = domEntryValueJson(entryEl);
  }

  return { name, value };
}

function truncateLabel(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function showDetailCtxMenu(clientX, clientY, entry) {
  hideOtherMenus(detailCtxMenuEl);
  detailCtxEntry = entry;
  const { name, value } = detailCtxData(entry);

  dcmCopyNameEl.classList.toggle('disabled', name === null);
  dcmCopyValueEl.classList.toggle('disabled', value === null);
  dcmCopyNameEl.textContent  = name  !== null ? 'Copy name — '  + truncateLabel(name,  40) : 'Copy name';
  dcmCopyValueEl.textContent = value !== null ? 'Copy value — ' + truncateLabel(value, 40) : 'Copy value';

  detailCtxMenuEl.classList.add('open');
  const mw = detailCtxMenuEl.offsetWidth;
  const mh = detailCtxMenuEl.offsetHeight;
  detailCtxMenuEl.style.left = Math.min(clientX, window.innerWidth  - mw - 4) + 'px';
  detailCtxMenuEl.style.top  = Math.min(clientY, window.innerHeight - mh - 4) + 'px';
}

function hideDetailCtxMenu() {
  detailCtxMenuEl.classList.remove('open');
  detailCtxEntry = null;
}

// Right-click inside the detail body — only when over a JSON .entry element or
// an event property row.
detailBodyEl.addEventListener('contextmenu', (e) => {
  const entry = e.target.closest('.entry, .kv');
  if (!entry) return; // let browser default handle non-entry areas
  e.preventDefault();
  e.stopPropagation(); // prevent document handler from immediately closing the menu
  showDetailCtxMenu(e.clientX, e.clientY, entry);
});

detailCtxMenuEl.addEventListener('click', async (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item || item.classList.contains('disabled') || !detailCtxEntry) return;
  const { name, value } = detailCtxData(detailCtxEntry);
  hideDetailCtxMenu();
  if (item === dcmCopyNameEl  && name  !== null) await copyToClipboard(name, 'Name copied');
  if (item === dcmCopyValueEl && value !== null) await copyToClipboard(value, 'Value copied');
});

document.addEventListener('click', (e) => {
  if (detailCtxMenuEl.classList.contains('open') && !detailCtxMenuEl.contains(e.target)) hideDetailCtxMenu();
});
document.addEventListener('contextmenu', (e) => {
  if (detailCtxMenuEl.classList.contains('open') && !detailCtxMenuEl.contains(e.target)) hideDetailCtxMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailCtxMenuEl.classList.contains('open')) hideDetailCtxMenu();
});
window.addEventListener('blur', hideDetailCtxMenu);

// ═══════════════════════════════════════════════════════════════════════════
// Console (one line per incoming request)
// ═══════════════════════════════════════════════════════════════════════════

let consoleSeq = 0;             // seq of the newest console line we have
const CONSOLE_MAX_DOM = 2000;   // lines kept in the DOM
const consoleLinesEl = $('console-lines');
const consoleAutoscrollEl = $('console-autoscroll');

function consoleStatusClass(st) {
  if (/^2\d\d$/.test(st)) return 'ok';
  if (/^[45]\d\d$/.test(st)) return 'err';
  if (/^3\d\d$|CLEAR_VIEW/.test(st)) return 'warn';
  return 'err'; // upstream error text / NO_UPSTREAM
}

function consoleLineHtml(l) {
  const title = '[' + l.ts + '] ' + l.method + ' ' + l.url + ' -> ' + l.status + (l.note ? ' ' + l.note : '');
  return '<div class="cl" title="' + escapeHtml(title) + '">'
    + '<span class="cl-ts">' + escapeHtml(formatTime(l.ts) || l.ts) + '</span>'
    + '<span class="cl-m">' + escapeHtml(l.method) + '</span>'
    + '<span class="cl-url">' + escapeHtml(l.url) + '</span>'
    + '<span class="cl-st ' + consoleStatusClass(l.status) + '">→ ' + escapeHtml(l.status) + '</span>'
    + (l.note ? '<span class="cl-note">' + escapeHtml(l.note) + '</span>' : '')
    + '</div>';
}

function appendConsole(lines) {
  if (!lines || !lines.length) return;
  const empty = $('console-empty');
  if (empty) empty.remove();
  let html = '';
  for (const l of lines) {
    if (l.seq <= consoleSeq) continue;
    consoleSeq = l.seq;
    html += consoleLineHtml(l);
  }
  if (!html) return;
  consoleLinesEl.insertAdjacentHTML('beforeend', html);
  while (consoleLinesEl.childElementCount > CONSOLE_MAX_DOM) consoleLinesEl.removeChild(consoleLinesEl.firstElementChild);
  $('console-info').textContent = consoleLinesEl.childElementCount + ' lines';
  if (consoleAutoscrollEl.checked) consoleLinesEl.scrollTop = consoleLinesEl.scrollHeight;
}

function resetConsole() {
  consoleLinesEl.innerHTML = '<div id="console-empty">No requests yet.</div>';
  $('console-info').textContent = '0 lines';
}

// Drag the console's top edge to change its height (persisted).
const CONSOLE_MIN_H = 60;
(function initConsole() {
  const panel = $('console');
  if (typeof uiState.consoleHeight === 'number' && uiState.consoleHeight >= CONSOLE_MIN_H) {
    panel.style.setProperty('--console-h', uiState.consoleHeight + 'px');
  }
  $('console-resizer').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = consoleLinesEl.getBoundingClientRect().height;
    const maxH = Math.max(CONSOLE_MIN_H, window.innerHeight - 250);
    const stickToBottom = consoleAutoscrollEl.checked;
    panel.classList.add('resizing');
    document.body.classList.add('resizing-console');
    let h = startH;
    const onMove = (ev) => {
      h = Math.min(maxH, Math.max(CONSOLE_MIN_H, startH + (startY - ev.clientY)));
      panel.style.setProperty('--console-h', h + 'px');
      if (stickToBottom) consoleLinesEl.scrollTop = consoleLinesEl.scrollHeight;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      panel.classList.remove('resizing');
      document.body.classList.remove('resizing-console');
      uiState.consoleHeight = Math.round(h);
      saveUiState();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  const setCollapsed = (on) => {
    panel.classList.toggle('collapsed', on);
    uiState.consoleCollapsed = on;
    saveUiState();
  };
  setCollapsed(!!uiState.consoleCollapsed);
  $('console-toggle').addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  $('console-clear').addEventListener('click', async () => {
    await fetch('/api/console/clear', { method: 'POST', headers: UI_HEADER });
    resetConsole();
  });
  resetConsole();
})();

// ═══════════════════════════════════════════════════════════════════════════
// Settings dialog
// ═══════════════════════════════════════════════════════════════════════════

configBtn.onclick = openConfig;
// Entry point for the desktop app's File → Settings menu. The menu runs in the
// Electron main process and can only reach the UI through a renderer global,
// so expose one deliberately rather than having it click a DOM id from afar.
window.openSettings = openConfig;
$('cfg-cancel').onclick = closeConfig;
$('cfg-save').onclick = saveConfigForm;
configModalEl.addEventListener('click', (e) => { if (e.target === configModalEl) closeConfig(); });
for (const el of [cfgPortEl, cfgUrlPrefixEl, cfgClearViewPatternEl, cfgMaxLogFilesEl, cfgMaxLogMbEl]) {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveConfigForm(); });
}
// Preview only — not persisted until Save.
cfgThemeEl.addEventListener('change', () => applyTheme(cfgThemeEl.value));

const configTabsEl = $('config-tabs');
const configPanelsEl = configModalEl.querySelector('.config-panels');
function activateConfigTab(tab) {
  configTabsEl.querySelectorAll('button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  configPanelsEl.querySelectorAll('section[data-panel]').forEach((s) => s.classList.toggle('active', s.dataset.panel === tab));
}
configTabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) activateConfigTab(btn.dataset.tab);
});

// Clear-session URL shown read-only. Prefer the host the browser used to reach
// the GUI (if it's a real LAN address, the device uses the same network); fall
// back to the server's detected LAN IP when the GUI is opened via localhost.
function clearViewUrl(cfg) {
  if (!cfg.clearViewUrl) return '(disabled)';
  const h = location.hostname;
  if (h && h !== 'localhost' && h !== '127.0.0.1') {
    const tail = cfg.clearViewPattern && cfg.clearViewPattern.startsWith('/')
      ? cfg.clearViewPattern : '/' + (cfg.clearViewPattern || '');
    return 'http://' + h + ':' + cfg.port + tail;
  }
  return cfg.clearViewUrl;
}

// Theme is a browser preference, not proxy config, so it is not part of the
// POST payload. It previews live and is only committed on Save — Cancel and
// Escape put back whatever was active when the dialog opened.
let themeOnOpen = null;

async function openConfig() {
  cfgErrorEl.textContent = '';
  themeOnOpen = uiState.theme === 'light' ? 'light' : 'dark';
  cfgThemeEl.value = themeOnOpen;
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    cfgPortEl.value = cfg.port;
    cfgUrlPrefixEl.value = cfg.urlPrefix || '';
    cfgRoutesEl.value = (cfg.routes || []).map((rt) => rt.prefix + ' ' + rt.upstream).join('\n');
    cfgClearViewPatternEl.value = cfg.clearViewPattern || '';
    cfgClearViewUrlEl.value = clearViewUrl(cfg);
    cfgRewriteResponseUrlsEl.checked = !!cfg.rewriteResponseUrls;
    cfgRewriteM3u8UrlsEl.checked = !!cfg.rewriteM3u8Urls;
    cfgMaxLogFilesEl.value = cfg.maxLogFiles || 0;
    // Stored in bytes, shown in MB — nobody wants to type 104857600.
    cfgMaxLogMbEl.value = cfg.maxLogBytes ? Math.round(cfg.maxLogBytes / (1024 * 1024)) : 0;
  } catch (err) {
    cfgErrorEl.textContent = 'failed to load config: ' + err.message;
  }
  activateConfigTab('general');
  configModalEl.classList.add('open');
  cfgPortEl.focus();
  cfgPortEl.select();
}

// Cancel/Escape/backdrop all land here, so reverting the live preview once
// covers every way out of the dialog that is not Save.
function closeConfig() {
  if (themeOnOpen !== null) {
    applyTheme(themeOnOpen);
    themeOnOpen = null;
  }
  configModalEl.classList.remove('open');
  cfgErrorEl.textContent = '';
}

async function saveConfigForm() {
  cfgErrorEl.textContent = '';
  const payload = {
    port: Number(cfgPortEl.value),
    urlPrefix: cfgUrlPrefixEl.value,
    routes: cfgRoutesEl.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [prefix, upstream] = l.split(/[\s=]+/);
      return { prefix, upstream };
    }),
    clearViewPattern: cfgClearViewPatternEl.value,
    rewriteResponseUrls: cfgRewriteResponseUrlsEl.checked,
    rewriteM3u8Urls: cfgRewriteM3u8UrlsEl.checked,
    maxLogFiles: Number(cfgMaxLogFilesEl.value) || 0,
    maxLogBytes: (Number(cfgMaxLogMbEl.value) || 0) * 1024 * 1024,
  };
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...UI_HEADER },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      cfgErrorEl.textContent = data.error || ('HTTP ' + r.status);
      return;
    }
    if (data.state) applyState(data.state);
    // Commit the previewed theme, then close without the revert.
    setTheme(cfgThemeEl.value);
    themeOnOpen = null;
    closeConfig();
  } catch (err) {
    cfgErrorEl.textContent = err.message;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Server sync: full refresh, incremental frames, fallback polling
// ═══════════════════════════════════════════════════════════════════════════

function setItems(next) {
  allItems = next;
  itemsVersion += 1;
}

// Full refresh of the request list. Used on load, on every (re)connect of the
// event stream, and by the fallback poll — anything that needs to
// resynchronise from scratch.
async function pollRequests() {
  const r = await fetch('/api/list');
  const data = await r.json();
  if (data.state) applyState(data.state);
  if (typeof data.diskBytes === 'number') lastDiskBytes = data.diskBytes;
  const rewritesChanged = data.rewrites ? applyRewrites(data.rewrites) : false;
  const changed = data.total !== allItems.length
    || (allItems.length && data.items[data.items.length - 1]?.file !== allItems[allItems.length - 1].file);
  if (changed) setItems(data.items);
  return changed || rewritesChanged;
}

// Same for the decoded events. Incremental when possible: `since` the newest
// row we hold, falling back to everything if the totals disagree (a delete or
// clear).
let analyticsLoaded = false;
async function pollAnalytics({ full = false } = {}) {
  const lastId = !full && eventRows.length ? eventRows[eventRows.length - 1].id : null;
  const url = '/api/analytics?cseq=' + consoleSeq + (lastId ? '&since=' + encodeURIComponent(lastId) : '');
  const r = await fetch(url);
  const data = await r.json();
  appendConsole(data.console);
  if (!analyticsLoaded && data.providers) {
    providers = data.providers;
    columnsByProvider = data.columns || {};
    analyticsLoaded = true;
    refreshProviderFilter();
  }
  if (data.state) applyState(data.state);
  let changed = false;
  if (lastId && data.total !== eventRows.length + data.rows.length) {
    const all = await fetch('/api/analytics').then((x) => x.json());
    ingestEventRows(all.rows, true);
    changed = true;
  } else {
    changed = ingestEventRows(data.rows, !lastId && data.rows.length !== eventRows.length) > 0;
  }
  return changed;
}

async function poll() {
  try {
    const [a, b] = await Promise.all([pollRequests(), pollAnalytics()]);
    if (a || b) renderView();
    else updateStats();
  } catch {}
}

// Applies one incremental change rather than re-fetching the whole capture.
function applyStoreChange(change) {
  if (typeof change.diskBytes === 'number') lastDiskBytes = change.diskBytes;
  if (change.type === 'entry') {
    if (allItems.some((it) => it.file === change.summary.file)) return;
    allItems.push(change.summary);
    itemsVersion += 1;
    ingestEventRows(change.events, false);
  } else if (change.type === 'updated') {
    // An entry rewritten in place — today that means its response body was
    // edited. Keep the row's position, swap the summary and its events.
    const idx = allItems.findIndex((it) => it.file === change.summary.file);
    if (idx === -1) return;
    allItems[idx] = change.summary;
    itemsVersion += 1;
    replaceEventRows(change.summary.file, change.events);
  } else if (change.type === 'deleted') {
    const before = allItems.length;
    setItems(allItems.filter((it) => it.file !== change.file));
    dropEventRows(new Set([change.file]));
    if (allItems.length === before) return updateStats();
    if (selectedFile === change.file) closeDetail();
  } else if (change.type === 'evicted') {
    const gone = new Set(change.files);
    setItems(allItems.filter((it) => !gone.has(it.file)));
    dropEventRows(gone);
    if (gone.has(selectedFile)) closeDetail();
  } else if (change.type === 'cleared') {
    setItems([]);
    ingestEventRows([], true);
    closeDetail();
  } else {
    return;
  }
  renderView();
}

// Push beats polling, but only if it actually connects: if the stream never
// opens (or the browser has no EventSource) fall back to a 1s poll.
let fallbackTimer = null;

function startFallbackPolling() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(poll, 1000);
}

function stopFallbackPolling() {
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}

function connectEventStream() {
  if (typeof EventSource === 'undefined') { startFallbackPolling(); return; }
  const source = new EventSource('/api/events');

  // Fires on first connect and on every automatic reconnect; a full refresh
  // here closes any gap while the stream was down.
  source.addEventListener('open', () => {
    stopFallbackPolling();
    poll();
  });
  source.addEventListener('state', (e) => {
    try { applyState(JSON.parse(e.data)); } catch {}
  });
  source.addEventListener('store', (e) => {
    try { applyStoreChange(JSON.parse(e.data)); } catch {}
  });
  source.addEventListener('console', (e) => {
    try { appendConsole([JSON.parse(e.data)]); } catch {}
  });
  // Rules can also change without this browser asking: another window toggling
  // one, or the proxy dropping a rule whose entry was deleted or evicted.
  source.addEventListener('rewrites', (e) => {
    try {
      if (applyRewrites(JSON.parse(e.data).items)) renderView({ autoscroll: false });
    } catch {}
  });
  // Only ever sent by the dev scripts, when a file under src/components changes.
  source.addEventListener('reload', () => location.reload());
  source.addEventListener('error', () => {
    // EventSource retries on its own; poll meanwhile so the UI stays live.
    startFallbackPolling();
  });

  // If it never opens at all, make sure something is still updating the view.
  setTimeout(() => { if (source.readyState !== EventSource.OPEN) startFallbackPolling(); }, 3000);
}

// ── Boot ───────────────────────────────────────────────────────────────────
// Applied once, before the first render, so the page comes up the way it was
// left rather than flashing defaults first.
(function applyRestoredUiState() {
  // Re-applied here as well as in the inline head script, so the attribute is
  // right even if localStorage was unreadable at that point.
  applyTheme(uiState.theme);
  sortBy = uiState.sortBy;
  sortDir = uiState.sortDir === 'desc' ? 'desc' : 'asc';
  groupByDomain = !!uiState.groupByDomain;
  groupByDomainEl.checked = groupByDomain;
  autoscrollEl.checked = uiState.autoscroll !== false;
  if (typeof uiState.detailWidth === 'number' && uiState.detailWidth >= MIN_DETAIL_WIDTH) {
    detailEl.style.width = uiState.detailWidth + 'px';
    detailEl.style.maxWidth = 'none';
  }
})();

renderHead();
poll();
connectEventStream();
