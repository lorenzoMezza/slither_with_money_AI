import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export function findChrome(explicit = '') {
  const list = [explicit, ...(CANDIDATES[process.platform] ?? [])].filter(Boolean);
  const found = list.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`nessun Chrome trovato (provati: ${list.join(', ')}). Imposta CHROME_PATH.`);
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chrome come processo normale, con il profilo persistente e la porta DevTools.
 * Nessun flag di automazione: la prima scheda e' about:blank e la navigazione
 * al gioco parte solo dopo che la registrazione e' agganciata.
 */
export async function launchChrome({ chromePath, profileDir }) {
  const exe = findChrome(chromePath);
  await fsp.mkdir(profileDir, { recursive: true });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  await fsp.rm(portFile, { force: true });

  const proc = spawn(exe, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Una scheda in secondo piano non deve rallentare il gioco: falserebbe le misure.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-3000); });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Chrome si e' chiuso durante l'avvio.\n${stderr}`);
    const port = readPort(profileDir);
    if (port) {
      const wsUrl = await browserWsUrl(port, 15_000);
      if (wsUrl) return { proc, wsUrl, port, exe };
    }
    await sleep(150);
  }
  throw new Error('timeout in attesa di DevTools: probabilmente un altro Chrome usa gia\' questo profilo.');
}

/** Chrome del tutto normale (niente porta di debug): serve per il login con Google. */
export function launchPlainChrome({ chromePath, profileDir, url }) {
  const exe = findChrome(chromePath);
  fs.mkdirSync(profileDir, { recursive: true });
  return spawn(exe, [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', url],
    { stdio: 'ignore' });
}

function readPort(profileDir) {
  try {
    const port = Number.parseInt(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0], 10);
    return port > 0 ? port : null;
  } catch { return null; }
}

export async function browserWsUrl(port, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      const info = await res.json();
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch { /* non ancora pronto */ }
    await sleep(150);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Un Chrome gia' aperto su questo profilo CON la porta di debug (es. una
 * sessione precedente rimasta aperta): ci si aggancia invece di avviarne un
 * altro, che fallirebbe perche' il profilo e' esclusivo.
 */
export async function existingChrome({ profileDir, debugPort }) {
  const port = debugPort || readPort(profileDir);
  if (!port) return null;
  const wsUrl = await browserWsUrl(port, 1000);
  return wsUrl ? { wsUrl, port, proc: null } : null;
}

/** Stato del lock del profilo: Chrome lo crea come symlink "host-pid". */
export function profileLock(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock');
  let target;
  try { target = fs.readlinkSync(lockPath); } catch (e) {
    return { locked: e.code !== 'ENOENT', alive: e.code !== 'ENOENT', pid: null };
  }
  const pid = Number.parseInt(/-(\d+)$/.exec(target)?.[1] ?? '', 10) || null;
  let alive = true;
  if (pid) {
    try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
  }
  return { locked: true, alive, pid };
}

export function clearStaleLock(profileDir) {
  const lock = profileLock(profileDir);
  if (lock.locked && !lock.alive) {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(profileDir, f)); } catch { /* gia' assente */ }
    }
    return true;
  }
  return false;
}

export async function closeChrome(proc, graceMs = 5000) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    try { proc.kill('SIGTERM'); } catch { resolve(); return; }
    setTimeout(() => {
      try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* gia' chiuso */ }
      resolve();
    }, graceMs).unref?.();
  });
}

export async function waitProfileFree(profileDir, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    clearStaleLock(profileDir);
    if (!profileLock(profileDir).locked) return true;
    await sleep(200);
  }
  return false;
}
