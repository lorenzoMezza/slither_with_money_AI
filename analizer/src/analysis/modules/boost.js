/**
 * Il costo del boost: quanta taglia si perde, e con che legge.
 *
 * Si misura solo su TRATTI PULITI: boost acceso senza interruzioni, nessun
 * cashout, e nessun orb abbastanza vicino da poter essere raccolto per tutta la
 * durata — cosi' la taglia puo' solo scendere. Poi si confrontano tre leggi
 * con i minimi quadrati, tutto contato in tick:
 *
 *   perdita = a·∫taglia·boost + b·∫boost      (due termini)
 *   perdita = a·∫taglia·boost                 (solo proporzionale)
 *   perdita = b·∫boost                        (solo costante)
 *
 * Il costo si paga in proporzione a `boostAmount`, cioe' anche sulla rampa.
 */
import { Section } from '../engine.js';
import { fit2 } from '../stats.js';

const MARGIN = 40;

export function createBoost() {
  const open = new Map();
  const runs = [];

  const close = (id) => {
    const r = open.get(id);
    open.delete(id);
    if (r && r.ticks >= 15 && r.integral > 0.1 && r.to <= r.from && runs.length < 20_000) runs.push(r);
  };

  return {
    id: 'boost',
    beginSession() { for (const id of [...open.keys()]) close(id); },
    onState(snap, pair) {
      const ticks = pair?.ok ? pair.ticks : 0;
      const seen = new Set();
      for (const p of snap.alive) {
        seen.add(p.id);
        const ba = Number(p.boostAmount ?? (p.boosting ? 1 : 0));
        let near = false;
        if (ba > 0.01 && !p.cashingOut) {
          const reach = (p.thickness ?? 15) + 42 + MARGIN;
          const r2 = reach * reach;
          for (const f of snap.foods) {
            const dx = f[0] - p.hx; const dy = f[1] - p.hy;
            if (dx * dx + dy * dy <= r2) { near = true; break; }
          }
        }
        if (ba <= 0.01 || p.cashingOut || near || !Number.isFinite(p.size)) { close(p.id); continue; }
        const cur = open.get(p.id);
        if (!cur) open.set(p.id, { from: p.size, to: p.size, ticks: 0, integral: 0, sizeIntegral: 0 });
        else if (ticks >= 1) {
          cur.to = p.size;
          cur.ticks += ticks;
          cur.integral += ba * ticks;
          cur.sizeIntegral += p.size * ba * ticks;
        } else close(p.id);
      }
      for (const id of [...open.keys()]) if (!seen.has(id)) close(id);
    },

    counts() { return { runs: runs.length }; },

    finalize(shared) {
      const sec = new Section('boost', 'Costo del boost', 'Taglia persa in boost, su tratti puliti (nessun orb raggiungibile, nessun cashout). Coefficienti per tick e al secondo.');
      const dec = shared.declaredHz ?? 60;
      if (runs.length < 6) {
        sec.missing('costo del boost', 'boost.costo', `servono tratti di boost lontano dal cibo (osservati ${runs.length}, ne servono 6)`);
        return sec;
      }
      const A = runs.map((r) => r.sizeIntegral);
      const B = runs.map((r) => r.integral);
      const Y = runs.map((r) => r.from - r.to);
      const two = fit2(A, B, Y);
      let saa = 0; let say = 0; let sbb = 0; let sby = 0;
      for (let i = 0; i < Y.length; i += 1) { saa += A[i] * A[i]; say += A[i] * Y[i]; sbb += B[i] * B[i]; sby += B[i] * Y[i]; }
      const prop = say / saa;
      const cost = sby / sbb;
      const rmse = (fa, fb) => Math.sqrt(Y.reduce((s, y, i) => s + (y - fa * A[i] - fb * B[i]) ** 2, 0) / Y.length);
      const eTwo = rmse(two.a, two.b); const eProp = rmse(prop, 0); const eCost = rmse(0, cost);
      const tick = runs.reduce((s, r) => s + r.ticks, 0);
      const best = [['due termini', eTwo], ['proporzionale', eProp], ['costante', eCost]].sort((x, y) => x[1] - y[1])[0][0];
      sec.item({ key: 'boost.costo', label: 'perdita per tick = (b + a·taglia)·boostAmount', value: { a: Number(two.a.toExponential(5)), b: Number(two.b.toFixed(6)) }, unit: 'taglia/tick', n: runs.length,
        detail: `${runs.length} tratti, ${tick} tick. Al secondo (${dec} Hz): ${(two.b * dec).toFixed(3)} + ${(two.a * dec).toFixed(4)}·taglia` });
      sec.item({ key: 'boost.leggeMigliore', label: 'legge che spiega meglio i dati', value: best, status: 'stimato',
        detail: `errore quadratico medio (unita' di taglia): due termini ${eTwo.toFixed(2)}, solo proporzionale ${eProp.toFixed(2)} (${(prop * dec).toFixed(4)}·taglia/s), solo costante ${eCost.toFixed(2)} (${(cost * dec).toFixed(2)}/s)` });
      sec.item({ key: 'boost.costoProporzionalePerSec', label: 'se fosse solo proporzionale: frazione al secondo', value: Number((prop * dec).toFixed(5)), unit: '1/s', status: 'stimato', n: runs.length });
      sec.table('Tratti di boost misurati (primi 30)', ['taglia da', 'a', 'tick', '∫boost', 'perdita', 'prevista (2 termini)'],
        runs.slice(0, 30).map((r) => [r.from, r.to, r.ticks, Number(r.integral.toFixed(2)), r.from - r.to, Number((two.a * r.sizeIntegral + two.b * r.integral).toFixed(2))]));
      return sec;
    },
  };
}
