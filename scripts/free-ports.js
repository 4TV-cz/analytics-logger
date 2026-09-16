'use strict';

// Free the ports the logger uses before it starts. A previous run that was
// force-quit (or crashed) can leave the proxy/GUI servers bound, and the new
// run then fails to listen. This finds whatever is holding those ports and, if
// it is a lingering node/electron process, kills it. Runs automatically via the
// `preweb` / `preelectron` npm hooks; also runnable on its own: `npm run free-ports`.
//
// Cross-platform: Windows (netstat + taskkill) and macOS/Linux (lsof + kill).
// It only kills node/electron processes so it can't take down an unrelated app
// that happens to sit on the same port.

const { execSync } = require('child_process');

const PROXY_PORT = Number(process.env.PORT) || 8889;
const GUI_PORT = Number(process.env.GUI_PORT) || 8080;
const PORTS = [...new Set([PROXY_PORT, GUI_PORT])];

const isWindows = process.platform === 'win32';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // Non-zero exit (e.g. no match) is expected — treat as empty output.
    return '';
  }
}

// Return the set of PIDs listening on the given TCP port.
function pidsOnPort(port) {
  const pids = new Set();
  if (isWindows) {
    // netstat rows look like:
    //   TCP    0.0.0.0:8889   0.0.0.0:0   LISTENING   12345
    const out = sh(`netstat -ano -p tcp`);
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

// Best-effort image/command name for a PID, so we only kill our own servers.
function processName(pid) {
  if (isWindows) {
    // tasklist CSV: "node.exe","12345","Console","1","45,000 K"
    const out = sh(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
    const m = out.match(/^"([^"]+)"/);
    return m ? m[1].toLowerCase() : '';
  }
  return sh(`ps -p ${pid} -o comm=`).trim().toLowerCase();
}

function kill(pid) {
  if (isWindows) sh(`taskkill /PID ${pid} /T /F`);
  else sh(`kill -9 ${pid}`);
}

function main() {
  const own = String(process.pid);
  let killed = 0;

  for (const port of PORTS) {
    for (const pid of pidsOnPort(port)) {
      if (pid === own) continue;
      const name = processName(pid);
      if (!/node|electron|mux ?logger/.test(name)) {
        console.warn(`[free-ports] port ${port} held by PID ${pid} (${name || 'unknown'}) — not node/electron, leaving it alone`);
        continue;
      }
      console.log(`[free-ports] freeing port ${port}: killing ${name} (PID ${pid})`);
      kill(pid);
      killed++;
    }
  }

  if (killed === 0) console.log(`[free-ports] ports ${PORTS.join(', ')} already free`);
}

main();
