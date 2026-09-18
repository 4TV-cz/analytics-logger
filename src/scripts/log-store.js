const fs = require('fs');
const path = require('path');
const { detectProvider } = require('./providers');

// Stores one JSON file per logged request and keeps an in-memory, flattened
// list of analytics *events* — one entry per event inside every request, as
// extracted by the matching provider (see providers.js) — which is what the
// GUI renders (one row each).
class LogStore {
  constructor(logDir) {
    this.logDir = logDir;
    this.eventRows = [];
    this.requestSeq = 0; // running request number, in arrival order
    this.lastTimestamp = '';
    this.dupCount = 0;
    this.diskBytes = 0;
    fs.mkdirSync(logDir, { recursive: true });
  }

  _timestampForFilename(d) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  }

  _makeFilename(d) {
    const ts = this._timestampForFilename(d);
    if (ts === this.lastTimestamp) {
      this.dupCount += 1;
      return path.join(this.logDir, `${ts}-${this.dupCount}.json`);
    }
    this.lastTimestamp = ts;
    this.dupCount = 0;
    return path.join(this.logDir, `${ts}.json`);
  }

  _safeBasename(name) {
    const base = path.basename(name);
    if (base !== name) return null;
    if (!/^[\w.\-]+\.json$/.test(base)) return null;
    return base;
  }

  // Flatten one logged request into provider-decoded event rows and append them.
  _indexEntry(fileBase, entry) {
    const provider = detectProvider(entry);
    let events;
    try { events = provider.events(entry); }
    catch (err) { console.error(`[log] ${provider.id} decode failed for ${fileBase}:`, err.message); events = []; }
    // A recognised request with nothing decodable still gets one row so it stays visible.
    if (events.length === 0) events = [{ event: 'request', props: {} }];
    const request = ++this.requestSeq;
    const ts = entry.request?.timestamp || null;
    const status = entry.response?.statusCode ?? null;
    const error = entry.response?.error || null;
    const forwarded = entry.response?.forwarded !== false;
    const upstream = entry.request?.upstream?.host || entry.request?.url || null;
    events.forEach((ev, idx) => {
      this.eventRows.push({
        id: `${fileBase}#${idx}`,
        file: fileBase,
        request,
        idx,
        ts,
        provider: provider.id,
        viewerTime: ev.viewerTime ?? null,
        status,
        error,
        forwarded,
        upstream,
        event: ev.event || '',
        props: ev.props || {},
      });
    });
    return { provider: provider.id, count: events.length };
  }

  // Persist one request and index its events. Returns { file, provider, count }.
  writeEntry(entry) {
    const file = this._makeFilename(new Date());
    const base = path.basename(file);
    const buf = Buffer.from(JSON.stringify(entry, null, 2));
    fs.writeFileSync(file, buf);
    this.diskBytes += buf.length;
    return { file, ...this._indexEntry(base, entry) };
  }

  loadFromDisk() {
    let files;
    try {
      files = fs.readdirSync(this.logDir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    // Filenames are timestamp-based, so name order == arrival order.
    files.sort();
    for (const name of files) {
      try {
        const full = path.join(this.logDir, name);
        const entry = JSON.parse(fs.readFileSync(full, 'utf8'));
        try { this.diskBytes += fs.statSync(full).size; } catch {}
        this._indexEntry(name, entry);
      } catch {}
    }
  }

  getDiskBytes() {
    return this.diskBytes;
  }

  getEventRows() {
    return this.eventRows;
  }

  getEventCount() {
    return this.eventRows.length;
  }

  getRequestCount() {
    return this.requestSeq;
  }

  readEntry(name) {
    const safe = this._safeBasename(name);
    if (!safe) return null;
    try {
      return fs.readFileSync(path.join(this.logDir, safe));
    } catch {
      return null;
    }
  }

  clearAll() {
    let deleted = 0;
    try {
      const names = fs.readdirSync(this.logDir).filter((n) => n.endsWith('.json'));
      for (const n of names) {
        try { fs.unlinkSync(path.join(this.logDir, n)); deleted += 1; } catch {}
      }
    } catch {}
    this.eventRows.length = 0;
    this.requestSeq = 0;
    this.diskBytes = 0;
    return deleted;
  }
}

module.exports = LogStore;
