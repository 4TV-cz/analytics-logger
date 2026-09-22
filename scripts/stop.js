'use strict';

// `npm stop`: stops every running instance of Analytics Logger, however it was
// started, and frees the proxy/GUI ports. Use it when a previous run was
// force-quit, crashed, or outlived a closed terminal and the next start fails
// with EADDRINUSE.
//
// What it kills:
//   1. by process — the headless server (`node server.js`), its `node --watch`
//      parent (`web:dev`), the `npm run …` wrapper around either, the desktop
//      app run from source (electron out of this repo's node_modules), and the
//      packaged app (Analytics Logger.app / AnalyticsLogger-*.exe)
//   2. by port — as a fallback, anything of ours still listening on the proxy
//      port (from config/config.json, else PORT / 8888) or the GUI port
//      (GUI_PORT / 8080)
//
// Only processes that belong to this checkout (working directory or command
// line inside it) or carry the app's name are touched, and never this
// process's own ancestors — so a different project's node server, an editor's
// language server, or the shell you ran this from are left alone.
//
// Cross-platform: Windows (PowerShell / netstat / taskkill) and macOS/Linux
// (ps / lsof / kill).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

// The executable at the start of a command line: "node", "npm", "electron".
// Anything else (a shell whose -c string merely mentions server.js, an editor's
// language server) is never a candidate.
const EXE_RE = /^(?:"?[^"\s]*[\\/])?(node(?:\.exe)?|npm(?:\.cmd|-cli\.js)?|electron(?:\.exe)?)"?(?=\s|$)/i;
// The packaged app: ".../Analytics Logger.app/Contents/MacOS/Analytics Logger"
// or "...\AnalyticsLogger-1.0.0-portable.exe" / "Analytics Logger.exe".
const PACKAGED_RE = /analytics[ _-]?logger[^\\/]*\.(app[\\/]|exe\b)/i;
const SERVER_RE = /(^|[\s\\/])(server\.js|electron[\\/]dev\.js)(\s|$)/;
const NPM_SCRIPT_RE = /^\S*npm\S*\s+(run\s+)?(web(:dev)?|electron(:dev)?|start)(\s|$)/i;
// Port holders we are willing to kill, by image/command name.
const OWN_PROCESS_RE = /node|electron|analytics ?logger/;

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // Non-zero exit (e.g. no match) is expected — treat as empty output.
    return '';
  }
}

function kill(pid) {
  if (isWindows) sh(`taskkill /PID ${pid} /T /F`);
  else sh(`kill -9 ${pid}`);
}

// ── By process ─────────────────────────────────────────────────────────────

// [{ pid, ppid, command }] for every process on the machine.
function listProcesses() {
  const out = [];
  if (isWindows) {
    // One record per line, so a command line containing commas or quotes
    // cannot break the parse.
    const raw = sh('powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId.ToString() + \'|\' + $_.ParentProcessId.ToString() + \'|\' + $_.CommandLine }"');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^(\d+)\|(\d+)\|(.*)$/);
      if (m) out.push({ pid: m[1], ppid: m[2], command: m[3].trim() });
    }
  } else {
    const raw = sh('ps -eo pid=,ppid=,command=');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) out.push({ pid: m[1], ppid: m[2], command: m[3] });
    }
  }
  return out;
}

// Working directory per PID (macOS/Linux only; on Windows the command line
// has to do). `node server.js` shows no path in ps, so this is what ties a
// bare node process to this checkout rather than to some other project.
function cwdByPid(pids) {
  const map = new Map();
  if (isWindows || !pids.length) return map;
  const raw = sh(`lsof -a -d cwd -Fpn -p ${pids.join(',')}`);
  let pid = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1));
  }
  return map;
}

function isUnderRoot(p) {
  if (!p) return false;
  const rel = path.relative(ROOT, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// This process, npm above it, the shell above that, and so on: none of them
// may be killed, whatever their command line or working directory look like.
function ancestorsOf(pid, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set([pid]);
  let cur = byPid.get(pid);
  while (cur && cur.ppid && cur.ppid !== '0' && !out.has(cur.ppid)) {
    out.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

function findOurs() {
  const all = listProcesses();
  const skip = ancestorsOf(String(process.pid), all);
  const procs = all.filter((p) => !skip.has(p.pid));
  const candidates = procs.filter((p) => EXE_RE.test(p.command) || PACKAGED_RE.test(p.command));
  const cwds = cwdByPid(candidates.filter((p) => EXE_RE.test(p.command)).map((p) => p.pid));

  const ours = [];
  for (const p of candidates) {
    const cmd = p.command;
    const exe = (cmd.match(EXE_RE) || [])[1] || '';
    const inRoot = cmd.includes(ROOT) || isUnderRoot(cwds.get(p.pid));
    let reason = null;
    if (PACKAGED_RE.test(cmd) && !/node_modules/.test(cmd)) reason = 'packaged app';
    else if (/^electron/i.test(exe) && inRoot) reason = 'electron';
    else if (/^node/i.test(exe) && inRoot && SERVER_RE.test(cmd)) reason = 'server';
    else if (/^npm/i.test(exe) && inRoot && NPM_SCRIPT_RE.test(cmd)) reason = 'npm wrapper';
    // `electron .` from npm runs the electron binary out of node_modules, and
    // its helper processes carry the same path.
    else if (inRoot && /node_modules[\\/]electron[\\/]/.test(cmd)) reason = 'electron';
    if (reason) ours.push({ ...p, reason });
  }
  // Wrappers and watchers first, so nothing respawns a child we just killed.
  const rank = (p) => (p.reason === 'npm wrapper' ? 0 : /--watch/.test(p.command) ? 1 : 2);
  return ours.sort((a, b) => rank(a) - rank(b));
}

// ── By port ────────────────────────────────────────────────────────────────

// The proxy port is whatever config.json says (the GUI saves it there), with
// the env var / built-in default as the fallback — the same resolution the
// server itself does.
function configuredPorts() {
  let proxy = Number(process.env.PORT) || 8888;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
    if (Number.isInteger(cfg.port)) proxy = cfg.port;
  } catch {}
  const gui = Number(process.env.GUI_PORT) || 8080;
  return [...new Set([proxy, gui])];
}

// PIDs listening on the given TCP port.
function pidsOnPort(port) {
  const pids = new Set();
  if (isWindows) {
    // netstat rows look like:
    //   TCP    0.0.0.0:8888   0.0.0.0:0   LISTENING   12345
    const out = sh('netstat -ano -p tcp');
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || '';
      const pid = cols[cols.length - 1];
      if (local.endsWith(`:${port}`) && /^\d+$/.test(pid)) pids.add(pid);
    }
  } else {
    const out = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
    for (const pid of out.split(/\r?\n/)) {
      if (/^\d+$/.test(pid.trim())) pids.add(pid.trim());
    }
  }
  return pids;
}

// Best-effort image/command name for a PID, so only our own servers are killed.
function processName(pid) {
  if (isWindows) {
    // tasklist CSV: "node.exe","12345","Console","1","45,000 K"
    const out = sh(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
    const m = out.match(/^"([^"]+)"/);
    return m ? m[1].toLowerCase() : '';
  }
  return sh(`ps -p ${pid} -o comm=`).trim().toLowerCase();
}

function freePorts(ports, alreadyKilled) {
  let killed = 0;
  for (const port of ports) {
    for (const pid of pidsOnPort(port)) {
      if (pid === String(process.pid) || alreadyKilled.has(pid)) continue;
      const name = processName(pid);
      if (!OWN_PROCESS_RE.test(name)) {
        console.warn(`[stop] port ${port} held by PID ${pid} (${name || 'unknown'}) — not ours, leaving it alone`);
        continue;
      }
      console.log(`[stop] freeing port ${port}: killing ${name} (PID ${pid})`);
      kill(pid);
      killed++;
    }
  }
  return killed;
}

function main() {
  const ours = findOurs();
  for (const p of ours) {
    console.log(`[stop] killing ${p.reason} PID ${p.pid}: ${p.command.slice(0, 110)}`);
    kill(p.pid);
  }
  const ports = configuredPorts();
  const freed = freePorts(ports, new Set(ours.map((p) => p.pid)));
  const total = ours.length + freed;
  if (!total) console.log(`[stop] nothing running; ports ${ports.join(', ')} free`);
  else console.log(`[stop] stopped ${total} process(es)`);
}

main();
