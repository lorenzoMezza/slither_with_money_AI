/**
 * Analisi statica del sorgente del client.
 *
 * Il client di moneyslither non e' offuscato e dichiara da se' la provenienza
 * del proprio codice: «Server constants - copied exactly from server.js»,
 * «MOVEMENT (server stepMovement port)», «COLLISIONS (server port)». Quelle
 * parti sono la copia piu' fedele delle regole del server che esista fuori dal
 * server, e questo modulo le estrae con la loro etichetta di affidabilita':
 *
 *  - costanti (con il blocco che le contiene e quindi quanto fidarsene);
 *  - le sezioni marcate, copiate per intero;
 *  - le funzioni della fisica, una per file;
 *  - i default delle impostazioni sovrascrivibili dal server (`_gameSettings`);
 *  - il protocollo visto dal client: tipi inviati con i loro campi, tipi gestiti;
 *  - endpoint HTTP e WebSocket, chiavi di localStorage, globali dichiarate.
 *
 * Il sorgente dice cosa il client CREDE; le misure sul traffico dicono cosa il
 * server FA. Il confronto fra le due cose sta in analysis/spec.js.
 */
import path from 'node:path';
import { beautify, blockAfter, lineOf, matchBrace } from './scan.js';

/**
 * Marcatori di blocco e affidabilita' di cio' che segue. Vince il piu' vicino
 * che precede. I marcatori `local` sono commenti puntuali (MS_PRACTICE_*): valgono
 * solo per le righe subito dopo, non per tutto il file che segue.
 */
const BLOCKS = [
  { re: /Server constants\s*-\s*copied exactly from server\.js/gi, tag: 'server-copia', conf: 0.97, meaning: 'dichiarate copia esatta di server.js' },
  { re: /=====\s*MOVEMENT\s*\(server stepMovement port\)\s*=====/gi, tag: 'server-movimento', conf: 0.97, meaning: 'port dichiarato della fisica del server' },
  { re: /=====\s*COLLISIONS\s*\(server port\)\s*=====/gi, tag: 'server-collisioni', conf: 0.97, meaning: 'port dichiarato delle collisioni del server' },
  { re: /=====\s*SNAPSHOT BUILDER[^=]*=====/gi, tag: 'server-snapshot', conf: 0.9, meaning: 'formato snapshot dichiarato conforme al server' },
  { re: /MS_PRACTICE_(?:SYNC|DEFAULTS)_V\d+/g, tag: 'default-live', conf: 0.9, meaning: 'default dei valori live, sovrascritti da user_flags', local: 1500 },
  { re: /=====\s*(?:KILL \/ DEATH|FOOD|SNAKE CONSTRUCTION|TICK|START \/ STOP)\s*=====/gi, tag: 'pratica', conf: 0.6, meaning: 'simulazione locale di pratica: non prova nulla sul server' },
  { re: /=====\s*BOT (?:AI|SPAWN)\s*=====/gi, tag: 'bot-locali', conf: 0.4, meaning: 'bot della pratica locale' },
  { re: /=====\s*END CLIENT-SIDE PRACTICE MODE SIMULATION\s*=====/gi, tag: 'fuori-sim', conf: 0.5, meaning: 'fuori dalla simulazione' },
  { re: /=====\s*MONEY RAIN[^=]*=====/gi, tag: 'money-rain', conf: 0.6, meaning: 'modulo client del money rain' },
];

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?`;
const SETTING_PREFIX = 'combat|cashout|boost|magnet|food|world|arena|map|tick|turn|speed|hitbox|loot|drop|rain|spawn|bounty';

/**
 * Funzioni da estrarre: tutte quelle dentro i blocchi marcati della simulazione,
 * piu' quelle che fuori da li' hanno un nome da regola di gioco.
 */
const SIM_BLOCKS = new Set(['server-copia', 'server-movimento', 'server-collisioni', 'server-snapshot', 'default-live', 'pratica']);
const PHYSICS_FN = /^(?:segmentsFor|thicknessFor|step[A-Z]|checkCollision|kill[A-Z]|spawnFood|spawnRandomFood|topUpFood|buildSnap|simTick|maxSizeFor|proportionalGain|makeSnake|angleNormalize|interp|lerp|predict|applyInput|updateCamera)/;

export function analyzeScript({ url, rel, text }) {
  const src = text;
  const cache = {};
  const at = (i) => lineOf(src, i, cache);
  const blockIndex = buildBlockIndex(src);
  const blockAt = (i) => {
    let best = { tag: 'non-marcato', conf: 0.5, meaning: 'nessun marcatore di provenienza' };
    let local = null;
    for (const b of blockIndex) {
      if (b.at > i) break;
      if (b.local) { if (i - b.at <= b.local) local = b; } else best = b;
    }
    return local ?? best;
  };

  const out = {
    url, rel, name: path.basename(rel ?? url ?? 'script'),
    length: src.length,
    minified: maxLineLength(src) > 1500,
    markers: [], sections: [], constants: [], functions: [], settingsDefaults: [],
    settingsKeys: [], messagesSent: [], messagesHandled: [], endpoints: [], storageKeys: [],
    declarations: [],
  };

  // --- marcatori e sezioni ---------------------------------------------------------
  const sectionRe = /\/\/\s*=====\s*([^=\n]{2,100}?)\s*=====/g;
  const heads = [];
  let m;
  while ((m = sectionRe.exec(src)) !== null) heads.push({ at: m.index, end: m.index + m[0].length, title: m[1].trim() });
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].at : Math.min(src.length, h.at + 200_000);
    out.sections.push({ title: h.title, line: at(h.at), block: blockAt(h.end).tag, text: src.slice(h.at, end) });
  });
  const msRe = /\/\*\s*(MS_[A-Z0-9_]+)([^*]{0,200})\*\//g;
  while ((m = msRe.exec(src)) !== null) out.markers.push({ marker: m[1], note: m[2].trim().replace(/^[-\s]+/, ''), line: at(m.index) });
  for (const h of heads) out.markers.push({ marker: h.title, line: at(h.at) });

  // --- costanti ----------------------------------------------------------------------
  const seen = new Map();
  const addConst = (name, raw, index, kind) => {
    const value = kind === 'number' ? Number(raw) : raw;
    if (kind === 'number' && !Number.isFinite(value)) return;
    const b = blockAt(index);
    const conf = b.tag === 'non-marcato' && /practice|tutorial|bot/i.test(src.slice(Math.max(0, index - 80), index + 80)) ? 0.4 : b.conf;
    const rec = {
      name, value, kind, line: at(index), block: b.tag, blockMeaning: b.meaning, confidence: conf,
      context: src.slice(Math.max(0, index - 50), index + 90).replace(/\s+/g, ' ').trim(),
    };
    const prev = seen.get(name);
    if (!prev) { seen.set(name, { ...rec, occurrences: 1, others: [] }); return; }
    prev.occurrences += 1;
    if (prev.value !== value) prev.others.push({ value, line: rec.line, block: rec.block });
    if (conf > prev.confidence) Object.assign(prev, rec, { occurrences: prev.occurrences, others: prev.others });
  };
  const patterns = [
    [new RegExp(String.raw`(?:const|let|var)\s+([A-Z][A-Z0-9_]{1,40})\s*=\s*(${NUM})\s*(?=[;,)\n])`, 'g'), 'number'],
    [new RegExp(String.raw`(?<![\w.$])([A-Z][A-Z0-9_]{3,40})\s*=\s*(${NUM})\s*[,;)\n]`, 'g'), 'number'],
    [new RegExp(String.raw`\b((?:${SETTING_PREFIX})[A-Za-z0-9_]{2,40})\s*:\s*(${NUM})(?![\w.])`, 'g'), 'number'],
    [/\b((?:combat|cashout|boost|rain)[A-Za-z0-9_]{2,40}|bodyStyle)\s*:\s*['"]([\w-]{1,40})['"]/g, 'string'],
    [/(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,40})\s*=\s*['"]([^'"\n]{1,80})['"]/g, 'string'],
  ];
  for (const [re, kind] of patterns) {
    while ((m = re.exec(src)) !== null) addConst(m[1], m[2], m.index, kind);
  }
  // Default "typeof x === 'number' ? x : 1.07": il letterale dopo i due punti e' il default.
  const defRe = new RegExp(String.raw`typeof\s+[\w$.]+\.(\w+)\s*===?\s*['"]number['"]\s*\)?\s*\?\s*[\w$.]+\s*:\s*(${NUM})`, 'g');
  while ((m = defRe.exec(src)) !== null) addConst(m[1], m[2], m.index, 'number');
  const defStrRe = /[\w$]+\.(\w+)\s*\|\|\s*['"]([\w-]{2,40})['"]/g;
  while ((m = defStrRe.exec(src)) !== null) if (/^(combat|cashout|rain)/.test(m[1])) addConst(m[1], m[2], m.index, 'string');
  out.constants = [...seen.values()].sort((a, b) => b.confidence - a.confidence || a.line - b.line);

  // --- default delle impostazioni live ------------------------------------------------
  const settingsRe = /window\.(_gameSettings|_renderSettings)\s*=\s*\{/g;
  while ((m = settingsRe.exec(src)) !== null) {
    const blk = blockAfter(src, m.index + m[0].length - 1);
    if (!blk) continue;
    out.settingsDefaults.push({ object: m[1], line: at(m.index), text: blk.text, value: looseJson(blk.text) });
  }
  const keyRe = new RegExp(String.raw`\b(_gs|gameSettings|combatSettings|renderSettings|_renderSettings|_gameSettings)\.((?:${SETTING_PREFIX}|tube|outline|highlight|body)[A-Za-z0-9_]*)`, 'g');
  const keys = new Set();
  while ((m = keyRe.exec(src)) !== null) keys.add(m[2]);
  out.settingsKeys = [...keys].sort();

  // --- funzioni -----------------------------------------------------------------------
  const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]{0,200})\)\s*\{/g;
  while ((m = fnRe.exec(src)) !== null) {
    const name = m[1];
    if (!SIM_BLOCKS.has(blockAt(m.index).tag) && !PHYSICS_FN.test(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close < 0 || close - m.index > 60_000) continue;
    out.functions.push({ name, params: m[2].trim(), line: at(m.index), block: blockAt(m.index).tag, text: src.slice(m.index, close + 1) });
  }

  // --- protocollo visto dal client -----------------------------------------------------
  const sent = new Map();
  const sentRe = /\{\s*t\s*:\s*["']([a-z][a-z0-9_]{1,40})["']/g;
  while ((m = sentRe.exec(src)) !== null) {
    const close = matchBrace(src, m.index);
    const lit = close > 0 && close - m.index < 3000 ? src.slice(m.index, close + 1) : src.slice(m.index, m.index + 200);
    const fields = [...lit.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
    const rec = sent.get(m[1]) ?? { type: m[1], fields: new Set(), examples: [], lines: [] };
    fields.forEach((f) => rec.fields.add(f));
    if (rec.examples.length < 3) rec.examples.push(lit.replace(/\s+/g, ' ').slice(0, 400));
    rec.lines.push(at(m.index));
    sent.set(m[1], rec);
  }
  out.messagesSent = [...sent.values()].map((r) => ({ ...r, fields: [...r.fields], lines: r.lines.slice(0, 10) }));

  const handled = new Map();
  const handledRes = [
    /["']([a-z][a-z0-9_]{1,40})["']\s*===?\s*[\w$]+\.t\b/g,
    /[\w$]+\.t\s*===?\s*["']([a-z][a-z0-9_]{1,40})["']/g,
    /\bcase\s*["']([a-z][a-z0-9_]{1,40})["']\s*:/g,
  ];
  for (const re of handledRes) {
    while ((m = re.exec(src)) !== null) {
      const rec = handled.get(m[1]) ?? { type: m[1], lines: [], snippet: src.slice(m.index, m.index + 700).replace(/\s+/g, ' ') };
      rec.lines.push(at(m.index));
      handled.set(m[1], rec);
    }
  }
  out.messagesHandled = [...handled.values()].map((r) => ({ ...r, lines: r.lines.slice(0, 10) }));

  // --- endpoint, storage, dichiarazioni -------------------------------------------------
  const eps = new Set();
  for (const re of [/["'`](\/api\/[\w\-/.?=&%]*)/g, /["'`](wss?:\/\/[^"'`\s]+)/g, /["'`](https?:\/\/[^"'`\s]{4,200})/g]) {
    while ((m = re.exec(src)) !== null) eps.add(m[1]);
  }
  if (/new WebSocket\(/.test(src)) {
    const i = src.indexOf('new WebSocket(');
    eps.add(`WebSocket: ${src.slice(i, i + 220).replace(/\s+/g, ' ')}`);
  }
  out.endpoints = [...eps].sort();
  const store = new Set();
  const stRe = /localStorage\.(?:getItem|setItem|removeItem)\(\s*["'`]([^"'`]{1,80})/g;
  while ((m = stRe.exec(src)) !== null) store.add(m[1]);
  out.storageKeys = [...store].sort();
  const declRe = /^(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm;
  const decl = new Set();
  while ((m = declRe.exec(src)) !== null) decl.add(m[1]);
  out.declarations = [...decl].sort();

  return out;
}

/** Versione leggibile di un file minificato (null se non serve). */
export function readableVersion(text) {
  return maxLineLength(text) > 1500 ? beautify(text) : null;
}

function buildBlockIndex(src) {
  const hits = [];
  for (const b of BLOCKS) {
    const re = new RegExp(b.re.source, b.re.flags);
    let m;
    while ((m = re.exec(src)) !== null) hits.push({ at: m.index, tag: b.tag, conf: b.conf, meaning: b.meaning, local: b.local ?? 0 });
  }
  return hits.sort((a, b) => a.at - b.at);
}

function maxLineLength(text) {
  let max = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i - start > max) max = i - start;
      start = i + 1;
    }
  }
  return max;
}

/** Converte un letterale oggetto JS semplice in JSON; null se non ci riesce. */
export function looseJson(text) {
  try {
    const json = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'([^'\\]*)'/g, (_m, s) => JSON.stringify(s))
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/:\s*!0\b/g, ':true').replace(/:\s*!1\b/g, ':false')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(json);
  } catch { return null; }
}

/**
 * Unisce le analisi di piu' script in una vista sola. Dove lo stesso nome
 * compare in piu' file vince l'occorrenza piu' affidabile, e le altre restano
 * come varianti: e' cosi' che si nota un client aggiornato fra due sessioni.
 */
export function mergeScripts(analyses) {
  const constants = new Map();
  const sent = new Map();
  const handled = new Map();
  const settings = new Map();
  const keys = new Set();
  const endpoints = new Set();
  const storage = new Set();
  for (const a of analyses) {
    for (const c of a.constants) {
      const prev = constants.get(c.name);
      const rec = { ...c, file: a.rel ?? a.url };
      if (!prev) { constants.set(c.name, { ...rec, variants: [] }); continue; }
      if (prev.value !== c.value) prev.variants.push({ value: c.value, file: rec.file, line: c.line, block: c.block });
      if (c.confidence > prev.confidence) constants.set(c.name, { ...rec, variants: prev.variants });
    }
    for (const s of a.messagesSent) {
      const prev = sent.get(s.type) ?? { type: s.type, fields: new Set(), examples: [], files: new Set() };
      s.fields.forEach((f) => prev.fields.add(f));
      for (const e of s.examples) if (prev.examples.length < 3 && !prev.examples.includes(e)) prev.examples.push(e);
      prev.files.add(a.name);
      sent.set(s.type, prev);
    }
    for (const h of a.messagesHandled) {
      const prev = handled.get(h.type) ?? { type: h.type, snippet: h.snippet, files: new Set() };
      prev.files.add(a.name);
      handled.set(h.type, prev);
    }
    for (const d of a.settingsDefaults) if (!settings.has(d.object) || d.value) settings.set(d.object, { ...d, file: a.name });
    a.settingsKeys.forEach((k) => keys.add(k));
    a.endpoints.forEach((e) => endpoints.add(e));
    a.storageKeys.forEach((k) => storage.add(k));
  }
  return {
    constants: [...constants.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name)),
    messagesSent: [...sent.values()].map((s) => ({ ...s, fields: [...s.fields], files: [...s.files] })).sort((a, b) => a.type.localeCompare(b.type)),
    messagesHandled: [...handled.values()].map((h) => ({ ...h, files: [...h.files] })).sort((a, b) => a.type.localeCompare(b.type)),
    settingsDefaults: [...settings.values()],
    settingsKeys: [...keys].sort(),
    endpoints: [...endpoints].sort(),
    storageKeys: [...storage].sort(),
  };
}
