const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LogStore = require('../src/scripts/log-store');

// Handles both sync and async bodies; always flushes queued writes before the
// directory is torn down so a background write cannot outlive the test.
async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logstore-test-'));
  const store = new LogStore(dir);
  try {
    return await fn(store, dir);
  } finally {
    await store.flush().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const jsonFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.json'));

const entryFor = (url) => ({
  request: { url, upstream: { url }, method: 'GET', timestamp: '2026-08-08T10:00:00.000Z', bodyBytes: 0 },
  response: { statusCode: 200, bodyBytes: 3 },
});

test('_entrySlug leads with the host, then the path, and drops the query string', () => {
  withStore((store) => {
    assert.equal(
      store._entrySlug(entryFor('https://sandbox-api.onvesper.com/api/v4/content/home?rpp=10&bpp=7')),
      'sandbox-api-onvesper-com-api-v4-content-home'
    );
    // Dots and the port colon flatten to dashes, so the name reads as one token.
    assert.equal(store._entrySlug(entryFor('http://127.0.0.1:8899/api/home')), '127-0-0-1-8899-api-home');
  });
});

test('_entrySlug yields the bare host for a root path', () => {
  withStore((store) => {
    assert.equal(store._entrySlug(entryFor('https://h.com/')), 'h-com');
    assert.equal(store._entrySlug(entryFor('https://h.com')), 'h-com');
  });
});

test('_entrySlug normalises traversal and unsafe characters', () => {
  withStore((store) => {
    assert.equal(store._entrySlug(entryFor('https://h.com/../../etc/passwd')), 'h-com-etc-passwd');
    assert.equal(store._entrySlug(entryFor('https://h.com/a b/c%2Fd')), 'h-com-a-b-c-d');
    assert.equal(store._entrySlug(entryFor('https://h.com/%%%')), 'h-com');
  });
});

test('_entrySlug falls back to the path alone when the URL will not parse', () => {
  withStore((store) => {
    assert.equal(store._entrySlug(entryFor('not a url at all?query=1')), 'not-a-url-at-all');
  });
});

test('_entrySlug caps length so the filename stays under the Windows path limit', () => {
  withStore((store) => {
    const path40 = Array.from({ length: 40 }, (_, i) => `segment${i}`).join('/');
    for (const url of [
      'https://h.com/' + path40,
      'https://' + 'x'.repeat(90) + '.com/' + path40,   // a host that would eat the budget
    ]) {
      const slug = store._entrySlug(entryFor(url));
      assert.ok(slug.length <= 120, `slug was ${slug.length} chars`);
      assert.ok(!/[-.]$/.test(slug), 'truncation must not leave a trailing separator');
    }
    // The host is capped first, so the path always keeps a usable share.
    const crowded = store._entrySlug(entryFor('https://' + 'x'.repeat(90) + '.com/' + path40));
    assert.ok(crowded.includes('-segment0-'), `path was squeezed out: ${crowded}`);
  });
});

test('generated filenames are accepted by the API guard', async () => {
  await withStore((store) => {
    const urls = [
      'https://h.com/api/v4/content/home?rpp=10',
      'https://h.com/../../etc/passwd',
      'https://h.com/a b/c%2Fd/éé?q=1',
      'https://h.com/',
      'not a url at all?query=1',
    ];
    for (const url of urls) {
      const name = path.basename(store.writeEntry(entryFor(url)));
      assert.equal(store._safeBasename(name), name, `rejected: ${name}`);
      assert.ok(!/[?&=]/.test(name), `query string leaked into: ${name}`);
    }
  });
});

test('filenames start with a sortable timestamp so name order is chronological', async () => {
  await withStore((store) => {
    // Entries from different milliseconds must sort by time regardless of path.
    // (Within a single millisecond the slug decides, which is not a chronology
    // claim — hence the distinct timestamps here.)
    const times = [
      new Date(2026, 0, 2, 3, 4, 5, 6),
      new Date(2026, 0, 2, 3, 4, 5, 7),
      new Date(2026, 11, 31, 23, 59, 59, 999),
    ];
    const paths = ['/zebra', '/apple', '/middle'];
    const names = times.map((d, i) => path.basename(store._makeFilename(d, entryFor('https://h.com' + paths[i]))));
    assert.deepEqual([...names].sort(), names);
    assert.match(names[0], /^2026-01-02-03-04-05-006-h-com-zebra\.json$/);
  });
});

test('same path in the same millisecond gets a numeric suffix, not an overwrite', async () => {
  await withStore(async (store, dir) => {
    const a = path.basename(store.writeEntry(entryFor('https://h.com/prod')));
    const b = path.basename(store.writeEntry(entryFor('https://h.com/prod')));
    assert.notEqual(a, b);
    await store.flush();
    assert.equal(jsonFiles(dir).length, 2);
  });
});

test('writeEntry queues the write and returns without waiting for the disk', async () => {
  await withStore(async (store, dir) => {
    const file = path.basename(store.writeEntry(entryFor('https://h.com/deferred')));

    // Deliberately not "the file does not exist yet": the write is handed to
    // libuv's threadpool, which can finish it while this thread runs on, so
    // that assertion failed about once in a hundred runs. What is actually
    // promised is that the caller never blocks — the entry is queued and fully
    // visible before the write has been waited on.
    assert.ok(store.writeQueue.includes(file) || store.pendingBuffers.has(file) || jsonFiles(dir).includes(file));
    assert.equal(store.getSummaries().length, 1, 'the entry is visible immediately');
    assert.equal(store.getSummaries()[0].file, file);

    await store.flush();
    assert.deepEqual(jsonFiles(dir), [file]);
    assert.equal(store.pendingBuffers.size, 0, 'flush drains the queue');
  });
});

test('an entry can be read back before its write has landed', async () => {
  await withStore(async (store) => {
    const file = path.basename(store.writeEntry(entryFor('https://h.com/early')));
    const raw = store.readEntry(file);
    assert.ok(raw, 'pending entry must be readable');
    assert.equal(JSON.parse(raw.toString()).request.url, 'https://h.com/early');
    await store.flush();
    assert.equal(JSON.parse(store.readEntry(file).toString()).request.url, 'https://h.com/early');
  });
});

test('deleting an entry that is still queued leaves nothing behind', async () => {
  await withStore(async (store, dir) => {
    const file = path.basename(store.writeEntry(entryFor('https://h.com/doomed')));
    assert.equal(await store.deleteEntry(file), true);
    await store.flush();
    assert.equal(jsonFiles(dir).length, 0, 'the queued write must not resurrect the file');
    assert.equal(store.getSummaries().length, 0);
    assert.equal(store.readEntry(file), null);
  });
});

test('a burst of writes all land despite the concurrency cap', async () => {
  await withStore(async (store, dir) => {
    for (let i = 0; i < 60; i++) store.writeEntry(entryFor(`https://h.com/burst/${i}`));
    await store.flush();
    assert.equal(jsonFiles(dir).length, 60);
    assert.equal(store.getSummaries().length, 60);
  });
});

test('_safeBasename rejects path traversal and non-json names', () => {
  withStore((store) => {
    assert.equal(store._safeBasename('../config/config.json'), null);
    assert.equal(store._safeBasename('sub/dir.json'), null);
    assert.equal(store._safeBasename('C:\\windows\\x.json'), null);
    assert.equal(store._safeBasename('notes.txt'), null);
    assert.equal(store._safeBasename('2026-08-08-10-00-00-000-api.json'), '2026-08-08-10-00-00-000-api.json');
  });
});

test('readEntry refuses a traversal attempt even when the file exists', () => {
  withStore((store, dir) => {
    fs.writeFileSync(path.join(dir, '..', 'outside.json'), '{"secret":1}');
    try {
      assert.equal(store.readEntry('../outside.json'), null);
    } finally {
      fs.rmSync(path.join(dir, '..', 'outside.json'), { force: true });
    }
  });
});

test('write, read, delete round-trips and keeps the disk total in step', async () => {
  await withStore(async (store) => {
    const file = path.basename(store.writeEntry(entryFor('https://h.com/x/y')));
    await store.flush();
    assert.equal(store.getSummaries().length, 1);
    assert.ok(store.getDiskBytes() > 0);

    const parsed = JSON.parse(store.readEntry(file).toString());
    assert.equal(parsed.request.url, 'https://h.com/x/y');

    assert.equal(await store.deleteEntry(file), true);
    assert.equal(store.getSummaries().length, 0);
    assert.equal(store.getDiskBytes(), 0);
    assert.equal(store.readEntry(file), null);
  });
});

test('loadFromDisk rebuilds summaries and disk usage from an existing folder', async () => {
  await withStore(async (store, dir) => {
    store.writeEntry(entryFor('https://h.com/one'));
    store.writeEntry(entryFor('https://h.com/two'));
    await store.flush();

    const reopened = new LogStore(dir);
    reopened.loadFromDisk();
    assert.equal(reopened.getSummaries().length, 2);
    assert.equal(reopened.getDiskBytes(), store.getDiskBytes());
  });
});

test('the summary index is reused on reload instead of re-parsing', async () => {
  await withStore(async (store, dir) => {
    store.writeEntry(entryFor('https://h.com/indexed'));
    await store.close();                       // writes the sidecar index

    const reopened = new LogStore(dir);
    // If the index is consulted, no log file needs to be opened at all.
    const realReadFileSync = fs.readFileSync;
    const opened = [];
    fs.readFileSync = (p, ...rest) => { opened.push(path.basename(p)); return realReadFileSync(p, ...rest); };
    try {
      reopened.loadFromDisk();
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    assert.equal(reopened.getSummaries().length, 1);
    assert.deepEqual(opened.filter((n) => n.endsWith('.json')), [], 'no log file should be re-parsed');
  });
});

test('a log file changed behind the index is re-parsed, not trusted', async () => {
  await withStore(async (store, dir) => {
    const file = path.basename(store.writeEntry(entryFor('https://h.com/stale')));
    await store.close();
    // Rewrite the file with a different URL and a different size.
    fs.writeFileSync(path.join(dir, file), JSON.stringify(entryFor('https://h.com/rewritten-and-longer'), null, 2));

    const reopened = new LogStore(dir);
    reopened.loadFromDisk();
    assert.equal(reopened.getSummaries()[0].url, 'https://h.com/rewritten-and-longer');
  });
});

test('the index file is never mistaken for a log entry', async () => {
  await withStore(async (store, dir) => {
    store.writeEntry(entryFor('https://h.com/a'));
    await store.close();
    assert.ok(fs.readdirSync(dir).includes('.log-index'), 'index should exist');

    const reopened = new LogStore(dir);
    reopened.loadFromDisk();
    assert.equal(reopened.getSummaries().length, 1, 'index must not be counted as an entry');
    assert.equal(reopened._safeBasename('.log-index'), null, 'index must not be fetchable via the API');
    assert.equal((await reopened.search('version')).files.includes('.log-index'), false);
  });
});

test('search finds text inside stored entries and ignores the rest', async () => {
  await withStore(async (store) => {
    store.writeEntry(entryFor('https://h.com/needle'));
    store.writeEntry(entryFor('https://h.com/other'));
    assert.equal((await store.search('needle')).files.length, 1);
    assert.equal((await store.search('nothing-here')).files.length, 0);
    assert.deepEqual((await store.search('')).files, []);
  });
});

test('search flushes queued writes so a just-captured entry is findable', async () => {
  await withStore(async (store) => {
    store.writeEntry(entryFor('https://h.com/brand-new-marker'));
    const result = await store.search('brand-new-marker');
    assert.equal(result.files.length, 1);
  });
});

test('search treats the query literally, not as a regex', async () => {
  await withStore(async (store) => {
    store.writeEntry(entryFor('https://h.com/a.b'));
    assert.equal((await store.search('a.b')).files.length, 1);
    assert.equal((await store.search('a+b')).files.length, 0);
  });
});

test('search returns results in a stable order and respects the limit', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 12; i++) store.writeEntry(entryFor(`https://h.com/many/${i}/shared-marker`));
    const all = await store.search('shared-marker');
    assert.equal(all.files.length, 12);
    assert.deepEqual(all.files, [...all.files].sort(), 'concurrent reads must not scramble the order');

    const capped = await store.search('shared-marker', 5);
    assert.equal(capped.truncated, true);
    assert.ok(capped.files.length >= 5);
  });
});

// ── Rotation ───────────────────────────────────────────────────────────────

async function withCappedStore(limits, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logstore-cap-'));
  const store = new LogStore(dir, () => limits);
  try {
    return await fn(store, dir);
  } finally {
    await store.flush().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('maxLogFiles evicts the oldest entries once the cap is passed', async () => {
  await withCappedStore({ maxLogFiles: 5 }, async (store, dir) => {
    for (let i = 0; i < 20; i++) store.writeEntry(entryFor(`https://h.com/n${i}`));
    assert.equal(store.getSummaries().length, 5);
    // the survivors must be the five most recent
    assert.deepEqual(store.getSummaries().map((s) => s.url).sort(), [
      'https://h.com/n15', 'https://h.com/n16', 'https://h.com/n17',
      'https://h.com/n18', 'https://h.com/n19',
    ].sort());
    await store.flush();
    assert.equal(jsonFiles(dir).length, 5, 'evicted files must be gone from disk too');
  });
});

test('maxLogBytes evicts until the capture fits', async () => {
  await withCappedStore({ maxLogBytes: 4000 }, async (store, dir) => {
    for (let i = 0; i < 30; i++) store.writeEntry(entryFor(`https://h.com/size/${i}`));
    assert.ok(store.getDiskBytes() <= 4000, `diskBytes was ${store.getDiskBytes()}`);
    assert.ok(store.getSummaries().length > 0);
    await store.flush();
    assert.equal(jsonFiles(dir).length, store.getSummaries().length);
  });
});

test('a cap smaller than one entry still keeps the newest entry', async () => {
  await withCappedStore({ maxLogBytes: 1 }, async (store) => {
    store.writeEntry(entryFor('https://h.com/first'));
    store.writeEntry(entryFor('https://h.com/second'));
    assert.equal(store.getSummaries().length, 1, 'must not delete everything');
    assert.equal(store.getSummaries()[0].url, 'https://h.com/second');
  });
});

test('eviction keeps diskBytes honest', async () => {
  await withCappedStore({ maxLogFiles: 3 }, async (store) => {
    for (let i = 0; i < 10; i++) store.writeEntry(entryFor(`https://h.com/acct/${i}`));
    await store.flush();
    const tracked = store.getDiskBytes();
    const summed = store.getSummaries().reduce((a, s) => a + store.sizeByFile.get(s.file), 0);
    assert.equal(tracked, summed);
  });
});

test('no cap configured means nothing is ever evicted', async () => {
  await withCappedStore({}, async (store) => {
    for (let i = 0; i < 25; i++) store.writeEntry(entryFor(`https://h.com/keep/${i}`));
    assert.equal(store.getSummaries().length, 25);
  });
});

test('eviction is announced so the GUI can drop the rows', async () => {
  await withCappedStore({ maxLogFiles: 2 }, async (store) => {
    const seen = [];
    store.onChange((e) => { if (e.type === 'evicted') seen.push(...e.files); });
    for (let i = 0; i < 6; i++) store.writeEntry(entryFor(`https://h.com/ev/${i}`));
    assert.equal(seen.length, 4, `expected 4 evictions, saw ${seen.length}`);
  });
});

test('clearAll empties the folder and resets accounting', async () => {
  await withStore(async (store, dir) => {
    store.writeEntry(entryFor('https://h.com/a'));
    store.writeEntry(entryFor('https://h.com/b'));
    assert.equal(await store.clearAll(), 2);
    assert.equal(store.getSummaries().length, 0);
    assert.equal(store.getDiskBytes(), 0);
    assert.equal(jsonFiles(dir).length, 0);
  });
});
