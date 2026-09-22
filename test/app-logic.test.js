// The GUI has no build step and no DOM harness, so app.js cannot simply be
// required. These tests extract the pure, self-contained helpers by source and
// evaluate them in isolation — enough to lock down the transformations that
// have no other coverage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'app.js'), 'utf8');

// Pulls `function <name>(...) { ... }` out of the file by brace matching.
function extract(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in app.js`);
  let depth = 0;
  let i = SOURCE.indexOf('{', start);
  const bodyStart = i;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++;
    else if (SOURCE[i] === '}' && --depth === 0) break;
  }
  return SOURCE.slice(start, i + 1) + `\n;__exports.${name} = ${name};`;
}

// Pulls `const NAME = ...;` (single-line) out of the file, so an extracted
// function can see the module constants it closes over.
function extractConst(name) {
  const re = new RegExp(`^const ${name} = .*?;$`, 'm');
  const match = SOURCE.match(re);
  assert.ok(match, `const ${name} not found in app.js`);
  return match[0];
}

function load(names, { consts = [] } = {}) {
  const ctx = {
    __exports: {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    URL,
    console,
  };
  vm.createContext(ctx);
  const source = consts.map(extractConst).concat(names.map(extract)).join('\n');
  vm.runInContext(source, ctx);
  return ctx.__exports;
}

// ── entryBody: the bug that made "Copy as cURL" emit [object Object] ────────

const { entryBody } = load(['entryBody']);

test('entryBody serialises an object body instead of stringifying it to [object Object]', () => {
  const entry = { request: { body: { name: 'ada', nested: { a: 1 } } } };
  const out = entryBody(entry, 'request');
  assert.equal(typeof out, 'string');
  assert.equal(out, '{"name":"ada","nested":{"a":1}}');
  assert.ok(!out.includes('[object Object]'));
});

test('entryBody passes a string body through untouched', () => {
  assert.equal(entryBody({ request: { body: 'raw text' } }, 'request'), 'raw text');
});

test('entryBody decodes a base64 body', () => {
  const b64 = Buffer.from('binary-ish').toString('base64');
  assert.equal(entryBody({ response: { bodyBase64: b64 } }, 'response'), 'binary-ish');
});

test('entryBody handles both sides and missing data', () => {
  const entry = { request: { body: 'req' }, response: { body: 'res' } };
  assert.equal(entryBody(entry, 'request'), 'req');
  assert.equal(entryBody(entry, 'response'), 'res');
  assert.equal(entryBody({}, 'request'), '');
  assert.equal(entryBody(null, 'request'), '');
  assert.equal(entryBody({ request: { body: '' } }, 'request'), '');
});

// ── filter parsing ─────────────────────────────────────────────────────────

const { parseFilter } = load(['parseFilter']);

test('parseFilter splits plain, negated and regex terms', () => {
  const { terms, error } = parseFilter('onvesper -images /\\.jpe?g$/');
  assert.equal(error, '');
  assert.equal(terms.length, 3);
  assert.deepEqual({ negate: terms[0].negate, text: terms[0].text }, { negate: false, text: 'onvesper' });
  assert.deepEqual({ negate: terms[1].negate, text: terms[1].text }, { negate: true, text: 'images' });
  // Asserted by behaviour, not `instanceof`: the RegExp is built inside the vm
  // sandbox, so it belongs to a different realm.
  assert.equal(typeof terms[2].regex?.test, 'function');
  assert.equal(terms[2].regex.test('photo.JPG'), true);
  assert.equal(terms[2].regex.test('photo.png'), false);
  assert.equal(terms[2].negate, false);
});

test('parseFilter handles a negated regex and keeps spaces inside it', () => {
  const { terms } = parseFilter('-/foo bar/');
  assert.equal(terms.length, 1);
  assert.equal(terms[0].negate, true);
  assert.ok(terms[0].regex.test('xxFOO BARxx'), 'regex terms are case-insensitive');
});

test('parseFilter reports a malformed regex rather than matching nothing silently', () => {
  const { error } = parseFilter('/[unclosed/');
  assert.match(error, /bad regex/);
});

test('parseFilter on empty input yields no terms', () => {
  assert.deepEqual(parseFilter('').terms, []);
});

// ── URL → tree path, the basis of the domain tree and the log filename ─────

const { splitTreePath } = load(['splitTreePath']);

test('splitTreePath separates origin, folders and the leaf with its query', () => {
  assert.deepEqual(splitTreePath('https://api.example.com/api/v4/vod/369802/adjacent?size=20'), {
    origin: 'https://api.example.com',
    dirs: ['api', 'v4', 'vod', '369802'],
    leaf: 'adjacent?size=20',
  });
});

test('splitTreePath treats a root or trailing-slash path as a "/" leaf', () => {
  assert.deepEqual(splitTreePath('https://h.com/'), { origin: 'https://h.com', dirs: [], leaf: '/' });
  assert.deepEqual(splitTreePath('https://h.com/a/b/'), { origin: 'https://h.com', dirs: ['a', 'b'], leaf: '/' });
});

test('splitTreePath degrades gracefully on an unparseable URL', () => {
  const out = splitTreePath('not a url');
  assert.equal(out.origin, '(no host)');
  assert.deepEqual(out.dirs, []);
});

// ── byte/size formatting shown in the status bar and columns ───────────────

const { formatBytes, formatKB } = load(['formatBytes', 'formatKB']);

test('formatBytes scales through B/KB/MB/GB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
  assert.equal(formatBytes(null), '');
});

test('formatKB renders two decimals and blanks null', () => {
  assert.equal(formatKB(1024), '1.00');
  assert.equal(formatKB(0), '0.00');
  assert.equal(formatKB(null), '');
});

// ── HTML escaping, now that the replacement map is hoisted ─────────────────

const { escapeHtml } = load(['escapeHtml'], { consts: ['HTML_ESCAPES'] });

test('escapeHtml escapes every character it claims to', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml('plain'), 'plain');
});

test('escapeHtml is stable across repeated calls (hoisted map is not mutated)', () => {
  const input = '<&">';
  const first = escapeHtml(input);
  for (let i = 0; i < 100; i++) assert.equal(escapeHtml(input), first);
});

// ── image body preview ─────────────────────────────────────────────────────

const { buildBodyHtml } = load(
  ['buildBodyHtml', 'buildImageHtml', 'getContentType', 'buildJsonTree', 'buildEntryHtml', 'buildLeafHtml', 'isComplex', 'escapeHtml', 'formatBytes'],
  { consts: ['HTML_ESCAPES', 'JSON_START_RE', 'IMAGE_CT_RE'] }
);

test('an image response renders as an <img> data URI, not as text', () => {
  const b64 = Buffer.from('\x89PNG\r\n\x1a\n-not-really', 'binary').toString('base64');
  const html = buildBodyHtml({
    headers: { 'content-type': 'image/png' },
    body: null,
    bodyBase64: b64,
    bodyBytes: 2048,
  });
  assert.ok(html.includes('<img class="body-image-img" src="data:image/png;base64,' + b64 + '"'), html);
  assert.ok(html.includes('2.0 KB'));
  assert.ok(!html.includes('body-raw'));
});

test('an SVG response is previewed from its text body', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>';
  const html = buildBodyHtml({
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
    body: svg,
    bodyBase64: null,
    bodyBytes: svg.length,
  });
  assert.ok(html.includes('src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '"'), html);
});

test('an image content type with no body falls back to the empty-body note', () => {
  const html = buildBodyHtml({ headers: { 'content-type': 'image/jpeg' }, body: null, bodyBase64: null });
  assert.ok(html.includes('empty body'));
  assert.ok(!html.includes('<img'));
});

test('non-image bodies still render as JSON tree / raw text', () => {
  const json = buildBodyHtml({ headers: { 'content-type': 'application/json' }, body: { a: 1 } });
  assert.ok(json.includes('tok-key'));
  const text = buildBodyHtml({ headers: { 'content-type': 'text/plain' }, body: 'hello' });
  assert.ok(text.includes('<pre class="body-raw">hello</pre>'));
});
