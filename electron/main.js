// Electron entry point. Owns the app lifecycle: starts the proxy + GUI servers
// when the app opens and stops them when it closes, so there's no separate
// `node server.js` to run. Launch with `npm run electron`.
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { createBackend } = require('../src/backend');
const { createWindowState } = require('./window-state');
const { buildAppMenu } = require('./menu');

const APP_NAME = 'Analytics Logger';

// Where config/ and logs/ are written:
//  - portable Windows build: an `analytics-logger-data` folder beside the .exe,
//    so the whole thing stays self-contained (electron-builder sets
//    PORTABLE_EXECUTABLE_DIR for exactly this)
//  - any other packaged build (the macOS dmg): the per-user data location —
//    the app bundle itself is read-only
//  - dev run: the repo root, matching `npm run web`
function resolveDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'analytics-logger-data');
  if (app.isPackaged) return app.getPath('userData');
  return path.join(__dirname, '..');
}

// Windows wants a multi-size .ico; macOS/Linux can't decode one (the window
// icon is ignored on macOS anyway — the dock uses the bundle icon).
const ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// Windows groups taskbar buttons (and attributes notifications) by App User
// Model ID; without this a dev run inherits Electron's, which is also what puts
// its icon on the taskbar button.
if (process.platform === 'win32' && !app.isPackaged) {
  app.setAppUserModelId('com.deltatre.analytics-logger');
}

// Only one copy may run: a second would fight over the proxy/GUI ports and the
// shared Chromium cache. Checked before anything else — before the backend is
// even constructed — so the loser exits without touching the data directory or
// the ports. The winner is told via 'second-instance' below.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// `npm run electron:dev` passes --live-reload so GUI edits refresh the window
// in place.
const backend = createBackend({
  dataDir: resolveDataDir(),
  liveReload: process.argv.includes('--live-reload'),
});
const windowState = createWindowState(path.join(backend.dataDir, 'config', 'window-state.json'));
const guiUrl = backend.guiUrl;

let mainWindow = null;
let quitting = false;

// Someone launched the app again. Surface the window we already have instead of
// letting them think nothing happened.
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

function createWindow() {
  const state = windowState.load();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 500,
    title: APP_NAME,
    icon: ICON,
    // Matches the GUI's dark theme so there is no white flash before load.
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (state.maximized) mainWindow.maximize();
  windowState.track(mainWindow);

  // The GUI's "Open URL in new tab" action calls window.open. Hand those to the
  // real browser instead of spawning a chromeless Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // ERR_ABORTED (-3) is what a load in progress reports when the window closes,
  // so it must not raise a dialog on the way out.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (quitting || !isMainFrame || code === -3) return;
    dialog.showErrorBox(APP_NAME, `Could not load the GUI from ${guiUrl}\n\n${description} (${code})`);
  });

  // The GUI is plain HTTP + fetch against the local server, so just point the
  // window at it (no file:// — relative /api calls need a real origin).
  mainWindow.loadURL(guiUrl);
}

app.whenReady().then(async () => {
  let started;
  try {
    started = await backend.start();
  } catch (err) {
    // The single-instance lock rules out a second copy of the desktop app, so
    // this is something else on the port — most often a headless `npm run web`
    // left running, since that shares the same default.
    dialog.showErrorBox(
      `${APP_NAME} failed to start`,
      [
        `The GUI server could not bind port ${backend.guiPort}.`,
        '',
        err.message,
        '',
        'Something else is using that port — a headless "npm run web" still',
        'running is the usual cause. Stop it (npm stop), or set the',
        'GUI_PORT environment variable to start on a different port.',
      ].join('\n')
    );
    app.exit(1);
    return;
  }

  buildAppMenu({ backend, guiUrl, appName: APP_NAME, getWindow: () => mainWindow });
  createWindow();

  // Non-fatal: the window still lists past traffic, and the toolbar can retry
  // once the conflicting port is free or the port is changed in Settings.
  if (started.proxyError) {
    const cfg = backend.config.get();
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Proxy not started',
      message: `The proxy could not listen on ${cfg.host}:${cfg.port}.`,
      detail: `${started.proxyError.message}\n\nUse the proxy switch in the toolbar once the port is free, or change it under Settings.`,
      buttons: ['OK'],
    });
  }
});

// Closing the window quits the app (the proxy is only useful with the viewer).
app.on('window-all-closed', () => app.quit());

// macOS: re-open a window if the app is reactivated with none open.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !quitting) createWindow();
});

// Give the servers a chance to close their sockets before the process goes away.
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const done = () => app.exit(0);
  backend.stop().then(done, done);
  setTimeout(done, 3000).unref();
});
