'use strict';

// ---- state ----
let providers = [];        // [{id,label}] from the server, in display order
let columnsByProvider = {}; // provider id -> curated columns [{key,label,width,num,combo}]
let headSig = '';          // signature of the currently rendered column set
let rows = [];             // every decoded event row we know about
const idSet = new Set();   // row ids we already have (for incremental polling)
let lastId = null;         // id of the most recent row, for /api/events?since=
let filtered = [];         // rows currently displayed
let selectedId = null;
let eventTypes = new Map(); // provider id -> Set of event names seen
let proxyListening = true;
let recording = true;
let forwarding = true;
let lastClearViewAt = null;
let stateInitialized = false; // suppresses the toast for a stale clear on first load
let hiddenBefore = null;   // "clear view": hide rows up to and including this id

const $ = (id) => document.getElementById(id);

// Create an element with optional class and text content.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Display cap: render only the most recent N events (0 = all). Display-only —
// it never deletes logs; all requests stay on disk and in memory.
let eventCap = (() => {
  const raw = localStorage.getItem('mux.eventCap');
  if (raw === null) return 500; // unset -> default (Number(null) is 0, so guard explicitly)
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 500;
})();

function fmtBytes(n) {
  if (n == null) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}

// meta columns rendered by the client, before the curated property columns
const META_COLS = [
  { key: '_idx', label: '#', width: 56, num: true },
  { key: '_request', label: 'req', width: 56, num: true },
  { key: '_time', label: 'time', width: 110 },
  { key: '_provider', label: 'provider', width: 90 },
];

// Selected provider ('' = all). Drives both the row filter and the column layout.
let providerFilter = localStorage.getItem('logger.provider') || '';

function providerLabel(id) {
  return (providers.find((p) => p.id === id) || {}).label || id;
}

// Columns for the current selection: the chosen provider's layout, or — for
// "All providers" — the union of layouts of every provider present in `list`
// (so a Mux-only session still looks exactly like the Mux layout).
function activeColumns(list) {
  const ids = providerFilter
    ? [providerFilter]
    : providers.map((p) => p.id).filter((id) => list.some((r) => r.provider === id));
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    for (const c of columnsByProvider[id] || []) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      out.push(c);
    }
  }
  if (!out.length && !providerFilter) {
    // nothing displayed yet: show the first provider's layout as a placeholder
    const first = providers[0] && columnsByProvider[providers[0].id];
    if (first) out.push(...first);
  }
  return [...META_COLS, ...out];
}

function eventClass(ev) {
  if (!ev) return '';
  if (ev === 'error' || ev === 'aderror') return 'err';
  if (ev.startsWith('ad')) return 'ad';
  if (ev === 'viewstart' || ev === 'viewend') return 'view';
  if (ev === 'playerready' || ev === 'hb') return 'life';
  return '';
}

function fmtTime(row) {
  const ms = row.viewerTime || (row.ts ? Date.parse(row.ts) : NaN);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function cellValue(row, col) {
  if (col.key === '_idx') return row._seq;
  if (col.key === '_request') return row.request;
  if (col.key === '_time') return fmtTime(row);
  if (col.key === '_provider') return providerLabel(row.provider);
  return row.props[col.key];
}

// ms -> "HH:MM:SS" (hours always shown, zero-padded).
function fmtHMS(ms) {
  let s = Math.floor(Number(ms) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); const sec = s - m * 60;
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function fmtCell(row, col) {
  if (col.key === '_provider') return el('span', 'prov ' + row.provider, providerLabel(row.provider));
  if (col.key === 'event') {
    const cls = eventClass(row.event);
    return el('span', 'ev' + (cls ? ' ' + cls : ''), row.event || '');
  }
  if (col.combo === 'playhead') {
    const ms = row.props.player_playhead_time;
    if (ms == null || !Number.isFinite(Number(ms))) return document.createTextNode('');
    const secs = Math.round(Number(ms) / 100) / 10; // seconds, 1 decimal
    return document.createTextNode(`${fmtHMS(ms)} | ${secs}s`);
  }
  const raw = cellValue(row, col);
  return document.createTextNode(raw == null || raw === '' ? '' : String(raw));
}

// ---- header ----
function renderHead(cols) {
  const head = $('head-row');
  head.innerHTML = '';
  for (const col of cols) {
    const th = document.createElement('th');
    th.textContent = col.label;
    if (col.num) th.className = 'num';
    if (col.width) th.style.width = col.width + 'px';
    head.appendChild(th);
  }
}

// ---- filtering ----
// Lowercased "event request provider key value key value …" blob, computed once per row
// at ingest so the free-text filter is a single substring test (see ingest).
function searchBlob(r) {
  const parts = [r.event, r.request, r.provider];
  for (const [k, v] of Object.entries(r.props)) { parts.push(k); if (v != null) parts.push(v); }
  return parts.join(' ').toLowerCase();
}

function computeFiltered() {
  const q = $('filter').value.trim().toLowerCase();
  const evSel = $('event-filter').value;
  let base = rows;
  if (hiddenBefore) {
    const idx = rows.findIndex((r) => r.id === hiddenBefore);
    if (idx !== -1) base = rows.slice(idx + 1);
  }
  filtered = base.filter((r) => {
    if (providerFilter && r.provider !== providerFilter) return false;
    if (evSel && r.event !== evSel) return false;
    return !q || r._search.includes(q);
  });
}

// ---- grid ----
const collapsed = new Set(); // request numbers whose events are hidden

function buildRow(r, cols) {
  const tr = document.createElement('tr');
  tr.dataset.id = r.id;
  if (r.id === selectedId) tr.classList.add('selected');
  for (const col of cols) {
    const td = document.createElement('td');
    if (col.num) td.className = 'num';
    if (col.key === '_idx' || col.key === '_request') td.classList.add('muted');
    td.appendChild(fmtCell(r, col));
    tr.appendChild(td);
  }
  tr.addEventListener('click', () => openDetail(r.id));
  return tr;
}

const MAX_HEADER_BADGES = 12;

function buildGroupHeader(grp, colspan) {
  const tr = el('tr', 'group-header');
  const td = document.createElement('td');
  td.colSpan = colspan;

  const arrow = el('span', 'gh-arrow', collapsed.has(grp.request) ? '▶' : '▼');
  const title = el('span', 'gh-title', `Request #${grp.request}`);

  const first = grp.rows[0];
  const n = grp.rows.length;
  const meta = el('span', 'gh-meta', [
    fmtTime(first),
    providerLabel(first.provider),
    first.upstream,
    `${n} event${n > 1 ? 's' : ''}`,
    first.error ? 'ERR' : first.status,
    first.forwarded === false ? 'not forwarded' : null,
  ].filter((x) => x != null && x !== '').join(' · '));

  const badges = el('span', 'gh-badges');
  grp.rows.slice(0, MAX_HEADER_BADGES).forEach((r) => {
    const cls = eventClass(r.event);
    badges.appendChild(el('span', 'ev' + (cls ? ' ' + cls : ''), r.event));
  });
  if (n > MAX_HEADER_BADGES) badges.appendChild(el('span', 'gh-more', `+${n - MAX_HEADER_BADGES}`));

  td.append(arrow, title, meta, badges);
  tr.appendChild(td);
  tr.addEventListener('click', () => toggleCollapse(grp.request));
  return tr;
}

function toggleCollapse(request) {
  if (collapsed.has(request)) collapsed.delete(request);
  else collapsed.add(request);
  render();
}

function render() {
  computeFiltered();
  // Display cap: keep only the most recent N events of those matching the filter.
  const display = (eventCap > 0 && filtered.length > eventCap) ? filtered.slice(-eventCap) : filtered;

  const tbody = $('rows');
  const cols = activeColumns(display);
  const sig = cols.map((c) => c.key).join(',');
  if (sig !== headSig) { headSig = sig; renderHead(cols); }
  const grid = $('grid');
  const grouped = $('group-requests').checked;
  const atBottom = grid.scrollHeight - grid.scrollTop - grid.clientHeight < 40;

  const frag = document.createDocumentFragment();
  if (grouped) {
    // group consecutive displayed rows by request (rows are already in order)
    const groups = [];
    let g = null;
    for (const r of display) {
      if (!g || g.request !== r.request) { g = { request: r.request, rows: [] }; groups.push(g); }
      g.rows.push(r);
    }
    for (const grp of groups) {
      frag.appendChild(buildGroupHeader(grp, cols.length));
      if (!collapsed.has(grp.request)) {
        for (const r of grp.rows) frag.appendChild(buildRow(r, cols));
      }
    }
  } else {
    for (const r of display) frag.appendChild(buildRow(r, cols));
  }
  tbody.innerHTML = '';
  tbody.appendChild(frag);

  const caBtn = $('collapse-all');
  caBtn.style.display = grouped ? '' : 'none';
  if (grouped) {
    const reqs = [...new Set(display.map((r) => r.request))];
    const allCollapsed = reqs.length > 0 && reqs.every((b) => collapsed.has(b));
    caBtn.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
  }
  $('empty').style.display = display.length ? 'none' : 'flex';
  $('stat-shown').textContent = (display.length < filtered.length)
    ? `${display.length} of ${filtered.length}` : display.length;
  if ($('autoscroll').checked && atBottom) grid.scrollTop = grid.scrollHeight;

  renderTimeline();
}

// Collapse all visible requests, or expand them all if everything is collapsed.
function toggleCollapseAll() {
  const reqs = [...new Set(filtered.map((r) => r.request))];
  const allCollapsed = reqs.length > 0 && reqs.every((b) => collapsed.has(b));
  if (allCollapsed) {
    reqs.forEach((b) => collapsed.delete(b));
  } else {
    reqs.forEach((b) => collapsed.add(b));
  }
  render();
}

// ---- detail panel ----
function openDetail(id) {
  const r = rows.find((x) => x.id === id);
  if (!r) return;
  selectedId = id;
  document.querySelectorAll('#rows tr').forEach((tr) => {
    tr.classList.toggle('selected', tr.dataset.id === id);
  });
  $('detail').classList.add('open');
  $('detail-title').textContent = `${r.event || 'event'}  ·  ${providerLabel(r.provider)} · request ${r.request} · #${r.idx + 1}`;
  $('detail-raw').dataset.file = r.file;
  renderDetailProps(r);
  updateTickSelection();
}

function kv(k, v) {
  const row = el('div', 'kv');
  row.appendChild(el('div', 'k', k));
  row.appendChild(el('div', 'v', v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))));
  return row;
}

function sectionTitle(t) {
  return el('div', 'section-title', t);
}

function renderDetailProps(r) {
  const body = $('detail-body');
  body.innerHTML = '';

  body.appendChild(sectionTitle('request'));
  body.appendChild(kv('request #', r.request));
  body.appendChild(kv('provider', providerLabel(r.provider)));
  body.appendChild(kv('event index in request', r.idx));
  body.appendChild(kv('received', r.ts));
  body.appendChild(kv('upstream status', r.error ? `ERROR: ${r.error}` : (r.forwarded === false ? `${r.status} (not forwarded)` : r.status)));
  body.appendChild(kv('upstream host', r.upstream));
  body.appendChild(kv('log file', r.file));

  const curatedKeys = (columnsByProvider[r.provider] || []).map((c) => c.key);
  const all = Object.keys(r.props);
  const rest = all.filter((k) => !curatedKeys.includes(k)).sort();
  const ordered = [...curatedKeys.filter((k) => k in r.props), ...rest];

  body.appendChild(sectionTitle(`event properties (${ordered.length})`));
  for (const k of ordered) body.appendChild(kv(k, r.props[k]));
}

async function showRawRequest(file) {
  if (!file) return;
  try {
    const txt = await fetch('/api/entry?file=' + encodeURIComponent(file)).then((r) => r.text());
    const body = $('detail-body');
    body.innerHTML = '';
    body.appendChild(sectionTitle('raw logged request (as received; body exactly as sent upstream)'));
    const pre = document.createElement('pre');
    pre.className = 'v';
    pre.style.padding = '8px 12px';
    pre.style.whiteSpace = 'pre-wrap';
    try { pre.textContent = JSON.stringify(JSON.parse(txt), null, 2); }
    catch { pre.textContent = txt; }
    body.appendChild(pre);
  } catch { /* ignore */ }
}

function closeDetail() {
  $('detail').classList.remove('open');
  selectedId = null;
  document.querySelectorAll('#rows tr.selected').forEach((tr) => tr.classList.remove('selected'));
  updateTickSelection();
}

// ---- viewer timeline ----
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

// Rows that make up the current session view (clear-view applied, but NOT the
// table's text/event-type filters — the timeline is a whole-session overview).
function sessionRows() {
  if (!hiddenBefore) return rows;
  const idx = rows.findIndex((r) => r.id === hiddenBefore);
  return idx === -1 ? rows : rows.slice(idx + 1);
}

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
  let state = 'startup';
  let segStart = t0;
  const segments = [];
  for (const r of evs) {
    const ns = stateOf(r.event);
    if (ns && ns !== state) {
      if (r.viewerTime > segStart) segments.push({ state, start: segStart, end: r.viewerTime });
      state = ns;
      segStart = r.viewerTime;
    }
  }
  if (t1 > segStart) segments.push({ state, start: segStart, end: t1 });
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

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let lastViewSig = '';

function renderTimeline() {
  const views = splitViews(sessionRows());
  const sel = $('tl-view');

  // (re)build the selector only when the set of views changes, so it doesn't
  // flicker or fight the user's current choice on every poll.
  const sig = views.map((v) => v.start + ':' + v.rows.length).join('|');
  if (sig !== lastViewSig) {
    lastViewSig = sig;
    const prev = sel.value;
    let opts = '<option value="latest">Latest view</option>';
    views.forEach((v, i) => {
      opts += `<option value="${i}">View ${i + 1} · ${fmtClock(v.start)} · ${v.rows.length} ev</option>`;
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

  if (!views.length) { $('tl-info').textContent = 'no events'; return; }

  const choice = sel.value;
  const view = choice === 'latest' ? views[views.length - 1] : (views[Number(choice)] || views[views.length - 1]);
  const data = buildTimeline(view.rows);
  if (!data) { $('tl-info').textContent = 'no events'; return; }

  const { segments, ticks, t0, span } = data;
  for (const s of segments) {
    if (s.state === 'end') continue;
    const seg = el('div', 'tl-seg s-' + s.state);
    seg.style.left = ((s.start - t0) / span * 100) + '%';
    seg.style.width = Math.max((s.end - s.start) / span * 100, 0.2) + '%';
    const dur = ((s.end - s.start) / 1000).toFixed(1);
    seg.dataset.tip = `${STATE_LABELS[s.state]}|${fmtRel(s.start - t0)} – ${fmtRel(s.end - t0)}  (${dur}s)`;
    track.appendChild(seg);
  }
  for (const tk of ticks) {
    const cls = eventClass(tk.event);
    const tick = el('div', 'tl-tick' + (cls ? ' ev-' + cls : ''));
    if (tk.id === selectedId) tick.classList.add('selected');
    tick.style.left = ((tk.t - t0) / span * 100) + '%';
    tick.dataset.id = tk.id;
    tick.dataset.tip = `${tk.event}|${fmtRel(tk.t - t0)}`;
    tick.addEventListener('click', () => openDetail(tk.id));
    ticksEl.appendChild(tick);
  }
  const totalSec = span / 1000;
  const step = niceStep(totalSec);
  for (let s = 0; s <= totalSec + 1e-6; s += step) {
    const label = el('div', 'tl-axis-label', fmtRel(s * 1000));
    label.style.left = (totalSec ? s / totalSec * 100 : 0) + '%';
    axisEl.appendChild(label);
  }
  const vidLabel = view.viewId ? ` · view_id ${view.viewId.slice(0, 8)}…` : '';
  $('tl-info').textContent = `${ticks.length} events · ${fmtRel(span)} span${vidLabel}`;
}

function updateTickSelection() {
  document.querySelectorAll('#tl-ticks .tl-tick').forEach((t) => {
    t.classList.toggle('selected', t.dataset.id === selectedId);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Transient notification that auto-hides after `ms` (default 5s).
let toastTimer = null;
function showToast(title, sub, ms = 5000) {
  const t = $('toast');
  t.innerHTML = `<div class="t-title">${escapeHtml(title)}</div>` +
    (sub ? `<div class="t-sub">${escapeHtml(sub)}</div>` : '');
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function initTimelineTooltip() {
  const wrap = $('tl-track-wrap');
  const tip = $('tl-tooltip');
  wrap.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.style.display = 'none'; return; }
    const [main, sub] = el.dataset.tip.split('|');
    tip.innerHTML = `<span class="t-state">${escapeHtml(main)}</span>` +
      (sub ? `<br><span class="t-sub">${escapeHtml(sub)}</span>` : '');
    tip.style.display = 'block';
    const r = wrap.getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 12, wrap.clientWidth - tip.offsetWidth - 4);
    tip.style.left = Math.max(0, x) + 'px';
    tip.style.top = Math.max(0, e.clientY - r.top - tip.offsetHeight - 8) + 'px';
  });
  wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

// ---- provider / event-type dropdowns ----
function refreshProviderFilter() {
  const sel = $('provider-filter');
  sel.innerHTML = '<option value="">All providers</option>' +
    providers.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
  if (!providers.some((p) => p.id === providerFilter)) providerFilter = '';
  sel.value = providerFilter;
}

// Event names of the selected provider (or of all providers when none is selected).
function refreshEventFilter() {
  const sel = $('event-filter');
  const cur = sel.value;
  const types = new Set();
  for (const [prov, set] of eventTypes) {
    if (providerFilter && prov !== providerFilter) continue;
    for (const t of set) types.add(t);
  }
  const sorted = [...types].sort();
  sel.innerHTML = '<option value="">All events</option>' +
    sorted.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  sel.value = sorted.includes(cur) ? cur : '';
}

// ---- state / switches ----
function setSwitch(id, on, label) {
  const sw = $(id);
  sw.classList.toggle('on', on);
  sw.classList.toggle('off', !on);
  sw.setAttribute('aria-checked', String(on));
  sw.querySelector('.switch-label').textContent = label;
}

function applyState(state) {
  if (!state) return;
  proxyListening = !!state.listening;
  recording = !!state.recording;
  forwarding = !!state.forwarding;

  setSwitch('toggle-proxy', proxyListening, proxyListening ? `proxy :${state.port}` : 'proxy off');
  setSwitch('toggle-rec', recording, recording ? 'recording' : 'paused');
  setSwitch('toggle-fwd', forwarding, forwarding ? 'forwarding' : 'not forwarding');

  $('stat-events').textContent = state.events ?? rows.length;
  $('stat-requests').textContent = state.requests ?? 0;
  $('stat-size').textContent = fmtBytes(state.diskBytes);

  if (state.clearViewAt && state.clearViewAt !== lastClearViewAt) {
    lastClearViewAt = state.clearViewAt;
    hiddenBefore = rows.length ? rows[rows.length - 1].id : null;
    if (stateInitialized) showToast('Session cleared', 'Logs deleted by a /session/clear request');
  }
  stateInitialized = true;
}

// ---- ingest / poll ----
function ingest(newRows, replace) {
  if (replace) { rows = []; idSet.clear(); eventTypes = new Map(); lastId = null; }
  let added = 0;
  for (const r of newRows) {
    if (idSet.has(r.id)) continue;
    idSet.add(r.id);
    r._seq = rows.length + 1;
    r._search = searchBlob(r);
    rows.push(r);
    if (r.event) {
      if (!eventTypes.has(r.provider)) eventTypes.set(r.provider, new Set());
      eventTypes.get(r.provider).add(r.event);
    }
    added++;
  }
  if (rows.length) lastId = rows[rows.length - 1].id;
  if (added) refreshEventFilter();
  return added;
}

async function poll() {
  try {
    const url = lastId ? '/api/events?since=' + encodeURIComponent(lastId) : '/api/events';
    const data = await fetch(url).then((r) => r.json());
    if (!providers.length && data.providers) {
      providers = data.providers;
      columnsByProvider = data.columns || {};
      refreshProviderFilter();
    }
    applyState(data.state);

    if (data.total < rows.length) {
      const full = await fetch('/api/events').then((r) => r.json());
      ingest(full.rows, true);
      render();
    } else if (ingest(data.rows, false) > 0) {
      render();
    }
  } catch {
    setSwitch('toggle-proxy', false, 'disconnected');
  }
}

// ---- toolbar actions ----
async function post(path) {
  const data = await fetch(path, { method: 'POST' }).then((r) => r.json());
  applyState(data);
  return data;
}

function confirmDialog(title, message) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-modal').classList.add('open');
    const ok = $('confirm-ok'); const cancel = $('confirm-cancel');
    const done = (v) => {
      $('confirm-modal').classList.remove('open');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

// ---- config modal ----
// Clear-session URL shown read-only. Prefer the host the browser used to reach
// the GUI (if it's a real LAN address, the device uses the same network); fall
// back to the server's detected LAN IP when the GUI is opened via localhost.
function clearViewUrl(cfg) {
  if (!cfg.clearViewUrl) return '(disabled)';
  const h = location.hostname;
  if (h && h !== 'localhost' && h !== '127.0.0.1') {
    const tail = cfg.clearViewPattern && cfg.clearViewPattern.startsWith('/')
      ? cfg.clearViewPattern : '/' + (cfg.clearViewPattern || '');
    return `http://${h}:${cfg.port}${tail}`;
  }
  return cfg.clearViewUrl;
}

async function openConfig() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  $('cfg-port').value = cfg.port;
  $('cfg-url-prefix').value = cfg.urlPrefix || '';
  $('cfg-routes').value = (cfg.routes || []).map((r) => `${r.prefix} ${r.upstream}`).join('\n');
  $('cfg-clear-view-url').value = clearViewUrl(cfg);
  $('cfg-error').textContent = '';
  $('config-modal').classList.add('open');
}

async function saveConfig() {
  const body = {
    port: Number($('cfg-port').value),
    urlPrefix: $('cfg-url-prefix').value,
    routes: $('cfg-routes').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [prefix, upstream] = l.split(/[\s=]+/);
      return { prefix, upstream };
    }),
  };
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  if (res.error) { $('cfg-error').textContent = res.error; return; }
  $('config-modal').classList.remove('open');
  if (res.state) applyState(res.state);
}

// ---- wiring ----
function init() {
  $('filter').addEventListener('input', render);
  $('event-filter').addEventListener('change', render);
  $('provider-filter').addEventListener('change', (e) => {
    providerFilter = e.target.value;
    localStorage.setItem('logger.provider', providerFilter);
    refreshEventFilter();
    render();
  });
  $('group-requests').addEventListener('change', render);
  $('collapse-all').addEventListener('click', toggleCollapseAll);
  $('tl-view').addEventListener('change', renderTimeline);

  const capInput = $('event-cap');
  capInput.value = eventCap;
  const applyCap = () => {
    let v = Math.floor(Number(capInput.value));
    if (!Number.isFinite(v) || v < 0) v = 0;
    eventCap = v;
    capInput.value = v;
    localStorage.setItem('mux.eventCap', String(v));
    render();
  };
  capInput.addEventListener('change', applyCap);

  $('toggle-proxy').addEventListener('click', () => post(proxyListening ? '/api/proxy/stop' : '/api/proxy/start'));
  $('toggle-rec').addEventListener('click', () => post(recording ? '/api/recording/stop' : '/api/recording/start'));
  $('toggle-fwd').addEventListener('click', () => post(forwarding ? '/api/forwarding/stop' : '/api/forwarding/start'));
  $('clear-disk').addEventListener('click', async () => {
    const ok = await confirmDialog('Delete logs', 'Permanently delete all logged request files from disk?');
    if (!ok) return;
    const res = await fetch('/api/logs/clear', { method: 'POST' }).then((r) => r.json());
    ingest([], true);
    hiddenBefore = null;
    closeDetail();
    applyState(res);
    render();
  });

  $('detail-close').addEventListener('click', closeDetail);
  $('detail-raw').addEventListener('click', (e) => showRawRequest(e.currentTarget.dataset.file));

  $('config-btn').addEventListener('click', openConfig);
  $('cfg-cancel').addEventListener('click', () => $('config-modal').classList.remove('open'));
  $('cfg-save').addEventListener('click', saveConfig);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('config-modal').classList.contains('open')) $('config-modal').classList.remove('open');
    else if ($('confirm-modal').classList.contains('open')) $('confirm-modal').classList.remove('open');
    else closeDetail();
  });

  initTimelineTooltip();
  poll();
  setInterval(poll, 1000);
}

document.addEventListener('DOMContentLoaded', init);
