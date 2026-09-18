'use strict';

const { decodeEvent, CURATED_COLUMNS: MUX_COLUMNS } = require('./mux');

// Analytics providers the proxy understands. Every logged request is matched
// against these (in order) and the first hit turns it into grid rows: one row
// per analytics event inside the request. Anything unrecognised falls through
// to `other`, which still yields one row per request so no traffic is lost.
//
// Each provider: { id, label, match(entry), events(entry) -> [{event, props, viewerTime?}], columns }
//   - `props` is a flat object shown in the detail panel; `columns` picks
//     which of its keys become grid columns (the GUI swaps layouts per provider).

// Flatten nested objects into dot keys (`custom_attributes.foo`) so the detail
// panel stays a flat key/value list. Arrays and anything deeper than `depth`
// are kept as-is (the GUI renders objects as JSON).
function flatten(obj, prefix = '', depth = 3, out = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth > 1) flatten(v, key, depth - 1, out);
    else out[key] = v;
  }
  return out;
}

function hostOf(entry) {
  return (entry.request?.upstream?.hostname || '').toLowerCase();
}

function pathOf(entry) {
  return entry.request?.upstream?.path || entry.request?.url || '';
}

function toNumber(v) {
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- Mux ------
// Beacon body: { events: [ {minified keys} ] }, see mux.js for decoding.
const mux = {
  id: 'mux',
  label: 'Mux',
  columns: MUX_COLUMNS,
  match(entry) {
    if (/(^|\.)litix\.io$/.test(hostOf(entry))) return true;
    // Roku SDK beacons may arrive on a custom collector host: recognise them
    // by shape (events array whose entries carry the minified `e` key).
    const evs = entry.request?.body?.events;
    return Array.isArray(evs) && evs.length > 0 && evs.every((e) => e && typeof e === 'object' && 'e' in e);
  },
  events(entry) {
    const evs = entry.request?.body?.events;
    if (!Array.isArray(evs)) return [];
    return evs.map((raw) => {
      const props = decodeEvent(raw);
      return { event: props.event || raw.e || '', props, viewerTime: toNumber(props.viewer_time) };
    });
  },
};

// --------------------------------------------------- Google Analytics ------
// Three wire formats share the google-analytics.com hosts:
//   GA4 gtag   POST /g/collect?v=2&tid=G-…&cid=…&en=page_view&ep.x=…   (+ optional
//              body: one extra "en=…&ep.x=…" event per line)
//   GA4 MP     POST /mp/collect?measurement_id=…  JSON { client_id, events:[{name, params}] }
//   UA         POST /collect | /batch  "v=1&t=event&ec=…&ea=…" (one hit per line)
const GA_KEYS = {
  // GA4 gtag
  v: 'protocol_version', tid: 'measurement_id', cid: 'client_id', sid: 'session_id',
  sct: 'session_count', seg: 'session_engaged', en: 'event_name', dl: 'page_location',
  dt: 'page_title', dr: 'page_referrer', ul: 'user_language', sr: 'screen_resolution',
  uid: 'user_id', _et: 'engagement_time_msec', _ss: 'session_start', _fv: 'first_visit',
  _p: 'page_load_id', _s: 'hit_counter', gtm: 'gtm_hash', gcs: 'consent_state',
  // UA
  t: 'hit_type', ec: 'event_category', ea: 'event_action', el: 'event_label',
  ev: 'event_value', cd: 'screen_name', dp: 'page_path', dh: 'page_host', an: 'app_name',
  av: 'app_version', aid: 'app_id', ni: 'non_interaction',
};

function gaDecodeParams(params, into) {
  for (const [k, v] of params) {
    if (k.startsWith('ep.') || k.startsWith('epn.')) into[k.replace(/^epn?\./, 'ep.')] = k.startsWith('epn.') ? toNumber(v) ?? v : v;
    else if (k.startsWith('up.') || k.startsWith('upn.')) into[k.replace(/^upn?\./, 'up.')] = k.startsWith('upn.') ? toNumber(v) ?? v : v;
    else into[GA_KEYS[k] || k] = v;
  }
  return into;
}

const ga = {
  id: 'ga',
  label: 'Google Analytics',
  columns: [
    { key: 'event', label: 'event', width: 150 },
    { key: 'client_id', label: 'client_id', width: 150 },
    { key: 'session_id', label: 'session_id', width: 100 },
    { key: 'page_title', label: 'page_title', width: 160 },
    { key: 'page_location', label: 'page_location', width: 220 },
    { key: 'measurement_id', label: 'measurement_id', width: 110 },
  ],
  match(entry) {
    if (/(^|\.)(google-analytics\.com|analytics\.google\.com|app-measurement\.com)$/.test(hostOf(entry))) return true;
    // No upstream (unrouted base-URL SDK): recognise the GA collect endpoints by path.
    return !hostOf(entry) && /\/(g|mp|debug\/mp)\/collect(\?|$)/.test(pathOf(entry));
  },
  events(entry) {
    const req = entry.request || {};
    const path = pathOf(entry);
    const qIdx = path.indexOf('?');
    const query = new URLSearchParams(qIdx === -1 ? '' : path.slice(qIdx + 1));
    const body = req.body;

    // GA4 Measurement Protocol: JSON with an events array.
    if (body && typeof body === 'object' && Array.isArray(body.events)) {
      const ctx = { measurement_id: query.get('measurement_id') || undefined };
      for (const k of ['client_id', 'user_id', 'timestamp_micros', 'non_personalized_ads']) if (k in body) ctx[k] = body[k];
      const userProps = flatten(body.user_properties || {}, 'up');
      return body.events.map((e) => ({
        event: e?.name || '',
        props: { event_name: e?.name, ...ctx, ...userProps, ...flatten(e?.params || {}) },
      }));
    }

    // gtag / UA: shared params in the query, optionally one extra hit per body line.
    const shared = gaDecodeParams(query, {});
    const lines = typeof req.bodyText === 'string'
      ? req.bodyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];
    const hits = lines.length ? lines.map((l) => gaDecodeParams(new URLSearchParams(l), { ...shared })) : [shared];
    return hits.map((props) => ({
      event: props.event_name || props.event_action || props.hit_type || '',
      props,
    }));
  },
};

// ---------------------------------------------------------- mParticle ------
// v3 (web/native SDKs): JSON { events:[{ event_type, data:{…} }], mpid, … }
// v2 (legacy/Roku SDK): JSON { dt:'h', msgs:[{ dt:'e', n:'name', et:'navigation', attrs:{…} }], mpid, … }
const MP_V2_TYPES = {
  ss: 'session_start', se: 'session_end', v: 'screen_view', e: 'custom_event', cr: 'crash',
  o: 'opt_out', fr: 'first_run', ast: 'app_state_transition', pr: 'profile', x: 'breadcrumb',
  cm: 'commerce_event', uac: 'user_attribute_change', uic: 'user_identity_change', h: 'batch',
};
const MP_V2_KEYS = {
  dt: 'message_type', n: 'event_name', et: 'custom_event_type', attrs: 'custom_attributes',
  ct: 'timestamp_unixtime_ms', sid: 'session_uuid', id: 'message_id', sct: 'session_start_unixtime_ms',
  dur: 'event_duration', sl: 'session_length', sn: 'screen_name', t: 'app_state', ifr: 'is_first_run',
};

function mpV2Event(msg, ctx) {
  const props = { ...ctx };
  for (const [k, v] of Object.entries(msg || {})) {
    const key = MP_V2_KEYS[k] || k;
    if (key === 'custom_attributes' && v && typeof v === 'object') Object.assign(props, flatten(v, 'custom_attributes'));
    else if (key === 'message_type') props[key] = MP_V2_TYPES[v] || v;
    else props[key] = v;
  }
  return { event: props.event_name || props.screen_name || props.message_type || '', props };
}

const mparticle = {
  id: 'mparticle',
  label: 'mParticle',
  columns: [
    { key: 'event', label: 'event', width: 170 },
    { key: 'event_type', label: 'event_type', width: 110 },
    { key: 'custom_event_type', label: 'custom_type', width: 100 },
    { key: 'screen_name', label: 'screen_name', width: 140 },
    { key: 'session_uuid', label: 'session', width: 130 },
    { key: 'mpid', label: 'mpid', width: 130 },
  ],
  match(entry) {
    if (/(^|\.)mparticle\.com$/.test(hostOf(entry))) return true;
    // No upstream (unrouted base-URL SDK): recognise an mParticle batch by shape.
    const body = entry.request?.body;
    if (!body || typeof body !== 'object') return false;
    if (body.dt === 'h' && Array.isArray(body.msgs)) return true;
    return Array.isArray(body.events) && body.events.length > 0 && body.events.every((e) => e && typeof e === 'object' && 'event_type' in e);
  },
  events(entry) {
    const body = entry.request?.body;
    if (!body || typeof body !== 'object') return [];
    const ctx = {};
    for (const k of ['mpid', 'environment', 'source_request_id']) if (k in body) ctx[k] = body[k];

    if (Array.isArray(body.events)) {
      const userAttrs = flatten(body.user_attributes || {}, 'user_attributes');
      return body.events.map((e) => {
        const data = e?.data || {};
        const props = { event_type: e?.event_type, ...ctx, ...flatten(data), ...userAttrs };
        return {
          event: data.event_name || data.screen_name || e?.event_type || '',
          props,
        };
      });
    }
    if (Array.isArray(body.msgs)) {
      return body.msgs.map((m) => mpV2Event(m, ctx));
    }
    // Identity / config / other mParticle calls: one row for the request itself.
    return [{ event: pathOf(entry).split('?')[0].split('/').filter(Boolean).slice(-1)[0] || 'request', props: { ...ctx, ...flatten(body) } }];
  },
};

// -------------------------------------------------------------- other ------
// Anything else that reaches the proxy: one row per request so the traffic is
// visible; the body (JSON keys or raw text) is available in the detail panel.
const other = {
  id: 'other',
  label: 'Other',
  columns: [
    { key: 'event', label: 'request', width: 260 },
    { key: 'host', label: 'host', width: 180 },
    { key: 'content_type', label: 'content-type', width: 160 },
    { key: 'body_bytes', label: 'bytes', width: 70, num: true },
  ],
  match() { return true; },
  events(entry) {
    const req = entry.request || {};
    const path = pathOf(entry);
    const props = {
      method: req.method,
      host: req.upstream?.host || null,
      path: path.split('?')[0],
      content_type: req.headers?.['content-type'] || null,
      body_bytes: req.bodyBytes ?? 0,
    };
    const qIdx = path.indexOf('?');
    if (qIdx !== -1) for (const [k, v] of new URLSearchParams(path.slice(qIdx + 1))) props[`query.${k}`] = v;
    if (req.body && typeof req.body === 'object') Object.assign(props, flatten(req.body, 'body'));
    else if (typeof req.bodyText === 'string' && req.bodyText) props.body_text = req.bodyText.slice(0, 2000);
    return [{ event: `${req.method || ''} ${props.path}`.trim(), props }];
  },
};

const PROVIDERS = [mux, ga, mparticle, other];

function detectProvider(entry) {
  return PROVIDERS.find((p) => p.match(entry)) || other;
}

// Provider id + label list and per-provider column layouts, as sent to the GUI.
function providerInfo() {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}

function providerColumns() {
  const out = {};
  for (const p of PROVIDERS) out[p.id] = p.columns;
  return out;
}

module.exports = { PROVIDERS, detectProvider, providerInfo, providerColumns };
