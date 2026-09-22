// Dev launcher for the desktop app. Electron has no equivalent of node --watch,
// and rather than pull in a watcher dependency this does the one thing needed:
// respawn the Electron process when main-process code changes.
//
// GUI files (src/components) are deliberately NOT watched here. They are read
// from disk per request, so a restart would achieve nothing except tearing down
// the window and the event stream — the very channel the in-page live reload
// travels on. GuiServer watches those itself and pushes a `reload` frame.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Required from plain Node (not from inside Electron), the package exports the
// path to the executable.
const electronPath = require('electron');

const ROOT = path.join(__dirname, '..');
const WATCH = [
  path.join(ROOT, 'electron'),
  path.join(ROOT, 'src', 'scripts'),
  path.join(ROOT, 'src', 'backend.js'),
  path.join(ROOT, 'server.js'),
];

let child = null;
let restarting = false;
let debounce = null;

function start() {
  child = spawn(electronPath, ['.', '--live-reload'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => {
    child = null;
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    // The window was closed (or the app quit on its own): stop watching too.
    process.exit(code ?? 0);
  });
}

function restart(reason) {
  console.log(`\n[dev] ${reason} changed — restarting app`);
  if (!child) return start();
  restarting = true;
  child.kill();          // respawn happens in the 'exit' handler, once the ports are free
}

// Editors write a file several times per save; collapse the burst.
function scheduleRestart(reason) {
  clearTimeout(debounce);
  debounce = setTimeout(() => restart(reason), 150);
}

for (const target of WATCH) {
  let isDir;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    continue;            // optional path, e.g. before a file exists
  }
  try {
    fs.watch(target, { recursive: isDir }, (_event, filename) => {
      scheduleRestart(filename ? String(filename) : path.basename(target));
    });
  } catch (err) {
    console.warn(`[dev] cannot watch ${target}: ${err.message}`);
  }
}

process.on('SIGINT', () => {
  restarting = false;
  if (child) child.kill();
  process.exit(0);
});

console.log('[dev] starting Analytics Logger — main-process edits restart it, GUI edits reload in place');
start();
