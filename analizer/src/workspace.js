/**
 * Le operazioni di alto livello, condivise da live e offline: rileggere le
 * sessioni, costruire il modello del sorgente, scrivere l'estratto, e
 * importare le catture nel vecchio formato del progetto.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Analyzer } from './analysis/engine.js';
import { buildSpec, sharedContext } from './analysis/spec.js';
import { latestGlobals, writeExtract } from './report/write.js';
import { buildSourceModel, SourceIndex } from './source/model.js';
import { readFrames, redactText, SessionStore, sha256, writeJsonFile } from './capture/store.js';

/** Rilegge una sessione salvata dentro un analizzatore. */
export async function feedSession(analyzer, dir, { onProgress } = {}) {
  analyzer.beginSession(path.basename(dir));
  const stato = path.join(dir, 'runtime', 'stato.ndjson');
  if (fs.existsSync(stato)) {
    for (const line of fs.readFileSync(stato, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); analyzer.noteRuntime(r.key, r.value, r.w); } catch { /* riga rotta */ }
    }
  }
  let n = 0;
  for await (const ev of readFrames(dir)) {
    analyzer.ingest(ev);
    n += 1;
    if (onProgress && n % 20_000 === 0) onProgress(n);
  }
  analyzer.endSession();
  return n;
}

/** Riduce l'analizzatore a estratto e lo scrive in `outDir`. */
export async function writeAnalysis(analyzer, sourceIndex, outDir, { sessionDirs = [], title = 'estratto' } = {}) {
  const model = sourceIndex.list.length ? buildSourceModel(sourceIndex) : null;
  const shared = sharedContext(analyzer, model);
  const report = analyzer.finalize(shared);
  const spec = buildSpec({ report, model, shared, runtime: analyzer.runtime });
  await writeExtract(outDir, {
    report, spec, protocol: analyzer.byId.protocol.document(), model, sourceIndex,
    runtime: analyzer.runtime, globals: latestGlobals(sessionDirs), title,
  });
  return { report, spec, model };
}

/** Analisi offline: un estratto per ogni sessione e uno complessivo. */
export async function analyzeSessions(dirs, { extractDir, gameHosts, perSession = true, log = () => {} }) {
  const total = new Analyzer();
  const totalSource = new SourceIndex(gameHosts);
  for (const dir of dirs) {
    const t0 = Date.now();
    const n = await feedSession(total, dir, { onProgress: (k) => log(`  ${path.basename(dir)}: ${k} righe…`) });
    totalSource.loadSession(dir);
    if (perSession) {
      const one = new Analyzer();
      const src = new SourceIndex(gameHosts);
      await feedSession(one, dir);
      src.loadSession(dir);
      await writeAnalysis(one, src, path.join(dir, 'estratto'), { sessionDirs: [dir], title: `sessione ${path.basename(dir)}` });
    }
    log(`  ${path.basename(dir)}: ${n} righe in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  return writeAnalysis(total, totalSource, extractDir, { sessionDirs: dirs, title: 'tutte le sessioni' });
}

/**
 * Importa una cattura del vecchio registratore (capture/<id>/) nel formato di
 * sessione di questo programma: frame WebSocket, script, risposte HTTP.
 */
export async function importCapture(src, sessionsDir, { log = () => {} } = {}) {
  const name = `importata-${path.basename(src)}`;
  const dir = path.join(sessionsDir, name);
  if (fs.existsSync(dir)) throw new Error(`esiste gia': ${dir}`);
  const store = new SessionStore(dir);
  let frames = 0;
  const wsRoot = path.join(src, 'websocket');
  const sockets = fs.existsSync(wsRoot) ? fs.readdirSync(wsRoot).sort() : [];
  for (const [i, sd] of sockets.entries()) {
    const sdir = path.join(wsRoot, sd);
    const jsonl = path.join(sdir, 'frames.jsonl');
    if (!fs.existsSync(jsonl)) continue;
    const fds = {};
    const open = (rel) => { fds[rel] ??= fs.openSync(path.join(src, rel), 'r'); return fds[rel]; };
    const s = i + 1;
    let announced = false;
    const rl = readline.createInterface({ input: fs.createReadStream(jsonl), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.event === 'created' || !announced) {
        store.frame({ k: 'ws', s, url: e.url ?? sd, w: e.ts });
        announced = true;
        if (e.event) continue;
      }
      if (e.event === 'closed') { store.frame({ k: 'wsclose', s, w: e.ts }); continue; }
      if (!e.dir || e.length == null || !e.packed) continue;
      const buf = Buffer.alloc(e.length);
      fs.readSync(open(e.packed), buf, 0, e.length, e.offset);
      const ev = { k: 'f', s, d: e.dir === 'sent' ? 'o' : 'i', m: e.cdpTs ?? null, w: e.ts, op: e.opcode ?? 1 };
      if (ev.op === 1) ev.p = redactText(buf.toString('utf8')); else ev.b = buf.toString('base64');
      store.frame(ev);
      frames += 1;
      if (frames % 20_000 === 0) log(`  ${frames} frame…`);
    }
    for (const fd of Object.values(fds)) fs.closeSync(fd);
  }

  // Script: i sorgenti V8 e i bundle scaricati.
  let scripts = 0;
  for (const root of ['scripts', path.join('resources', 'javascript')]) {
    const base = path.join(src, root);
    if (!fs.existsSync(base)) continue;
    for (const file of walkFiles(base)) {
      if (!file.endsWith('.js')) continue;
      const buf = fs.readFileSync(file);
      const host = path.relative(base, file).split(path.sep)[0];
      const url = host === '_blob' || host === 'inline' ? `inline:https://moneyslither.com/#${sha256(buf).slice(0, 10)}` : `https://${host}/${path.basename(file)}`;
      const saved = await store.saveBlob('script', url, buf, '.js');
      if (saved.duplicate) continue;
      store.append('sorgente/script.ndjson', { url, rel: saved.rel, sha: saved.sha, length: buf.length, via: 'importato' });
      scripts += 1;
    }
  }
  // Risposte HTTP gia' salvate dal vecchio registratore.
  const resJsonl = path.join(src, 'metadata', 'resources.jsonl');
  let bodies = 0;
  if (fs.existsSync(resJsonl)) {
    for (const line of fs.readFileSync(resJsonl, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const rec = { url: r.url, method: r.method, status: r.status, mimeType: r.mimeType, type: r.resourceType, w: r.startedAt };
      if (r.savedAs && fs.existsSync(path.join(src, r.savedAs)) && r.category !== 'javascript') {
        let buf = fs.readFileSync(path.join(src, r.savedAs));
        if (/json/.test(r.mimeType ?? '')) buf = Buffer.from(redactText(buf.toString('utf8')));
        const saved = await store.saveBlob('http', r.url, buf);
        rec.body = saved.rel;
        bodies += 1;
      }
      store.append('rete/http.ndjson', rec);
    }
  }
  await store.close();
  await writeJsonFile(path.join(dir, 'meta.json'), { formato: 1, importataDa: path.resolve(src), frame: frames, script: scripts, corpiHttp: bodies, importata: new Date().toISOString() });
  return { dir, frames, scripts, bodies };
}

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

export async function writeSessionMeta(dir, meta) {
  await fsp.mkdir(dir, { recursive: true });
  await writeJsonFile(path.join(dir, 'meta.json'), meta);
}
