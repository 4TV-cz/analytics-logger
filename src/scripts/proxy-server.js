const http = require('http');
const path = require('path');
const { parseUpstreamFromUrl, buildUpstreamHeaders, buildClientHeaders, callUpstream } = require('./proxy');
const { parseIfJson } = require('./body-utils');

const CONSOLE_MAX_LINES = 2000;

// Transparent proxy for analytics endpoints (Mux, Google Analytics, mParticle
// or anything else). The device points its reporting traffic here, reaching us
// as e.g. http://<proxy>/;https://<env>.litix.io. We forward every request
// upstream unchanged and log all of them; providers.js decodes the ones it
// recognises into events. With forwarding off, requests are still logged but
// terminate here (200 OK) and never reach the upstream.
class ProxyServer {
  constructor({ config, logStore }) {
    this.config = config;
    this.logStore = logStore;
    this.isListening = false;
    this.isRecording = true;
    this.isForwarding = true;
    this.clearViewAt = null;
    // In-memory console: one line per incoming request, mirrored to stdout
    // and served to the GUI console panel. Bounded ring buffer.
    this.consoleLines = [];
    this.consoleSeq = 0;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('clientError', (err, socket) => {
      console.error('[proxy] client error:', err.message);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  }

  // Record one console line for a request and echo it to stdout.
  _logRequest({ timestamp, method, url, status, note }) {
    const line = { seq: ++this.consoleSeq, ts: timestamp, method, url, status: String(status), note: note || '' };
    this.consoleLines.push(line);
    if (this.consoleLines.length > CONSOLE_MAX_LINES) this.consoleLines.splice(0, this.consoleLines.length - CONSOLE_MAX_LINES);
    console.log(`[${timestamp}] ${method} ${url} -> ${status}${note ? ' ' + note : ''}`);
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

  _handle(req, res) {
    const receivedAt = new Date();
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    const cfg = this.config.get();

    // Node delivers origin-form requests as just the path; rebuild the full URL.
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
      // Control URL: delete all stored logs (like the GUI "Delete logs" button)
      // and signal the GUI to reset the view, without forwarding/logging.
      if (cfg.clearViewPattern && req.url.includes(cfg.clearViewPattern)) {
        this.clearViewAt = new Date().toISOString();
        let deleted = 0;
        try {
          deleted = this.logStore.clearAll();
        } catch (err) {
          console.error('[proxy] clear error:', err.message);
        }
        this._logRequest({ timestamp: this.clearViewAt, method: req.method, url: req.url, status: 'CLEAR_VIEW', note: `(${deleted} files deleted)` });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      const buf = Buffer.concat(chunks, bytes);
      const target = parseUpstreamFromUrl(req.url, cfg.urlPrefix, cfg.routes);

      // JSON bodies are stored parsed (`body`); anything else is kept as text
      // (`bodyText`) so providers with line-based formats (GA) can decode it.
      let parsedBody = null;
      let bodyText = null;
      if (buf.length) {
        const body = parseIfJson(buf.toString('utf8'), req.headers['content-type'] || '');
        if (typeof body === 'string') bodyText = body;
        else parsedBody = body;
      }

      const requestPart = {
        timestamp: receivedAt.toISOString(),
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        method: req.method,
        url: target ? target.url : req.url,
        originalUrl: req.url,
        httpVersion: req.httpVersion,
        headers: req.headers,
        bodyBytes: bytes,
        bodyTruncated: truncated,
        body: parsedBody,
        bodyText,
        upstream: target,
      };

      const finish = (responsePart, clientStatus, clientHeaders, clientBody) => {
        const entry = { request: requestPart, response: responsePart };
        // Every request is recorded (unless recording is paused); the console
        // line says which provider it was decoded as and how many events it held.
        let written = null;
        if (this.isRecording) {
          try {
            written = this.logStore.writeEntry(entry);
          } catch (err) {
            console.error('[proxy] write error:', err.message);
          }
        }
        const recTag = written
          ? `(${written.provider}: ${written.count} events -> ${path.basename(written.file)})`
          : (this.isRecording ? '' : '[paused]');
        const fwdTag = responsePart.forwarded === false ? '[not forwarded]' : '';
        this._logRequest({
          timestamp: requestPart.timestamp,
          method: requestPart.method,
          url: target ? target.url : requestPart.url,
          status: responsePart.statusCode ?? responsePart.error ?? 'NO_UPSTREAM',
          note: [fwdTag, recTag].filter(Boolean).join(' '),
        });
        res.writeHead(clientStatus, clientHeaders);
        res.end(clientBody);
      };

      // Forwarding off: answer the device ourselves with an empty 200 so the
      // SDK keeps sending, and record the request without ever contacting
      // the upstream.
      if (!this.isForwarding) {
        finish(
          { forwarded: false, statusCode: 200, statusMessage: 'OK', headers: {}, bodyBytes: 0, body: '' },
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

      const upstreamHeaders = buildUpstreamHeaders(req.headers, target.host);
      const result = await callUpstream(target, req.method, upstreamHeaders, buf, cfg.upstreamTimeoutMs);

      if (!result.ok) {
        finish(
          { error: result.error, durationMs: result.durationMs },
          502,
          { 'Content-Type': 'text/plain' },
          'Bad Gateway: ' + result.error
        );
        return;
      }

      const clientBody = result.body;
      const responsePart = {
        durationMs: result.durationMs,
        statusCode: result.statusCode,
        statusMessage: result.statusMessage,
        headers: result.headers,
        bodyBytes: clientBody.length,
        body: clientBody.length ? clientBody.toString('utf8') : '',
      };
      finish(
        responsePart,
        result.statusCode,
        buildClientHeaders(result.headers, clientBody.length),
        clientBody
      );
    });

    req.on('error', (err) => {
      console.error('[proxy] request error:', err.message);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.isListening) return resolve();
      const cfg = this.config.get();
      const onErr = (err) => { this.server.off('listening', onOk); reject(err); };
      const onOk = () => {
        this.server.off('error', onErr);
        this.isListening = true;
        console.log(`[proxy] listening on http://${cfg.host}:${cfg.port}`);
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
        resolve();
      });
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  setRecording(on) {
    this.isRecording = !!on;
  }

  setForwarding(on) {
    this.isForwarding = !!on;
  }

  state() {
    return {
      listening: this.isListening,
      recording: this.isRecording,
      forwarding: this.isForwarding,
      clearViewAt: this.clearViewAt,
    };
  }
}

module.exports = ProxyServer;
