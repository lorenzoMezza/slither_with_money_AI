/**
 * Il modello del sorgente: le costanti e le funzioni della fisica estratte dal
 * client, rese ESEGUIBILI in una sandbox (node:vm, senza accesso a nulla).
 *
 * Cosi' le misure si confrontano con il codice vero del client in uso, non con
 * una formula ricopiata a mano che diventerebbe falsa al primo aggiornamento:
 * se domani `thicknessForSegments` cambia, il confronto cambia con lei.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { analyzeScript, mergeScripts } from './extract.js';

/** Funzioni pure che vale la pena rendere eseguibili. */
const CALLABLE = ['angleNormalize', 'segmentsForSize', 'thicknessForSegments', 'proportionalGain', 'maxSizeForBalance'];

/** Raccolta degli script del gioco visti, analizzati una volta sola per contenuto. */
export class SourceIndex {
  constructor(gameHosts) {
    this.gameHosts = gameHosts;
    this.analyses = new Map();   // sha -> analisi (con il testo, per le versioni leggibili)
  }

  isGameScript(url) {
    if (!url) return false;
    const m = /^inline:(.*)#/.exec(url);
    const target = m ? m[1] : url;
    try {
      const host = new URL(target).hostname;
      return this.gameHosts.some((h) => host === h || host.endsWith(`.${h}`));
    } catch { return false; }
  }

  add({ url, rel, sha, text }) {
    if (!text || this.analyses.has(sha) || !this.isGameScript(url)) return null;
    const a = analyzeScript({ url, rel, text });
    a.sha = sha;
    a.text = text;
    this.analyses.set(sha, a);
    return a;
  }

  /** Rilegge gli script salvati di una sessione. */
  loadSession(dir) {
    const idx = path.join(dir, 'sorgente', 'script.ndjson');
    if (!fs.existsSync(idx)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(idx, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      const file = path.join(dir, rec.rel);
      if (!fs.existsSync(file)) continue;
      if (this.add({ url: rec.url, rel: rec.rel, sha: rec.sha, text: fs.readFileSync(file, 'utf8') })) n += 1;
    }
    return n;
  }

  get list() { return [...this.analyses.values()]; }
  merged() { return mergeScripts(this.list); }
}

export function buildSourceModel(index) {
  const list = index.list;
  const merged = mergeScripts(list);
  const consts = {};
  for (const c of merged.constants) if (c.confidence >= 0.5 && !(c.name in consts)) consts[c.name] = c.value;
  // I default delle impostazioni live, appiattiti: combatHitboxScale, mapBaseRadius, ...
  const gs = merged.settingsDefaults.find((d) => d.object === '_gameSettings')?.value;
  const settings = gs ? { ...gs, ...(gs.combatSettings ?? {}) } : {};
  delete settings.combatSettings;

  // Le funzioni: vince la copia nel blocco piu' affidabile.
  const rank = { 'server-movimento': 5, 'server-collisioni': 5, 'server-copia': 5, 'server-snapshot': 4, 'default-live': 3, pratica: 2 };
  const fnText = new Map();
  for (const a of list) {
    for (const f of a.functions) {
      const prev = fnText.get(f.name);
      if (!prev || (rank[f.block] ?? 0) > (rank[prev.block] ?? 0)) fnText.set(f.name, { ...f, file: a.rel });
    }
  }

  const sandbox = { Math, Number, Infinity, NaN, isFinite, parseFloat, parseInt };
  for (const [k, v] of Object.entries(consts)) if (/^[A-Z_][A-Z0-9_]*$/.test(k)) sandbox[k] = v;
  const context = vm.createContext(sandbox);
  const fn = {};
  const fnErrors = {};
  for (const name of CALLABLE) {
    const f = fnText.get(name);
    if (!f) continue;
    try {
      vm.runInContext(f.text, context, { timeout: 100 });
      const ref = context[name];
      if (typeof ref === 'function') fn[name] = (...args) => ref(...args);
    } catch (err) { fnErrors[name] = String(err.message); }
  }

  // Letterali che non hanno un nome ma decidono una regola.
  const derived = {};
  const step = fnText.get('stepMovement')?.text ?? '';
  const pow = /Math\.pow\(\s*t\s*,\s*([\d.]+)\s*\)/.exec(step);
  if (pow) derived.cashoutExponent = Number(pow[1]);
  const wall = /thickness\s*\*\s*([\d.]+)\s*;[\s\S]{0,200}?world\.r/.exec(step) ?? /actualHeadRadius\s*=\s*\w+\.thickness\s*\*\s*([\d.]+)/.exec(step);
  if (wall) derived.wallHeadFactor = Number(wall[1]);
  const drain = /maxPerTick\s*=\s*([\d.]+)\s*\+\s*\w+\.size\s*\*\s*([\d.]+)/.exec(step);
  if (drain) derived.growthDrainPerTick = { base: Number(drain[1]), perSize: Number(drain[2]) };
  const orb = /radius\s*:\s*[^?]*\?\s*([\d.]+)\s*:\s*([\d.]+)/.exec(fnText.get('spawnFoodAt')?.text ?? '');
  if (orb) derived.orbRadius = { gold: Number(orb[1]), normal: Number(orb[2]) };
  if (fn.proportionalGain) {
    try { derived.gainExponent = Math.log(fn.proportionalGain(200, 1) / fn.proportionalGain(100, 1)) / Math.log(2); } catch { /* ignora */ }
  }
  const kill = fnText.get('killPlayer')?.text ?? '';
  const ks = /step\s*=\s*Math\.max\(\s*(\d+)\s*,\s*Math\.floor\(\s*\w+\.numSegments\s*\/\s*(\d+)\s*\)\s*\)/.exec(kill);
  if (ks) derived.lootStep = { min: Number(ks[1]), divisor: Number(ks[2]) };

  return {
    merged, consts, settings, fn, fnErrors, derived,
    functions: [...fnText.values()].map(({ text, ...meta }) => ({ ...meta, length: text.length })),
    fnText,
    tickOrder: tickOrder(fnText),
  };
}

/**
 * L'ordine delle operazioni in un tick, dai commenti del port del server: e'
 * l'ordine in cui il codice le esegue, e invertirne due cambia le traiettorie.
 */
function tickOrder(fnText) {
  const out = [];
  for (const name of ['simTick', 'stepMovement', 'checkCollisions']) {
    const f = fnText.get(name);
    if (!f) continue;
    const steps = [];
    const re = /\/\/\s*([^\n]{3,120})|\b(stepTurning|stepMovement|checkCollisions|topUpFood|killPlayer|runBotBrain|buildSnap)\s*\(/g;
    re.lastIndex = f.text.indexOf('{') + 1;    // la firma della funzione non e' un passo
    let m;
    while ((m = re.exec(f.text)) !== null) {
      const s = (m[1] ?? `chiama ${m[2]}()`).trim();
      if (steps[steps.length - 1] !== s) steps.push(s);
    }
    out.push({ funzione: name, blocco: f.block, file: f.file, riga: f.line, passi: steps });
  }
  return out;
}
