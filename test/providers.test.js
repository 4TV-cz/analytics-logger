const test = require('node:test');
const assert = require('node:assert');
const { decodeKey, decodeEvent } = require('../src/scripts/mux');
const { detectProvider, providerInfo, providerColumns } = require('../src/scripts/providers');

const entry = (host, body, path = '/') => ({
  request: { method: 'POST', url: `https://${host}${path}`, upstream: { hostname: host, host, path, url: `https://${host}${path}` }, headers: {}, body, bodyBytes: 0 },
  response: { statusCode: 200 },
});

test('mux keys decode back to their snake_case names', () => {
  assert.equal(decodeKey('pcycd'), 'player_country_code');
  assert.equal(decodeKey('psqno'), 'player_sequence_number');
  assert.equal(decodeKey('pphti'), 'player_playhead_time');
  assert.equal(decodeKey('e'), 'event');
  assert.equal(decodeKey('c1'), 'custom_1');
  assert.equal(decodeKey('_correlation_id'), '_correlation_id', 'literal keys stay put');
  assert.deepEqual(decodeEvent({ e: 'playing', xid: 'v1' }), { event: 'playing', view_id: 'v1' });
});

test('a litix.io beacon is Mux, one row per event, with viewer time', () => {
  const p = detectProvider(entry('tvos-prod.litix.io', { events: [{ e: 'playing', uti: 1700000000000 }, { e: 'pause', uti: 1700000005000 }] }));
  assert.equal(p.id, 'mux');
  const rows = p.events(entry('tvos-prod.litix.io', { events: [{ e: 'playing', uti: 1700000000000 }, { e: 'pause', uti: 1700000005000 }] }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'playing');
  assert.equal(rows[0].viewerTime, 1700000000000);
  assert.equal(rows[1].props.viewer_time, 1700000005000);
});

test('a Mux-shaped beacon on any host is still recognised by shape', () => {
  assert.equal(detectProvider(entry('collector.example.com', { events: [{ e: 'hb' }] })).id, 'mux');
});

test('GA4 gtag hits come from the query plus one hit per body line', () => {
  const e = entry('www.google-analytics.com', 'en=page_view&ep.title=Home\nen=video_start&epn.pos=12', '/g/collect?v=2&tid=G-1&cid=c1');
  const p = detectProvider(e);
  assert.equal(p.id, 'ga');
  const rows = p.events(e);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'page_view');
  assert.equal(rows[0].props.measurement_id, 'G-1');
  assert.equal(rows[0].props.client_id, 'c1');
  assert.equal(rows[0].props['ep.title'], 'Home');
  assert.equal(rows[1].props['ep.pos'], 12, 'epn.* is numeric');
});

test('GA4 Measurement Protocol JSON yields one row per event', () => {
  const e = entry('www.google-analytics.com', { client_id: 'c9', events: [{ name: 'login', params: { method: 'sso' } }] }, '/mp/collect?measurement_id=G-2');
  const rows = detectProvider(e).events(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'login');
  assert.equal(rows[0].props.method, 'sso');
  assert.equal(rows[0].props.client_id, 'c9');
});

test('mParticle v2 (Roku) and v3 batches decode, and are recognised by shape without a host', () => {
  const v2 = entry('nativesdks.mparticle.com', { dt: 'h', mpid: '42', msgs: [{ dt: 'ss', sid: 's1' }, { dt: 'e', n: 'Play', et: 'navigation', attrs: { title: 'Bunny' } }] });
  const rows = detectProvider(v2).events(v2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'session_start');
  assert.equal(rows[1].event, 'Play');
  assert.equal(rows[1].props['custom_attributes.title'], 'Bunny');
  assert.equal(rows[1].props.mpid, '42');

  const v3 = { request: { method: 'POST', url: 'http://p/x', upstream: null, headers: {}, body: { events: [{ event_type: 'screen_view', data: { screen_name: 'Home' } }] } }, response: {} };
  assert.equal(detectProvider(v3).id, 'mparticle');
  assert.equal(detectProvider(v3).events(v3)[0].event, 'Home');
});

test('anything else is "other": one row per request with the URL and body flattened', () => {
  const e = entry('api.example.com', { user: { id: 7 } }, '/v1/thing?x=1');
  const p = detectProvider(e);
  assert.equal(p.id, 'other');
  const rows = p.events(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'POST /v1/thing');
  assert.equal(rows[0].props['query.x'], '1');
  assert.equal(rows[0].props['body.user.id'], 7);
  const text = entry('api.example.com', 'plain text body');
  assert.equal(detectProvider(text).events(text)[0].props.body_text, 'plain text body');
});

test('provider info and columns are exposed for the GUI', () => {
  assert.deepEqual(providerInfo().map((p) => p.id), ['mux', 'ga', 'mparticle', 'other']);
  assert.ok(providerColumns().mux.some((c) => c.key === 'event'));
});
