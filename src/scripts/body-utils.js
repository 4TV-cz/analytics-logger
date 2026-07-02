// Parse a request body as JSON when it looks like JSON; otherwise return the
// raw text. Used only to surface the beacon's events for logging — the bytes
// forwarded upstream are always the untouched original.
function parseIfJson(text, contentType) {
  if (!text) return text;
  const ct = (contentType || '').toLowerCase();
  const trimmed = text.trimStart();
  const looksJson = ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

module.exports = { parseIfJson };
