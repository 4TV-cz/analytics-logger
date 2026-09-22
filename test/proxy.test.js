const test = require('node:test');
const assert = require('node:assert');
const {
  parseUpstreamFromUrl,
  getPrefixPath,
  getProxyPath,
  isControlRequest,
  rewriteUrlsInBody,
  isM3u8Response,
  rewriteM3u8Body,
  buildUpstreamHeaders,
  buildClientHeaders,
} = require('../src/scripts/proxy');

test('getPrefixPath takes the path portion of whatever form the prefix is in', () => {
  assert.equal(getPrefixPath('/;'), '/;');
  assert.equal(getPrefixPath('http://192.168.2.42:8889/;'), '/;');
  assert.equal(getPrefixPath(';'), '/;');
  assert.equal(getPrefixPath(''), '');
});

test('parseUpstreamFromUrl extracts the upstream after the prefix', () => {
  const t = parseUpstreamFromUrl('http://192.168.2.42:8889/;https://api.example.com/v1/users?a=1', '/;');
  assert.equal(t.scheme, 'https');
  assert.equal(t.host, 'api.example.com');
  assert.equal(t.port, 443);
  assert.equal(t.path, '/v1/users?a=1');
});

test('parseUpstreamFromUrl ignores the host in the prefix, matching on path only', () => {
  // The proxy listens on 0.0.0.0 and may be reached via any local address.
  const viaOtherIp = parseUpstreamFromUrl('http://10.0.0.9:8889/;http://api.example.com/x', 'http://192.168.2.42:8889/;');
  assert.equal(viaOtherIp.host, 'api.example.com');
});

test('parseUpstreamFromUrl returns null when the prefix does not match', () => {
  assert.equal(parseUpstreamFromUrl('http://p:8889/nope/http://api.example.com/x', '/;'), null);
});

test('parseUpstreamFromUrl with no prefix treats the whole URL as upstream', () => {
  const t = parseUpstreamFromUrl('http://api.example.com/x', '');
  assert.equal(t.host, 'api.example.com');
  assert.equal(t.port, 80);
});

test('parseUpstreamFromUrl rejects non-http schemes', () => {
  assert.equal(parseUpstreamFromUrl('http://p:8889/;file:///etc/passwd', '/;'), null);
  assert.equal(parseUpstreamFromUrl('http://p:8889/;ftp://h/x', '/;'), null);
});

test('getProxyPath strips scheme and host but keeps the embedded upstream', () => {
  assert.equal(getProxyPath('http://p:8889/;http://api.example.com/x'), '/;http://api.example.com/x');
  assert.equal(getProxyPath('http://p:8889/session/clear'), '/session/clear');
  assert.equal(getProxyPath('http://p:8889'), '/');
});

test('isControlRequest fires on a request aimed at the proxy itself', () => {
  assert.equal(isControlRequest('http://p:8889/session/clear', '/;', '/session/clear'), true);
});

test('isControlRequest ignores a forwarded request that merely mentions the pattern', () => {
  // Regression: this used to be swallowed with 200 ok and never forwarded.
  assert.equal(
    isControlRequest('http://p:8889/;http://api.example.com/foo?next=/session/clear', '/;', '/session/clear'),
    false
  );
  assert.equal(
    isControlRequest('http://p:8889/;http://api.example.com/session/clear', '/;', '/session/clear'),
    false
  );
});

test('isControlRequest is disabled when no pattern is configured', () => {
  assert.equal(isControlRequest('http://p:8889/session/clear', '/;', ''), false);
});

test('buildUpstreamHeaders recomputes content-length from the body actually sent', () => {
  // maxBodyBytes may have truncated the buffer after the client set the header.
  const out = buildUpstreamHeaders(
    { 'content-length': '5000', 'content-type': 'application/json' },
    'api.example.com',
    120
  );
  assert.equal(out['content-length'], '120');
  assert.equal(out.host, 'api.example.com');
});

test('buildUpstreamHeaders adds content-length for a chunked request', () => {
  // transfer-encoding is dropped as hop-by-hop, so a length is required.
  const out = buildUpstreamHeaders({ 'transfer-encoding': 'chunked' }, 'h', 42);
  assert.equal(out['content-length'], '42');
  assert.equal(out['transfer-encoding'], undefined);
});

test('buildUpstreamHeaders leaves a bodyless request without content-length', () => {
  const out = buildUpstreamHeaders({ accept: '*/*' }, 'h', 0);
  assert.equal('content-length' in out, false);
});

test('buildUpstreamHeaders drops hop-by-hop, host and accept-encoding', () => {
  const out = buildUpstreamHeaders(
    { host: 'proxy:8889', connection: 'keep-alive', upgrade: 'websocket', 'accept-encoding': 'gzip', 'x-keep': 'yes' },
    'api.example.com',
    0
  );
  assert.equal(out.host, 'api.example.com');
  assert.equal(out.connection, undefined);
  assert.equal(out.upgrade, undefined);
  assert.equal(out['accept-encoding'], undefined);
  assert.equal(out['x-keep'], 'yes');
});

test('buildClientHeaders always sets the length of the body being returned', () => {
  const out = buildClientHeaders({ 'content-length': '999', 'transfer-encoding': 'chunked', 'x-a': '1' }, 7);
  assert.equal(out['content-length'], '7');
  assert.equal(out['transfer-encoding'], undefined);
  assert.equal(out['x-a'], '1');
});

test('rewriteUrlsInBody prefixes absolute URLs so they route back through the proxy', () => {
  const out = rewriteUrlsInBody('{"a":"https://api.example.com/next"}', 'http://p:8889', '/;');
  assert.equal(out, '{"a":"http://p:8889/;https://api.example.com/next"}');
});

test('rewriteUrlsInBody does not double-wrap an already rewritten URL', () => {
  const already = '{"a":"http://p:8889/;https://api.example.com/next"}';
  assert.equal(rewriteUrlsInBody(already, 'http://p:8889', '/;'), already);
});

test('rewriteUrlsInBody is a no-op without an origin or prefix', () => {
  assert.equal(rewriteUrlsInBody('http://a.com/x', '', '/;'), 'http://a.com/x');
  assert.equal(rewriteUrlsInBody('http://a.com/x', 'http://p:1', ''), 'http://a.com/x');
});

// ── m3u8 (HLS) rewriting ───────────────────────────────────────────────────
// Playlists reference their variants and segments relatively, so unlike JSON
// there is no absolute URL to match on — each reference has to be resolved
// against the playlist's own URL first.

const PLAYLIST_URL = 'https://cdn.example.com/hls/live/2000150/129428-309545/playlist-d.m3u8?token=abc';

test('isM3u8Response trusts the content-type, then sniffs the body', () => {
  assert.equal(isM3u8Response('application/vnd.apple.mpegurl', ''), true);
  assert.equal(isM3u8Response('application/x-mpegURL; charset=utf-8', ''), true);
  assert.equal(isM3u8Response('audio/mpegurl', ''), true);
  // Some CDNs serve playlists as plain text.
  assert.equal(isM3u8Response('text/plain', '#EXTM3U\n#EXT-X-VERSION:5\n'), true);
  assert.equal(isM3u8Response('application/json', '{"a":1}'), false);
  assert.equal(isM3u8Response('', 'not a playlist'), false);
});

test('rewriteM3u8Body resolves a relative reference against the playlist URL', () => {
  const body = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1804000,CODECS="avc1.4D401F"',
    '../../2000150/129428-309545/rendition/chunklist-d.m3u8?hdntl=exp=1~acl=*hls%2flive%2f*!*x*~hmac=ab',
  ].join('\n');
  const out = rewriteM3u8Body(body, 'http://p:8889', '/;', PLAYLIST_URL).split('\n');

  assert.equal(out[0], '#EXTM3U', 'tags without a URI are untouched');
  assert.equal(out[1], '#EXT-X-STREAM-INF:BANDWIDTH=1804000,CODECS="avc1.4D401F"');
  assert.equal(
    out[2],
    'http://p:8889/;https://cdn.example.com/hls/live/2000150/129428-309545/rendition/chunklist-d.m3u8'
      + '?hdntl=exp=1~acl=*hls%2flive%2f*!*x*~hmac=ab',
    'the ../.. is resolved and the signed query survives byte for byte'
  );
});

test('rewriteM3u8Body handles absolute, root-relative and URI= references', () => {
  const body = [
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k?id=1",IV=0x0',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/eng.m3u8"',
    '/root/segment0.ts',
    'https://other.example.com/segment1.ts',
  ].join('\n');
  const out = rewriteM3u8Body(body, 'http://p:8889', '/;', PLAYLIST_URL).split('\n');

  assert.equal(out[0], '#EXT-X-KEY:METHOD=AES-128,URI="http://p:8889/;https://keys.example.com/k?id=1",IV=0x0');
  assert.equal(out[1], '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="http://p:8889/;https://cdn.example.com/hls/live/2000150/129428-309545/audio/eng.m3u8"');
  assert.equal(out[2], 'http://p:8889/;https://cdn.example.com/root/segment0.ts');
  assert.equal(out[3], 'http://p:8889/;https://other.example.com/segment1.ts');
});

test('rewriteM3u8Body preserves blank lines and CRLF, and never double-wraps', () => {
  const body = '#EXTM3U\r\n\r\nchunk.ts\r\n';
  const once = rewriteM3u8Body(body, 'http://p:8889', '/;', PLAYLIST_URL);
  assert.equal(
    once,
    '#EXTM3U\r\n\r\nhttp://p:8889/;https://cdn.example.com/hls/live/2000150/129428-309545/chunk.ts\r\n'
  );
  assert.equal(rewriteM3u8Body(once, 'http://p:8889', '/;', PLAYLIST_URL), once, 'idempotent');
});

test('rewriteM3u8Body leaves alone what it cannot forward', () => {
  const body = 'data:text/plain;base64,AAAA\nmailto:someone@example.com';
  assert.equal(rewriteM3u8Body(body, 'http://p:8889', '/;', PLAYLIST_URL), body);
});

test('rewriteM3u8Body is a no-op without an origin, prefix or base URL', () => {
  const body = '#EXTM3U\nchunk.ts';
  assert.equal(rewriteM3u8Body(body, '', '/;', PLAYLIST_URL), body);
  assert.equal(rewriteM3u8Body(body, 'http://p:1', '', PLAYLIST_URL), body);
  assert.equal(rewriteM3u8Body(body, 'http://p:1', '/;', ''), body);
});

// ── Path routes ────────────────────────────────────────────────────────────
// For SDKs that can only be given a base URL and append their own path.

const ROUTES = [
  { prefix: '/mparticle', upstream: 'https://nativesdks.mparticle.com' },
  { prefix: '/ga', upstream: 'https://www.google-analytics.com' },
];

test('a path route forwards the rest of the path to its upstream', () => {
  const t = parseUpstreamFromUrl('http://p:8889/mparticle/v2/key/events', '/;', ROUTES);
  assert.equal(t.url, 'https://nativesdks.mparticle.com/v2/key/events');
  assert.equal(parseUpstreamFromUrl('http://p:8889/ga/g/collect?v=2', '/;', ROUTES).url, 'https://www.google-analytics.com/g/collect?v=2');
  assert.equal(parseUpstreamFromUrl('http://p:8889/ga', '/;', ROUTES).url, 'https://www.google-analytics.com/');
});

test('a route only matches whole path segments, and the prefix form still wins', () => {
  assert.equal(parseUpstreamFromUrl('http://p:8889/gateway/x', '/;', ROUTES), null);
  assert.equal(parseUpstreamFromUrl('http://p:8889/;https://api.example.com/x', '/;', ROUTES).host, 'api.example.com');
});

test('a route is honoured even with no URL prefix configured', () => {
  // Otherwise the whole request URL would be taken as the upstream and the
  // proxy would forward to itself.
  assert.equal(parseUpstreamFromUrl('http://p:8889/mparticle/v2/x', '', ROUTES).host, 'nativesdks.mparticle.com');
});

test('a control pattern under a routed path is forwarded, not treated as a command', () => {
  assert.equal(isControlRequest('http://p:8889/mparticle/session/clear', '/;', '/session/clear', ROUTES), false);
  assert.equal(isControlRequest('http://p:8889/session/clear', '/;', '/session/clear', ROUTES), true);
});
