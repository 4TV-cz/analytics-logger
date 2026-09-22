const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildHar } = require('./har');
const { sameJsonShape } = require('./body-utils');
const { providerInfo, providerColumns } = require('./providers');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// The object/array a stored part's body parses to, or undefined when it has
// none. Bodies arrive already parsed when they were JSON, but one that only
// looks like JSON (served under another content-type) is still stored as text.
function parseJsonBody(part) {
  const raw = part.bodyEdited !== undefined ? part.bodyEdited : part.body;
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* not JSON after all */ }
  }
  return undefined;
}

// Best-effort LAN IPv4 a device on the network uses to reach this machine.
// Prefers common home/LAN ranges (192.168 > 172.16-31 > 10) over VPN/virtual
// adapters, then any external IPv4, then loopback.
function lanIPv4() {
  const addrs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) addrs.push(ni.address);
    }
  }
  return addrs.find((a) => a.startsWith('192.168.'))
    || addrs.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a))
    || addrs.find((a) => a.startsWith('10.'))
    || addrs[0]
    || '127.0.0.1';
}

class GuiServer {
  // Defaults to loopback: the API serves captured traffic verbatim, including
  // Authorization headers and signed URLs, and has no authentication. Set
  // GUI_HOST=0.0.0.0 to deliberately expose it to the network.
  constructor({ port, host = process.env.GUI_HOST || '127.0.0.1', guiDir, config, logStore, proxy, rewrites = null, liveReload = false }) {
    this.port = port;
    this.host = host;
    this.guiDir = guiDir;
    this.config = config;
    this.logStore = logStore;
    this.proxy = proxy;
    this.rewrites = rewrites;
    this.liveReload = liveReload;
    // Open event-stream connections, so a change can be pushed to all of them.
    this.eventClients = new Set();
    this.guiWatcher = null;
    this.reloadTimer = null;
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  // Resolves once listening, rejects if the port cannot be bound — callers need
  // to know, since a dead GUI server means there is no UI at all.
  start() {
    return new Promise((resolve, reject) => {
      const onErr = (err) => { this.server.off('listening', onOk); reject(err); };
      const onOk = () => {
        this.server.off('error', onErr);
        const display = this.host === '0.0.0.0' ? 'localhost' : this.host;
        console.log(`GUI listening on http://${display}:${this.port}`);
        this._startLiveReload();
        resolve();
      };
      this.server.once('error', onErr);
      this.server.once('listening', onOk);
      this.server.listen(this.port, this.host);
    });
  }

  // Dev only: the GUI files are read from disk per request, so a change needs no
  // server restart — only a browser refresh, which the event stream can push.
  _startLiveReload() {
    if (!this.liveReload || this.guiWatcher) return;
    try {
      // persistent:false so the watcher never keeps the process alive on its own.
      this.guiWatcher = fs.watch(this.guiDir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        // Editors write a file several times per save; collapse the burst.
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          console.log(`[gui] ${filename} changed — reloading ${this.eventClients.size} client(s)`);
          this._broadcast('reload', { file: String(filename) });
        }, 120);
      });
      console.log(`[gui] live reload watching ${this.guiDir}`);
    } catch (err) {
      console.warn('[gui] live reload unavailable:', err.message);
    }
  }

  _broadcast(event, data) {
    for (const send of this.eventClients) {
      try { send(event, data); } catch { /* a dead client must not stop the rest */ }
    }
  }

  stop() {
    clearTimeout(this.reloadTimer);
    if (this.guiWatcher) { this.guiWatcher.close(); this.guiWatcher = null; }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // Full URL a device hits to trigger "clear session" (empty when disabled).
  _clearViewUrl() {
    const cfg = this.config.get();
    const pat = cfg.clearViewPattern || '';
    if (!pat) return '';
    const tail = pat.startsWith('/') ? pat : '/' + pat;
    return `http://${lanIPv4()}:${cfg.port}${tail}`;
  }

  // Proxy state plus the capture totals, so one frame is enough for the status
  // bar and a reconnecting browser can tell whether it missed anything.
  _currentState() {
    return {
      ...this.proxy.state(),
      requests: this.logStore.getSummaries().length,
      events: this.logStore.getEventCount(),
      diskBytes: this.logStore.getDiskBytes(),
    };
  }

  _rewriteList() {
    return this.rewrites ? this.rewrites.list() : [];
  }

  _sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  _readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 65536) reject(new Error('body too large')); });
      req.on('end', () => {
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
      });
      req.on('error', reject);
    });
  }

  _serveStatic(res, fileName) {
    const safe = path.basename(fileName);
    const full = path.join(this.guiDir, safe);
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(safe).toLowerCase();
      res.writeHead(200, {
        'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
        // The GUI ships with the app and changes when the app is updated, but
        // the URL never does — without this the browser (and the Electron
        // window) keeps serving a stale UI after an upgrade or an edit.
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  }

  // A cross-site <form> can issue POST/DELETE but cannot set a custom header
  // without a CORS preflight the server never approves, so requiring one keeps
  // another page in the browser from wiping or reconfiguring the capture.
  _isTrustedMutation(req) {
    return req.headers['x-proxy-ui'] === '1';
  }

  // Server-sent events: the browser used to re-fetch every summary once a
  // second, which grows with the capture. Now it is told what changed.
  _streamEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('state', this._currentState());
    this.eventClients.add(send);

    const offStore = this.logStore.onChange((change) => {
      send('store', {
        ...change,
        total: this.logStore.getSummaries().length,
        eventTotal: this.logStore.getEventCount(),
        diskBytes: this.logStore.getDiskBytes(),
      });
    });
    const offProxy = this.proxy.onStateChange(() => send('state', this._currentState()));
    const offConsole = this.proxy.onConsole((line) => send('console', line));
    const offRewrites = this.rewrites
      ? this.rewrites.onChange((items) => send('rewrites', { items }))
      : () => {};

    // Comment frames keep intermediaries from closing an idle connection.
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25000);

    const cleanup = () => {
      clearInterval(ping);
      this.eventClients.delete(send);
      offStore();
      offProxy();
      offConsole();
      offRewrites();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method !== 'GET' && !this._isTrustedMutation(req)) {
      return this._sendJson(res, 403, { error: 'missing X-Proxy-UI header' });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return this._serveStatic(res, 'index.html');
    if (req.method === 'GET' && p === '/styles.css') return this._serveStatic(res, 'styles.css');
    if (req.method === 'GET' && p === '/app.js') return this._serveStatic(res, 'app.js');

    if (req.method === 'GET' && p === '/api/list') {
      const items = this.logStore.getSummaries();
      return this._sendJson(res, 200, {
        total: items.length,
        items,
        diskBytes: this.logStore.getDiskBytes(),
        state: this._currentState(),
        // Carried on the full refresh too, so a reconnecting browser picks the
        // rules up without a second round trip.
        rewrites: this._rewriteList(),
      });
    }
    // Decoded analytics rows (one per event) plus the per-provider grid
    // columns. `since=<row id>` returns only what came after that row, so the
    // fallback poll stays cheap; `cseq` does the same for console lines.
    if (req.method === 'GET' && p === '/api/analytics') {
      const sinceId = url.searchParams.get('since');
      const rows = this.logStore.getEventRows();
      let slice = rows;
      if (sinceId) {
        const idx = rows.findIndex((r) => r.id === sinceId);
        if (idx !== -1) slice = rows.slice(idx + 1);
      }
      return this._sendJson(res, 200, {
        providers: providerInfo(),
        columns: providerColumns(),
        total: rows.length,
        rows: slice,
        console: this.proxy.consoleSince(Number(url.searchParams.get('cseq')) || 0),
        state: this._currentState(),
      });
    }
    if (req.method === 'GET' && p === '/api/console') {
      return this._sendJson(res, 200, { lines: this.proxy.consoleSince(Number(url.searchParams.get('since')) || 0) });
    }
    if (req.method === 'POST' && p === '/api/console/clear') {
      this.proxy.clearConsole();
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'GET' && p === '/api/state') {
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'GET' && p === '/api/events') {
      return this._streamEvents(req, res);
    }
    if (req.method === 'GET' && p === '/api/config') {
      return this._sendJson(res, 200, { ...this.config.get(), guiPort: this.port, clearViewUrl: this._clearViewUrl() });
    }
    if (req.method === 'POST' && p === '/api/config') {
      try {
        const body = await this._readJsonBody(req);
        const changes = this.config.applyUpdate(body, { reservedPort: this.port });
        if ((changes.portChanged || changes.hostChanged) && this.proxy.state().listening) {
          try { await this.proxy.restart(); }
          catch (err) {
            return this._sendJson(res, 400, { error: 'failed to bind: ' + err.message, config: this.config.get(), state: this._currentState() });
          }
        }
        return this._sendJson(res, 200, { config: this.config.get(), state: this._currentState(), clearViewUrl: this._clearViewUrl() });
      } catch (err) {
        return this._sendJson(res, 400, { error: err.message, config: this.config.get(), state: this._currentState() });
      }
    }
    if (req.method === 'GET' && p === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const t0 = Date.now();
      const result = await this.logStore.search(q);
      return this._sendJson(res, 200, { query: q, ...result, durationMs: Date.now() - t0 });
    }
    if (req.method === 'GET' && p === '/api/entry') {
      const data = this.logStore.readEntry(url.searchParams.get('file') || '');
      if (!data) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
      return;
    }
    if (req.method === 'DELETE' && p === '/api/entry') {
      const ok = await this.logStore.deleteEntry(url.searchParams.get('file') || '');
      if (!ok) return this._sendJson(res, 400, { error: 'invalid or missing file' });
      return this._sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/proxy/start') {
      try { await this.proxy.start(); return this._sendJson(res, 200, this._currentState()); }
      catch (err) { return this._sendJson(res, 500, { error: err.message, ...this._currentState() }); }
    }
    if (req.method === 'POST' && p === '/api/proxy/stop') {
      await this.proxy.stop();
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'POST' && p === '/api/recording/start') {
      this.proxy.setRecording(true);
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'POST' && p === '/api/recording/stop') {
      this.proxy.setRecording(false);
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'POST' && p === '/api/forwarding/start') {
      this.proxy.setForwarding(true);
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'POST' && p === '/api/forwarding/stop') {
      this.proxy.setForwarding(false);
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'GET' && p === '/api/har') {
      const har = buildHar(await this.logStore.readAllEntries(), { name: 'Analytics Logger' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="analytics-capture.har"',
      });
      res.end(JSON.stringify(har, null, 2));
      return;
    }
    if (req.method === 'POST' && p === '/api/replay') {
      const raw = this.logStore.readEntry(url.searchParams.get('file') || '');
      if (!raw) return this._sendJson(res, 404, { error: 'entry not found' });
      let entry;
      try { entry = JSON.parse(raw.toString('utf8')); }
      catch { return this._sendJson(res, 400, { error: 'entry is not valid JSON' }); }
      try {
        return this._sendJson(res, 200, await this.proxy.replay(entry));
      } catch (err) {
        return this._sendJson(res, 400, { error: err.message });
      }
    }
    // ── Edited response body ───────────────────────────────────────────────
    // Stored on the entry as `response.bodyEdited`, leaving the captured body
    // untouched. A rewrite rule pointing at this entry serves the edit.
    if (p === '/api/entry/body' && (req.method === 'POST' || req.method === 'DELETE')) {
      const file = url.searchParams.get('file') || '';
      const raw = this.logStore.readEntry(file);
      if (!raw) return this._sendJson(res, 404, { error: 'entry not found' });
      let entry;
      try { entry = JSON.parse(raw.toString('utf8')); }
      catch { return this._sendJson(res, 400, { error: 'entry is not valid JSON' }); }
      if (!entry?.response) return this._sendJson(res, 400, { error: 'entry has no response' });

      if (req.method === 'DELETE') {
        const result = await this.logStore.updateEntry(file, (e) => {
          delete e.response.bodyEdited;
          return e;
        });
        if (!result) return this._sendJson(res, 500, { error: 'could not update the entry' });
        return this._sendJson(res, 200, { ok: true, summary: result.summary });
      }

      let body;
      try { body = await this._readJsonBody(req); }
      catch (err) { return this._sendJson(res, 400, { error: err.message }); }
      if (!('body' in body)) return this._sendJson(res, 400, { error: 'missing body' });

      const captured = parseJsonBody(entry.response);
      if (captured === undefined) return this._sendJson(res, 400, { error: 'response body is not JSON' });
      // The editor can only change values, so a shape mismatch means something
      // else built this request — reject rather than store a body whose keys no
      // longer match what was captured.
      if (!sameJsonShape(captured, body.body)) {
        return this._sendJson(res, 400, { error: 'edited body must keep the same keys and array lengths' });
      }

      const result = await this.logStore.updateEntry(file, (e) => {
        e.response.bodyEdited = body.body;
        return e;
      });
      if (!result) return this._sendJson(res, 500, { error: 'could not update the entry' });
      return this._sendJson(res, 200, { ok: true, summary: result.summary });
    }

    // ── Response rewrites ──────────────────────────────────────────────────
    // A rule is created from a captured entry: the GUI sends the log file it
    // was right-clicked on, and the method + URL come from the entry itself, so
    // the key can never disagree with what the proxy matches on.
    if (p === '/api/rewrites') {
      if (!this.rewrites) return this._sendJson(res, 501, { error: 'rewrites are not available' });
      if (req.method === 'GET') {
        return this._sendJson(res, 200, { items: this._rewriteList() });
      }
      if (req.method === 'POST') {
        let body;
        try { body = await this._readJsonBody(req); }
        catch (err) { return this._sendJson(res, 400, { error: err.message }); }

        const file = String(body.file || '');
        const raw = this.logStore.readEntry(file);
        if (!raw) return this._sendJson(res, 404, { error: 'entry not found' });
        let entry;
        try { entry = JSON.parse(raw.toString('utf8')); }
        catch { return this._sendJson(res, 400, { error: 'entry is not valid JSON' }); }

        const targetUrl = entry?.request?.upstream?.url || entry?.request?.url;
        if (!targetUrl) return this._sendJson(res, 400, { error: 'entry has no URL to match on' });
        if (!entry?.response || entry.response.error || entry.response.statusCode == null) {
          return this._sendJson(res, 400, { error: 'entry has no response to serve' });
        }
        const rule = this.rewrites.add({ method: entry.request.method, url: targetUrl, file: path.basename(file) });
        return this._sendJson(res, 200, { rule, items: this._rewriteList() });
      }
      if (req.method === 'DELETE') {
        const key = url.searchParams.get('key');
        if (key === null) {
          const cleared = this.rewrites.clear();
          return this._sendJson(res, 200, { cleared, items: this._rewriteList() });
        }
        const removed = this.rewrites.remove(key);
        if (!removed) return this._sendJson(res, 404, { error: 'no such rewrite', items: this._rewriteList() });
        return this._sendJson(res, 200, { removed: key, items: this._rewriteList() });
      }
    }
    if (req.method === 'POST' && p === '/api/logs/clear') {
      const deleted = await this.logStore.clearAll();
      return this._sendJson(res, 200, { deleted, ...this._currentState() });
    }

    res.writeHead(404); res.end('not found');
  }
}

module.exports = GuiServer;
