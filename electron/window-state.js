const fs = require('fs');
const path = require('path');
const { screen } = require('electron');

const DEFAULTS = { width: 1400, height: 900, maximized: false };

function createWindowState(stateFile) {
  function load() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return { ...DEFAULTS };
    }
    if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
      return { ...DEFAULTS };
    }
    const state = {
      width: Math.max(900, Math.round(saved.width)),
      height: Math.max(500, Math.round(saved.height)),
      maximized: !!saved.maximized,
    };
    // Only restore a position that still lands on a connected display — a
    // monitor may have been unplugged since the last run.
    if (typeof saved.x === 'number' && typeof saved.y === 'number' && isOnScreen(saved)) {
      state.x = Math.round(saved.x);
      state.y = Math.round(saved.y);
    }
    return state;
  }

  function isOnScreen({ x, y, width, height }) {
    return screen.getAllDisplays().some(({ workArea: a }) =>
      x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y);
  }

  function save(win) {
    if (!win || win.isDestroyed()) return;
    // getNormalBounds() reports the pre-maximise size, which is what we want to
    // restore to when the user un-maximises later.
    const bounds = win.getNormalBounds();
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2));
    } catch {
      // A read-only data directory should not stop the app from closing.
    }
  }

  // Bounds change continuously while dragging; only persist once things settle.
  function track(win) {
    let timer = null;
    const queue = () => {
      clearTimeout(timer);
      timer = setTimeout(() => save(win), 400);
    };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, queue);
    win.on('close', () => {
      clearTimeout(timer);
      save(win);
    });
  }

  return { load, save, track };
}

module.exports = { createWindowState };
