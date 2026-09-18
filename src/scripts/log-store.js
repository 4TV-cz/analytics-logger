const fs = require('fs');
const path = require('path');
const { decodeEvent, extractEvents } = require('./mux');

// Stores one JSON file per beacon request (as received from the Roku Mux SDK)
// and keeps an in-memory, flattened list of decoded *events* — one entry per
// event inside every beacon — which is what the GUI renders (one row each).
class LogStore {
  constructor(logDir) {
    this.logDir = logDir;
    this.eventRows = [];
    this.beaconSeq = 0; // running beacon number, in arrival order
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

  // Flatten one beacon entry into decoded event rows and append them.
  _indexEntry(fileBase, entry) {
    const events = extractEvents(entry);
    if (events.length === 0) return 0;
    const beacon = ++this.beaconSeq;
    const ts = entry.request?.timestamp || null;
    const status = entry.response?.statusCode ?? null;
    const error = entry.response?.error || null;
    const forwarded = entry.response?.forwarded !== false;
    const upstream = entry.request?.upstream?.host || entry.request?.url || null;
    events.forEach((raw, idx) => {
      const props = decodeEvent(raw);
      const viewerTimeRaw = props.viewer_time;
      const viewerTime = viewerTimeRaw != null ? Number(viewerTimeRaw) : null;
      this.eventRows.push({
        id: `${fileBase}#${idx}`,
        file: fileBase,
        beacon,
        idx,
        ts,
        viewerTime: Number.isFinite(viewerTime) ? viewerTime : null,
        status,
        error,
        forwarded,
        upstream,
        event: props.event || raw.e || '',
        props,
      });
    });
    return events.length;
  }

  writeEntry(entry) {
    const file = this._makeFilename(new Date());
    const base = path.basename(file);
    const buf = Buffer.from(JSON.stringify(entry, null, 2));
    fs.writeFileSync(file, buf);
    this.diskBytes += buf.length;
    this._indexEntry(base, entry);
    return file;
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

  getBeaconCount() {
    return this.beaconSeq;
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
    this.beaconSeq = 0;
    this.diskBytes = 0;
    return deleted;
  }
}

module.exports = LogStore;
