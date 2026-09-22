const http = require('http');
const path = require('path');
const { parseUpstreamFromUrl, getPrefixPath, isControlRequest, rewriteUrlsInBody, isM3u8Response, rewriteM3u8Body, buildUpstreamHeaders, buildClientHeaders, callUpstream } = require('./proxy');
const { isLikelyText, parseIfJson } = require('./body-utils');

const CONSOLE_MAX_LINES = 2000;

// The stored shape of a response, from a callUpstream result plus the body the
// client actually received (which differs from the upstream's when URL
// rewriting applies). One definition, so the live path and replay cannot drift.
function buildResponsePart(result, body) {
  if (!result.ok) return { error: result.error, durationMs: result.durationMs };
  const contentType = result.headers['content-type'] || '';
  const textual = isLikelyText(body, contentType);
  return {
    durationMs: result.durationMs,
    statusCode: result.statusCode,
    statusMessage: result.statusMessage,
    headers: result.headers,
    rawHeaders: result.rawHeaders,
    bodyBytes: body.length,
    body: textual ? parseIfJson(body.toString('utf8'), contentType) : null,
    bodyBase64: textual ? null : body.toString('base64'),
  };
}

// Rebuilds the original request body from however it was stored.
function replayBody(req) {
  if (req.bodyBase64) return Buffer.from(req.bodyBase64, 'base64');
  if (req.body == null || req.body === '') return Buffer.alloc(0);
  return Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), 'utf8');
}

// Same, for a stored response — a JSON body is kept parsed, so it has to be
// re-serialised rather than concatenated.
function storedBody(part) {
  if (part.bodyBase64) return Buffer.from(part.bodyBase64, 'base64');
  if (part.body == null || part.body === '') return Buffer.alloc(0);
  return Buffer.from(typeof part.body === 'string' ? part.body : JSON.stringify(part.body), 'utf8');
}

// Transparent proxy for analytics endpoints (Mux, Google Analytics, mParticle
// or anything else) — and for any other HTTP traffic a client is pointed at
// it with. The upstream URL travels in the request path, after the configured
// prefix (http://<proxy>/;https://<env>.litix.io/...) or via a path route.
// Every request is forwarded unchanged and logged; providers.js decodes the
// ones it recognises into events. With forwarding off, requests are still
// logged but terminate here (200 OK) and never reach the upstream.
class ProxyServer {
  constructor({ config, logStore, rewrites = null }) {
    this.config = config;
    this.logStore = logStore;
    this.rewrites = rewrites;
    this.isListening = false;
    this.isRecording = true;
    this.isForwarding = true;
    this.clearViewAt = null;
    this.stateListeners = new Set();
    // In-memory console: one line per incoming request, mirrored to stdout
    // and served to the GUI console panel. Bounded ring buffer.
    this.consoleLines = [];
    this.consoleSeq = 0;
    this.consoleListeners = new Set();
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('clientError', (err, socket) => {
      console.error('[proxy] client error:', err.message);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  }

  // ── Console ────────────────────────────────────────────────────────────

  // Record one console line for a request and echo it to stdout.
  _logRequest({ timestamp, method, url, status, note }) {
    const line = { seq: ++this.consoleSeq, ts: timestamp, method, url, status: String(status), note: note || '' };
    this.consoleLines.push(line);
    if (this.consoleLines.length > CONSOLE_MAX_LINES) this.consoleLines.splice(0, this.consoleLines.length - CONSOLE_MAX_LINES);
    console.log(`[${timestamp}] ${method} ${url} -> ${status}${note ? ' ' + note : ''}`);
    for (const cb of this.consoleListeners) {
      try { cb(line); } catch { /* a broken listener must not break the proxy */ }
    }
  }

  // Console lines newer than `seq` (0 = everything still buffered).
  consoleSince(seq) {
    if (!seq) return this.consoleLines.slice();
    const idx = this.consoleLines.findIndex((l) => l.seq > seq);
    return idx === -1 ? [] : this.consoleLines.slice(idx);
  }

  clearConsole() {
    this.consoleLines = [];
  }

  // Lets the GUI push console lines to the browser as they happen.
  onConsole(cb) {
    this.consoleListeners.add(cb);
    return () => this.consoleListeners.delete(cb);
  }

  // ── Request handling ───────────────────────────────────────────────────

  _handle(req, res) {
    const receivedAt = new Date();
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    const cfg = this.config.get();

    // Node's HTTP parser delivers origin-form requests as just the path (the
    // scheme+host land in the Host header). Restore the full original URL so
    // downstream code sees exactly what the client sent.
    if (!/^https?:\/\//i.test(req.url)) {
      req.url = `http://${req.headers.host}${req.url}`;
    }

    req.on('data', (chunk) => {
      if (truncated) return;
      if (bytes + chunk.length > cfg.maxBodyBytes) {
        chunks.push(chunk.subarray(0, cfg.maxBodyBytes - bytes));
        bytes = cfg.maxBodyBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });

    req.on('end', async () => {
      // Control URL: clear the capture without forwarding or logging — the same
      // thing the toolbar's Clear does, so a device or test script can start a
      // session from scratch.
      //
      // The delete is awaited before answering: replying first would leave the
      // clear running while the client fires its next requests, and those would
      // be deleted by the sweep they raced.
      if (isControlRequest(req.url, cfg.urlPrefix, cfg.clearViewPattern, cfg.routes)) {
        this.clearViewAt = new Date().toISOString();
        let deleted = 0;
        try {
          deleted = await this.logStore.clearAll();
        } catch (err) {
          console.error('[proxy] clear failed:', err.message);
        }
        this._emitState();
        this._logRequest({ timestamp: this.clearViewAt, method: req.method, url: req.url, status: 'CLEAR_VIEW', note: `(${deleted} log file(s) deleted)` });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      const buf = Buffer.concat(chunks, bytes);
      const reqContentType = req.headers['content-type'] || '';
      const reqTextual = isLikelyText(buf, reqContentType);
      const target = parseUpstreamFromUrl(req.url, cfg.urlPrefix, cfg.routes);

      const requestPart = {
        timestamp: receivedAt.toISOString(),
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        method: req.method,
        url: target ? target.url : req.url,
        originalUrl: req.url,
        httpVersion: req.httpVersion,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        bodyBytes: bytes,
        bodyTruncated: truncated,
        body: reqTextual ? parseIfJson(buf.toString('utf8'), reqContentType) : null,
        bodyBase64: reqTextual ? null : buf.toString('base64'),
        upstream: target,
      };

      const finish = (responsePart, clientStatus, clientHeaders, clientBody) => {
        const entry = { request: requestPart, response: responsePart };
        // Every request is recorded (unless recording is paused); the console
        // line says which provider it was decoded as and how many events it held.
        let summary = null;
        if (this.isRecording) {
          try {
            summary = this.logStore.getSummary(path.basename(this.logStore.writeEntry(entry)));
          } catch (err) {
            console.error('[proxy] write error:', err.message);
          }
        }
        const recTag = summary
          ? `(${summary.provider}: ${summary.events} event${summary.events === 1 ? '' : 's'} -> ${summary.file})`
          : (this.isRecording ? '' : '[not recorded]');
        const fwdTag = responsePart.forwarded === false ? '[not forwarded]' : '';
        const rwTag = responsePart.rewrittenFrom ? `[rewritten from ${responsePart.rewrittenFrom}]` : '';
        this._logRequest({
          timestamp: requestPart.timestamp,
          method: requestPart.method,
          url: target ? target.url : requestPart.url,
          status: responsePart.statusCode ?? responsePart.error ?? 'NO_UPSTREAM',
          note: [fwdTag, rwTag, recTag].filter(Boolean).join(' '),
        });
        res.writeHead(clientStatus, clientHeaders);
        res.end(clientBody);
      };

      // A rewrite rule short-circuits the upstream entirely: the client gets the
      // response captured earlier, byte for byte. Recorded like any other
      // request so the row (and its flag) show up in the GUI.
      const canned = target ? this._cannedResponse(req.method, target.url) : null;
      if (canned) {
        finish(canned.responsePart, canned.statusCode, canned.headers, canned.body);
        return;
      }

      // Forwarding off: answer the device ourselves with an empty 200 so the
      // SDK keeps sending, and record the request without ever contacting
      // the upstream.
      if (!this.isForwarding) {
        finish(
          { forwarded: false, durationMs: 0, statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'text/plain' }, rawHeaders: [], bodyBytes: 0, body: '', bodyBase64: null },
          200,
          { 'Content-Type': 'text/plain', 'content-length': '0' },
          ''
        );
        return;
      }

      if (!target) {
        finish(
          { error: 'could not extract upstream host from URL path' },
          502,
          { 'Content-Type': 'text/plain' },
          'Bad Gateway: no upstream host in URL'
        );
        return;
      }

      const upstreamHeaders = buildUpstreamHeaders(req.headers, target.host, buf.length);
      const result = await callUpstream(target, req.method, upstreamHeaders, buf, cfg.upstreamTimeoutMs);

      if (!result.ok) {
        finish(
          buildResponsePart(result),
          502,
          { 'Content-Type': 'text/plain' },
          'Bad Gateway: ' + result.error
        );
        return;
      }

      const resContentType = result.headers['content-type'] || '';
      const resTextual = isLikelyText(result.body, resContentType);

      // Rewrite URLs in the response body so the client routes them back through
      // this proxy. http://target.com/x -> http://<proxy>/;http://target.com/x
      //
      // JSON carries absolute URLs, which can be matched anywhere in the text.
      // An m3u8 is mostly *relative* references, which only mean anything
      // resolved against the playlist's own URL — hence the separate pass, and
      // its own setting.
      let clientBody = result.body;
      const proxyOrigin = `http://${req.headers.host}`;
      const prefixPath = getPrefixPath(cfg.urlPrefix);
      const isJson = resTextual && resContentType.toLowerCase().includes('json');
      if (isJson && cfg.urlPrefix && cfg.rewriteResponseUrls) {
        const rewritten = rewriteUrlsInBody(result.body.toString('utf8'), proxyOrigin, prefixPath);
        clientBody = Buffer.from(rewritten, 'utf8');
      } else if (resTextual && cfg.urlPrefix && cfg.rewriteM3u8Urls) {
        const text = result.body.toString('utf8');
        if (isM3u8Response(resContentType, text)) {
          clientBody = Buffer.from(rewriteM3u8Body(text, proxyOrigin, prefixPath, target.url), 'utf8');
        }
      }

      finish(
        buildResponsePart(result, clientBody),
        result.statusCode,
        buildClientHeaders(result.headers, clientBody.length),
        clientBody
      );
    });

    req.on('error', (err) => {
      console.error('[proxy] request error:', err.message);
    });
  }

  // The stored response a rewrite rule points at, ready to send, or null when
  // there is no rule for this method+URL. A rule whose log file has gone (or
  // never held a usable response) is dropped rather than left to fail on every
  // future request — the client falls through to the real upstream instead.
  _cannedResponse(method, url) {
    const rule = this.rewrites?.match(method, url);
    if (!rule) return null;

    const drop = (why) => {
      console.warn(`[rewrite] dropping rule for ${rule.key}: ${why}`);
      this.rewrites.remove(rule.key);
      return null;
    };

    const raw = this.logStore.readEntry(rule.file);
    if (!raw) return drop('log file is gone');
    let stored;
    try {
      stored = JSON.parse(raw.toString('utf8'))?.response;
    } catch {
      return drop('log file is not valid JSON');
    }
    if (!stored || stored.error || stored.statusCode == null) return drop('entry has no usable response');

    // A hand-edited body wins over the captured one — that is the whole point of
    // editing it. The recorded response says what the client actually got, so
    // the edit is folded into `body` rather than carried alongside it.
    const edited = stored.bodyEdited !== undefined;
    const body = storedBody(edited ? { body: stored.bodyEdited } : stored);
    const responsePart = { ...stored, durationMs: 0, bodyBytes: body.length, rewrittenFrom: rule.file };
    delete responsePart.bodyEdited;
    delete responsePart.forwarded;
    if (edited) {
      responsePart.body = stored.bodyEdited;
      responsePart.bodyBase64 = null;
      // The body here *is* the edit, so the flag is what is left to say that
      // this was a fixture rather than a replayed capture.
      responsePart.rewrittenEdited = true;
    }

    return {
      body,
      statusCode: stored.statusCode,
      headers: buildClientHeaders(stored.headers || {}, body.length),
      responsePart,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start() {
    return new Promise((resolve, reject) => {
      if (this.isListening) return resolve();
      const cfg = this.config.get();
      const onErr = (err) => { this.server.off('listening', onOk); reject(err); };
      const onOk = () => {
        this.server.off('error', onErr);
        this.isListening = true;
        console.log(`[proxy] listening on http://${cfg.host}:${cfg.port}`);
        this._emitState();
        resolve();
      };
      this.server.once('error', onErr);
      this.server.once('listening', onOk);
      this.server.listen(cfg.port, cfg.host);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.isListening) return resolve();
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
      this.server.close(() => {
        this.isListening = false;
        console.log('[proxy] stopped');
        this._emitState();
        resolve();
      });
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  // Re-issues a previously captured request against the same upstream and
  // records the outcome as a new entry, so the replay appears in the list next
  // to the original. Goes straight to callUpstream — it does not travel back
  // through the proxy's own listener, so it works even while the proxy is
  // stopped (and regardless of the forwarding switch: a replay is an explicit
  // request to hit the upstream).
  async replay(entry) {
    const req = entry?.request;
    const target = req?.upstream;
    if (!target || !target.hostname) throw new Error('entry has no upstream to replay');

    const cfg = this.config.get();
    const body = replayBody(req);
    const headers = buildUpstreamHeaders(req.headers || {}, target.host, body.length);
    const startedAt = new Date();
    const result = await callUpstream(target, req.method || 'GET', headers, body, cfg.upstreamTimeoutMs);

    const requestPart = {
      ...req,
      timestamp: startedAt.toISOString(),
      replayOf: entry.request?.url || null,
      bodyBytes: body.length,
    };
    const replayed = { request: requestPart, response: buildResponsePart(result, result.body) };
    const file = this.isRecording ? this.logStore.writeEntry(replayed) : null;
    const summary = file ? this.logStore.getSummary(path.basename(file)) : null;
    this._logRequest({
      timestamp: requestPart.timestamp,
      method: requestPart.method || 'GET',
      url: target.url,
      status: result.statusCode ?? result.error ?? 'ERROR',
      note: ['[replay]', summary ? `(${summary.provider}: ${summary.events} event${summary.events === 1 ? '' : 's'} -> ${summary.file})` : ''].filter(Boolean).join(' '),
    });
    return { file: file ? path.basename(file) : null, ok: result.ok, status: result.statusCode ?? null, error: result.error ?? null };
  }

  setRecording(on) {
    this.isRecording = !!on;
    this._emitState();
  }

  setForwarding(on) {
    this.isForwarding = !!on;
    this._emitState();
  }

  // Lets the GUI push state to the browser instead of it polling for changes.
  onStateChange(cb) {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  _emitState() {
    for (const cb of this.stateListeners) {
      try { cb(this.state()); } catch { /* a broken listener must not break the proxy */ }
    }
  }

  // Reports what is actually bound, not what config asks for — the two diverge
  // when a restart fails to bind and the proxy is left stopped on a new port.
  state() {
    const cfg = this.config.get();
    const bound = this.isListening ? this.server.address() : null;
    return {
      listening: this.isListening,
      recording: this.isRecording,
      forwarding: this.isForwarding,
      clearViewAt: this.clearViewAt,
      host: bound ? bound.address : cfg.host,
      port: bound ? bound.port : cfg.port,
    };
  }
}

module.exports = ProxyServer;
