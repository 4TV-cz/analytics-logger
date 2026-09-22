// Web entry point: run the proxy + GUI servers without Electron and open the
// GUI in a browser. Data (config/, logs/) lives in the repo root; the Electron
// entry point (electron/main.js) resolves a different data directory when
// packaged. `--live-reload` is a CLI flag rather than an env var because
// `VAR=1 cmd` is not portable to the cmd.exe that npm uses on Windows.
const path = require('path');
const { createBackend } = require('./src/backend');

const backend = createBackend({
  dataDir: __dirname,
  liveReload: process.argv.includes('--live-reload'),
});

backend.start().then(() => {
  console.log(`Open ${backend.guiUrl}`);
}).catch((err) => {
  console.error(`[logger] GUI server failed to start on port ${backend.guiPort}:`, err.message);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n[logger] ${signal} received, closing...`);
  backend.stop().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// The terminal went away: close the ports rather than linger as an orphan.
process.on('SIGHUP', () => shutdown('SIGHUP'));
