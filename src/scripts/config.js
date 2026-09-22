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
      // Path routes for SDKs that can only be given a base URL (no `/;https://`
      // prefix): a request to <prefix>/rest is forwarded to <upstream>/rest.
      routes: [
        { prefix: '/mparticle', upstream: 'https://nativesdks.mparticle.com' },
        { prefix: '/ga', upstream: 'https://www.google-analytics.com' },
      ],
      // Off by default: an analytics relay should hand responses back
      // untouched. Turn on (Settings → Response) when proxying an API or HLS
      // origin whose links the client must follow back through the proxy.
      rewriteResponseUrls: process.env.REWRITE_RESPONSE_URLS === '1',
      rewriteM3u8Urls: process.env.REWRITE_M3U8_URLS === '1',
      // 0 disables the cap. Both are enforced together: whichever is hit first
      // starts evicting the oldest entries.
      maxLogFiles: Number(process.env.MAX_LOG_FILES) || 0,
      maxLogBytes: Number(process.env.MAX_LOG_BYTES) || 0,
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
    if ('routes' in input) {
      if (!Array.isArray(input.routes)) throw new Error('routes must be an array');
      next.routes = input.routes.map((r, i) => {
        const prefix = String(r?.prefix || '').trim();
        const upstream = String(r?.upstream || '').trim().replace(/\/+$/, '');
        if (!prefix.startsWith('/') || prefix.length < 2) throw new Error(`route ${i + 1}: prefix must start with "/"`);
        if (!/^https?:\/\/[^/\s]+$/i.test(upstream)) throw new Error(`route ${i + 1}: upstream must be an http(s) origin like https://host`);
        return { prefix: prefix.replace(/\/+$/, ''), upstream };
      });
    }
    if ('rewriteResponseUrls' in input) {
      next.rewriteResponseUrls = !!input.rewriteResponseUrls;
    }
    if ('rewriteM3u8Urls' in input) {
      next.rewriteM3u8Urls = !!input.rewriteM3u8Urls;
    }
    for (const key of ['maxLogFiles', 'maxLogBytes']) {
      if (!(key in input)) continue;
      const n = Number(input[key]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be zero or a positive number`);
      next[key] = Math.floor(n);
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
