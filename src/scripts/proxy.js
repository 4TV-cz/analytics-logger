const http = require('http');
const https = require('https');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function _upstreamFromFullUrl(fullUrl) {
  try {
    const u = new URL(fullUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const scheme = u.protocol.slice(0, -1);
    const defaultPort = scheme === 'https' ? 443 : 80;
    return {
      scheme,
      host: u.host,
      hostname: u.hostname,
      port: u.port ? Number(u.port) : defaultPort,
      path: (u.pathname || '/') + u.search,
      url: u.toString(),
    };
  } catch {
    return null;
  }
}

// Memoised on the input: the prefix comes from config and changes only when
// Settings are saved, but this is consulted several times per request.
let prefixCacheKey = null;
let prefixCacheValue = '';

function getPrefixPath(urlPrefix) {
  if (!urlPrefix) return '';
  if (urlPrefix === prefixCacheKey) return prefixCacheValue;
  let value;
  try { value = new URL(urlPrefix).pathname; }
  catch { value = urlPrefix.startsWith('/') ? urlPrefix : '/' + urlPrefix; }
  prefixCacheKey = urlPrefix;
  prefixCacheValue = value;
  return value;
}

// The path the client asked this proxy for, with the scheme+host stripped but
// the embedded upstream URL (if any) still attached.
function getProxyPath(reqUrl) {
  const schemeEnd = reqUrl.indexOf('://');
  if (schemeEnd < 0) return reqUrl;
  const pathStart = reqUrl.indexOf('/', schemeEnd + 3);
  return pathStart < 0 ? '/' : reqUrl.slice(pathStart);
}

// Path-route fallback for SDKs that can only be given a base URL and append
// their own path (the mParticle Roku SDK posts to <base>/v2/<key>/events):
// "/mparticle/v2/x" + { prefix: "/mparticle", upstream: "https://host" }
// -> https://host/v2/x. Longest prefix wins.
function matchRoute(proxyPath, routes) {
  if (!routes || !routes.length) return null;
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const r of sorted) {
    if (proxyPath === r.prefix || proxyPath.startsWith(r.prefix + '/') || proxyPath.startsWith(r.prefix + '?')) {
      return _upstreamFromFullUrl(r.upstream + proxyPath.slice(r.prefix.length));
    }
  }
  return null;
}

// True when the request is aimed at the proxy itself rather than asking it to
// forward somewhere. Control URLs must only be recognised on these, otherwise
// an upstream URL that merely mentions the pattern gets swallowed.
function isControlRequest(reqUrl, urlPrefix, pattern, routes) {
  if (!pattern) return false;
  const proxyPath = getProxyPath(reqUrl);
  const prefixPath = getPrefixPath(urlPrefix);
  if (prefixPath && proxyPath.startsWith(prefixPath)) return false; // forwarding
  if (matchRoute(proxyPath, routes)) return false;                  // forwarding via a route
  return proxyPath.includes(pattern);
}

function parseUpstreamFromUrl(reqUrl, urlPrefix, routes) {
  const proxyPath = getProxyPath(reqUrl);
  // A route is checked first either way: with no prefix configured the whole
  // request URL would otherwise be taken as the upstream, and a base-URL SDK
  // hitting http://<proxy>/mparticle/... would be forwarded to the proxy itself.
  const routed = matchRoute(proxyPath, routes);
  if (routed) return routed;
  if (!urlPrefix) return _upstreamFromFullUrl(reqUrl);

  // Match on the path portion of urlPrefix only (e.g. "/;"). The proxy may
  // listen on 0.0.0.0 and be reached via any local IP, so the host:port in
  // urlPrefix is not reliable for matching the incoming request.
  const prefixPath = getPrefixPath(urlPrefix);
  // getProxyPath echoes its input when there is no scheme; a URL with no path
  // at all yields "/". Neither can start with a non-empty prefix, so both fall
  // out as "no upstream here" without a separate check.
  if (!proxyPath.startsWith(prefixPath)) return null;
  return _upstreamFromFullUrl(proxyPath.slice(prefixPath.length));
}

function rewriteUrlsInBody(text, proxyOrigin, prefixPath) {
  if (!text || !proxyOrigin || !prefixPath) return text;
  const wrapped = proxyOrigin + prefixPath;
  return text.replace(/https?:\/\/[^\s"'<>\\]+/gi, (url) => {
    if (url.startsWith(wrapped)) return url;
    return wrapped + url;
  });
}

// An HLS playlist is text, whatever it is served as: the extension is the only
// reliable tell, since CDNs use application/vnd.apple.mpegurl, application/
// x-mpegURL, audio/mpegurl and plain text/plain interchangeably.
function isM3u8Response(contentType, text) {
  if (/mpegurl/i.test(contentType || '')) return true;
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

// Tags that carry a URI do it the same way: URI="…" (#EXT-X-KEY, #EXT-X-MEDIA,
// #EXT-X-MAP, #EXT-X-I-FRAME-STREAM-INF, #EXT-X-PART, #EXT-X-PRELOAD-HINT …).
const M3U8_URI_ATTR_RE = /(URI=")([^"]*)(")/gi;

// Resolves one playlist reference against the playlist's own URL and points it
// back through the proxy. Relative references are the whole reason this exists:
// "../../2000150/…/chunklist-d.m3u8" means nothing to a client that fetched the
// playlist from the proxy rather than from the CDN.
function wrapPlaylistUri(ref, proxyOrigin, prefixPath, baseUrl) {
  const trimmed = ref.trim();
  if (!trimmed) return ref;
  const wrapped = proxyOrigin + prefixPath;
  if (trimmed.startsWith(wrapped)) return ref;      // already proxied
  let absolute;
  try {
    absolute = new URL(trimmed, baseUrl);
  } catch {
    return ref;                                     // not a URL we can resolve
  }
  // data: and anything else the proxy cannot forward is left as it is.
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return ref;
  return wrapped + absolute.toString();
}

// Rewrites every reference in an m3u8 so the client keeps talking to the proxy.
// Line-based rather than a single regex: in a playlist, a bare line *is* a URI,
// so there is nothing to pattern-match against.
function rewriteM3u8Body(text, proxyOrigin, prefixPath, baseUrl) {
  if (!text || !proxyOrigin || !prefixPath || !baseUrl) return text;
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      // A tag line: only its URI="…" attributes are references.
      return line.replace(M3U8_URI_ATTR_RE, (_m, open, uri, close) =>
        open + wrapPlaylistUri(uri, proxyOrigin, prefixPath, baseUrl) + close);
    }
    // Everything else is a variant playlist or a media segment. Replacing the
    // trimmed text in place keeps any indentation, and the \r of a CRLF file.
    return line.replace(trimmed, wrapPlaylistUri(trimmed, proxyOrigin, prefixPath, baseUrl));
  }).join('\n');
}

function buildUpstreamHeaders(reqHeaders, upstreamHost, bodyLength) {
  const out = {};
  let hadContentLength = false;
  for (const [name, value] of Object.entries(reqHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'host') continue;
    if (lower === 'accept-encoding') continue;
    if (lower === 'content-length') { hadContentLength = true; continue; }
    out[name] = value;
  }
  out.host = upstreamHost;
  // The body is fully buffered before it is forwarded, and maxBodyBytes may
  // have truncated it, so the length we are actually sending is authoritative —
  // the client's own header can be stale. (Chunked requests arrive with no
  // content-length at all and still need one, since transfer-encoding is
  // dropped as hop-by-hop.)
  if (bodyLength > 0 || hadContentLength) out['content-length'] = String(bodyLength);
  return out;
}

function buildClientHeaders(upstreamHeaders, bodyLength) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'content-length') continue;
    out[name] = value;
  }
  out['content-length'] = String(bodyLength);
  return out;
}

function callUpstream(target, method, headers, bodyBuf, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const mod = target.scheme === 'http' ? http : https;
    const options = {
      method,
      host: target.hostname,
      port: target.port,
      path: target.path,
      headers,
      timeout: timeoutMs,
    };
    const upReq = mod.request(options, (upRes) => {
      const chunks = [];
      let bytes = 0;
      upRes.on('data', (c) => { chunks.push(c); bytes += c.length; });
      upRes.on('end', () => {
        resolve({
          ok: true,
          durationMs: Date.now() - start,
          statusCode: upRes.statusCode,
          statusMessage: upRes.statusMessage,
          headers: upRes.headers,
          rawHeaders: upRes.rawHeaders,
          body: Buffer.concat(chunks, bytes),
          bytes,
        });
      });
      upRes.on('error', (err) => resolve({ ok: false, durationMs: Date.now() - start, error: err.message }));
    });
    upReq.on('timeout', () => {
      upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (err) => resolve({ ok: false, durationMs: Date.now() - start, error: err.message }));
    if (bodyBuf && bodyBuf.length) upReq.write(bodyBuf);
    upReq.end();
  });
}

module.exports = { HOP_BY_HOP, parseUpstreamFromUrl, getPrefixPath, getProxyPath, isControlRequest, rewriteUrlsInBody, isM3u8Response, rewriteM3u8Body, buildUpstreamHeaders, buildClientHeaders, callUpstream };
