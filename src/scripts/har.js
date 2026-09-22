// Converts captured entries into HAR 1.2, the format Chrome DevTools, Charles
// and Fiddler all import. Pure transformation so it can be tested directly.
// Spec: http://www.softwareishard.com/blog/har-12-spec/

function toNameValuePairs(headers) {
  if (!headers || typeof headers !== 'object') return [];
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(', ') : String(value ?? ''),
  }));
}

function queryStringOf(url) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

// Bodies are stored either as text/JSON (`body`) or base64 (`bodyBase64`).
// HAR wants a string plus an optional encoding marker.
function bodyToHar(part) {
  if (!part) return { text: '', encoding: null };
  if (part.bodyBase64) return { text: part.bodyBase64, encoding: 'base64' };
  const body = part.body;
  if (body == null || body === '') return { text: '', encoding: null };
  return { text: typeof body === 'string' ? body : JSON.stringify(body), encoding: null };
}

function mimeTypeOf(headers) {
  if (!headers) return '';
  const ct = headers['content-type'] || headers['Content-Type'] || '';
  return Array.isArray(ct) ? ct[0] : String(ct);
}

function harEntry(entry) {
  const req = entry?.request || {};
  const res = entry?.response || {};
  const url = req.upstream?.url || req.url || '';
  const reqBody = bodyToHar(req);
  const resBody = bodyToHar(res);
  const failed = !!res.error;

  const harRequest = {
    method: req.method || 'GET',
    url,
    httpVersion: req.httpVersion ? `HTTP/${req.httpVersion}` : 'HTTP/1.1',
    cookies: [],
    headers: toNameValuePairs(req.headers),
    queryString: queryStringOf(url),
    headersSize: -1,
    bodySize: req.bodyBytes ?? -1,
  };
  if (reqBody.text) {
    harRequest.postData = {
      mimeType: mimeTypeOf(req.headers) || 'application/octet-stream',
      text: reqBody.text,
    };
  }

  return {
    startedDateTime: req.timestamp || new Date(0).toISOString(),
    // HAR has no representation for "never got a response"; a failed request is
    // recorded as status 0, which is how DevTools shows a network error too.
    time: res.durationMs ?? 0,
    request: harRequest,
    response: {
      status: failed ? 0 : (res.statusCode ?? 0),
      statusText: failed ? String(res.error) : (res.statusMessage || ''),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: toNameValuePairs(res.headers),
      content: {
        size: res.bodyBytes ?? 0,
        mimeType: mimeTypeOf(res.headers) || 'application/octet-stream',
        text: resBody.text,
        ...(resBody.encoding ? { encoding: resBody.encoding } : {}),
      },
      redirectURL: (res.headers && (res.headers.location || res.headers.Location)) || '',
      headersSize: -1,
      bodySize: res.bodyBytes ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: res.durationMs ?? 0, receive: 0 },
  };
}

function buildHar(entries, { name = 'Proxy', version = '1.0.0' } = {}) {
  return {
    log: {
      version: '1.2',
      creator: { name, version },
      entries: entries.filter(Boolean).map(harEntry),
    },
  };
}

module.exports = { buildHar, harEntry };
