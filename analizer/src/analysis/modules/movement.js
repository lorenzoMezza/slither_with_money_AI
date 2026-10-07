/**
 * Il movimento: passo per tick, boost (velocita' e rampa), sterzata, e il
 * ritardo fra un comando del client e la sua applicazione sul server.
 *
 * Tutto in UNITA' PER TICK: e' cio' che il server conta davvero. La
 * conversione in secondi si fa alla fine, con la frequenza misurata.
 */
import { Section } from '../engine.js';
import { fitLine, mad, median, quantile, Sample, wrap } from '../stats.js';

const LATENCIES = Array.from({ length: 41 }, (_, i) => i * 10);   // 0..400 ms

export function createMovement() {
  const base = new Sample();
  const baseTurning = new Sample();
  const boostFull = new Sample();
  const byBoost = new Map();            // quota di boost (fasce da 0,025) -> passi
  const rampUp = new Sample();
  const rampDown = new Sample();
  const turn = new Sample(100_000);
  const turnBySize = new Map();
  const turnBoost = new Sample();
  const turnNoBoost = new Sample();
  let minBoostSize = Infinity;
  let maxSizeSeen = 0;
  // Ritardo dei comandi propri.
  const boostLatency = new Sample(2000);
  let own = [];                          // transizioni proprie della sessione
  const steerFit = LATENCIES.map(() => ({ n: 0, exact: 0, err: [] }));
  let pendingBoost = null;

  const ba = (p) => Number(p.boostAmount ?? (p.boosting ? 1 : 0));

  /** Accumula in `acc` quanto bene la legge di sterzata spiega le transizioni proprie. */
  function scoreSteering(acc, ctx, list, maxTurn) {
    if (!list.length || !ctx?.inputs.length || !(maxTurn > 0)) return;
    LATENCIES.forEach((L, k) => {
      const a = acc[k];
      for (const r of list) {
        const inp = ctx.inputBefore(r.msB - L);
        if (!inp || !Number.isFinite(inp.dir) || inp.cashing) continue;
        const diff = wrap(inp.dir - r.angA);
        const pred = r.angA + Math.sign(diff) * Math.min(Math.abs(diff), maxTurn * r.ticks);
        const e = Math.abs(wrap(pred - r.angB));
        a.n += 1;
        if (e < 0.0025) a.exact += 1;
        if (a.err.length < 20_000) a.err.push(e);
      }
    });
  }

  const mod = {
    id: 'movement',
    beginSession() { own = []; pendingBoost = null; },
    endSession(ctx) { scoreSteering(steerFit, ctx, own, mod.maxTurnPerTick()); own = []; },
    onMessage(msg, fr, ctx) {
      if (fr.d === 'o' && msg.t === 'input') {
        const prev = ctx.inputs.length > 1 ? ctx.inputs[ctx.inputs.length - 2] : null;
        if (msg.boost && prev && !prev.boost) pendingBoost = fr.ms;
      }
    },
    onState(snap, pair, ctx) {
      for (const p of snap.alive) if (p.size > maxSizeSeen) maxSizeSeen = p.size;
      if (!pair?.ok) return;
      for (const t of pair.tx) {
        const a0 = ba(t.a); const a1 = ba(t.b);
        const cashing = t.a.cashingOut || t.b.cashingOut;
        if (!cashing) {
          if (Math.abs(t.da) < 2e-3 && a0 === 0 && a1 === 0) base.push(t.arc / t.ticks);
          else if (a0 === 0 && a1 === 0) baseTurning.push(t.step);
          if (Math.abs(t.da) < 5e-3 && a0 >= 0.999 && a1 >= 0.999) boostFull.push(t.arc / t.ticks);
          if (Math.abs(t.da) < 5e-3) {
            const k = Math.round(((a0 + a1) / 2) * 40) / 40;
            const arr = byBoost.get(k) ?? [];
            if (arr.length < 20_000) arr.push(t.arc / t.ticks);
            byBoost.set(k, arr);
          }
          if (a1 > a0 && a1 < 0.999) rampUp.push((a1 - a0) / t.ticks);
          if (a1 < a0 && a1 > 0.001) rampDown.push((a0 - a1) / t.ticks);
          if (a1 > a0 && Number.isFinite(t.a.size)) minBoostSize = Math.min(minBoostSize, t.a.size);
          const w = Math.abs(t.da) / t.ticks;
          turn.push(w);
          const sk = Math.round((t.b.size ?? 100) / 50) * 50;
          const arr = turnBySize.get(sk) ?? new Sample(20_000);
          arr.push(w);
          turnBySize.set(sk, arr);
          if (a0 > 0.9 && a1 > 0.9) turnBoost.push(w); else if (a0 === 0 && a1 === 0) turnNoBoost.push(w);
        }
        if (t.id === ctx.ownId) {
          if (own.length < 50_000) own.push({ msB: snap.ms, angA: t.a.angle, angB: t.b.angle, ticks: t.ticks });
          if (pendingBoost != null && a1 > 0 && a0 === 0) {
            const lat = snap.ms - pendingBoost;
            if (lat >= 0 && lat < 1000) boostLatency.push(lat);
            pendingBoost = null;
          }
        }
      }
    },

    maxTurnPerTick() {
      if (turn.length < 50) return NaN;
      return quantile(turn.v, 0.999);
    },
    baseStep() { return base.length >= 20 ? median(base.v) : NaN; },
    boostStep() { return boostFull.length >= 10 ? median(boostFull.v) : NaN; },
    counts() { return { base: base.length, boostFull: boostFull.length, rampUp: rampUp.length, turn: turn.length, maxSize: maxSizeSeen, ownBoost: boostLatency.length }; },

    finalize(shared) {
      const sec = new Section('movimento', 'Movimento', 'Passo, boost e sterzata misurati sulle posizioni di tutti i serpenti visibili, contando i tick fra snapshot. Le transizioni curve usano la corda corretta in arco.');
      const hz = shared.hz;            // frequenza vera, dal modulo clock
      const dec = shared.declaredHz ?? 60;
      const perSec = (x) => `${(x * dec).toFixed(3)} u/s a ${dec} Hz dichiarati${hz ? `, ${(x * hz).toFixed(2)} u/s a ${hz.toFixed(2)} Hz veri` : ''}`;

      if (base.length >= 20) {
        const m = median(base.v);
        sec.item({ key: 'movimento.passoBase', label: 'passo per tick senza boost', value: Number(m.toFixed(5)), unit: 'u/tick', n: base.length,
          detail: `dispersione (MAD) ${mad(base.v).toFixed(5)}: zero vuol dire tick davvero discreti. ${perSec(m)}` });
        if (baseTurning.length > 20) sec.item({ label: 'passo per tick senza boost, anche in curva (ruota poi avanza)', value: Number(median(baseTurning.v).toFixed(5)), unit: 'u/tick', n: baseTurning.length, status: 'osservato', detail: 'se coincide col precedente l\'ordine «prima ruota, poi avanza» e\' quello del server' });
      } else sec.missing('passo per tick senza boost', 'movimento.passoBase', 'servono tratti dritti senza boost');

      if (boostFull.length >= 10) {
        const m = median(boostFull.v);
        sec.item({ key: 'movimento.passoBoost', label: 'passo per tick a boost pieno', value: Number(m.toFixed(5)), unit: 'u/tick', n: boostFull.length, detail: perSec(m) });
      } else sec.missing('passo per tick a boost pieno', 'movimento.passoBoost', 'serve tenere il boost premuto almeno mezzo secondo in linea retta');

      const buckets = [...byBoost.entries()].filter(([, v]) => v.length >= 8).sort((a, b) => a[0] - b[0]);
      if (buckets.length >= 3) {
        const f = fitLine(buckets.map(([k]) => k), buckets.map(([, v]) => median(v)), buckets.map(([, v]) => v.length));
        sec.item({ key: 'movimento.passoInFunzioneDelBoost', label: 'passo = a + b·boostAmount', value: { a: Number(f.a.toFixed(4)), b: Number(f.b.toFixed(4)) }, unit: 'u/tick', n: buckets.reduce((s, [, v]) => s + v.length, 0),
          detail: `R² ${f.r2.toFixed(5)}, scarto quadratico ${f.rmse.toFixed(4)}: lineare se R² ≈ 1` });
        sec.table('Passo per tick in funzione della quota di boost', ['boostAmount', 'intervalli', 'passo mediano', 'retta'],
          buckets.map(([k, v]) => [k, v.length, Number(median(v).toFixed(4)), Number((f.a + f.b * k).toFixed(4))]));
      }

      if (rampUp.length >= 5) {
        sec.item({ key: 'movimento.rampaBoostSalita', label: 'rampa del boost in salita', value: Number(median(rampUp.v).toFixed(5)), unit: '/tick', n: rampUp.length, detail: `0→1 in ${(1 / median(rampUp.v)).toFixed(2)} tick` });
      } else sec.missing('rampa del boost in salita', 'movimento.rampaBoostSalita', 'servono pressioni del boost');
      if (rampDown.length >= 5) sec.item({ key: 'movimento.rampaBoostDiscesa', label: 'rampa del boost in discesa', value: Number(median(rampDown.v).toFixed(5)), unit: '/tick', n: rampDown.length });
      if (Number.isFinite(minBoostSize)) sec.item({ key: 'movimento.tagliaMinimaPerBoost', label: 'taglia minima a cui il boost e\' partito', value: minBoostSize, status: 'osservato', detail: 'il minimo osservato, non una soglia misurata' });

      const mt = this.maxTurnPerTick();
      if (Number.isFinite(mt)) {
        sec.item({ key: 'movimento.sterzataMaxPerTick', label: 'sterzata massima per tick', value: Number(mt.toFixed(5)), unit: 'rad/tick', n: turn.length,
          detail: `p99,9 della rotazione per tick (max ${quantile(turn.v, 1).toFixed(5)}). Gli angoli arrivano arrotondati: ±0,001 rad su un intervallo. ${(mt * dec).toFixed(3)} rad/s a ${dec} Hz` });
        const rows = [...turnBySize.entries()].filter(([, s]) => s.length >= 100).sort((a, b) => a[0] - b[0])
          .map(([k, s]) => [k, s.length, Number(quantile(s.v, 0.999).toFixed(5))]);
        sec.table('La sterzata dipende dalla taglia?', ['taglia ~', 'intervalli', 'p99,9 rad/tick'], rows);
        if (rows.length >= 2) {
          const vals = rows.map((r) => r[2]);
          sec.item({ key: 'movimento.sterzataDipendeDallaTaglia', label: 'la sterzata dipende dalla taglia', value: (Math.max(...vals) - Math.min(...vals)) / mt > 0.08, status: 'stimato', detail: `p99,9 fra ${Math.min(...vals).toFixed(4)} e ${Math.max(...vals).toFixed(4)} rad/tick nelle fasce di taglia` });
        }
        if (turnBoost.length >= 50 && turnNoBoost.length >= 50) {
          const r = quantile(turnBoost.v, 0.99) / quantile(turnNoBoost.v, 0.99);
          sec.item({ key: 'movimento.sterzataInBoostRapporto', label: 'sterzata in boost / senza boost (p99)', value: Number(r.toFixed(3)), n: turnBoost.length, status: 'stimato', detail: '1 = il boost non cambia la sterzata (in rad per tick)' });
        }
      } else sec.missing('sterzata massima per tick', 'movimento.sterzataMaxPerTick', 'servono curve strette');

      if (boostLatency.length >= 3) {
        sec.item({ key: 'rete.ritardoComandoBoostMs', label: 'ritardo pressione del boost → primo snapshot con boost', value: Number(median(boostLatency.v).toFixed(1)), unit: 'ms', n: boostLatency.length, status: 'osservato', detail: 'comprende il giro di rete e l\'attesa del prossimo snapshot' });
      }
      // La legge di sterzata verificata sul proprio serpente, con il ritardo che la spiega meglio.
      const tmp = steerFit.map((a) => ({ n: a.n, exact: a.exact, err: [...a.err] }));
      scoreSteering(tmp, shared.analyzer?.ctx, own, mt);
      const best = tmp.map((a, k) => ({ L: LATENCIES[k], ...a, med: a.err.length ? median(a.err) : Infinity }))
        .filter((a) => a.n >= 30).sort((x, y) => y.exact / y.n - x.exact / x.n)[0];
      if (best) {
        sec.item({ key: 'movimento.leggeSterzata', label: 'sterzata = verso targetDir, al massimo il limite per tick', value: Number((best.exact / best.n).toFixed(4)), n: best.n, status: 'stimato',
          detail: `quota di intervalli propri spiegati entro 0,0025 rad assumendo un ritardo del comando di ${best.L} ms (errore mediano ${best.med.toFixed(4)} rad). Vicino a 1 = legge esatta` });
        sec.item({ key: 'rete.ritardoComandoStimatoMs', label: 'ritardo comando → applicazione che spiega meglio la sterzata', value: best.L, unit: 'ms', n: best.n, status: 'stimato' });
      }
      sec.note(`taglia massima vista: ${maxSizeSeen}`);
      return sec;
    },
  };
  return mod;
}
