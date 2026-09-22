const test = require('node:test');
const assert = require('node:assert');
const { buildHar, harEntry } = require('../src/scripts/har');

const sample = {
  request: {
    timestamp: '2026-08-08T10:00:00.000Z',
    method: 'POST',
    url: 'https://api.example.com/v1/users?page=2&sort=name',
    upstream: { url: 'https://api.example.com/v1/users?page=2&sort=name', host: 'api.example.com' },
    httpVersion: '1.1',
    headers: { 'content-type': 'application/json', authorization: 'Bearer xyz' },
    bodyBytes: 13,
    body: { name: 'ada' },
  },
  response: {
    durationMs: 142,
    statusCode: 201,
    statusMessage: 'Created',
    headers: { 'content-type': 'application/json', location: '/v1/users/9' },
    bodyBytes: 20,
    body: { id: 9 },
  },
};

test('buildHar produces a well-formed HAR 1.2 log', () => {
  const har = buildHar([sample], { name: 'Proxy', version: '1.0.0' });
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.creator.name, 'Proxy');
  assert.equal(har.log.entries.length, 1);
});

test('the request half carries method, url, headers and query string', () => {
  const e = harEntry(sample);
  assert.equal(e.request.method, 'POST');
  assert.equal(e.request.url, 'https://api.example.com/v1/users?page=2&sort=name');
  assert.equal(e.request.httpVersion, 'HTTP/1.1');
  assert.deepEqual(e.request.queryString, [
    { name: 'page', value: '2' },
    { name: 'sort', value: 'name' },
  ]);
  assert.deepEqual(
    e.request.headers.find((h) => h.name === 'content-type'),
    { name: 'content-type', value: 'application/json' }
  );
  assert.equal(e.request.postData.mimeType, 'application/json');
  assert.equal(e.request.postData.text, '{"name":"ada"}');
});

test('the response half carries status, content and redirect target', () => {
  const e = harEntry(sample);
  assert.equal(e.response.status, 201);
  assert.equal(e.response.statusText, 'Created');
  assert.equal(e.response.content.mimeType, 'application/json');
  assert.equal(e.response.content.text, '{"id":9}');
  assert.equal(e.response.content.size, 20);
  assert.equal(e.response.redirectURL, '/v1/users/9');
  assert.equal(e.time, 142);
  assert.equal(e.timings.wait, 142);
  assert.equal(e.startedDateTime, '2026-08-08T10:00:00.000Z');
});

test('binary bodies are marked base64 rather than mangled into text', () => {
  const e = harEntry({
    request: { method: 'GET', url: 'https://h.com/img.png', headers: {} },
    response: { statusCode: 200, headers: { 'content-type': 'image/png' }, bodyBase64: 'iVBORw0KGgo=', bodyBytes: 8 },
  });
  assert.equal(e.response.content.encoding, 'base64');
  assert.equal(e.response.content.text, 'iVBORw0KGgo=');
  assert.equal(e.response.content.mimeType, 'image/png');
});

test('a failed upstream becomes status 0 with the error as status text', () => {
  const e = harEntry({
    request: { method: 'GET', url: 'https://down.example.com/x', headers: {} },
    response: { error: 'connect ECONNREFUSED', durationMs: 5 },
  });
  assert.equal(e.response.status, 0);
  assert.equal(e.response.statusText, 'connect ECONNREFUSED');
  assert.equal(e.time, 5);
});

test('a GET with no body omits postData entirely', () => {
  const e = harEntry({
    request: { method: 'GET', url: 'https://h.com/x', headers: {}, bodyBytes: 0 },
    response: { statusCode: 200, headers: {}, bodyBytes: 0 },
  });
  assert.equal('postData' in e.request, false);
  assert.equal(e.response.content.text, '');
});

test('a malformed entry does not throw', () => {
  assert.doesNotThrow(() => harEntry({}));
  assert.equal(buildHar([null, undefined, {}]).log.entries.length, 1);
});
