// Electron entry point. Owns the app lifecycle: starts the proxy + GUI servers
// when the app opens and stops them when it closes, so there's no separate
// `node server.js` to run. Launch with `npm run electron`.
const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { createApp } = require('./src');

// Windows wants a multi-size .ico; macOS/Linux can't decode one (the window
// icon is ignored on macOS anyway — the dock uses the bundle icon).
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// When packaged, the app source lives inside the read-only app.asar archive, so
// logs/config can't be written next to the code. For the portable build,
// electron-builder sets PORTABLE_EXECUTABLE_DIR to the folder holding the .exe —
// keep the data there so it travels with the app. Otherwise fall back to the
// per-user data dir.
const DATA_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'mux-logger-data')
  : app.getPath('userData');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const CONFIG_FILE = path.join(DATA_DIR, 'config', 'config.json');

let backend = null;
let win = null;
let stopping = false;

async function createWindow() {
  // Boot the proxy (0.0.0.0:8889 — the Roku still reaches it) and the GUI
  // (localhost:8080) before loading the window. If the GUI port is already
  // taken (a leftover run, or another app), start() throws. We must NOT let
  // that leave the process alive: it would still hold the single-instance lock
  // (below), so every later launch silently quits with no window. Surface the
  // error and quit so the lock is released and the next launch can succeed.
  backend = createApp({ logDir: LOG_DIR, configFile: CONFIG_FILE });
  try {
    await backend.start();
  } catch (err) {
    await stopBackend();
    dialog.showErrorBox(
      'Mux Logger failed to start',
      `Could not start the local servers:\n\n${err.message}\n\n` +
      'A previous copy may still be running. Close it (or reboot) and try again.'
    );
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Mux Logger',
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The GUI is plain HTTP + fetch against the local server, so just point the
  // window at it (no file:// — relative /api calls need a real origin).
  win.loadURL(backend.guiUrl);

  // Any window.open / target=_blank goes to the system browser, not a child
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

async function stopBackend() {
  if (backend && !stopping) {
    stopping = true;
    try { await backend.stop(); } finally { backend = null; }
  }
}

// Only one instance may run: a second copy would fight over the proxy/GUI
// ports and the shared Chromium cache (causing "Unable to create cache"
// errors). If we don't get the lock, hand off to the running instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);
}

// Closing the window quits the app (the proxy is only useful with the viewer).
app.on('window-all-closed', () => app.quit());

// Ensure the servers are stopped before the process actually exits.
app.on('before-quit', (e) => {
  if (backend && !stopping) {
    e.preventDefault();
    stopBackend().then(() => app.quit());
  }
});

// macOS: re-open a window if the app is reactivated with none open.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
