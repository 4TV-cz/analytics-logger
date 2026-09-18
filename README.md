# Analytics Logger

Local proxy + viewer for **player analytics beacons** from any player — Roku, web players, smart TVs, or any other frontend device that reports to Mux. Mux SDKs send their analytics beacons with minified property names (`pcycd` instead of `player_country_code`); this tool sits between the player and `litix.io`, forwards every beacon upstream unchanged, logs each one to disk, and renders every Mux event on its own row with **decoded property names**. Mux is the first supported endpoint; **mParticle** and **Google Analytics** are planned next.

![Analytics Logger](assets/app_screenshot.png)

```
player / device ──► Analytics Logger proxy (0.0.0.0:8889) ──► https://<env>.litix.io
(Roku, web, TV)          │
                         ├── logs/  (one JSON file per beacon)
                         └── GUI    (http://localhost:8080)
```

## How it works

- The player points its Mux reporting traffic at this proxy. Requests arrive as `http://<proxy-ip>:8889/;https://<env>.litix.io/...` — the `/;` prefix separates the proxy address from the real upstream URL. (The prefix is configurable in ⚙ config — see [Pointing a player at the proxy](#pointing-a-player-at-the-proxy).)
- The proxy forwards the request byte-for-byte to Mux and relays the response back to the player, so real Mux dashboards keep working while you observe.
- Any request whose body contains an `events` array is recorded as one JSON file in `logs/`. Other traffic is forwarded but not logged.
- Property keys are decoded by reversing the Mux SDK `_minify` word tables (reversed from `MuxTask.bs` in the Roku SDK; the same minification scheme is used across Mux SDKs, including `mux-embed` on the web) — see `src/scripts/mux.js`.

## Pointing a player at the proxy

The device does not discover the proxy by itself — you must **update the Mux endpoint URL in the player/app configuration** so beacons are sent to this proxy instead of directly to `litix.io`:

1. Start Analytics Logger and note the proxy address: `<your-LAN-IP>` (the machine running this tool — it must be reachable from the device, same network) and the proxy port (`8889` by default, shown in the toolbar badge and the ⚙ dialog).
2. Take the original Mux endpoint the player uses today, e.g. `https://<env>.litix.io`.
3. Build the new endpoint by joining the three parts — proxy address, the **Client URL prefix** from the ⚙ config (default `/;`), and the original URL:

   ```
   http://<your-LAN-IP>:<port>  +  <urlPrefix>  +  <original Mux URL>
   ```

   Example with the default config (`port: 8889`, `urlPrefix: "/;"`), proxy machine at `192.168.1.50`:

   ```
   before:  https://tvos-prod.litix.io
   after:   http://192.168.1.50:8889/;https://tvos-prod.litix.io
   ```

4. Set that URL as the Mux beacon endpoint on the device and restart playback; rows should appear in the grid as soon as the player reports.

Where to set it, per client:

- **Roku SDK** — set the beacon/base URL to `http://<your-LAN-IP>:8889/;https://<env>.litix.io`.
- **Web (`mux-embed`, player SDKs)** — set `beaconCollectionDomain` / beacon domain so requests hit `http://<your-LAN-IP>:8889/;https://<env>.litix.io` (or use browser devtools/proxy rules to rewrite the litix.io request URL).
- **Other devices** — anything that can be pointed at a custom HTTP endpoint (directly or via a charles/mitm rewrite rule) and sends standard Mux beacons.

If your SDK composes the URL differently, adjust the **Client URL prefix** in ⚙ config to match: `/;` when the client inserts a `;` separator (Roku default), `/` for clients that send `http://<proxy>/https://...`, or empty for clients using the tool as a plain HTTP proxy with absolute-form URLs.

## Quick start

The app can be used in two ways — both run the same proxy and the same GUI, pick whichever suits you:

- **In the browser (web mode)** — a plain Node process runs the proxy and serves the GUI; you open it in any browser.
- **As a desktop app (Electron)** — a standalone window wraps the same GUI; the proxy starts when the app opens and stops when you close the window. This mode can also be built into a distributable (portable .exe / dmg), so end users don't need Node.js at all.

Requires Node.js ≥ 18 (when running from source).

```sh
npm install
```

**Browser:**

```sh
npm run web        # then open http://localhost:8080
npm run web:dev    # same, restarting on source changes
```

**Electron desktop app:**

```sh
npm run electron               # run from source, window opens by itself

# or build a self-contained distributable (no Node.js needed on the target machine):
npm run electron:release            # builds for the OS you're on
npm run electron:release -- --win   # portable .exe (x64) -> dist/AnalyticsLogger-<version>-portable.exe
npm run electron:release -- --mac   # dmg                 -> dist/AnalyticsLogger-<version>.dmg
```

Anything after `--` is passed straight through to `electron-builder`, so one script covers every target. Either release can be built from either OS — the Windows `.exe` cross-builds fine from macOS, no wine required. Both are unsigned: Windows shows a SmartScreen warning, macOS requires right-click → Open (or `xattr -d com.apple.quarantine`) on first launch.

Where `logs/` and `config/` live depends on how you run it:

- **From source** (`npm run web`, `npm run web:dev`, `npm run electron`) — the repo's own `logs/` and `config/` directories.
- **Portable Windows build** — an `analytics-logger-data` folder next to the `.exe`, so the data travels with the app.
- **macOS dmg build** — `~/Library/Application Support/analytics-logger/` (the app bundle itself is read-only).

Either way, then point the player's Mux beacon URL at `http://<your-LAN-IP>:8889/;https://<env>.litix.io` (see [Pointing a player at the proxy](#pointing-a-player-at-the-proxy)).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run web` | Proxy + GUI as a plain Node process. Open http://localhost:8080 |
| `npm run web:dev` | Same, under `node --watch` — restarts on changes to `server.js` or `src/` |
| `npm run electron` | Desktop app from source; it starts and stops the proxy itself |
| `npm run electron:release` | Builds a distributable into `dist/` for the OS you're on. Add `-- --win` for the portable Windows x64 `.exe`, or `-- --mac` for the `.dmg` |
| `npm run free-ports` | Frees ports 8889 / 8080 by killing leftover node/electron processes still holding them |
| `npm run clean` | Deletes `dist/` |

`free-ports` also runs automatically before `web`, `web:dev`, and `electron` (via the `preweb`, `preweb:dev`, and `preelectron` hooks), so a previous run that was force-quit can't block the next start with `EADDRINUSE`. It only ever kills node/electron processes, never an unrelated app that happens to sit on the same port. Run it by hand when you want the ports freed without starting anything.

> Note: npm matches lifecycle hooks on the **full** script name — the hook for `web:dev` must be called `preweb:dev`, not `preweb`.

## The GUI

- **Grid** — one row per decoded Mux event, with curated columns (event, sequence numbers, playhead, video title, view id, error code/message). Click a row for the full decoded property list and the raw logged beacon JSON.
- **Filtering** — free-text filter across all fields, event-type dropdown, optional grouping by request (beacon) with collapsible headers.
- **Viewer timeline** — Mux-style playback timeline per view (starting up / playing / rebuffering / seeking / ad / paused / failure), with a tick per event and a view selector.
- **Controls** — start/stop the proxy, pause/resume recording, enable/disable forwarding, delete all logs, display cap ("show last N events" — display-only, nothing is deleted).
- **Forwarding toggle** — on (default): each beacon is relayed to the Mux URL in the request path and the real response goes back to the player. Off: beacons terminate at this server — they are still logged and the player gets an empty `200 OK`, but nothing reaches Mux (handy for keeping test sessions out of the real dashboards). Locally terminated beacons are marked "not forwarded" in the grid and detail panel.
- **⚙ Settings dialog** — change the **proxy port** and the client URL prefix (the proxy restarts automatically on save), and view the read-only clear-session URL.
- **Clear session URL** — calling `http://<proxy-ip>:8889/session/clear` (from the device or a browser) deletes all stored logs and resets the grid without forwarding anything. Useful as a test-run separator; the exact URL is shown in the ⚙ config dialog.

  > **Tip:** hook the clear session URL into your app's build/deploy script to start every build with a clean session — e.g. as the last step before sideloading:
  >
  > ```sh
  > curl -s http://192.168.1.50:8889/session/clear
  > ```
  >
  > The grid then only ever shows beacons from the build you just deployed.

## Configuration

Settings live in `config/config.json` (created/updated when you save from the GUI's ⚙ dialog). The dialog edits `port` and `urlPrefix`; the remaining keys can be set via environment variables (defaults on first run), by editing `config.json` directly, or via `POST /api/config`:

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
| `GET /api/state` | Proxy/recording/forwarding state, counts, disk usage |
| `GET /api/config` / `POST /api/config` | Read / update config (proxy restarts on port/host change) |
| `GET /api/entry?file=<name>` | Raw logged beacon JSON for one file |
| `POST /api/proxy/start` / `POST /api/proxy/stop` | Start / stop the proxy listener |
| `POST /api/recording/start` / `POST /api/recording/stop` | Resume / pause writing beacons to disk |
| `POST /api/forwarding/start` / `POST /api/forwarding/stop` | Enable / disable relaying beacons to Mux (off: logged, answered 200 locally) |
| `POST /api/logs/clear` | Delete all logged beacon files |

