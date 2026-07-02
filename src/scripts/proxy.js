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

function getPrefixPath(urlPrefix) {
  if (!urlPrefix) return '';
  try { return new URL(urlPrefix).pathname; }
  catch { return urlPrefix.startsWith('/') ? urlPrefix : '/' + urlPrefix; }
}

function parseUpstreamFromUrl(reqUrl, urlPrefix) {
  if (!urlPrefix) return _upstreamFromFullUrl(reqUrl);

  // Match on the path portion of urlPrefix only (e.g. "/;"). The proxy may
  // listen on 0.0.0.0 and be reached via any local IP, so the host:port in
  // urlPrefix is not reliable for matching the incoming request.
  const prefixPath = getPrefixPath(urlPrefix);

  const schemeEnd = reqUrl.indexOf('://');
  if (schemeEnd < 0) return null;
  const pathStart = reqUrl.indexOf('/', schemeEnd + 3);
  if (pathStart < 0) return null;
  const proxyPath = reqUrl.slice(pathStart);
  if (!proxyPath.startsWith(prefixPath)) return null;
  return _upstreamFromFullUrl(proxyPath.slice(prefixPath.length));
}

function buildUpstreamHeaders(reqHeaders, upstreamHost) {
  const out = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'host') continue;
    if (name.toLowerCase() === 'accept-encoding') continue;
    out[name] = value;
  }
  out.host = upstreamHost;
  return out;
}

function buildClientHeaders(upstreamHeaders, bodyLength) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'content-length') continue;
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
          body: Buffer.concat(chunks, bytes),
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

module.exports = { parseUpstreamFromUrl, buildUpstreamHeaders, buildClientHeaders, callUpstream };
