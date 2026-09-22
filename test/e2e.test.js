// Real upstream -> real proxy -> real GUI API, over loopback on ephemeral ports.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackend } = require('../src/backend');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, urlPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Config validation rejects port 0, so grab a real free port by opening and
// immediately closing a throwaway listener.
async function freePort() {
  const s = http.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

// Spins up an upstream that records what it received, plus the proxy + GUI.
// Everything is created inside the try so a failure still tears the ports down —
// a leaked listener would hang the test runner instead of failing it.
async function withBackend(fn, { configure } = {}) {
  const received = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-e2e-'));
  let upstream = null;
  let backend = null;
  try {
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          bodyLength: Buffer.concat(chunks).length,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, seen: req.url }));
      });
    });
    const upstreamPort = await listen(upstream);
    const guiPort = await freePort();
    const proxyPort = await freePort();

    backend = createBackend({ dataDir, guiPort });
    // `configure` may be a function of the upstream base URL, for settings
    // (routes) that have to point at the ephemeral upstream.
    const extra = typeof configure === 'function' ? configure(`http://127.0.0.1:${upstreamPort}`) : configure;
    backend.config.applyUpdate({ port: proxyPort, host: '127.0.0.1', ...extra });
    await backend.start();

    await fn({
      backend,
      proxyPort,
      guiPort,
      upstreamPort,
      upstreamBase: `http://127.0.0.1:${upstreamPort}`,
      received,
      dataDir,
    });
  } finally {
    if (backend) await backend.stop();
    if (upstream) await new Promise((r) => upstream.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('forwards a request and writes a log file named after the host and path', async () => {
  await withBackend(async ({ proxyPort, upstreamPort, upstreamBase, backend, received }) => {
    const res = await request(proxyPort, `/;${upstreamBase}/api/v4/content/home?rpp=10`);
    assert.equal(res.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/v4/content/home?rpp=10');

    const summaries = backend.logStore.getSummaries();
    assert.equal(summaries.length, 1);
    // timestamp, then the upstream host (dots and the port flattened), then the path
    const host = `127-0-0-1-${upstreamPort}`;
    assert.match(summaries[0].file, new RegExp(`^\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{3}-${host}-api-v4-content-home\\.json$`));
    assert.equal(summaries[0].status, 200);
    assert.equal(summaries[0].method, 'GET');
  });
});

test('the upstream sees the real body length after truncation', async () => {
  // Regression: the client's content-length used to be forwarded verbatim, so a
  // body clipped by maxBodyBytes arrived shorter than it claimed.
  await withBackend(async ({ proxyPort, upstreamBase, received }) => {
    const body = 'x'.repeat(500);
    const res = await request(proxyPort, `/;${upstreamBase}/upload`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
    });
    assert.equal(res.status, 200);
    assert.equal(received[0].bodyLength, 100, 'body should have been truncated to maxBodyBytes');
    assert.equal(received[0].headers['content-length'], '100', 'content-length must match what was sent');
  }, { configure: { maxBodyBytes: 100 } });
});

test('a forwarded URL mentioning the clear-view pattern is still proxied', async () => {
  await withBackend(async ({ proxyPort, upstreamBase, received, backend }) => {
    const res = await request(proxyPort, `/;${upstreamBase}/foo?next=/session/clear`);
    assert.equal(res.status, 200);
    assert.equal(received.length, 1, 'request must reach the upstream, not be swallowed');
    assert.equal(backend.logStore.getSummaries().length, 1);
  });
});

test('a control URL aimed at the proxy is answered without forwarding or logging', async () => {
  await withBackend(async ({ proxyPort, received, backend }) => {
    const res = await request(proxyPort, '/session/clear');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
    assert.equal(received.length, 0);
    assert.equal(backend.logStore.getSummaries().length, 0);
    assert.ok(backend.proxy.state().clearViewAt, 'clearViewAt should be stamped');
  });
});

test('a control URL deletes the capture, and nothing sent after it is lost', async () => {
  await withBackend(async ({ proxyPort, upstreamBase, backend, dataDir }) => {
    for (const p of ['/one', '/two', '/three']) await request(proxyPort, `/;${upstreamBase}${p}`);
    await backend.logStore.flush();
    assert.equal(backend.logStore.getSummaries().length, 3);
    assert.equal(fs.readdirSync(path.join(dataDir, 'logs')).filter((n) => n.endsWith('.json')).length, 3);

    const res = await request(proxyPort, '/session/clear');
    assert.equal(res.status, 200);
    assert.equal(backend.logStore.getSummaries().length, 0, 'the in-memory list is emptied');
    assert.deepEqual(
      fs.readdirSync(path.join(dataDir, 'logs')).filter((n) => n.endsWith('.json')),
      [],
      'and the files are gone from disk'
    );
    assert.equal(backend.logStore.getDiskBytes(), 0);

    // The delete is awaited before the 200, so a client starting its next
    // session immediately cannot have that traffic swept up by the clear.
    await request(proxyPort, `/;${upstreamBase}/after`);
    await backend.logStore.flush();
    assert.equal(backend.logStore.getSummaries().length, 1);
    assert.match(backend.logStore.getSummaries()[0].url, /\/after$/);
  });
});

test('a control URL drops the rewrite rules along with the entries they point at', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/pinned`);
    await addRewrite(guiPort, backend.logStore.getSummaries()[0].file);
    assert.equal(backend.rewrites.list().length, 1);

    await request(proxyPort, '/session/clear');
    assert.deepEqual(backend.rewrites.list(), [], 'a rule with no entry left cannot serve anything');
  });
});

test('an unroutable request gets 502 and is still logged', async () => {
  await withBackend(async ({ proxyPort, backend }) => {
    const res = await request(proxyPort, '/no-prefix-here');
    assert.equal(res.status, 502);
    assert.equal(backend.logStore.getSummaries().length, 1);
    assert.match(backend.logStore.getSummaries()[0].error, /upstream/i);
  });
});

test('paused recording still forwards but writes nothing', async () => {
  await withBackend(async ({ proxyPort, upstreamBase, backend, received }) => {
    backend.proxy.setRecording(false);
    const res = await request(proxyPort, `/;${upstreamBase}/quiet`);
    assert.equal(res.status, 200);
    assert.equal(received.length, 1);
    assert.equal(backend.logStore.getSummaries().length, 0);
  });
});

test('GUI serves the capture and rejects unheadered mutations', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase }) => {
    await request(proxyPort, `/;${upstreamBase}/thing`);

    const list = JSON.parse((await request(guiPort, '/api/list')).body);
    assert.equal(list.total, 1);
    const file = list.items[0].file;

    const entry = JSON.parse((await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`)).body);
    assert.equal(entry.request.upstream.host, new URL(upstreamBase).host);

    // A cross-site form post cannot set a custom header, so this must fail.
    const blocked = await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
    assert.equal(blocked.status, 403);
    assert.equal(JSON.parse((await request(guiPort, '/api/list')).body).total, 1);

    // The UI's own call carries the header and succeeds.
    const allowed = await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`, {
      method: 'DELETE',
      headers: { 'X-Proxy-UI': '1' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(JSON.parse((await request(guiPort, '/api/list')).body).total, 0);
  });
});

// Collects SSE frames off a raw HTTP response until `want` events have arrived.
function collectEvents(port, want, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('status ' + res.statusCode));
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.+)$/m.exec(frame);
          if (event && data) events.push({ event: event[1], data: JSON.parse(data[1]) });
          if (events.length >= want) { req.destroy(); resolve(events); return; }
        }
      });
    });
    req.on('error', (err) => { if (events.length >= want) resolve(events); else reject(err); });
    req.end();
    setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
  });
}

test('the event stream pushes state on connect and an entry as it is captured', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase }) => {
    const collecting = collectEvents(guiPort, 2);
    await new Promise((r) => setTimeout(r, 150)); // let the stream open first
    await request(proxyPort, `/;${upstreamBase}/pushed`);
    const events = await collecting;

    assert.equal(events[0].event, 'state', 'first frame should be the current state');
    assert.equal(typeof events[0].data.listening, 'boolean');

    const store = events.find((e) => e.event === 'store');
    assert.ok(store, 'a store event should arrive for the captured request');
    assert.equal(store.data.type, 'entry');
    assert.equal(store.data.total, 1);
    assert.match(store.data.summary.file, /-pushed\.json$/);
    assert.equal(store.data.summary.status, 200);
  });
});

test('the event stream reports deletions and clears', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase }) => {
    await request(proxyPort, `/;${upstreamBase}/doomed`);
    const list = JSON.parse((await request(guiPort, '/api/list')).body);
    const file = list.items[0].file;

    const collecting = collectEvents(guiPort, 3);
    await new Promise((r) => setTimeout(r, 150));
    await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`, {
      method: 'DELETE', headers: { 'X-Proxy-UI': '1' },
    });
    await request(guiPort, '/api/logs/clear', { method: 'POST', headers: { 'X-Proxy-UI': '1' } });
    const events = await collecting;

    const types = events.filter((e) => e.event === 'store').map((e) => e.data.type);
    assert.ok(types.includes('deleted'), `expected a deleted event, got ${types}`);
    assert.ok(types.includes('cleared'), `expected a cleared event, got ${types}`);
  });
});

test('the event stream pushes proxy state changes', async () => {
  await withBackend(async ({ guiPort, backend }) => {
    const collecting = collectEvents(guiPort, 2);
    await new Promise((r) => setTimeout(r, 150));
    backend.proxy.setRecording(false);
    const events = await collecting;

    const states = events.filter((e) => e.event === 'state');
    assert.ok(states.length >= 2, 'connect state plus the change');
    assert.equal(states[states.length - 1].data.recording, false);
  });
});

test('the capture exports as importable HAR', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase }) => {
    await request(proxyPort, `/;${upstreamBase}/api/thing?x=1`);
    const res = await request(guiPort, '/api/har');

    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'], /\.har"?$/);
    const har = JSON.parse(res.body);
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.entries.length, 1);
    const e = har.log.entries[0];
    assert.equal(e.request.method, 'GET');
    assert.match(e.request.url, /\/api\/thing\?x=1$/);
    assert.deepEqual(e.request.queryString, [{ name: 'x', value: '1' }]);
    assert.equal(e.response.status, 200);
    assert.ok(e.response.content.text.includes('"ok":true'));
  });
});

test('replaying an entry re-issues it upstream and records a new entry', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/replay-me`);
    assert.equal(received.length, 1);
    const original = backend.logStore.getSummaries()[0].file;

    const res = await request(guiPort, `/api/replay?file=${encodeURIComponent(original)}`, {
      method: 'POST', headers: { 'X-Proxy-UI': '1' },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 200);

    assert.equal(received.length, 2, 'the upstream should have been hit again');
    assert.equal(received[1].url, '/replay-me');
    assert.equal(backend.logStore.getSummaries().length, 2, 'the replay is logged as its own entry');
  });
});

test('replay of a POST resends the original body', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/echo`, {
      method: 'POST',
      body: '{"hello":"world"}',
      headers: { 'Content-Type': 'application/json' },
    });
    const original = backend.logStore.getSummaries()[0].file;
    await request(guiPort, `/api/replay?file=${encodeURIComponent(original)}`, {
      method: 'POST', headers: { 'X-Proxy-UI': '1' },
    });
    assert.equal(received.length, 2);
    assert.equal(received[1].bodyLength, 17, 'the replayed body must match the original');
    assert.equal(received[1].headers['content-length'], '17');
  });
});

test('replay refuses an entry with no upstream, and a missing file', async () => {
  await withBackend(async ({ proxyPort, guiPort, backend }) => {
    await request(proxyPort, '/no-prefix');            // 502, logged with upstream: null
    const bad = backend.logStore.getSummaries()[0].file;

    const noUpstream = await request(guiPort, `/api/replay?file=${encodeURIComponent(bad)}`, {
      method: 'POST', headers: { 'X-Proxy-UI': '1' },
    });
    assert.equal(noUpstream.status, 400);

    const missing = await request(guiPort, '/api/replay?file=nope.json', {
      method: 'POST', headers: { 'X-Proxy-UI': '1' },
    });
    assert.equal(missing.status, 404);
  });
});

test('log rotation caps the capture end to end', async () => {
  await withBackend(async ({ proxyPort, upstreamBase, backend }) => {
    for (let i = 0; i < 8; i++) await request(proxyPort, `/;${upstreamBase}/rot/${i}`);
    assert.equal(backend.logStore.getSummaries().length, 3);
    const urls = backend.logStore.getSummaries().map((s) => s.url);
    assert.ok(urls.every((u) => /\/rot\/[567]$/.test(u)), `kept the wrong entries: ${urls}`);
  }, { configure: { maxLogFiles: 3 } });
});

test('deep search finds a request by its response body', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase }) => {
    await request(proxyPort, `/;${upstreamBase}/findme`);
    await request(proxyPort, `/;${upstreamBase}/other`);
    const result = JSON.parse((await request(guiPort, '/api/search?q=findme')).body);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0], /findme/);
  });
});

// ── Response rewrites ──────────────────────────────────────────────────────
// A rule pins one captured entry to a method+URL; while it exists the proxy
// answers from that entry and the upstream is never called.

const UI = { 'X-Proxy-UI': '1' };

// Arms a rewrite from the most recent capture and returns the rule.
async function addRewrite(guiPort, file) {
  const res = await request(guiPort, '/api/rewrites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...UI },
    body: JSON.stringify({ file }),
  });
  return { status: res.status, ...JSON.parse(res.body) };
}

test('a rewritten URL is answered from the stored entry, upstream untouched', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    const first = await request(proxyPort, `/;${upstreamBase}/mocked`);
    assert.equal(received.length, 1);
    const file = backend.logStore.getSummaries()[0].file;

    const added = await addRewrite(guiPort, file);
    assert.equal(added.status, 200);
    assert.equal(added.rule.method, 'GET');
    assert.equal(added.rule.url, `${upstreamBase}/mocked`);
    assert.equal(added.rule.file, file);

    const second = await request(proxyPort, `/;${upstreamBase}/mocked`);
    assert.equal(received.length, 1, 'the upstream must not be called again');
    assert.equal(second.status, first.status);
    assert.equal(second.body, first.body);
    assert.equal(second.headers['content-type'], 'application/json');
    assert.equal(second.headers['content-length'], String(Buffer.byteLength(first.body)));

    // The served request is captured like any other, flagged with its source.
    const summaries = backend.logStore.getSummaries();
    assert.equal(summaries.length, 2);
    assert.equal(summaries[1].rewrittenFrom, file);
    assert.equal(summaries[1].status, 200);
    assert.equal(summaries[0].rewrittenFrom, null, 'the original was not rewritten');

    // Nothing was edited here, so the served response says so by omission.
    const servedEntry = JSON.parse((await request(
      guiPort, `/api/entry?file=${encodeURIComponent(summaries[1].file)}`)).body);
    assert.equal(servedEntry.response.rewrittenEdited, undefined);
  });
});

test('a rewrite only covers its own method and exact URL', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/scoped`);
    await addRewrite(guiPort, backend.logStore.getSummaries()[0].file);

    await request(proxyPort, `/;${upstreamBase}/scoped`, { method: 'POST', body: 'x' });
    assert.equal(received.length, 2, 'a different method still reaches the upstream');
    await request(proxyPort, `/;${upstreamBase}/scoped?v=2`);
    assert.equal(received.length, 3, 'a different query string still reaches the upstream');
    await request(proxyPort, `/;${upstreamBase}/scoped`);
    assert.equal(received.length, 3, 'the exact match is still served from the entry');
  });
});

test('removing a rewrite goes back to the upstream', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/toggled`);
    const { rule } = await addRewrite(guiPort, backend.logStore.getSummaries()[0].file);
    await request(proxyPort, `/;${upstreamBase}/toggled`);
    assert.equal(received.length, 1);

    const removed = await request(guiPort, `/api/rewrites?key=${encodeURIComponent(rule.key)}`, {
      method: 'DELETE', headers: UI,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(JSON.parse(removed.body).items, []);

    await request(proxyPort, `/;${upstreamBase}/toggled`);
    assert.equal(received.length, 2, 'with the rule gone the request is forwarded again');
  });
});

test('deleting the entry a rewrite points at drops the rule', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/doomed-rule`);
    const file = backend.logStore.getSummaries()[0].file;
    await addRewrite(guiPort, file);

    await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`, { method: 'DELETE', headers: UI });
    assert.deepEqual(backend.rewrites.list(), []);

    await request(proxyPort, `/;${upstreamBase}/doomed-rule`);
    assert.equal(received.length, 2, 'no rule left, so the upstream is called');
  });
});

test('a rewrite whose file vanished behind the store falls through and self-heals', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend, dataDir }) => {
    await request(proxyPort, `/;${upstreamBase}/vanishing`);
    const file = backend.logStore.getSummaries()[0].file;
    await addRewrite(guiPort, file);
    await backend.logStore.flush();

    // Removed on disk without going through the store, so nothing prunes it.
    fs.unlinkSync(path.join(dataDir, 'logs', file));

    await request(proxyPort, `/;${upstreamBase}/vanishing`);
    assert.equal(received.length, 2, 'unusable rule must not break the request');
    assert.deepEqual(backend.rewrites.list(), [], 'the dead rule is dropped');
  });
});

test('rewrites are listed, pushed over the event stream, and validated', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/listed`);
    const file = backend.logStore.getSummaries()[0].file;

    const collecting = collectEvents(guiPort, 2);
    await new Promise((r) => setTimeout(r, 150));
    await addRewrite(guiPort, file);
    const events = await collecting;
    const pushed = events.find((e) => e.event === 'rewrites');
    assert.ok(pushed, 'the rule set should be pushed to open browsers');
    assert.equal(pushed.data.items.length, 1);

    const list = JSON.parse((await request(guiPort, '/api/list')).body);
    assert.equal(list.rewrites.length, 1, 'a full refresh carries the rules too');
    assert.equal(JSON.parse((await request(guiPort, '/api/rewrites')).body).items.length, 1);

    const missing = await addRewrite(guiPort, 'nope.json');
    assert.equal(missing.status, 404);
    const unheadered = await request(guiPort, '/api/rewrites', { method: 'POST', body: '{}' });
    assert.equal(unheadered.status, 403);
  });
});

test('an entry with no usable response cannot be rewritten', async () => {
  await withBackend(async ({ proxyPort, guiPort, backend }) => {
    // No upstream in the URL: logged with an error instead of a response.
    await request(proxyPort, '/no-upstream-here');
    const file = backend.logStore.getSummaries()[0].file;
    const res = await addRewrite(guiPort, file);
    assert.equal(res.status, 400);
    assert.match(res.error, /no response/);
  });
});

// ── Edited response bodies ─────────────────────────────────────────────────
// An edit is stored on the entry as response.bodyEdited, leaving the captured
// body intact; a rewrite rule pointing at that entry serves the edit.

async function editBody(guiPort, file, body) {
  const res = await request(guiPort, `/api/entry/body?file=${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...UI },
    body: JSON.stringify({ body }),
  });
  return { status: res.status, ...JSON.parse(res.body) };
}

test('an edited body is stored beside the captured one and served by a rewrite', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/edited`);
    const file = backend.logStore.getSummaries()[0].file;

    const saved = await editBody(guiPort, file, { ok: false, seen: '/rewritten-by-hand' });
    assert.equal(saved.status, 200);
    assert.equal(saved.summary.responseEdited, true);

    // The capture itself is untouched — the edit sits alongside it.
    const entry = JSON.parse((await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`)).body);
    assert.deepEqual(entry.response.body, { ok: true, seen: '/edited' });
    assert.deepEqual(entry.response.bodyEdited, { ok: false, seen: '/rewritten-by-hand' });

    await addRewrite(guiPort, file);
    const served = await request(proxyPort, `/;${upstreamBase}/edited`);
    assert.equal(received.length, 1, 'still no second upstream call');
    assert.deepEqual(JSON.parse(served.body), { ok: false, seen: '/rewritten-by-hand' });
    assert.equal(served.headers['content-length'], String(Buffer.byteLength(served.body)));

    // What was logged for the served request is what the client got.
    const servedEntry = JSON.parse((await request(
      guiPort, `/api/entry?file=${encodeURIComponent(backend.logStore.getSummaries()[1].file)}`)).body);
    assert.deepEqual(servedEntry.response.body, { ok: false, seen: '/rewritten-by-hand' });
    assert.equal(servedEntry.response.bodyEdited, undefined);
    assert.equal(servedEntry.response.rewrittenFrom, file);
    // Flagged, so the detail panel can say the body was a fixture rather than
    // a replayed capture.
    assert.equal(servedEntry.response.rewrittenEdited, true);
  });
});

test('an edit that renames or adds a key is rejected', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/guarded`);
    const file = backend.logStore.getSummaries()[0].file;

    for (const bad of [
      { ok: true, SEEN: '/guarded' },              // renamed
      { ok: true },                                // dropped
      { ok: true, seen: '/guarded', extra: 1 },    // added
    ]) {
      const res = await editBody(guiPort, file, bad);
      assert.equal(res.status, 400, `should reject ${JSON.stringify(bad)}`);
      assert.match(res.error, /same keys/);
    }
    const entry = JSON.parse((await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`)).body);
    assert.equal(entry.response.bodyEdited, undefined, 'nothing was stored');
  });
});

test('reverting an edit restores the captured body for a rewrite', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/reverted`);
    const file = backend.logStore.getSummaries()[0].file;
    await editBody(guiPort, file, { ok: false, seen: 'hand-written' });
    await addRewrite(guiPort, file);

    const edited = await request(proxyPort, `/;${upstreamBase}/reverted`);
    assert.deepEqual(JSON.parse(edited.body), { ok: false, seen: 'hand-written' });

    const reverted = await request(guiPort, `/api/entry/body?file=${encodeURIComponent(file)}`, {
      method: 'DELETE', headers: UI,
    });
    assert.equal(reverted.status, 200);
    assert.equal(JSON.parse(reverted.body).summary.responseEdited, false);

    const back = await request(proxyPort, `/;${upstreamBase}/reverted`);
    assert.deepEqual(JSON.parse(back.body), { ok: true, seen: '/reverted' });
  });
});

test('editing is refused for a missing entry, a non-JSON body and an unheadered request', async () => {
  await withBackend(async ({ proxyPort, guiPort, backend }) => {
    const missing = await editBody(guiPort, 'nope.json', { a: 1 });
    assert.equal(missing.status, 404);

    // No upstream: the entry is logged with an error instead of a response body.
    await request(proxyPort, '/no-upstream-at-all');
    const file = backend.logStore.getSummaries()[0].file;
    const notJson = await editBody(guiPort, file, { a: 1 });
    assert.equal(notJson.status, 400);

    const unheadered = await request(guiPort, `/api/entry/body?file=${encodeURIComponent(file)}`, {
      method: 'POST', body: '{}',
    });
    assert.equal(unheadered.status, 403);
  });
});

test('an edit is pushed to open browsers as an updated summary', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, backend }) => {
    await request(proxyPort, `/;${upstreamBase}/pushed-edit`);
    const file = backend.logStore.getSummaries()[0].file;

    const collecting = collectEvents(guiPort, 2);
    await new Promise((r) => setTimeout(r, 150));
    await editBody(guiPort, file, { ok: false, seen: 'x' });
    const events = await collecting;

    const updated = events.find((e) => e.event === 'store' && e.data.type === 'updated');
    assert.ok(updated, 'an updated frame should arrive');
    assert.equal(updated.data.summary.file, file);
    assert.equal(updated.data.summary.responseEdited, true);
  });
});

// ── m3u8 rewriting ─────────────────────────────────────────────────────────

test('relative references in an m3u8 come back proxied, and the chunklist is then reachable', async () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1804000',
    '../../v2/rendition/chunklist-d.m3u8?token=abc',
    '',
  ].join('\n');

  const hls = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(req.url.includes('chunklist') ? '#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts\n' : playlist);
  });
  const hlsPort = await listen(hls);

  try {
    await withBackend(async ({ proxyPort, received }) => {
      const base = `http://127.0.0.1:${hlsPort}`;
      const res = await request(proxyPort, `/;${base}/hls/live/v1/129428/playlist-d.m3u8`);
      assert.equal(res.status, 200);

      const line = res.body.split('\n').find((l) => l.includes('chunklist'));
      // ../.. climbs out of /hls/live/v1/129428/ to /hls/live/
      const expected = `http://127.0.0.1:${proxyPort}/;${base}/hls/live/v2/rendition/chunklist-d.m3u8?token=abc`;
      assert.equal(line, expected, 'the ../.. is resolved against the playlist URL and routed back');

      // The proof that matters: a player following that line reaches the CDN.
      const followed = await request(proxyPort, new URL(line).pathname + new URL(line).search);
      assert.equal(followed.status, 200);
      assert.match(followed.body, /#EXT-X-TARGETDURATION/);
      assert.equal(received.length, 0, 'the HLS origin is separate from the default upstream');
    }, { configure: { rewriteM3u8Urls: true } });
  } finally {
    await new Promise((r) => hls.close(r));
  }
});

test('m3u8 rewriting can be switched off, and leaves other bodies alone', async () => {
  const playlist = '#EXTM3U\nchunk.ts\n';
  const hls = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(playlist);
  });
  const hlsPort = await listen(hls);

  try {
    await withBackend(async ({ proxyPort }) => {
      const res = await request(proxyPort, `/;http://127.0.0.1:${hlsPort}/a/playlist.m3u8`);
      assert.equal(res.body, playlist, 'off (the default) means byte-for-byte passthrough');
    });

    // On, but the response is JSON: the m3u8 pass must not touch it.
    await withBackend(async ({ proxyPort, upstreamBase }) => {
      const res = await request(proxyPort, `/;${upstreamBase}/plain`);
      assert.deepEqual(JSON.parse(res.body), { ok: true, seen: '/plain' });
    }, { configure: { rewriteM3u8Urls: true, rewriteResponseUrls: false } });
  } finally {
    await new Promise((r) => hls.close(r));
  }
});

test('an m3u8 served as audio/mpegurl is stored as text, not base64', async () => {
  const hls = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpegurl' });
    res.end('#EXTM3U\nchunk.ts\n');
  });
  const hlsPort = await listen(hls);

  try {
    await withBackend(async ({ proxyPort, guiPort, backend }) => {
      await request(proxyPort, `/;http://127.0.0.1:${hlsPort}/a/playlist.m3u8`);
      const file = backend.logStore.getSummaries()[0].file;
      const entry = JSON.parse((await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`)).body);
      assert.equal(entry.response.bodyBase64, null, 'a playlist is text, whatever it is served as');
      assert.match(entry.response.body, /^#EXTM3U/);
    });
  } finally {
    await new Promise((r) => hls.close(r));
  }
});

// ── Analytics: forwarding toggle, routes, decoded events, console ──────────

test('with forwarding off the proxy answers 200 itself, logs the request and flags it', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, received, backend }) => {
    backend.proxy.setForwarding(false);
    assert.equal(backend.proxy.state().forwarding, false);

    const res = await request(proxyPort, `/;${upstreamBase}/beacon`, { method: 'POST', body: '{"events":[{"e":"hb"}]}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], '0');
    assert.equal(received.length, 0, 'the upstream must never be called');

    const summary = backend.logStore.getSummaries()[0];
    assert.equal(summary.forwarded, false);
    assert.equal(summary.status, 200);
    assert.equal(summary.provider, 'mux');
    const entry = JSON.parse((await request(guiPort, `/api/entry?file=${encodeURIComponent(summary.file)}`)).body);
    assert.equal(entry.response.forwarded, false);

    // Back on: the same request reaches the upstream again.
    const on = await request(guiPort, '/api/forwarding/start', { method: 'POST', headers: UI });
    assert.equal(JSON.parse(on.body).forwarding, true);
    await request(proxyPort, `/;${upstreamBase}/beacon`);
    assert.equal(received.length, 1);
    assert.equal(backend.logStore.getSummaries()[1].forwarded, true);
  });
});

test('a path route forwards a base-URL SDK request to its configured upstream', async () => {
  await withBackend(async ({ proxyPort, upstreamBase, received, backend }) => {
    const res = await request(proxyPort, '/mp/v2/key/events', { method: 'POST', body: '{"dt":"h","msgs":[{"dt":"ss"}]}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/v2/key/events');
    const summary = backend.logStore.getSummaries()[0];
    assert.equal(summary.upstream, `${upstreamBase}/v2/key/events`);
    assert.equal(summary.provider, 'mparticle');
    assert.equal(summary.events, 1);
  }, { configure: (upstreamBase) => ({ routes: [{ prefix: '/mp', upstream: upstreamBase }] }) });
});

test('the analytics endpoint decodes each request into event rows, incrementally', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase }) => {
    await request(proxyPort, `/;${upstreamBase}/tvos-prod.litix.io/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ e: 'playerready', uti: 1 }, { e: 'viewstart', uti: 2, xid: 'v1' }] }),
    });
    await request(proxyPort, `/;${upstreamBase}/plain`);

    const all = JSON.parse((await request(guiPort, '/api/analytics')).body);
    assert.equal(all.total, 3);
    assert.deepEqual(all.providers.map((p) => p.id), ['mux', 'ga', 'mparticle', 'other']);
    assert.ok(all.columns.mux.length > 0);
    assert.equal(all.rows[0].provider, 'mux');
    assert.equal(all.rows[0].event, 'playerready');
    assert.equal(all.rows[0].request, 1);
    assert.equal(all.rows[1].props.view_id, 'v1');
    assert.equal(all.rows[2].provider, 'other');
    assert.equal(all.rows[2].request, 2);
    assert.equal(all.rows[2].id, all.rows[2].file + '#0');

    // `since` returns only what came after that row; the console piggybacks.
    const since = JSON.parse((await request(guiPort, `/api/analytics?since=${encodeURIComponent(all.rows[1].id)}`)).body);
    assert.equal(since.total, 3);
    assert.equal(since.rows.length, 1);
    assert.equal(since.rows[0].event, 'GET /plain');
    assert.equal(since.console.length, 2, 'one console line per request');
    assert.match(since.console[0].note, /mux: 2 events/);

    // The summary carries the same numbers, so the requests view agrees.
    const list = JSON.parse((await request(guiPort, '/api/list')).body);
    assert.equal(list.items[0].provider, 'mux');
    assert.equal(list.items[0].events, 2);
    assert.equal(list.items[0].seq, 1);
    assert.equal(list.state.events, 3);
  });
});

test('event rows survive a restart via the index, and go with their entry on delete', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, backend, dataDir }) => {
    await request(proxyPort, `/;${upstreamBase}/x.litix.io/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ e: 'playing' }, { e: 'pause' }] }),
    });
    await request(proxyPort, `/;${upstreamBase}/other`);
    await backend.logStore.close();

    const LogStore = require('../src/scripts/log-store');
    const reopened = new LogStore(path.join(dataDir, 'logs'));
    reopened.loadFromDisk();
    assert.equal(reopened.getEventCount(), 3);
    assert.deepEqual(reopened.getEventRows().map((r) => r.event), ['playing', 'pause', 'GET /other']);
    assert.deepEqual(reopened.getSummaries().map((s) => s.seq), [1, 2]);

    const file = backend.logStore.getSummaries()[0].file;
    await request(guiPort, `/api/entry?file=${encodeURIComponent(file)}`, { method: 'DELETE', headers: UI });
    assert.equal(backend.logStore.getEventCount(), 1);
    assert.equal(backend.logStore.getEventRows()[0].event, 'GET /other');
  });
});

test('console lines are pushed over the event stream and can be cleared', async () => {
  await withBackend(async ({ proxyPort, guiPort, upstreamBase, backend }) => {
    const collecting = collectEvents(guiPort, 3);
    await new Promise((r) => setTimeout(r, 150));
    await request(proxyPort, `/;${upstreamBase}/logged`);
    const events = await collecting;
    const line = events.find((e) => e.event === 'console');
    assert.ok(line, 'a console frame should arrive for the request');
    assert.equal(line.data.method, 'GET');
    assert.match(line.data.url, /\/logged$/);
    assert.equal(line.data.status, '200');
    // The store frame carries the decoded rows too, for the Events tab.
    const store = events.find((e) => e.event === 'store' && e.data.type === 'entry');
    assert.equal(store.data.events.length, 1);
    assert.equal(store.data.eventTotal, 1);

    assert.equal(JSON.parse((await request(guiPort, '/api/console')).body).lines.length, 1);
    await request(guiPort, '/api/console/clear', { method: 'POST', headers: UI });
    assert.equal(JSON.parse((await request(guiPort, '/api/console')).body).lines.length, 0);
    assert.equal(backend.logStore.getSummaries().length, 1, 'clearing the console keeps the logs');
  });
});
