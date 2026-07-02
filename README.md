# Mux Logger

Local proxy + viewer for **Roku Mux reporting beacons**. The Roku Mux SDK sends its analytics beacons with minified property names (`pcycd` instead of `player_country_code`); this tool sits between the device and `litix.io`, forwards every beacon upstream unchanged, logs each one to disk, and renders every Mux event on its own row with **decoded property names**.

```
Roku device ──► Mux Logger proxy (0.0.0.0:8889) ──► https://<env>.litix.io
                       │
                       ├── logs/  (one JSON file per beacon)
                       └── GUI    (http://localhost:8080)
```

## How it works

- The Roku app points its Mux reporting traffic at this proxy. Requests arrive as `http://<proxy-ip>:8889/;https://<env>.litix.io/...` — the `/;` prefix separates the proxy address from the real upstream URL.
- The proxy forwards the request byte-for-byte to Mux and relays the response back to the device, so real Mux dashboards keep working while you observe.
- Any request whose body contains an `events` array is recorded as one JSON file in `logs/`. Other traffic is forwarded but not logged.
- Property keys are decoded by reversing the SDK's `_minify` word tables (source of truth: `MuxTask.bs` in the Roku SDK) — see `src/scripts/mux.js`.

## Quick start

Requires Node.js ≥ 18.

```sh
npm install

# Web: proxy + browser GUI, open http://localhost:8080
npm run web

# Same, restarting on source changes
npm run web:dev

# Desktop app (Electron window wrapping the same GUI)
npm run electron
```

Then point the Roku device's Mux beacon URL at `http://<your-LAN-IP>:8889/;https://<env>.litix.io`.

## The GUI

- **Grid** — one row per decoded Mux event, with curated columns (event, sequence numbers, playhead, video title, view id, error code/message). Click a row for the full decoded property list and the raw logged beacon JSON.
- **Filtering** — free-text filter across all fields, event-type dropdown, optional grouping by request (beacon) with collapsible headers.
- **Viewer timeline** — Mux-style playback timeline per view (starting up / playing / rebuffering / seeking / ad / paused / failure), with a tick per event and a view selector.
- **Controls** — start/stop the proxy, pause/resume recording, delete all logs, display cap ("show last N events" — display-only, nothing is deleted).
- **Clear session URL** — calling `http://<proxy-ip>:8889/session/clear` (from the device or a browser) deletes all stored logs and resets the grid without forwarding anything. Useful as a test-run separator; the exact URL is shown in the ⚙ config dialog.

## Configuration

Settings live in `config/config.json` (created/updated when you save from the GUI's ⚙ dialog). Environment variables provide the defaults on first run:

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `PORT` | `8889` | Proxy listen port (what the device targets) |
| `host` | `HOST` | `0.0.0.0` | Proxy bind address |
| `upstreamTimeoutMs` | `UPSTREAM_TIMEOUT_MS` | `30000` | Timeout for the forwarded request to Mux |
| `maxBodyBytes` | `MAX_BODY_BYTES` | `10485760` | Max request body captured for logging |
| `urlPrefix` | `URL_PREFIX` | `/;` | Separator between proxy address and upstream URL in the request path |
| `clearViewPattern` | `CLEAR_VIEW_PATTERN` | `/session/clear` | Path that triggers "clear session" (empty string disables) |
| — | `GUI_PORT` | `8080` | GUI/web server port (headless mode) |

## HTTP API

The GUI is a thin client over these endpoints (all served by the GUI port):

| Method & path | Purpose |
| --- | --- |
| `GET /api/events[?since=<id>]` | Decoded event rows (incremental with `since`) + curated columns + state |
| `GET /api/state` | Proxy/recording state, counts, disk usage |
| `GET /api/config` / `POST /api/config` | Read / update config (proxy restarts on port/host change) |
| `GET /api/entry?file=<name>` | Raw logged beacon JSON for one file |
| `POST /api/proxy/start` / `POST /api/proxy/stop` | Start / stop the proxy listener |
| `POST /api/recording/start` / `POST /api/recording/stop` | Resume / pause writing beacons to disk |
| `POST /api/logs/clear` | Delete all logged beacon files |

## Building a distributable

```sh
npm run electron:release:win   # portable .exe  -> dist/MuxLogger-<version>-portable.exe
npm run electron:release:mac   # dmg            -> dist/MuxLogger-<version>.dmg
npm run clean                  # remove dist/
```

The portable Windows build stores its `logs/` and `config/` in a `mux-logger-data` folder next to the `.exe` (so the data travels with the app); non-portable/dev runs use the repo's own `logs/` and `config/` directories.

## Project layout

```
electron-main.js          Electron entry point (app lifecycle, window, single instance)
server.js                 Web entry point (no Electron)
src/
  index.js                createApp(): wires config + log store + proxy + GUI servers
  scripts/
    proxy-server.js       Beacon proxy: capture, forward, log, clear-session handling
    proxy.js              Upstream URL parsing, header filtering, upstream HTTP call
    gui-server.js         Static GUI + JSON API
    log-store.js          One JSON file per beacon; in-memory decoded event rows
    mux.js                Minified-key decoder (reverse of MuxTask.bs _minify) + curated columns
    config.js             config.json load/save/validate
    body-utils.js         Best-effort JSON body parsing (logging only)
  components/
    index.html, app.js, styles.css   The GUI (vanilla JS, no build step)
config/config.json        Runtime settings (created/updated by the GUI)
logs/                     Logged beacons (one .json per beacon)
```
