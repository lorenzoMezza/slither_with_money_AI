#!/usr/bin/env node
/**
 * Confronta due estratti di analizer: quello del server vero e quello di una
 * partita simulata (`simulatore registra`), misurati dallo STESSO analizzatore.
 *
 *   node strumenti/confronta.mjs <vero/simulatore.json> <simulato/simulatore.json>
 *
 * Per ogni parametro misurato in entrambi stampa i due valori e lo scarto.
 * Esce con codice 1 se uno dei parametri di fisica supera la sua tolleranza.
 */
import fs from 'node:fs';

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('uso: confronta.mjs <vero.json> <simulato.json>'); process.exit(2); }
const real = JSON.parse(fs.readFileSync(a, 'utf8')).parametri;
const sim = JSON.parse(fs.readFileSync(b, 'utf8')).parametri;

/** Tolleranza relativa dei parametri che DEVONO coincidere (fisica e regole). */
const STRICT = {
  'tempo.tickHzMisurato': 0.005,
  'movimento.passoBase': 0.001,
  'movimento.passoBoost': 0.001,
  'movimento.rampaBoostSalita': 0.01,
  'movimento.rampaBoostDiscesa': 0.01,
  'movimento.sterzataMaxPerTick': 0.01,
  'corpo.distanzaAnelli': 0.001,
  'cibo.inCampoDentroMuro': 0.05,
  'cibo.raggioRaccoltaNormale': 0.05,
  'cibo.guadagnoBase': 0.08,
  'cibo.guadagnoOro': 0.03,
  'cibo.raggioRaccoltaOro': 0.05,
  'arena.raggioBase': 0.001,
  'arena.raggioPerSerpente': 0.02,
  'arena.rilassamentoPerTick': 0.05,
  'cashout.durataMs': 0.01,
  'cashout.sterzataDurante': 0.0,
  'economia.rakeCashout': 0.001,
  'bottino.frazioneDelSaldo': 0.01,
  'nascita.tagliaIniziale': 0.0,
};

const fmt = (v) => {
  const s = v === null || v === undefined ? '–' : typeof v === 'number' ? String(Number(v.toPrecision(6))) : JSON.stringify(v);
  return s.length > 38 ? `${s.slice(0, 37)}…` : s;
};
let bad = 0;
const rows = [];
for (const [k, r] of Object.entries(real)) {
  const s = sim[k];
  if (!s || r.fonte !== 'misura' || s.fonte !== 'misura') continue;
  let verdict = '';
  if (typeof r.valore === 'number' && typeof s.valore === 'number') {
    const rel = Math.abs(s.valore - r.valore) / Math.max(Math.abs(r.valore), 1e-9);
    verdict = `${(rel * 100).toFixed(2)} %`;
    if (k in STRICT) {
      const ok = rel <= STRICT[k] + 1e-12;
      if (!ok) bad += 1;
      verdict += ok ? '  ✓' : `  ✗ (tolleranza ${(STRICT[k] * 100).toFixed(1)} %)`;
    }
  } else if (JSON.stringify(r.valore) === JSON.stringify(s.valore)) verdict = 'identico ✓';
  rows.push([k, fmt(r.valore), fmt(s.valore), verdict]);
}
const w = [0, 1, 2].map((i) => Math.max(...rows.map((x) => x[i].length), 10));
console.log(`\n  ${'parametro'.padEnd(w[0])}  ${'server vero'.padEnd(w[1])}  ${'simulatore'.padEnd(w[2])}  scarto`);
for (const x of rows) console.log(`  ${x[0].padEnd(w[0])}  ${x[1].padEnd(w[1])}  ${x[2].padEnd(w[2])}  ${x[3]}`);
console.log(bad ? `\n  ${bad} parametri fuori tolleranza\n` : '\n  tutti i parametri di fisica e regole entro tolleranza\n');
process.exit(bad ? 1 : 0);
