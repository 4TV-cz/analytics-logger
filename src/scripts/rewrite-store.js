const fs = require('fs');
const path = require('path');

// A rewrite pins one captured entry to a method + URL: while the rule exists,
// the proxy answers matching requests out of that stored log file instead of
// calling the upstream at all.
//
// Not to be confused with config.rewriteResponseUrls, which only rewrites the
// URLs found *inside* a live response body. This replaces the whole response.
//
// The method is part of the key even though a rule is created from a URL: a
// canned GET body handed back for the OPTIONS preflight of the same URL would
// break the client rather than help it.
function ruleKey(method, url) {
  return String(method || 'GET').toUpperCase() + ' ' + url;
}

class RewriteStore {
  constructor(file) {
    this.file = file;
    this.rules = new Map();
    this.listeners = new Set();
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;              // no rules yet, or unreadable — start empty
    }
    const list = Array.isArray(raw?.rules) ? raw.rules : [];
    for (const r of list) {
      if (!r || typeof r.url !== 'string' || typeof r.file !== 'string') continue;
      const rule = {
        key: ruleKey(r.method, r.url),
        method: String(r.method || 'GET').toUpperCase(),
        url: r.url,
        file: r.file,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
      };
      this.rules.set(rule.key, rule);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, rules: this.list() }, null, 2));
    } catch (err) {
      console.error('[rewrite] write failed:', err.message);
    }
  }

  // Lets the GUI push the rule set to open browsers instead of them polling.
  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  _emitChange() {
    for (const cb of this.listeners) {
      try { cb(this.list()); } catch { /* a broken listener must not break the proxy */ }
    }
  }

  list() {
    return [...this.rules.values()];
  }

  match(method, url) {
    return this.rules.get(ruleKey(method, url)) || null;
  }

  // Replaces any rule for the same method+URL, so re-running "Rewrite response"
  // on a newer capture of the same request just re-points the rule.
  add({ method, url, file, createdAt = new Date().toISOString() }) {
    if (typeof url !== 'string' || !url) throw new Error('rewrite needs a url');
    if (typeof file !== 'string' || !file) throw new Error('rewrite needs a log file');
    const rule = { key: ruleKey(method, url), method: String(method || 'GET').toUpperCase(), url, file, createdAt };
    this.rules.set(rule.key, rule);
    this._save();
    this._emitChange();
    return rule;
  }

  remove(key) {
    if (!this.rules.delete(key)) return false;
    this._save();
    this._emitChange();
    return true;
  }

  // Called when log files go away (deleted, evicted by a cap). A rule whose
  // entry no longer exists can never serve anything, and leaving it behind would
  // keep flagging the URL as rewritten in the UI.
  pruneFiles(files) {
    const gone = new Set(files || []);
    const dropped = [];
    for (const rule of this.rules.values()) {
      if (gone.has(rule.file)) dropped.push(rule.key);
    }
    if (!dropped.length) return [];
    for (const key of dropped) this.rules.delete(key);
    this._save();
    this._emitChange();
    return dropped;
  }

  clear() {
    if (!this.rules.size) return 0;
    const n = this.rules.size;
    this.rules.clear();
    this._save();
    this._emitChange();
    return n;
  }
}

module.exports = RewriteStore;
module.exports.ruleKey = ruleKey;
