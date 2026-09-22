const test = require('node:test');
const assert = require('node:assert');
const { isLikelyText, parseIfJson, sameJsonShape } = require('../src/scripts/body-utils');

test('isLikelyText trusts a textual content-type', () => {
  const buf = Buffer.from('hello');
  assert.equal(isLikelyText(buf, 'text/html; charset=utf-8'), true);
  assert.equal(isLikelyText(buf, 'application/json'), true);
  assert.equal(isLikelyText(buf, 'application/xml'), true);
  assert.equal(isLikelyText(buf, 'application/x-www-form-urlencoded'), true);
});

test('isLikelyText rejects binary content-types', () => {
  const buf = Buffer.from('hello');
  assert.equal(isLikelyText(buf, 'image/webp'), false);
  assert.equal(isLikelyText(buf, 'video/mp4'), false);
  assert.equal(isLikelyText(buf, 'application/octet-stream'), false);
});

test('isLikelyText falls back to sniffing for NUL bytes', () => {
  assert.equal(isLikelyText(Buffer.from([0x68, 0x69]), ''), true);
  assert.equal(isLikelyText(Buffer.from([0x68, 0x00, 0x69]), ''), false);
});

test('isLikelyText treats an empty body as text', () => {
  assert.equal(isLikelyText(Buffer.alloc(0), 'image/png'), true);
});

test('parseIfJson returns an object for JSON and the string otherwise', () => {
  assert.deepEqual(parseIfJson('{"a":1}', 'application/json'), { a: 1 });
  assert.deepEqual(parseIfJson('[1,2]', ''), [1, 2]);
  assert.equal(parseIfJson('plain text', 'text/plain'), 'plain text');
});

test('parseIfJson returns the raw string when JSON is malformed', () => {
  assert.equal(parseIfJson('{"a":', 'application/json'), '{"a":');
});

// ── sameJsonShape: the guard behind "values only, never keys" ───────────────

test('sameJsonShape accepts changed values and rejects changed keys', () => {
  const captured = { id: 1, name: 'ada', tags: ['a', 'b'], meta: { ok: true, note: null } };

  assert.equal(sameJsonShape(captured, { id: 99, name: 'grace', tags: ['x', 'y'], meta: { ok: false, note: null } }), true);
  // A leaf may even change type — only the structure is fixed.
  assert.equal(sameJsonShape(captured, { id: 'one', name: 'ada', tags: ['a', 'b'], meta: { ok: true, note: null } }), true);

  assert.equal(sameJsonShape(captured, { id: 1, nome: 'ada', tags: ['a', 'b'], meta: { ok: true, note: null } }), false, 'renamed key');
  assert.equal(sameJsonShape(captured, { id: 1, name: 'ada', tags: ['a', 'b'] }), false, 'dropped key');
  assert.equal(sameJsonShape(captured, { ...captured, extra: 1 }), false, 'added key');
  assert.equal(sameJsonShape(captured, { ...captured, tags: ['a'] }), false, 'shortened array');
  assert.equal(sameJsonShape(captured, { ...captured, meta: { ok: true, note: null, x: 1 } }), false, 'nested added key');
});

test('sameJsonShape distinguishes containers from leaves', () => {
  assert.equal(sameJsonShape({ a: { b: 1 } }, { a: 1 }), false);
  assert.equal(sameJsonShape([1, 2], { 0: 1, 1: 2 }), false);
  assert.equal(sameJsonShape([], []), true);
  assert.equal(sameJsonShape({}, {}), true);
  assert.equal(sameJsonShape(null, 'x'), true, 'two leaves');
  assert.equal(sameJsonShape(null, {}), false);
});
