/**
 * Il formato di una sessione su disco, scritto e letto da un posto solo.
 *
 *   sessioni/<id>/
 *     meta.json                      riepilogo (riscritto periodicamente)
 *     rete/frames.ndjson.gz          ogni frame WebSocket, in ordine d'arrivo
 *     rete/http.ndjson               ogni richiesta HTTP (metadati)
 *     rete/http/<host>/<percorso>    il corpo di ogni risposta
 *     rete/post/                     i corpi delle richieste POST/PUT
 *     sorgente/script/<host>/…       ogni script visto (HTTP e V8: inline, eval, worker)
 *     sorgente/script.ndjson         indice degli script
 *     runtime/stato.ndjson           stato del client letto dalla pagina (impostazioni live)
 *     runtime/console.ndjson         console ed eccezioni della pagina
 *     estratto/                      l'analisi di questa sola sessione
 *
 * Righe di frames.ndjson.gz (campo `k`):
 *   ws {s,url,target}  hs {s,status}  f {s,d:'o'|'i',op,p|b}  wsclose {s}  mark {label}
 * Ogni riga porta `w` (ora di sistema, ms) e, se viene dalla rete, `m`: il
 * timestamp MONOTONO dello stack di rete di Chrome in secondi, cioe' l'istante
 * in cui il frame e' passato dal socket senza il ritardo del JavaScript.
 *
 * Il gzip viene svuotato ogni due secondi: una chiusura brusca lascia leggibile
 * tutto cio' che e' stato scritto fino a quel momento.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

export const FRAMES_FILE = path.join('rete', 'frames.ndjson.gz');

// --- privacy -------------------------------------------------------------------

const SECRET_KEYS = 'sessionToken|reconnectToken|token|idToken|accessToken|refreshToken|authToken|customToken|jwt|password|secret|oobCode';
const SECRET_RE = new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)"([^"]*)"`, 'gi');
const SECRET_HEADERS = new Set([
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-session-token',
  'x-auth-token', 'x-api-key', 'x-csrf-token', 'x-xsrf-token', 'x-firebase-appcheck',
]);

/** Toglie dal testo i valori dei campi-credenziale, conservandone la lunghezza. */
export function redactText(text) {
  if (typeof text !== 'string' || !/oken|jwt|password|secret|oobCode/i.test(text)) return text;
  return text.replace(SECRET_RE, (_m, head, v) => `${head}"<redatto:${v.length}>"`);
}

export function redactHeaders(h, on = true) {
  if (!h || typeof h !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = on && SECRET_HEADERS.has(k.toLowerCase()) ? `<redatto:${String(v).length}>` : v;
  }
  return out;
}

// --- nomi file -----------------------------------------------------------------

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function sanitize(s, max = 80) {
  return String(s ?? '').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'x';
}

/** host/percorso leggibile per un URL, con un hash della query per distinguere le varianti. */
export function urlToRelPath(url, fallbackExt = '') {
  // Script senza URL (inline, eval): «inline:<pagina>#<hash>» -> inline/<host della pagina>/<hash>.js
  const inline = /^inline:(.*)#(\w+)$/.exec(String(url));
  if (inline) {
    let host = 'pagina';
    try { host = sanitize(new URL(inline[1]).host) || host; } catch { /* pagina senza URL */ }
    return path.join('inline', host, `${inline[2]}${fallbackExt || '.js'}`);
  }
  let u;
  try { u = new URL(url); } catch { return path.join('altro', `${sha256(String(url)).slice(0, 12)}${fallbackExt}`); }
  const host = sanitize(u.host || u.protocol.replace(':', ''));
  const parts = u.pathname.split('/').filter(Boolean).map((p) => sanitize(decodeURIComponent(p)));
  let file = parts.pop() || 'index';
  if (u.search) file = `${file}.${sha256(u.search).slice(0, 8)}`;
  if (!path.extname(file) && fallbackExt) file += fallbackExt;
  return path.join(host, ...parts.slice(0, 6), file);
}

// --- scrittura -----------------------------------------------------------------

export class SessionStore {
  constructor(dir, { redact = true } = {}) {
    this.dir = dir;
    this.redact = redact;
    for (const d of ['rete/http', 'rete/post', 'sorgente/script', 'runtime', 'estratto']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    this.file = fs.createWriteStream(path.join(dir, FRAMES_FILE));
    this.gz = zlib.createGzip({ level: 6 });
    this.gz.pipe(this.file);
    this.lines = {};
    this.closed = false;
    this.seen = { http: new Map(), script: new Map() };   // sha -> percorso
    this.stats = { frames: 0, rawBytes: 0, httpBodies: 0, scripts: 0 };
    this.flushTimer = setInterval(() => {
      if (!this.closed) this.gz.flush(zlib.constants.Z_SYNC_FLUSH);
    }, 2000);
    this.flushTimer.unref?.();
  }

  /** Una riga dello stream di rete. */
  frame(ev) {
    if (this.closed) return;
    const line = `${JSON.stringify(ev)}\n`;
    this.stats.frames += 1;
    this.stats.rawBytes += line.length;
    this.gz.write(line);
  }

  get compressedBytes() { return this.file.bytesWritten; }

  /** Append su un file ndjson accessorio (http, script, console, stato...). */
  append(rel, obj) {
    let s = this.lines[rel];
    if (!s) {
      s = fs.createWriteStream(path.join(this.dir, rel), { flags: 'a' });
      this.lines[rel] = s;
    }
    s.write(`${JSON.stringify(obj)}\n`);
  }

  /** Salva un corpo deduplicato per contenuto; restituisce il percorso relativo alla sessione. */
  async saveBlob(kind, url, buffer, ext = '') {
    const digest = sha256(buffer);
    const known = this.seen[kind].get(digest);
    if (known) return { rel: known, sha: digest, duplicate: true };
    const base = kind === 'script' ? 'sorgente/script' : 'rete/http';
    let rel = path.join(base, urlToRelPath(url || `inline:${digest}`, ext));
    // Due contenuti diversi allo stesso URL (es. ricaricato e cambiato): si numerano.
    for (let i = 1; fs.existsSync(path.join(this.dir, rel)); i += 1) {
      const e = path.extname(rel);
      rel = `${rel.slice(0, rel.length - e.length).replace(/~\d+$/, '')}~${i}${e}`;
    }
    await fsp.mkdir(path.dirname(path.join(this.dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(this.dir, rel), buffer);
    this.seen[kind].set(digest, rel);
    this.stats[kind === 'script' ? 'scripts' : 'httpBodies'] += 1;
    return { rel, sha: digest, duplicate: false };
  }

  async writeJson(rel, obj) {
    const file = path.join(this.dir, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(obj, null, 2)}\n`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.flushTimer);
    await Promise.all(Object.values(this.lines).map((s) => new Promise((r) => s.end(r))));
    await new Promise((resolve) => { this.file.once('close', resolve); this.gz.end(); });
  }
}

// --- lettura -------------------------------------------------------------------

/**
 * Le righe dello stream di rete, in ordine. Tollera un file troncato da una
 * chiusura brusca: si ferma all'ultima riga completa.
 */
export async function* readFrames(dir) {
  const file = path.join(dir, FRAMES_FILE);
  if (!fs.existsSync(file)) return;
  const gun = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const src = fs.createReadStream(file);
  const fail = () => gun.end();
  gun.on('error', fail);
  src.on('error', fail);
  const rl = readline.createInterface({ input: src.pipe(gun), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* ultima riga troncata */ }
  }
}

export function listSessions(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((d) => fs.existsSync(path.join(d, FRAMES_FILE)))
    .sort();
}

export async function writeJsonFile(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(obj, null, 2)}\n`);
}

export async function writeTextFile(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}
