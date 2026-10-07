#!/usr/bin/env node
/**
 * analizer — analizzatore in tempo reale di moneyslither.com.
 *
 *   node analizer.js login        login con Google in un Chrome normale (una volta sola)
 *   node analizer.js              apre il gioco, registra e analizza mentre giochi
 *   node analizer.js analizza     rigenera l'estratto da tutte le sessioni registrate
 *   node analizer.js importa <cartella>   importa catture del vecchio registratore
 *
 * Mentre giochi registra ogni frame WebSocket, ogni risposta HTTP, ogni script
 * e lo stato del client, e aggiorna di continuo `estratto/`: la cartella da cui
 * si costruisce il simulatore.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Analyzer } from './src/analysis/engine.js';
import { CdpClient } from './src/browser/cdp.js';
import {
  clearStaleLock, closeChrome, existingChrome, launchChrome, launchPlainChrome, profileLock, waitProfileFree,
} from './src/browser/chrome.js';
import { Recorder } from './src/capture/recorder.js';
import { listSessions, SessionStore } from './src/capture/store.js';
import { config, newSessionId } from './src/config.js';
import { bold, color, humanBytes, humanDuration, log } from './src/log.js';
import { SourceIndex } from './src/source/model.js';
import { analyzeSessions, feedSession, importCapture, writeAnalysis, writeSessionMeta } from './src/workspace.js';

const [cmd = 'live', ...args] = process.argv.slice(2);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const ask = (q) => new Promise((resolve) => {
  let done = false;
  const settle = (v) => { if (!done) { done = true; resolve(v); } };
  rl.question(q, (a) => settle(a.trim().toLowerCase()));
  rl.once('close', () => settle(null));
});

const commands = { live, login, analizza, importa, aiuto };
if (!commands[cmd]) { log.error(`comando sconosciuto: ${cmd}`); aiuto(); process.exit(1); }
commands[cmd]().catch((err) => { log.error(err?.stack ?? String(err)); process.exit(1); });

// ---------------------------------------------------------------------------------

async function aiuto() {
  log.raw(`
  ${bold('analizer')} — analizzatore in tempo reale di moneyslither.com

    node analizer.js login                 login con Google (Chrome normale, una volta sola)
    node analizer.js                       apre il gioco, registra e analizza mentre giochi
    node analizer.js analizza [sessione]   rigenera l'estratto dalle sessioni registrate
    node analizer.js importa <cartella>    importa catture del vecchio registratore

  Uscita: ${path.relative(process.cwd(), config.extractDir) || '.'}/  (si parte da simulatore.json)
  Dati grezzi: ${path.relative(process.cwd(), config.sessionsDir) || '.'}/<sessione>/
`);
  rl.close();
}

// --- login ---------------------------------------------------------------------------

/**
 * Google rifiuta il login in un browser collegato a DevTools («This browser or
 * app may not be secure»): e' una protezione legittima e non va aggirata. Il
 * login si fa quindi in un Chrome del tutto normale sullo stesso profilo, e la
 * registrazione riusa poi la sessione salvata.
 */
async function login() {
  if (!await freeProfile()) process.exit(1);
  const proc = launchPlainChrome({ chromePath: config.chromePath, profileDir: config.profileDir, url: config.targetUrl });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  log.raw(`
  ${bold('Login')} — Chrome normale, nessun debugger collegato.

    1. fai il login (Google) e verifica di essere dentro al gioco
    2. torna qui e premi ${bold('INVIO')}: Chrome lo chiudo io
`);
  await Promise.race([ask('  INVIO quando hai finito  '), new Promise((r) => proc.once('exit', r))]);
  if (!exited) await closeChrome(proc);
  await waitProfileFree(config.profileDir);
  log.ok(`profilo salvato. Ora: ${bold('node analizer.js')}`);
  rl.close();
}

/** Il profilo deve essere libero: un Chrome aperto su di esso senza porta di debug va chiuso. */
async function freeProfile() {
  clearStaleLock(config.profileDir);
  const lock = profileLock(config.profileDir);
  if (!lock.locked) return true;
  log.warn('il profilo e\' aperto in un altro Chrome.');
  const a = await ask('  Lo chiudo io e proseguo? [S/n]  ');
  if (a === null || !['', 's', 'si', 'y'].includes(a)) return false;
  if (lock.pid) { try { process.kill(lock.pid, 'SIGTERM'); } catch { /* gia' chiuso */ } }
  if (!await waitProfileFree(config.profileDir)) { log.error('il profilo risulta ancora occupato'); return false; }
  return true;
}

// --- analisi offline ------------------------------------------------------------------

async function analizza() {
  let dirs = listSessions(config.sessionsDir);
  if (args.length) dirs = dirs.filter((d) => args.some((a) => path.basename(d).includes(a)));
  if (!dirs.length) { log.error(`nessuna sessione in ${config.sessionsDir}`); process.exit(1); }
  log.info(`analizzo ${dirs.length} sessioni…`);
  const t0 = Date.now();
  const { spec } = await analyzeSessions(dirs, { extractDir: config.extractDir, gameHosts: config.gameHosts, log: log.info });
  summarize(spec);
  log.ok(`estratto in ${config.extractDir} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  rl.close();
}

async function importa() {
  if (!args.length) { log.error('uso: node analizer.js importa <cartella-cattura> [...]'); process.exit(1); }
  const targets = [];
  for (const a of args) {
    if (fs.existsSync(path.join(a, 'websocket'))) targets.push(a);
    else if (fs.existsSync(a)) {
      for (const d of fs.readdirSync(a)) if (fs.existsSync(path.join(a, d, 'websocket'))) targets.push(path.join(a, d));
    }
  }
  if (!targets.length) { log.error('nessuna cattura riconosciuta (serve una cartella con websocket/)'); process.exit(1); }
  for (const t of targets) {
    const r = await importCapture(t, config.sessionsDir, { log: log.info });
    log.ok(`${path.basename(t)}: ${r.frames} frame, ${r.scripts} script, ${r.bodies} corpi HTTP → ${path.relative(process.cwd(), r.dir)}`);
  }
  log.raw(`\n  Ora: ${bold('node analizer.js analizza')}\n`);
  rl.close();
}

// --- live ---------------------------------------------------------------------------------

async function live() {
  log.raw(`\n  ${bold('analizer')} ${color('grey', '— registrazione e analisi in tempo reale')}\n`);

  // --- browser ---
  let chrome = await existingChrome({ profileDir: config.profileDir, debugPort: config.debugPort });
  let launched = false;
  if (chrome) log.info(`mi aggancio al Chrome gia' aperto (porta ${chrome.port})`);
  else {
    if (!await freeProfile()) process.exit(1);
    chrome = await launchChrome({ chromePath: config.chromePath, profileDir: config.profileDir });
    launched = true;
    log.ok(`Chrome avviato (${path.basename(chrome.exe)}), profilo ${path.relative(process.cwd(), config.profileDir)}`);
  }
  const cdp = new CdpClient(chrome.wsUrl);
  await cdp.connect();

  // --- analizzatori ---
  // `total` comprende le sessioni precedenti (estratto complessivo), `mine` solo questa.
  const id = newSessionId();
  const dir = path.join(config.sessionsDir, id);
  const previous = listSessions(config.sessionsDir);
  const total = new Analyzer();
  const mine = new Analyzer();
  const totalSource = new SourceIndex(config.gameHosts);
  const mySource = new SourceIndex(config.gameHosts);
  if (config.includeHistory && previous.length) {
    log.info(`ricarico ${previous.length} sessioni precedenti per l'estratto complessivo…`);
    for (const d of previous) {
      await feedSession(total, d);
      totalSource.loadSession(d);
    }
    log.ok('storico caricato');
  }
  total.beginSession(id);
  mine.beginSession(id);

  const store = new SessionStore(dir, { redact: config.redact });
  const rec = new Recorder({ cdp, store, config });
  const startedAt = Date.now();
  const win = { state: 0, frames: 0, bytes: 0 };

  total.onEvent = (ev) => printEvent(ev);
  const ingest = (ev) => { total.ingest(ev); mine.ingest(ev); };
  rec.on('socket', (s) => { ingest({ k: 'ws', s: s.s, url: s.url, w: Date.now() }); log.tag('ws', `socket ${s.s}: ${s.url}`); });
  rec.on('frame', (ev) => {
    ingest(ev);
    win.frames += 1;
    win.bytes += ev.p ? ev.p.length : 0;
    if (ev.d === 'i' && ev.p && ev.p.startsWith('{"t":"state"')) win.state += 1;
  });
  rec.on('mark', ingest);
  rec.on('probe', (probe) => {
    for (const [k, v] of Object.entries(probe)) { total.noteRuntime(k, v); mine.noteRuntime(k, v); }
  });
  rec.on('script', (info) => {
    const a = totalSource.add(info);
    mySource.add(info);
    if (a && (a.sections.length || a.functions.length)) log.tag('sorgente', `${a.name}: ${a.constants.length} costanti, ${a.sections.length} sezioni, ${a.functions.length} funzioni`);
  });
  rec.on('note', (s) => log.info(s));

  await rec.start();
  await rec.openGame(config.targetUrl);
  log.ok(`registrazione attiva → ${path.relative(process.cwd(), dir)}`);
  log.raw(color('grey', '  comandi: s stato · c copertura · m <nota> marcatore · a analizza ora · q esci\n'));

  // --- analisi periodica ---
  let writing = null;
  const writeAll = async (final = false) => {
    if (writing) { await writing; if (!final) return; }
    writing = (async () => {
      try {
        const t0 = Date.now();
        await writeAnalysis(mine, mySource, path.join(dir, 'estratto'), { sessionDirs: [dir], title: `sessione ${id}` });
        const { spec } = await writeAnalysis(total, totalSource, config.extractDir, { sessionDirs: [...previous, dir], title: 'tutte le sessioni' });
        if (final) summarize(spec);
        else log.tag('estratto', color('grey', `aggiornato in ${Date.now() - t0} ms`));
      } catch (err) { log.warn(`analisi fallita: ${err.message}`); }
    })();
    await writing;
    writing = null;
  };
  const analysisTimer = config.analysisMs > 0 ? setInterval(() => writeAll(), config.analysisMs) : null;

  // --- stato a terminale ---
  const statusTimer = config.statusMs > 0 ? setInterval(() => {
    const sec = config.statusMs / 1000;
    const ctx = total.ctx;
    const snap = ctx?.prevSnap;
    const me = snap && ctx.ownId ? snap.players.get(ctx.ownId) : null;
    const cov = total.byId.coverage.status(total);
    const parts = [
      color('grey', humanDuration(Date.now() - startedAt)),
      `state ${(win.state / sec).toFixed(1)} Hz`,
      `↓ ${humanBytes(win.bytes / sec)}/s`,
      snap ? `vivi ${snap.alive.length} · r ${Math.round(snap.r)} · cibo ${snap.foods.length}` : color('grey', 'nessuno snapshot'),
      me?.alive ? color('cyan', `tu: taglia ${me.size} boost ${(me.boostAmount ?? 0).toFixed(2)} $${Number(me.balance ?? 0).toFixed(2)}`) : color('grey', 'tu: fuori partita'),
      `copertura ${cov.filter((c) => c.ok).length}/${cov.length}`,
      color('grey', `file ${humanBytes(store.compressedBytes)}`),
    ];
    log.raw(`  ${parts.join(' · ')}`);
    win.state = 0; win.frames = 0; win.bytes = 0;
  }, config.statusMs) : null;

  const showCoverage = () => {
    for (const c of total.byId.coverage.status(total)) {
      log.raw(c.ok ? `    ${color('green', '✓')} ${c.label}` : `    ${color('grey', '·')} ${c.label} ${color('grey', `— ${c.how}`)}`);
    }
  };

  // --- chiusura ---
  let closing = false;
  const shutdown = async (why) => {
    if (closing) { log.warn('uscita forzata'); process.exit(1); }
    closing = true;
    log.raw('');
    log.info(`chiusura (${why})…`);
    clearInterval(analysisTimer); clearInterval(statusTimer);
    clearTimeout(autoStop);
    rec.stop();
    await store.close();
    await writeSessionMeta(dir, {
      formato: 1, id, inizio: new Date(startedAt).toISOString(), fine: new Date().toISOString(),
      url: config.targetUrl, browser: chrome.exe ?? null, contatori: rec.counters, file: store.stats,
    });
    await writeAll(true);
    try { cdp.close(); } catch { /* gia' chiuso */ }
    if (launched && config.closeBrowserOnExit) await closeChrome(chrome.proc);
    log.ok(`sessione: ${path.relative(process.cwd(), dir)}`);
    log.ok(`estratto: ${path.relative(process.cwd(), config.extractDir)}/  (parti da simulatore.json)`);
    rl.close();
    process.exit(0);
  };
  const autoStop = config.autoStopMs > 0 ? setTimeout(() => shutdown('tempo scaduto'), config.autoStopMs) : null;
  cdp.on('disconnected', () => { if (!closing) shutdown('Chrome chiuso'); });
  process.on('SIGINT', () => shutdown('CTRL+C'));
  rl.on('SIGINT', () => shutdown('CTRL+C'));

  rl.on('line', (line) => {
    const [c, ...rest] = line.trim().split(/\s+/);
    switch ((c ?? '').toLowerCase()) {
      case 's': case 'stato':
        log.raw(`  frame ${rec.counters.framesIn}↓ ${rec.counters.framesOut}↑ · http ${rec.counters.http} · script ${rec.counters.scripts} · socket ${rec.counters.sockets} · errori ${rec.counters.errors}`);
        showCoverage();
        break;
      case 'c': case 'copertura': showCoverage(); break;
      case 'm': rec.mark(rest.join(' ') || 'marcatore'); log.ok('marcatore inserito'); break;
      case 'a': case 'analizza': writeAll().then(() => log.ok('estratto aggiornato')); break;
      case 'q': case 'esci': shutdown('richiesta'); break;
      case 'h': case 'aiuto': log.raw('  s stato · c copertura · m <nota> · a analizza ora · q esci'); break;
      case '': break;
      default: log.warn(`comando sconosciuto: ${c}`);
    }
  });
}

/** Messaggi di routine: non vale la pena segnalarli quando compaiono. */
const ROUTINE = new Set(['state', 'input', 'ping', 'pong', 'auth', 'auth_ok', 'init', 'join', 'join_ok', 'user_flags', 'tutorial_status', 'xp_update']);

/** Eventi di gioco degni di una riga mentre si gioca. */
function printEvent(ev) {
  const t = ev.type;
  if (t === 'nuovo_messaggio') { if (!ROUTINE.has(ev.t)) log.tag('proto', `${ev.dir}: ${bold(ev.t)} ${color('magenta', '(primo messaggio di questo tipo)')}`); }
  else if (t === 'morte') log.tag('gioco', `morte: ${ev.nome} (taglia ${ev.taglia}, saldo ${ev.saldo})`);
  else if (t === 'morte_propria') log.tag('gioco', color('yellow', `sei morto: ${ev.causa ?? '?'}${ev.da ? ` (da ${ev.da})` : ''}`));
  else if (t === 'nascita_propria') log.tag('gioco', color('cyan', `in partita: taglia ${ev.taglia}, saldo ${ev.saldo}`));
  else if (t === 'cashout') log.tag('gioco', color('green', `cashout: pagati ${ev.pagato} $, trattenuti ${ev.trattenuto} $`));
  else if (t === 'rain_started' || t === 'rain_ended') log.tag('gioco', color('magenta', t));
  else if (t === 'marcatore') log.tag('nota', ev.label);
}

/** Le righe principali della specifica a fine analisi. */
function summarize(spec) {
  const p = spec.parametri;
  const v = (k) => {
    const x = p[k];
    if (!x || x.valore === null || x.valore === undefined) return color('grey', '–');
    const s = typeof x.valore === 'object' ? JSON.stringify(x.valore) : String(x.valore);
    const tag = x.verdetto === 'smentito' ? color('yellow', ' (il client dice altro)') : x.fonte !== 'misura' ? color('grey', ' (non misurato)') : '';
    return `${s}${x.unita ? ` ${x.unita}` : ''}${tag}`;
  };
  log.raw('');
  for (const [k, label] of [
    ['tempo.tickHzMisurato', 'frequenza vera del server'], ['movimento.passoBase', 'passo base'], ['movimento.passoBoost', 'passo in boost'],
    ['movimento.sterzataMaxPerTick', 'sterzata massima'], ['boost.costo', 'costo del boost'], ['cibo.inCampoDentroMuro', 'cibo dentro il muro'],
    ['arena.raggioPerSerpente', 'raggio per serpente'], ['cashout.tick', 'durata del cashout'], ['economia.rakeCashout', 'commissione'],
  ]) log.raw(`    ${label.padEnd(28)} ${v(k)}`);
  const smentiti = Object.entries(p).filter(([, x]) => x.verdetto === 'smentito').map(([k]) => k);
  if (smentiti.length) log.raw(color('yellow', `\n    il sorgente del client e' smentito dal server su: ${smentiti.join(', ')}`));
  log.raw('');
}
