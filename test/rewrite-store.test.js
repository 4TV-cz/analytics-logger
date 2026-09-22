const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RewriteStore = require('../src/scripts/rewrite-store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-rewrites-'));
  return path.join(dir, 'config', 'rewrites.json');
}

test('a rule matches its own method and URL, and nothing else', () => {
  const store = new RewriteStore(tmpFile());
  store.add({ method: 'get', url: 'http://api.test/v1/home', file: 'a.json' });

  assert.equal(store.match('GET', 'http://api.test/v1/home').file, 'a.json');
  // Case-insensitive on the method, exact on the URL.
  assert.equal(store.match('get', 'http://api.test/v1/home').file, 'a.json');
  assert.equal(store.match('POST', 'http://api.test/v1/home'), null);
  assert.equal(store.match('GET', 'http://api.test/v1/home?x=1'), null);
  assert.equal(store.match('GET', 'http://api.test/v1/other'), null);
});

test('adding the same method+URL re-points the rule instead of duplicating it', () => {
  const store = new RewriteStore(tmpFile());
  store.add({ method: 'GET', url: 'http://api.test/a', file: 'first.json' });
  store.add({ method: 'GET', url: 'http://api.test/a', file: 'second.json' });

  assert.equal(store.list().length, 1);
  assert.equal(store.match('GET', 'http://api.test/a').file, 'second.json');
});

test('rules survive a restart', () => {
  const file = tmpFile();
  const store = new RewriteStore(file);
  store.add({ method: 'GET', url: 'http://api.test/a', file: 'a.json' });

  const reopened = new RewriteStore(file);
  assert.equal(reopened.match('GET', 'http://api.test/a').file, 'a.json');
});

test('an unreadable or corrupt rules file starts empty rather than throwing', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.equal(new RewriteStore(file).list().length, 0);
  assert.equal(new RewriteStore(path.join(path.dirname(file), 'missing.json')).list().length, 0);
});

test('pruneFiles drops only the rules pointing at files that went away', () => {
  const store = new RewriteStore(tmpFile());
  store.add({ method: 'GET', url: 'http://api.test/a', file: 'a.json' });
  store.add({ method: 'GET', url: 'http://api.test/b', file: 'b.json' });

  const dropped = store.pruneFiles(['a.json', 'never-existed.json']);
  assert.deepEqual(dropped, ['GET http://api.test/a']);
  assert.equal(store.match('GET', 'http://api.test/a'), null);
  assert.equal(store.match('GET', 'http://api.test/b').file, 'b.json');
  assert.deepEqual(store.pruneFiles([]), []);
});

test('remove and clear report whether they changed anything, and notify listeners', () => {
  const store = new RewriteStore(tmpFile());
  const seen = [];
  store.onChange((items) => seen.push(items.length));

  const rule = store.add({ method: 'GET', url: 'http://api.test/a', file: 'a.json' });
  assert.equal(store.remove(rule.key), true);
  assert.equal(store.remove(rule.key), false, 'removing twice is not a change');

  store.add({ method: 'GET', url: 'http://api.test/a', file: 'a.json' });
  assert.equal(store.clear(), 1);
  assert.equal(store.clear(), 0, 'clearing an empty store is not a change');

  assert.deepEqual(seen, [1, 0, 1, 0]);
});

test('a broken listener cannot break the store', () => {
  const store = new RewriteStore(tmpFile());
  store.onChange(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => store.add({ method: 'GET', url: 'http://api.test/a', file: 'a.json' }));
});

test('rules without a URL or a file are rejected', () => {
  const store = new RewriteStore(tmpFile());
  assert.throws(() => store.add({ method: 'GET', file: 'a.json' }), /url/);
  assert.throws(() => store.add({ method: 'GET', url: 'http://api.test/a' }), /log file/);
});
