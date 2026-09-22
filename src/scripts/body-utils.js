function isLikelyText(buf, contentType) {
  if (buf.length === 0) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.startsWith('text/')) return true;
    if (ct.includes('json') || ct.includes('xml') || ct.includes('javascript') || ct.includes('urlencoded')) return true;
    // An HLS playlist is text even when it is served as audio/mpegurl, which
    // would otherwise be caught by the audio/ rule below and stored as base64.
    if (ct.includes('mpegurl')) return true;
    if (ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/') || ct.includes('octet-stream')) return false;
  }
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

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

// True when two parsed JSON values have the same *structure*: identical key sets
// at every level and identical array lengths. Leaf values may differ — that is
// the point. Backs the rule that an edited response body may change values but
// never key names, so a client sees the shape it was written against.
function sameJsonShape(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJsonShape(item, b[i]));
  }
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (aObj !== bObj) return false;
  if (!aObj) return true;                 // both leaves: any value is allowed
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && sameJsonShape(a[k], b[k]));
}

module.exports = { isLikelyText, parseIfJson, sameJsonShape };
