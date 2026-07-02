const fs = require('fs');
const path = require('path');

class Config {
  constructor(file) {
    this.file = file;
    this.defaults = {
      port: Number(process.env.PORT) || 8889,
      host: process.env.HOST || '0.0.0.0',
      upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS) || 30000,
      maxBodyBytes: Number(process.env.MAX_BODY_BYTES) || 10 * 1024 * 1024,
      urlPrefix: process.env.URL_PREFIX || '/;',
      clearViewPattern: process.env.CLEAR_VIEW_PATTERN || '/session/clear',
    };
    this.current = this._load();
  }

  _load() {
    try {
      const fromFile = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...this.defaults, ...fromFile };
    } catch {
      return { ...this.defaults };
    }
  }

  get() {
    return this.current;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.current, null, 2));
    } catch (err) {
      console.error('[config] write failed:', err.message);
    }
  }

  applyUpdate(input, opts = {}) {
    const next = { ...this.current };
    if ('port' in input) {
      const p = Number(input.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('port must be an integer between 1 and 65535');
      if (opts.reservedPort && p === opts.reservedPort) throw new Error(`port cannot equal GUI port (${opts.reservedPort})`);
      next.port = p;
    }
    if ('host' in input && typeof input.host === 'string' && input.host) next.host = input.host;
    if ('upstreamTimeoutMs' in input) {
      const n = Number(input.upstreamTimeoutMs);
      if (!Number.isFinite(n) || n < 0) throw new Error('upstreamTimeoutMs must be a positive number');
      next.upstreamTimeoutMs = n;
    }
    if ('maxBodyBytes' in input) {
      const n = Number(input.maxBodyBytes);
      if (!Number.isFinite(n) || n < 0) throw new Error('maxBodyBytes must be a positive number');
      next.maxBodyBytes = n;
    }
    if ('urlPrefix' in input) {
      if (typeof input.urlPrefix !== 'string') throw new Error('urlPrefix must be a string');
      next.urlPrefix = input.urlPrefix;
    }
    if ('clearViewPattern' in input) {
      if (typeof input.clearViewPattern !== 'string') throw new Error('clearViewPattern must be a string');
      next.clearViewPattern = input.clearViewPattern;
    }
    const changes = {
      portChanged: next.port !== this.current.port,
      hostChanged: next.host !== this.current.host,
    };
    this.current = next;
    this.save();
    return changes;
  }
}

module.exports = Config;
