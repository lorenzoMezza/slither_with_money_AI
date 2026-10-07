/**
 * Il cashout: durata, rallentamento, sterzo, interruzione, e la sequenza dei
 * messaggi che lo chiude.
 *
 * `cashoutProgress` e' a TEMPO d'orologio: cresce di 1/durata per millisecondo di
 * `ts` (il `ts` e' proprio l'ora a cui il server lo calcola). La durata esce dal
 * rapporto Δprogresso/Δts, esatto. La curva del rallentamento si stima con i
 * minimi quadrati sulla velocita' relativa: v = v0·(1 − m·t^p).
 */
import { Section } from '../engine.js';
import { median, quantile, Sample } from '../stats.js';

export function createCashout() {
  const quantum = new Sample();
  const perMs = new Sample();
  const rot = new Sample();
  const boostDuring = new Sample();
  const curve = [];                 // {prog, step}
  const restarts = new Sample(2000);
  const interrupts = [];
  let ownStart = null; let ownSent = null;
  const holds = new Sample(500); const resultLatency = new Sample(500);
  let resultMs = null; const vanish = new Sample(500);

  return {
    id: 'cashout',
    beginSession() { ownStart = null; ownSent = null; resultMs = null; },
    onMessage(msg, fr) {
      if (fr.d === 'o' && msg.t === 'input') {
        if (msg.cashingOut && ownStart == null) ownStart = fr.ms;
        if (!msg.cashingOut) ownStart = null;
      }
      if (fr.d === 'o' && msg.t === 'cashout') {
        ownSent = fr.ms;
        if (ownStart != null) holds.push(fr.ms - ownStart);
      }
      if (fr.d === 'i' && msg.t === 'cashout_result') {
        if (ownSent != null) resultLatency.push(fr.ms - ownSent);
        resultMs = fr.ms;
        ownSent = null;
      }
    },
    onState(snap, pair, ctx) {
      if (resultMs != null && ctx.ownId) {
        const me = snap.players.get(ctx.ownId);
        if (!me || me.alive === false) { vanish.push(snap.ms - resultMs); resultMs = null; }
      }
      if (!pair?.ok) return;
      for (const t of pair.tx) {
        const pa = Number(t.a.cashoutProgress ?? 0); const pb = Number(t.b.cashoutProgress ?? 0);
        if (!t.a.cashingOut && t.b.cashingOut) restarts.push(pb / t.ticks);
        if (t.a.cashingOut && !t.b.cashingOut && pa < 0.95) interrupts.push({ progress: pa, after: pb });
        if (!(t.a.cashingOut && t.b.cashingOut)) continue;
        if (pb > pa && pb < 1) {
          perMs.push((pb - pa) / pair.dts);
          if (pair.ticksFrom === 'moto') quantum.push((pb - pa) / t.ticks);
        }
        rot.push(Math.abs(t.da) / t.ticks);
        boostDuring.push(Math.max(Number(t.a.boostAmount ?? 0), Number(t.b.boostAmount ?? 0)));
        if (curve.length < 50_000) curve.push({ prog: (pa + pb) / 2, step: t.arc / t.ticks, end: pb >= 1 });
      }
    },

    finalize(shared) {
      const sec = new Section('cashout', 'Cashout', 'Durata, rallentamento, sterzo e sequenza dei messaggi del cashout.');
      if (perMs.length < 10) {
        sec.missing('cashout', 'cashout.durataMs', 'serve vedere un cashout (tuo o di un altro giocatore) per almeno un secondo');
      } else {
        const q = median(perMs.v);
        const ms = 1 / q;
        const spreadOk = quantile(perMs.v, 0.1) === quantile(perMs.v, 0.9);
        sec.item({ key: 'cashout.durataMs', label: 'durata della carica (il progresso e\' a tempo d\'orologio)', value: Number(ms.toFixed(1)), unit: 'ms', n: perMs.length,
          detail: `Δprogresso/Δts = ${q.toExponential(6)} per ms${spreadOk ? ', identico in tutti gli intervalli: il progresso e\' (ora − inizio)/durata' : ''}` });
        const hzv = shared.hz ?? shared.declaredHz ?? 60;
        sec.item({ key: 'cashout.tick', label: 'durata della carica in tick', value: Number((ms / 1000 * hzv).toFixed(2)), unit: 'tick', n: perMs.length, status: 'stimato', detail: `a ${hzv.toFixed(2)} Hz` });
        if (quantum.length) sec.item({ key: 'cashout.progressoPerTick', label: 'avanzamento medio del progresso per tick (tick dallo spostamento)', value: Number(median(quantum.v).toFixed(7)), unit: '/tick', n: quantum.length, status: 'osservato' });
        sec.item({ key: 'cashout.sterzataDurante', label: 'rotazione per tick durante il cashout (p99)', value: Number(quantile(rot.v, 0.99).toFixed(5)), unit: 'rad/tick', n: rot.length, detail: '0 = sterzo bloccato' });
        sec.item({ key: 'cashout.boostDurante', label: 'boostAmount massimo durante il cashout', value: Number(quantile(boostDuring.v, 1).toFixed(4)), n: boostDuring.length, status: 'osservato', detail: '0 = boost disattivato' });
        const v0 = shared.steps?.base;
        if (Number.isFinite(v0)) {
          // v/v0 = 1 − m·t^p, minimi quadrati sulla velocita' (non sul logaritmo, che
          // gonfia il rumore dei punti a inizio carica dove la perdita e' quasi nulla).
          // Per p fissato m e' lineare: si cerca p su una griglia fine.
          const pts = curve.filter((c) => c.prog > 0.02 && c.prog < 0.995).map((c) => ({ t: c.prog, y: 1 - c.step / v0 }));
          if (pts.length >= 15) {
            let best = null;
            for (let p = 0.5; p <= 6; p += 0.005) {
              let sxy = 0; let sxx = 0;
              for (const q of pts) { const x = q.t ** p; sxy += x * q.y; sxx += x * x; }
              const m = sxy / sxx;
              let sse = 0;
              for (const q of pts) sse += (q.y - m * q.t ** p) ** 2;
              if (!best || sse < best.sse) best = { p, m, sse };
            }
            const rmse = Math.sqrt(best.sse / pts.length);
            sec.item({ key: 'cashout.esponenteRallentamento', label: 'esponente p di v = v0·(1 − m·t^p)', value: Number(best.p.toFixed(3)), n: pts.length, detail: `minimi quadrati sulla velocita' relativa, scarto ${rmse.toFixed(4)}` });
            sec.item({ key: 'cashout.rallentamentoMassimo', label: 'm: frazione di velocita\' persa a fine carica', value: Number(best.m.toFixed(4)), n: pts.length, detail: '1 = a fine carica il serpente e\' fermo; 0,6 = resta al 40 %' });
          }
          const tail = curve.filter((c) => c.prog >= 0.985).map((c) => c.step / v0);
          if (tail.length >= 3) sec.item({ key: 'cashout.velocitaFinaleFrazione', label: 'velocita\' a fine carica / velocita\' base', value: Number(median(tail).toFixed(4)), n: tail.length });
          const bins = new Map();
          for (const c of curve) { const k = Math.round(c.prog * 10) / 10; const a = bins.get(k) ?? []; a.push(c.step / v0); bins.set(k, a); }
          sec.table('Velocita\' relativa per progresso', ['progresso', 'intervalli', 'v / v0'], [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, a]) => [k, a.length, Number(median(a).toFixed(4))]));
        }
      }
      if (restarts.length) sec.item({ key: 'cashout.ripartenza', label: 'progresso per tick al primo snapshot di una carica', value: Number(median(restarts.v).toFixed(5)), n: restarts.length, status: 'osservato', detail: 'uguale al quanto per tick = ogni carica riparte da zero' });
      if (interrupts.length) sec.item({ key: 'cashout.interruzioneAzzera', label: 'rilasciato prima della fine, il progresso torna a zero', value: interrupts.every((i) => i.after === 0), n: interrupts.length, status: 'osservato' });
      if (holds.length) sec.item({ key: 'cashout.pressioneClientMs', label: 'dal primo input cashingOut al messaggio cashout (client)', value: Math.round(median(holds.v)), unit: 'ms', n: holds.length, status: 'osservato', detail: 'il timer e\' del CLIENT: il server incassa solo quando arriva {"t":"cashout"}' });
      if (resultLatency.length) sec.item({ key: 'cashout.rispostaMs', label: 'da cashout a cashout_result', value: Math.round(median(resultLatency.v)), unit: 'ms', n: resultLatency.length, status: 'osservato' });
      if (vanish.length) sec.item({ key: 'cashout.sparizioneMs', label: 'da cashout_result alla sparizione del proprio serpente', value: Math.round(median(vanish.v)), unit: 'ms', n: vanish.length, status: 'osservato' });
      return sec;
    },

    counts() { return { cashing: perMs.length, completed: holds.length }; },
  };
}
