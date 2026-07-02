const http = require('http');
const path = require('path');
const { parseUpstreamFromUrl, buildUpstreamHeaders, buildClientHeaders, callUpstream } = require('./proxy');
const { parseIfJson } = require('./body-utils');
const { isMuxEntry } = require('./mux');

// Transparent proxy for the Roku Mux SDK beacon endpoint. The device points
// only its Mux reporting traffic here (everything else goes through Charles),
// reaching us as e.g. http://<proxy>/;https://<env>.litix.io. We forward every
// beacon upstream to Mux unchanged and log the ones that carry events.
class ProxyServer {
  constructor({ config, logStore }) {
    this.config = config;
    this.logStore = logStore;
    this.isListening = false;
    this.isRecording = true;
    this.clearViewAt = null;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('clientError', (err, socket) => {
      console.error('[proxy] client error:', err.message);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
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
        console.log(`[${this.clearViewAt}] ${req.method} ${req.url} -> CLEAR_VIEW (${deleted} files deleted)`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      const buf = Buffer.concat(chunks, bytes);
      const target = parseUpstreamFromUrl(req.url, cfg.urlPrefix);

      let parsedBody = null;
      if (buf.length) {
        const body = parseIfJson(buf.toString('utf8'), req.headers['content-type'] || '');
        parsedBody = typeof body === 'string' ? null : body;
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
        upstream: target,
      };

      const finish = (responsePart, clientStatus, clientHeaders, clientBody) => {
        const entry = { request: requestPart, response: responsePart };
        // Only Mux beacons (bodies with an events array) are recorded; any other
        // traffic is still forwarded but never written to disk.
        let file;
        if (this.isRecording && isMuxEntry(entry)) {
          try {
            file = this.logStore.writeEntry(entry);
          } catch (err) {
            console.error('[proxy] write error:', err.message);
          }
        }
        const eventCount = entry.request.body?.events?.length || 0;
        const recTag = file ? ` (${eventCount} events -> ${path.basename(file)})`
          : (this.isRecording ? ' [not a mux beacon]' : ' [paused]');
        console.log(`[${requestPart.timestamp}] ${requestPart.method} ${target ? target.url : requestPart.url} -> ${responsePart.statusCode ?? responsePart.error ?? 'NO_UPSTREAM'}${recTag}`);
        res.writeHead(clientStatus, clientHeaders);
        res.end(clientBody);
      };

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

  state() {
    return { listening: this.isListening, recording: this.isRecording, clearViewAt: this.clearViewAt };
  }
}

module.exports = ProxyServer;
