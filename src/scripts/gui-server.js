const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { providerInfo, providerColumns } = require('./providers');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

class GuiServer {
  constructor({ port, host = '0.0.0.0', guiDir, config, logStore, proxy }) {
    this.port = port;
    this.host = host;
    this.guiDir = guiDir;
    this.config = config;
    this.logStore = logStore;
    this.proxy = proxy;
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  start() {
    return new Promise((resolve, reject) => {
      const onErr = (err) => { this.server.off('listening', onOk); reject(err); };
      const onOk = () => {
        this.server.off('error', onErr);
        const display = this.host === '0.0.0.0' ? 'localhost' : this.host;
        console.log(`GUI listening on http://${display}:${this.port}`);
        resolve();
      };
      this.server.once('error', onErr);
      this.server.once('listening', onOk);
      this.server.listen(this.port, this.host);
    });
  }

  stop() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // Best-effort LAN IPv4 the Roku device uses to reach this proxy. Prefers
  // common home/LAN ranges (192.168 > 172.16-31 > 10) over VPN/virtual
  // adapters, then any external IPv4, then loopback.
  _lanIPv4() {
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

  // Full URL the device hits to trigger "clear view" (empty if disabled).
  _clearViewUrl() {
    const cfg = this.config.get();
    const pat = cfg.clearViewPattern || '';
    if (!pat) return '';
    const tail = pat.startsWith('/') ? pat : '/' + pat;
    return `http://${this._lanIPv4()}:${cfg.port}${tail}`;
  }

  _currentState() {
    const cfg = this.config.get();
    return {
      ...this.proxy.state(),
      port: cfg.port,
      events: this.logStore.getEventCount(),
      requests: this.logStore.getRequestCount(),
      diskBytes: this.logStore.getDiskBytes(),
    };
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
      res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return this._serveStatic(res, 'index.html');
    if (req.method === 'GET' && p === '/styles.css') return this._serveStatic(res, 'styles.css');
    if (req.method === 'GET' && p === '/app.js') return this._serveStatic(res, 'app.js');

    // Decoded event rows (one per analytics event) plus the per-provider grid columns.
    if (req.method === 'GET' && p === '/api/events') {
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
    if (req.method === 'POST' && p === '/api/console/clear') {
      this.proxy.clearConsole();
      return this._sendJson(res, 200, this._currentState());
    }
    if (req.method === 'GET' && p === '/api/state') {
      return this._sendJson(res, 200, this._currentState());
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
        return this._sendJson(res, 200, { config: this.config.get(), state: this._currentState() });
      } catch (err) {
        return this._sendJson(res, 400, { error: err.message, config: this.config.get(), state: this._currentState() });
      }
    }
    // Raw logged request (full request/response JSON for one file).
    if (req.method === 'GET' && p === '/api/entry') {
      const data = this.logStore.readEntry(url.searchParams.get('file') || '');
      if (!data) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
      return;
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
    if (req.method === 'POST' && p === '/api/logs/clear') {
      const deleted = this.logStore.clearAll();
      return this._sendJson(res, 200, { deleted, ...this._currentState() });
    }

    res.writeHead(404); res.end('not found');
  }
}

module.exports = GuiServer;
