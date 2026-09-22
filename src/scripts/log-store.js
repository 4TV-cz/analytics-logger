const fs = require('fs');
const path = require('path');
const { detectProvider } = require('./providers');

// Keeps the timestamp-first name short enough to stay clear of Windows' 260
// character path limit even when the log directory itself is nested.
const MAX_SLUG_LENGTH = 120;
// The host's share of that budget. Long enough for any real hostname, short
// enough that the path is never crowded out.
const MAX_HOST_SLUG_LENGTH = 60;

// Reduces one URL component to the characters _safeBasename accepts.
function sanitiseSlug(text, maxLength) {
  return String(text || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')  // separators and anything unsafe
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')      // no leading/trailing dots or dashes
    .slice(0, maxLength)
    .replace(/[-.]+$/, '');             // truncation can expose a separator
}

// Joins the parts that are actually there, so a missing host or a root path
// never leaves a stray dash behind.
function slugJoin(...parts) {
  return parts.filter(Boolean).join('-');
}

// Enough parallelism to keep the disk busy without exhausting file handles
// during a burst of traffic or a search over a large capture.
const MAX_CONCURRENT_WRITES = 8;
const MAX_CONCURRENT_READS = 8;

// Deliberately has no .json extension: every directory scan filters on that, so
// the index can never be mistaken for a log entry or fetched through /api/entry.
const INDEX_FILE = '.log-index';
// Bumped whenever what is cached per entry changes shape; an older index is
// simply ignored and rebuilt.
const INDEX_VERSION = 2;

// Runs the matching provider over one entry: the decoded analytics events it
// carries, or a single placeholder so every request has at least one row. Never throws — a decoder bug costs one row, not the
// capture.
function decodeEvents(entry) {
  const provider = detectProvider(entry);
  let events;
  try { events = provider.events(entry); }
  catch (err) {
    console.error(`[log] ${provider.id} decode failed:`, err.message);
    events = [];
  }
  if (!events.length) events = [{ event: 'request', props: {} }];
  return { provider: provider.id, decoded: events };
}

class LogStore {
  // `getLimits` is read on every write so a cap changed in Settings takes
  // effect immediately, without wiring an update path through the config.
  constructor(logDir, getLimits = () => ({})) {
    this.logDir = logDir;
    this.getLimits = getLimits;
    this.summaries = [];
    this.summaryByFile = new Map();
    this.sizeByFile = new Map();
    this.diskBytes = 0;
    this.skippedOnLoad = 0;

    // One row per decoded analytics event, across every entry, in arrival
    // order — what /api/analytics serves. `decodedByFile` keeps the provider output so the index can
    // persist it and a row can be rebuilt when its summary changes.
    this.eventRows = [];
    this.decodedByFile = new Map();
    // Running request number, in arrival order — the "#" column, shared by a
    // request and its events.
    this.requestSeq = 0;

    // Background write queue. `pendingBuffers` doubles as the read-through
    // cache for entries that exist logically but are not on disk yet.
    this.pendingBuffers = new Map();
    this.writeQueue = [];
    this.deletedWhilePending = new Set();
    this.activeWrites = 0;
    this.idleWaiters = [];
    this.changeListeners = new Set();
    this.indexTimer = null;

    fs.mkdirSync(logDir, { recursive: true });
  }

  // Lets the GUI server push updates instead of the browser polling for them.
  onChange(cb) {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  _emitChange(event) {
    for (const cb of this.changeListeners) {
      try { cb(event); } catch { /* a broken listener must not break logging */ }
    }
  }

  _timestampForFilename(d) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  }

  // Filename-safe rendering of the upstream host and request path, query string
  // dropped: `sandbox-api.onvesper.com/api/home` -> `sandbox-api-onvesper-com-api-home`.
  // The host is what tells two captures of the same path apart, so it leads.
  // The output must stay within the character set _safeBasename accepts,
  // because the GUI round-trips these names back through /api/entry.
  _entrySlug(entry) {
    const raw = entry?.request?.upstream?.url || entry?.request?.url || '';
    let host;
    let pathname;
    try {
      const url = new URL(raw);
      host = url.host;                 // includes the port when there is one
      pathname = url.pathname;
    } catch {
      host = entry?.request?.upstream?.host || '';
      pathname = raw.split('?')[0];
    }
    // Dots and the port colon become dashes, so the name reads as one token
    // rather than looking like a file with three extensions.
    host = host.replace(/[.:]+/g, '-');
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Leave malformed percent escapes as-is; the sanitiser below handles them.
    }
    // Host and path share one budget, so adding the host did not make the name
    // any longer than it used to be. The host is capped first, which stops a
    // pathological one from squeezing out the path — the more useful half when
    // scanning the folder.
    const hostSlug = sanitiseSlug(host, MAX_HOST_SLUG_LENGTH);
    const pathBudget = MAX_SLUG_LENGTH - (hostSlug ? hostSlug.length + 1 : 0);
    return slugJoin(hostSlug, sanitiseSlug(pathname, pathBudget));
  }

  _makeFilename(d, entry) {
    const slug = this._entrySlug(entry);
    const ts = this._timestampForFilename(d);
    const base = slug ? `${ts}-${slug}` : ts;
    let name = `${base}.json`;
    // sizeByFile mirrors the directory (populated by both writes and
    // loadFromDisk), so it is enough to spot a same-millisecond collision.
    for (let n = 2; this.sizeByFile.has(name); n++) name = `${base}-${n}.json`;
    return path.join(this.logDir, name);
  }

  _summarize(file, entry, seq, provider, eventCount) {
    return {
      file: path.basename(file),
      seq,
      timestamp: entry.request?.timestamp || null,
      method: entry.request?.method || null,
      url: entry.request?.url || null,
      upstream: entry.request?.upstream?.url || null,
      host: entry.request?.upstream?.host || null,
      status: entry.response?.statusCode ?? null,
      error: entry.response?.error || null,
      durationMs: entry.response?.durationMs ?? null,
      reqBytes: entry.request?.bodyBytes ?? null,
      resBytes: entry.response?.bodyBytes ?? null,
      // False when forwarding was off and the proxy answered the client itself.
      forwarded: entry.response?.forwarded !== false,
      // Which analytics provider decoded this request, and how many events it
      // held.
      provider,
      events: eventCount,
      // Set when this response came from a rewrite rule rather than the
      // upstream, so the row can say so.
      rewrittenFrom: entry.response?.rewrittenFrom || null,
      // Whether this entry carries a hand-edited response body, which is what a
      // rewrite rule pointing at it would serve.
      responseEdited: entry.response?.bodyEdited !== undefined,
    };
  }

  // The event rows for one entry, derived from its summary plus the
  // provider's decoded events.
  _rowsFor(summary, decoded) {
    return decoded.map((ev, idx) => ({
      id: `${summary.file}#${idx}`,
      file: summary.file,
      request: summary.seq,
      idx,
      ts: summary.timestamp,
      provider: summary.provider,
      viewerTime: ev.viewerTime ?? null,
      status: summary.status,
      error: summary.error,
      forwarded: summary.forwarded,
      upstream: summary.host || summary.url,
      event: ev.event || '',
      props: ev.props || {},
    }));
  }

  // Registers one entry in every in-memory index; shared by writes and the
  // startup load.
  _admit(summary, decoded, size) {
    this.summaries.push(summary);
    this.summaryByFile.set(summary.file, summary);
    this.decodedByFile.set(summary.file, decoded);
    this.eventRows.push(...this._rowsFor(summary, decoded));
    this._trackSize(summary.file, size);
  }

  _safeBasename(name) {
    const base = path.basename(name);
    if (base !== name) return null;
    if (!/^[\w.\-]+\.json$/.test(base)) return null;
    return base;
  }

  _trackSize(name, size) {
    this.sizeByFile.set(name, size);
    this.diskBytes += size;
  }

  _untrackSize(name) {
    const sz = this.sizeByFile.get(name);
    if (sz != null) {
      this.diskBytes -= sz;
      this.sizeByFile.delete(name);
    }
  }

  // Returns the filename immediately but writes in the background: the proxy
  // must not block on disk while a client waits for its response. The entry is
  // readable from `pendingBuffers` until the write lands, so the GUI never sees
  // a row it cannot open.
  writeEntry(entry) {
    const file = this._makeFilename(new Date(), entry);
    const name = path.basename(file);
    const buf = Buffer.from(JSON.stringify(entry, null, 2));

    const { provider, decoded } = decodeEvents(entry);
    const summary = this._summarize(file, entry, ++this.requestSeq, provider, decoded.length);
    this._admit(summary, decoded, buf.length);
    this.pendingBuffers.set(name, buf);
    this.writeQueue.push(name);
    this._drainWrites();
    this._emitChange({ type: 'entry', summary, events: this._rowsFor(summary, decoded) });
    this._enforceLimits();
    return file;
  }

  // Drops the oldest entries until the capture is back inside its caps.
  // `summaries` is kept in chronological order, so the oldest is always at the
  // front. Always leaves one entry behind, so a cap smaller than a single
  // request cannot delete the thing that was just captured.
  _enforceLimits() {
    const { maxLogFiles = 0, maxLogBytes = 0 } = this.getLimits() || {};
    if (!maxLogFiles && !maxLogBytes) return;

    const evicted = [];
    while (
      this.summaries.length > 1 &&
      ((maxLogFiles && this.summaries.length > maxLogFiles) ||
       (maxLogBytes && this.diskBytes > maxLogBytes))
    ) {
      const oldest = this.summaries.shift();
      this._untrackSize(oldest.file);
      this.summaryByFile.delete(oldest.file);
      this.decodedByFile.delete(oldest.file);
      evicted.push(oldest.file);
    }
    if (!evicted.length) return;
    this._dropRows(new Set(evicted));

    for (const name of evicted) {
      if (this.pendingBuffers.has(name)) {
        this.pendingBuffers.delete(name);
        this.deletedWhilePending.add(name);
      }
      fs.promises.unlink(path.join(this.logDir, name)).catch(() => {});
    }
    this._emitChange({ type: 'evicted', files: evicted });
  }

  _dropRows(files) {
    this.eventRows = this.eventRows.filter((r) => !files.has(r.file));
  }

  _drainWrites() {
    while (this.activeWrites < MAX_CONCURRENT_WRITES && this.writeQueue.length) {
      const name = this.writeQueue.shift();
      const buf = this.pendingBuffers.get(name);
      if (!buf) continue; // deleted before it reached the front of the queue
      this.activeWrites += 1;
      fs.promises.writeFile(path.join(this.logDir, name), buf)
        .then(() => {
          // A delete that arrived mid-write wins: remove what we just wrote.
          if (this.deletedWhilePending.has(name)) {
            this.deletedWhilePending.delete(name);
            return fs.promises.unlink(path.join(this.logDir, name)).catch(() => {});
          }
        })
        .catch((err) => {
          console.error('[logger] write failed:', name, err.message);
          this._forgetEntry(name);
        })
        .finally(() => {
          this.pendingBuffers.delete(name);
          this.activeWrites -= 1;
          this._drainWrites();
          if (!this.activeWrites && !this.writeQueue.length) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const resolve of waiters) resolve();
          }
        });
    }
  }

  // Resolves once every queued write has hit the disk. Anything that reads the
  // directory rather than the in-memory index awaits this first.
  flush() {
    if (!this.activeWrites && !this.writeQueue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  _forgetEntry(name) {
    const idx = this.summaries.findIndex((s) => s.file === name);
    if (idx !== -1) this.summaries.splice(idx, 1);
    this.summaryByFile.delete(name);
    this.decodedByFile.delete(name);
    this._dropRows(new Set([name]));
    this._untrackSize(name);
  }

  // Summaries (and the decoded events behind /api/analytics) are expensive
  // to rebuild — a JSON.parse plus a provider pass per file — so they are cached
  // in a sidecar keyed by name+size. Log files are only ever rewritten by
  // updateEntry, which changes their size, so a size match is enough to trust
  // the cached copy.
  _readIndex() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.logDir, INDEX_FILE), 'utf8'));
      if (raw?.version !== INDEX_VERSION || !Array.isArray(raw.entries)) return new Map();
      return new Map(raw.entries.map((e) => [e.file, e]));
    } catch {
      return new Map();
    }
  }

  _writeIndex() {
    const entries = this.summaries.map((s) => ({
      file: s.file,
      size: this.sizeByFile.get(s.file) ?? 0,
      summary: s,
      decoded: this.decodedByFile.get(s.file) || [],
    }));
    try {
      fs.writeFileSync(
        path.join(this.logDir, INDEX_FILE),
        JSON.stringify({ version: INDEX_VERSION, entries })
      );
    } catch {
      // A stale or missing index only costs a slower next startup.
    }
  }

  // Rewriting the whole index synchronously for a single deletion blocked the
  // proxy. A stale index costs nothing but a slower next start, so coalesce.
  _scheduleIndexWrite() {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this._writeIndex();
    }, 2000);
    this.indexTimer.unref?.();
  }

  loadFromDisk() {
    let files;
    try {
      files = fs.readdirSync(this.logDir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    const index = this._readIndex();
    let reparsed = 0;
    const loaded = [];
    for (const name of files) {
      const full = path.join(this.logDir, name);
      let size;
      try { size = fs.statSync(full).size; } catch { continue; }

      const cached = index.get(name);
      if (cached && cached.size === size && cached.summary && Array.isArray(cached.decoded)) {
        loaded.push({ summary: cached.summary, decoded: cached.decoded, size });
        continue;
      }
      try {
        const entry = JSON.parse(fs.readFileSync(full, 'utf8'));
        const { provider, decoded } = decodeEvents(entry);
        loaded.push({ summary: this._summarize(full, entry, 0, provider, decoded.length), decoded, size });
        reparsed += 1;
      } catch {
        // Corrupt or truncated file — skipped, and reported below.
        this.skippedOnLoad += 1;
      }
    }
    // Numbered after sorting so the sequence reflects chronology, whatever
    // order the directory listing had them in. Two entries from the same
    // millisecond keep the order the previous run numbered them in (cached in
    // the index); failing that, filename order.
    loaded.sort((a, b) =>
      (a.summary.timestamp || '').localeCompare(b.summary.timestamp || '')
      || ((a.summary.seq && b.summary.seq) ? a.summary.seq - b.summary.seq : 0)
      || a.summary.file.localeCompare(b.summary.file));
    for (const { summary, decoded, size } of loaded) {
      summary.seq = ++this.requestSeq;
      this._admit(summary, decoded, size);
    }
    if (this.skippedOnLoad) {
      console.warn(`[logger] skipped ${this.skippedOnLoad} unreadable log file(s)`);
    }
    if (reparsed || index.size !== this.summaries.length) this._writeIndex();
  }

  getDiskBytes() {
    return this.diskBytes;
  }

  getSummaries() {
    return this.summaries;
  }

  getSummary(name) {
    return this.summaryByFile.get(name) || null;
  }

  getEventRows() {
    return this.eventRows;
  }

  getEventCount() {
    return this.eventRows.length;
  }

  readEntry(name) {
    const safe = this._safeBasename(name);
    if (!safe) return null;
    const pending = this.pendingBuffers.get(safe);
    if (pending) return pending;
    try {
      return fs.readFileSync(path.join(this.logDir, safe));
    } catch {
      return null;
    }
  }

  // Rewrites one entry in place. Captures are otherwise write-once, so this is
  // the single path that mutates one — it exists for the edited response body a
  // rewrite rule serves. `mutate` receives the parsed entry and returns the
  // entry to store, or null to abandon the update.
  //
  // Queued writes are flushed first: editing a file that a background write is
  // about to overwrite would silently lose the edit.
  async updateEntry(name, mutate) {
    const safe = this._safeBasename(name);
    if (!safe) return null;
    await this.flush();

    const raw = this.readEntry(safe);
    if (!raw) return null;
    let entry;
    try { entry = JSON.parse(raw.toString('utf8')); }
    catch { return null; }

    const next = mutate(entry);
    if (!next) return null;

    const buf = Buffer.from(JSON.stringify(next, null, 2));
    try {
      await fs.promises.writeFile(path.join(this.logDir, safe), buf);
    } catch (err) {
      console.error('[logger] update failed:', safe, err.message);
      return null;
    }

    this._untrackSize(safe);
    this._trackSize(safe, buf.length);
    const previous = this.summaryByFile.get(safe);
    const { provider, decoded } = decodeEvents(next);
    const summary = this._summarize(safe, next, previous ? previous.seq : ++this.requestSeq, provider, decoded.length);
    const idx = this.summaries.findIndex((s) => s.file === safe);
    if (idx !== -1) this.summaries[idx] = summary;
    else this.summaries.push(summary);
    this.summaryByFile.set(safe, summary);
    this.decodedByFile.set(safe, decoded);
    // The rows are rebuilt in place so the Events tab keeps its order.
    const rows = this._rowsFor(summary, decoded);
    const first = this.eventRows.findIndex((r) => r.file === safe);
    if (first === -1) this.eventRows.push(...rows);
    else {
      let last = first;
      while (last + 1 < this.eventRows.length && this.eventRows[last + 1].file === safe) last += 1;
      this.eventRows.splice(first, last - first + 1, ...rows);
    }
    this._scheduleIndexWrite();
    this._emitChange({ type: 'updated', summary, events: rows });
    return { summary, entry: next };
  }

  async deleteEntry(name) {
    const safe = this._safeBasename(name);
    if (!safe) return false;

    if (this.pendingBuffers.has(safe)) {
      // Not on disk yet: drop the buffer so a queued write is skipped, and mark
      // it so a write already in flight unlinks itself when it finishes.
      this.pendingBuffers.delete(safe);
      this.deletedWhilePending.add(safe);
    }
    try {
      await fs.promises.unlink(path.join(this.logDir, safe));
    } catch (err) {
      if (err.code !== 'ENOENT') return false;
    }
    this._forgetEntry(safe);
    this._scheduleIndexWrite();
    this._emitChange({ type: 'deleted', file: safe });
    return true;
  }

  async clearAll() {
    await this.flush();
    let deleted = 0;
    try {
      const names = fs.readdirSync(this.logDir).filter((n) => n.endsWith('.json'));
      for (const n of names) {
        try { fs.unlinkSync(path.join(this.logDir, n)); deleted += 1; } catch {}
      }
    } catch {}
    this.summaries.length = 0;
    this.summaryByFile.clear();
    this.decodedByFile.clear();
    this.eventRows = [];
    this.requestSeq = 0;
    this.sizeByFile.clear();
    this.diskBytes = 0;
    this.skippedOnLoad = 0;
    this._scheduleIndexWrite();
    this._emitChange({ type: 'cleared' });
    return deleted;
  }

  // Reads the whole capture, so it is deliberately asynchronous and bounded:
  // the synchronous version froze the proxy and the GUI for the duration.
  async search(query, limit = 2000) {
    if (!query) return { files: [], scanned: 0, truncated: false };
    await this.flush();

    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let names;
    try { names = (await fs.promises.readdir(this.logDir)).filter((n) => n.endsWith('.json')); }
    catch { return { files: [], scanned: 0, truncated: false }; }
    names.sort();

    const files = [];
    let scanned = 0;
    let truncated = false;
    let next = 0;

    const worker = async () => {
      while (next < names.length && !truncated) {
        const name = names[next++];
        scanned += 1;
        try {
          const txt = await fs.promises.readFile(path.join(this.logDir, name), 'utf8');
          if (re.test(txt)) {
            files.push(name);
            if (files.length >= limit) truncated = true;
          }
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT_READS }, worker));

    files.sort();
    return { files, scanned, truncated };
  }

  // Every entry, parsed, read with the same bounded concurrency as search —
  // the synchronous version of this blocked the proxy for the whole export.
  async readAllEntries() {
    await this.flush();
    const names = this.summaries.map((s) => s.file);
    const entries = new Array(names.length);
    let next = 0;

    const worker = async () => {
      while (next < names.length) {
        const i = next++;
        try {
          entries[i] = JSON.parse(await fs.promises.readFile(path.join(this.logDir, names[i]), 'utf8'));
        } catch {
          entries[i] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT_READS }, worker));
    return entries.filter(Boolean);   // order preserved: workers write by index
  }

  // Called on shutdown so nothing queued is lost and the next start is fast.
  async close() {
    clearTimeout(this.indexTimer);
    this.indexTimer = null;
    await this.flush();
    this._writeIndex();
  }
}

module.exports = LogStore;
