const path = require('path');
const Config = require('./scripts/config');
const LogStore = require('./scripts/log-store');
const ProxyServer = require('./scripts/proxy-server');
const GuiServer = require('./scripts/gui-server');
const RewriteStore = require('./scripts/rewrite-store');

// Static GUI files ship with the code, so they resolve relative to this file
// (inside app.asar in a packaged build, where they are read-only).
const GUI_DIR = path.join(__dirname, 'components');

// Builds the proxy + GUI servers over a shared log store. This does NOT start
// them — call start() from the entry point that owns the lifecycle (the CLI
// `server.js` for headless use, or the Electron main process).
//
// `dataDir` is where config/ and logs/ are written. It is deliberately separate
// from the code path: a packaged build keeps its code read-only inside asar and
// its data next to the executable.
function createBackend({
  dataDir,
  guiPort = Number(process.env.GUI_PORT) || 8080,
  guiHost = process.env.GUI_HOST || '127.0.0.1',
  liveReload = false,
} = {}) {
  const configFile = path.join(dataDir, 'config', 'config.json');
  const logDir = path.join(dataDir, 'logs');

  const config = new Config(configFile);
  const logStore = new LogStore(logDir, () => config.get());
  const rewrites = new RewriteStore(path.join(dataDir, 'config', 'rewrites.json'));
  const proxy = new ProxyServer({ config, logStore, rewrites });
  const gui = new GuiServer({ port: guiPort, host: guiHost, guiDir: GUI_DIR, config, logStore, proxy, rewrites, liveReload });

  // A rule points at one log file; when that file goes, so does the rule —
  // otherwise the GUI keeps flagging a URL that nothing can serve.
  logStore.onChange((change) => {
    if (change.type === 'deleted') rewrites.pruneFiles([change.file]);
    else if (change.type === 'evicted') rewrites.pruneFiles(change.files);
    else if (change.type === 'cleared') rewrites.clear();
  });

  // The GUI server failing is fatal — there would be nothing to show. The proxy
  // failing is not: the window still lists past traffic and can retry from the
  // toolbar, which is also how a port clash is meant to be resolved.
  async function start() {
    logStore.loadFromDisk();
    await gui.start();
    console.log(`Logging requests (one JSON file each) to ${logDir}`);
    console.log(`Loaded ${logStore.getEventCount()} events from ${logStore.getSummaries().length} requests`);
    try {
      await proxy.start();
    } catch (err) {
      const cfg = config.get();
      console.error(`[proxy] failed to start on ${cfg.host}:${cfg.port}:`, err.message);
      return { guiPort, proxyError: err };
    }
    return { guiPort, proxyError: null };
  }

  // Close the servers first so nothing new is queued, then let the log store
  // finish its background writes and persist its summary index.
  async function stop() {
    await Promise.allSettled([proxy.stop(), gui.stop()]);
    await logStore.close().catch(() => {});
  }

  const guiUrl = `http://${guiHost === '0.0.0.0' ? 'localhost' : guiHost}:${guiPort}`;
  return { config, logStore, rewrites, proxy, gui, start, stop, dataDir, logDir, configFile, guiPort, guiUrl };
}

module.exports = { createBackend };
