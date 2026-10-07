/**
 * Scrive la cartella dell'estratto: tutto cio' che serve a ricostruire il
 * gioco, in forma leggibile (Markdown) e macchina-leggibile (JSON).
 *
 *   estratto/
 *     LEGGIMI.md            cosa c'e' e da dove partire
 *     simulatore.json       ogni parametro: valore, fonte, verdetto  <- il simulatore parte da qui
 *     SIMULATORE.md         la stessa cosa da leggere, con formule e ordine del tick
 *     MISURE.md / misure.json   ogni misura con metodo, campione e tabelle
 *     PROTOCOLLO.md / protocollo.json   ogni messaggio, campo per campo
 *     COPERTURA.md          cosa manca ancora da osservare
 *     eventi.ndjson         cronologia degli eventi di gioco riconosciuti
 *     sorgente/             costanti, sezioni «server port», funzioni, file leggibili
 *     runtime/              impostazioni live del server e globali del client
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readableVersion } from '../source/extract.js';
import { sanitize } from '../capture/store.js';
import { fmt } from '../analysis/stats.js';

const show = (v) => {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number' || typeof v === 'boolean') return fmt(v, 6);
  if (typeof v === 'string') return v;
  return `\`${JSON.stringify(v)}\``;
};
const cell = (v) => show(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (cols, rows) => (rows.length
  ? `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n${rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')}\n`
  : '_nessun dato_\n');

async function write(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

export async function writeExtract(dir, { report, spec, protocol, model, sourceIndex, runtime, globals, title }) {
  await fsp.mkdir(dir, { recursive: true });
  const sessions = report.sessions;
  const header = `_${title} · generato ${new Date().toLocaleString('it-IT')} · ${sessions.length} sessioni, ${sessions.reduce((a, s) => a + (s.snapshots ?? 0), 0)} snapshot_\n`;

  // --- simulatore -------------------------------------------------------------------
  await write(path.join(dir, 'simulatore.json'), spec);
  const groups = new Map();
  for (const [k, p] of Object.entries(spec.parametri)) {
    const g = k.split('.')[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([k, p]);
  }
  let md = `# Specifica per il simulatore\n\n${header}\n`;
  md += 'Ogni riga e\' un parametro del gioco. **Valore** e\' quello da usare. **Fonte**: `misura` = misurato sul traffico del server vero; `live` = impostazione mandata dal server; `sorgente` = letto dal client e NON verificato. **Verdetto** confronta la misura con il sorgente: dove dice _smentito_ il client mente, e vale la misura.\n\n';
  for (const [g, rows] of groups) {
    md += `## ${g}\n\n`;
    md += table(['parametro', 'valore', 'unità', 'fonte', 'sorgente', 'verdetto', 'n'],
      rows.map(([k, p]) => [k.slice(g.length + 1), p.valore, p.unita ?? '', p.fonte ?? '', p.sorgente ? `${show(p.sorgente.valore)} (${p.sorgente.come})` : '', p.verdetto ?? '', p.n ?? '']));
    md += '\n';
  }
  md += `## Formule\n\n${spec.formule.map((f) => `- ${f}`).join('\n')}\n\n`;
  md += '## Ordine delle operazioni nel tick (dal port del server nel client)\n\n';
  for (const t of spec.ordineTick) md += `**${t.funzione}()** — ${t.file}:${t.riga} (blocco ${t.blocco})\n\n${t.passi.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n`;
  if (!spec.ordineTick.length) md += '_sorgente non ancora catturato_\n\n';
  md += `## Impostazioni live\n\n\`\`\`json\n${JSON.stringify(spec.impostazioniLive, null, 2)}\n\`\`\`\n\n`;
  md += `## Funzioni del client rese eseguibili\n\n${spec.funzioniEseguibili.map((f) => `\`${f}\``).join(', ') || '_nessuna_'}: il codice e\' in \`sorgente/funzioni/\`, ed e\' quello da copiare nel simulatore.\n`;
  await write(path.join(dir, 'SIMULATORE.md'), md);

  // --- misure -------------------------------------------------------------------------
  await write(path.join(dir, 'misure.json'), { sessioni: sessions, sezioni: report.sections });
  let mm = `# Misure\n\n${header}\n`;
  for (const s of report.sections) {
    if (s.id === 'protocollo') continue;
    mm += `## ${s.title}\n\n${s.intro ? `${s.intro}\n\n` : ''}`;
    if (s.error) mm += `> errore nel modulo: \`${s.error.split('\n')[0]}\`\n\n`;
    if (s.items.length) {
      mm += table(['misura', 'valore', 'unità', 'n', 'stato', 'come'], s.items.map((i) => [i.label, i.value, i.unit ?? '', i.n ?? '', i.status, i.detail ?? '']));
      mm += '\n';
    }
    for (const t of s.tables) mm += `**${t.title}**\n\n${table(t.columns, t.rows)}\n`;
    for (const n of s.notes) mm += `> ${n}\n\n`;
  }
  mm += `## Sessioni\n\n${table(['sessione', 'inizio', 'durata s', 'snapshot', 'nome in gioco', 'tick dichiarato'], sessions.map((x) => [x.name, x.start, x.durationS, x.snapshots, x.ownName, x.declaredTickRate]))}`;
  await write(path.join(dir, 'MISURE.md'), mm);

  // --- protocollo ----------------------------------------------------------------------
  await write(path.join(dir, 'protocollo.json'), protocol);
  let pm = `# Protocollo\n\n${header}\n`;
  pm += `Socket: ${protocol.socket.map((s) => `\`${s.url}\`${s.game ? ' (gioco)' : ''}`).join(', ') || '–'}\n\n`;
  pm += `Trasporto: ${protocol.trasporto.frameBinari} frame binari, ${protocol.trasporto.frameTestoNonJson} frame di testo non JSON.\n\n`;
  pm += table(['direzione', 't', 'conteggio', 'Hz', 'byte medi'], protocol.messaggi.map((m) => [m.direzione, m.t, m.conteggio, m.hz ?? '–', m.byteMedi]));
  const sent = new Map((model?.merged.messagesSent ?? []).map((x) => [x.type, x]));
  const handled = new Set((model?.merged.messagesHandled ?? []).map((x) => x.type));
  const seen = new Set(protocol.messaggi.map((m) => m.t));
  const neverSeen = [...new Set([...sent.keys(), ...handled])].filter((t) => !seen.has(t)).sort();
  pm += `\nTipi che il client sa mandare o gestire ma che non sono ancora passati sul socket: ${neverSeen.map((t) => `\`${t}\``).join(', ') || 'nessuno'}.\n\n`;
  for (const m of protocol.messaggi) {
    pm += `## \`${m.t}\` (${m.direzione})\n\n${m.conteggio} messaggi · ${m.hz ?? '–'} Hz · ${m.byteMin}–${m.byteMax} byte\n\n`;
    pm += table(['campo', 'tipi', 'presenza', 'min', 'max', 'decimali', 'valori / esempi'],
      m.campi.slice(0, 120).map((c) => [c.campo, c.tipi.join('/'), `${Math.round(c.presenza * 100)} %`, c.min ?? '', c.max ?? '', c.decimaliMax ?? '',
        c.valori ? Object.keys(c.valori).slice(0, 8).join(', ') : c.esempi ? c.esempi.slice(0, 3).join(', ') : c.lunghezza ? `lunghezza ${c.lunghezza.min}–${c.lunghezza.max}` : c.elementi ? `${c.elementi.min}–${c.elementi.max} elementi` : '']));
    const src = sent.get(m.t);
    if (src) pm += `\nNel sorgente: campi \`${src.fields.join(', ')}\` — es. \`${src.examples[0]}\`\n`;
    pm += `\n\`\`\`json\n${JSON.stringify(m.esempio, null, 2).slice(0, 4000)}\n\`\`\`\n\n`;
  }
  await write(path.join(dir, 'PROTOCOLLO.md'), pm);

  // --- copertura ed eventi --------------------------------------------------------------
  const cov = report.sections.find((s) => s.id === 'copertura');
  await write(path.join(dir, 'COPERTURA.md'), `# Copertura\n\n${header}\n${cov ? table(cov.tables[0].columns, cov.tables[0].rows) : ''}\n${cov?.notes.join('\n') ?? ''}\n`);
  await write(path.join(dir, 'eventi.ndjson'), report.events.map((e) => JSON.stringify(e)).join('\n') + (report.events.length ? '\n' : ''));

  // --- sorgente --------------------------------------------------------------------------
  if (model && sourceIndex) await writeSource(path.join(dir, 'sorgente'), model, sourceIndex, header);

  // --- runtime ---------------------------------------------------------------------------
  await write(path.join(dir, 'runtime', 'impostazioni-live.json'), Object.fromEntries([...runtime.entries()]));
  if (globals) await write(path.join(dir, 'runtime', 'globali.json'), globals);

  await write(path.join(dir, 'LEGGIMI.md'), readme(header));
}

async function writeSource(dir, model, sourceIndex, header) {
  // La cartella si riscrive da capo: una sezione sparita dal client non deve restare.
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const merged = model.merged;
  await write(path.join(dir, 'costanti.json'), merged.constants);
  await write(path.join(dir, 'messaggi.json'), { inviati: merged.messagesSent, gestiti: merged.messagesHandled });
  await write(path.join(dir, 'endpoint.json'), { endpoint: merged.endpoints, localStorage: merged.storageKeys, impostazioni: merged.settingsKeys });
  await write(path.join(dir, 'impostazioni-default.json'), merged.settingsDefaults.map(({ text, ...r }) => ({ ...r, testo: text })));
  await write(path.join(dir, 'modello.json'), { costanti: model.consts, impostazioni: model.settings, derivati: model.derived, funzioni: model.functions, errori: model.fnErrors, ordineTick: model.tickOrder });

  const scripts = sourceIndex.list.sort((a, b) => b.length - a.length);
  const usedNames = new Set();
  const uniq = (n) => { let x = n; for (let i = 2; usedNames.has(x); i += 1) x = `${n}-${i}`; usedNames.add(x); return x; };
  const fileRows = [];
  for (const a of scripts) {
    const base = uniq(sanitize(a.name.replace(/\.js$/, ''), 60));
    for (const [i, s] of a.sections.entries()) {
      await write(path.join(dir, 'sezioni', `${base}__${String(i + 1).padStart(2, '0')}-${sanitize(s.title, 50)}.js`),
        `// ${s.title}\n// file: ${a.rel ?? a.url}  riga: ${s.line}  blocco: ${s.block}\n\n${s.text}\n`);
    }
    const readable = a.minified ? readableVersion(a.text) : null;
    if (readable) await write(path.join(dir, 'leggibile', `${base}.js`), `// versione leggibile di ${a.url}\n// (righe spezzate e rientrate: il codice e' identico)\n\n${readable}`);
    fileRows.push([a.name, a.url, a.length, a.minified ? 'sì' : 'no', a.sections.length, a.constants.length, a.functions.length]);
  }
  for (const [name, f] of model.fnText) {
    await write(path.join(dir, 'funzioni', `${sanitize(name)}.js`), `// ${name}() — ${f.file}:${f.line}, blocco «${f.block}»\n\n${f.text}\n`);
  }

  let md = `# Sorgente del client\n\n${header}\n`;
  md += 'Il client non e\' offuscato e dichiara da se\' la provenienza del codice. **Blocco** e\' il marcatore piu\' vicino che precede la riga: `server-*` = port dichiarato del server (affidabile), `default-live` = valori che il server sovrascrive con user_flags, `pratica` = simulazione locale (non prova nulla).\n\n';
  md += `## File analizzati\n\n${table(['file', 'url', 'byte', 'minificato', 'sezioni', 'costanti', 'funzioni'], fileRows)}\n`;
  md += `## Costanti\n\n${table(['nome', 'valore', 'blocco', 'affidabilità', 'riga', 'varianti', 'contesto'], merged.constants.map((c) => [c.name, c.value, c.block, c.confidence, `${c.file}:${c.line}`, c.variants?.length ? c.variants.map((v) => v.value).join(', ') : '', c.context.slice(0, 120)]))}\n`;
  md += `## Default delle impostazioni live\n\n${merged.settingsDefaults.map((d) => `\`window.${d.object}\` (${d.file}:${d.line})\n\n\`\`\`js\n${d.text}\n\`\`\``).join('\n\n') || '_nessuno_'}\n\nChiavi lette dal codice: ${merged.settingsKeys.map((k) => `\`${k}\``).join(', ')}\n\n`;
  md += `## Funzioni della fisica\n\n${table(['funzione', 'file', 'riga', 'blocco', 'byte'], model.functions.map((f) => [f.name, f.file, f.line, f.block, f.length]))}\n`;
  md += `## Messaggi che il client manda\n\n${table(['t', 'campi', 'esempio'], merged.messagesSent.map((m) => [m.type, m.fields.join(', '), m.examples[0] ?? '']))}\n`;
  md += `## Messaggi che il client gestisce\n\n${merged.messagesHandled.map((m) => `\`${m.type}\``).join(', ')}\n\n`;
  md += `## Endpoint\n\n${merged.endpoints.map((e) => `- \`${e}\``).join('\n')}\n\n## localStorage\n\n${merged.storageKeys.map((e) => `\`${e}\``).join(', ')}\n`;
  await write(path.join(dir, 'SORGENTE.md'), md);
}

function readme(header) {
  return `# Estratto di moneyslither.com

${header}
Questa cartella contiene tutto cio' che l'analizzatore ha ricavato dal gioco: le
regole e la fisica del server, misurate sul traffico e confrontate con il
sorgente del client. **Per costruire il simulatore si parte da \`simulatore.json\`.**

| file | contenuto |
|---|---|
| \`simulatore.json\` | ogni parametro con valore, fonte (misura / live / sorgente) e verdetto |
| \`SIMULATORE.md\` | gli stessi parametri da leggere, con le formule e l'ordine delle operazioni nel tick |
| \`MISURE.md\`, \`misure.json\` | ogni misura con il metodo, il campione e le tabelle di dettaglio |
| \`PROTOCOLLO.md\`, \`protocollo.json\` | ogni messaggio WebSocket, campo per campo, con precisione numerica ed esempi |
| \`COPERTURA.md\` | cosa e' gia' stato osservato e cosa manca, con l'azione che lo provoca |
| \`eventi.ndjson\` | gli eventi di gioco riconosciuti, in ordine |
| \`sorgente/\` | costanti con provenienza, sezioni «server port», funzioni della fisica, file minificati resi leggibili |
| \`runtime/\` | impostazioni live mandate dal server e globali del client |

I dati grezzi (ogni frame, ogni risposta HTTP, ogni script) stanno nelle
sessioni: \`sessioni/<id>/\`. Questa cartella si rigenera da quelli in qualunque
momento con \`node analizer.js analizza\`.
`;
}

export function latestGlobals(sessionDirs) {
  for (const d of [...sessionDirs].reverse()) {
    const f = path.join(d, 'runtime', 'globali.json');
    if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* prossima */ } }
  }
  return null;
}
