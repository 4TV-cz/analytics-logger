const path = require('path');
const Config = require('./scripts/config');
const LogStore = require('./scripts/log-store');
const ProxyServer = require('./scripts/proxy-server');
const GuiServer = require('./scripts/gui-server');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');
const GUI_DIR = path.join(__dirname, 'components');
const DEFAULT_GUI_PORT = Number(process.env.GUI_PORT) || 8080;

// Build the proxy + GUI servers over a shared log store. This does NOT start
// them — call start() from the entry point that owns the lifecycle (the CLI
// `server.js` for headless use, or the Electron main process).
function createApp({ guiPort = DEFAULT_GUI_PORT, logDir = LOG_DIR, configFile = CONFIG_FILE } = {}) {
  const config = new Config(configFile);
  const logStore = new LogStore(logDir);
  const proxy = new ProxyServer({ config, logStore });
  const gui = new GuiServer({ port: guiPort, guiDir: GUI_DIR, config, logStore, proxy });

  logStore.loadFromDisk();

  async function start() {
    try {
      await proxy.start();
    } catch (err) {
      const cfg = config.get();
      console.error(`[proxy] failed to start on ${cfg.host}:${cfg.port}:`, err.message);
    }
    await gui.start();
    console.log(`Logging Mux beacons (one JSON file per beacon) to ${logDir}`);
    console.log(`Loaded ${logStore.getEventCount()} events from ${logStore.getBeaconCount()} beacons`);
  }

  async function stop() {
    await Promise.allSettled([proxy.stop(), gui.stop()]);
  }

  return {
    start,
    stop,
    guiUrl: `http://localhost:${guiPort}`,
  };
}

module.exports = { createApp };
