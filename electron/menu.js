const fs = require('fs');
const { Menu, shell, dialog, app } = require('electron');
const { buildHar } = require('../src/scripts/har');

// "analytics-capture-2026-08-08-1432.har"
function defaultHarName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `analytics-capture-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}.har`;
}

// Reads the capture straight from the store rather than through /api/har —
// the main process already holds it, and this way the export is not bounded by
// the HTTP layer or affected by the GUI server being reachable.
async function exportHar({ backend, appName, getWindow }) {
  const win = getWindow();
  const count = backend.logStore.getSummaries().length;
  if (!count) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Export HAR',
      message: 'Nothing to export.',
      detail: 'No requests have been captured yet.',
      buttons: ['OK'],
    });
    return;
  }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export capture as HAR',
    defaultPath: defaultHarName(),
    filters: [{ name: 'HTTP Archive', extensions: ['har'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return;

  try {
    const entries = await backend.logStore.readAllEntries();
    const har = buildHar(entries, { name: appName, version: app.getVersion() });
    await fs.promises.writeFile(filePath, JSON.stringify(har, null, 2));

    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Export HAR',
      message: `Exported ${entries.length} request${entries.length === 1 ? '' : 's'}.`,
      detail: filePath,
      buttons: ['OK', 'Show in folder'],
      defaultId: 0,
    });
    if (response === 1) shell.showItemInFolder(filePath);
  } catch (err) {
    dialog.showErrorBox('Export failed', err.message);
  }
}

// The settings dialog belongs to the page, so the menu asks the renderer to
// open it. Restore/focus first, otherwise a minimised window would open a
// dialog nobody can see.
function openSettings(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents
    .executeJavaScript('typeof window.openSettings === "function" && (window.openSettings(), true)')
    .catch((err) => console.error('[menu] could not open settings:', err.message));
}

function buildAppMenu({ backend, guiUrl, appName, getWindow }) {
  const isMac = process.platform === 'darwin';
  const template = [
    // macOS puts the first menu under the app's own name; without this the
    // File menu would be hijacked for it.
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        {
          label: 'Export HAR…',
          accelerator: 'CmdOrCtrl+E',
          click: () => exportHar({ backend, appName, getWindow }),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettings(getWindow()),
        },
        { type: 'separator' },
        {
          label: 'Open logs folder',
          accelerator: 'CmdOrCtrl+L',
          click: () => shell.openPath(backend.logDir),
        },
        {
          label: 'Open GUI in browser',
          click: () => shell.openExternal(guiUrl),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: `About ${appName}`,
          click: () => {
            const state = backend.proxy.state();
            dialog.showMessageBox(getWindow(), {
              type: 'info',
              title: `About ${appName}`,
              message: `${appName} ${app.getVersion()}`,
              detail: [
                `Proxy port: ${state.host}:${state.port} (${state.listening ? 'listening' : 'stopped'})`,
                `GUI:        ${guiUrl}`,
                `Data:       ${backend.dataDir}`,
                '',
                `Electron ${process.versions.electron} · Node ${process.versions.node}`,
              ].join('\n'),
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildAppMenu };
