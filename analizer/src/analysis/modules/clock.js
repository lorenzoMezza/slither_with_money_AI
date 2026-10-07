/**
 * Il tempo del server e la rete.
 *
 * Il numero di tick fra due snapshot si conta dallo SPOSTAMENTO (multipli esatti
 * del passo), non dal `ts`: il `ts` e' l'ora d'invio dello snapshot, presa da un
 * timer diverso da quello del tick. Contare i tick col `ts` arrotondato li sbaglia
 * nel ~7 % degli intervalli, sempre per eccesso in media, ed e' cosi' che in
 * passato era venuta fuori una frequenza di 61,25–61,7 Hz: contati dallo
 * spostamento i tick sono 60,0 al secondo. Il tempo lo da' l'orologio locale.
 */
import { Section } from '../engine.js';
import { histogram, median, quantile, Sample } from '../stats.js';

export function createClock() {
  const perTickMs = new Sample(50_000);        // Δts / tick, per calibrare il conteggio
  const ticksPerSnap = [];
  let motoTicks = 0; let motoMs = 0; let motoTs = 0; let tsPairs = 0; let motoPairs = 0; let tsWrong = 0;
  const dtsByTicks = new Map();
  const spans = [];                             // per sessione: {ticks, localMs, serverMs}
  let span = null;
  const rtt = new Sample(5000);
  const pings = new Map();
  const inputGaps = new Sample(50_000);
  let lastInput = null;
  const stateGaps = new Sample(50_000);
  const stateBytes = new Sample(20_000);
  // Arrivo locale meno ts del server: il minimo e' il ritardo di base, il resto
  // e' jitter. Gli orologi cambiano da una sessione all'altra, quindi si misura
  // per sessione.
  let offsets = [];
  const jitter = new Sample(50_000);
  const declared = new Set();
  let ownStates = 0;

  const mod = {
    id: 'clock',
    calibrated: false,
    beginSession() { span = { ticks: 0, firstLocal: null, lastLocal: null, firstServer: null, lastServer: null }; lastInput = null; offsets = []; },
    endSession() {
      if (span?.ticks) spans.push(span);
      span = null;
      if (offsets.length > 50) {
        const base = quantile(offsets, 0.01);
        for (const o of offsets) jitter.push(o - base);
      }
      offsets = [];
    },
    onMessage(msg, fr, ctx) {
      if (fr.d === 'o' && msg.t === 'ping' && msg.ts != null) pings.set(String(msg.ts), fr.ms);
      if (fr.d === 'i' && msg.t === 'pong' && msg.ts != null) {
        const s = pings.get(String(msg.ts));
        if (s != null) { rtt.push(fr.ms - s); pings.delete(String(msg.ts)); }
        if (pings.size > 50) pings.clear();
      }
      if (fr.d === 'o' && msg.t === 'input') {
        if (lastInput != null) inputGaps.push(fr.ms - lastInput);
        lastInput = fr.ms;
      }
      if (msg.t === 'init' && Number.isFinite(msg.tickRate)) declared.add(msg.tickRate);
      void ctx;
    },
    onState(snap, pair, ctx) {
      stateBytes.push(snap.bytes);
      if (Number.isFinite(snap.ts) && offsets.length < 200_000) offsets.push(snap.ms - snap.ts);
      if (ctx.me(snap)) ownStates += 1;
      if (!pair) return;
      stateGaps.push(pair.dms);
      mod.pairs = (mod.pairs ?? 0) + 1;
      if (!pair.ok) return;
      if (pair.ticksFrom !== 'moto') { tsPairs += 1; return; }
      motoPairs += 1;
      motoTicks += pair.ticks; motoMs += pair.dms; motoTs += pair.dts;
      if (pair.ticks !== Math.round(pair.dts / (1000 / (ctx.declaredTickRate || 60)))) tsWrong += 1;
      ticksPerSnap.push(pair.ticks);
      if (ticksPerSnap.length > 200_000) ticksPerSnap.splice(0, 100_000);
      perTickMs.push(pair.dts / pair.ticks);
      const arr = dtsByTicks.get(pair.ticks) ?? [];
      if (arr.length < 5000) arr.push(pair.dts);
      dtsByTicks.set(pair.ticks, arr);
      if (span) {
        span.ticks += pair.ticks;
        span.firstLocal ??= pair.a.ms;
        span.firstServer ??= pair.a.ts;
        span.lastLocal = pair.b.ms;
        span.lastServer = pair.b.ts;
      }
      // Calibrazione: la durata del tick secondo il `ts` del server. Con il
      // valore giusto l'arrotondamento resta esatto anche su intervalli lunghi.
      if (perTickMs.length >= 200 && perTickMs.length % 200 === 0) {
        const est = median(perTickMs.v);
        if (est > 5 && est < 100) { ctx.analyzer.tickMs = est; mod.calibrated = true; }
      }
    },

    /** Frequenza vera: tick contati dallo spostamento diviso il tempo locale degli stessi intervalli. */
    measuredHz() {
      if (motoTicks < 300 || !(motoMs > 0)) return null;
      return { hz: motoTicks / (motoMs / 1000), hzTs: motoTicks / (motoTs / 1000), ticks: motoTicks, localS: motoMs / 1000, serverOverLocal: motoTs / motoMs };
    },

    finalize() {
      const sec = new Section('tempo', 'Tempo del server e rete', 'Il conteggio dei tick fra snapshot e la frequenza vera del server, misurata con due orologi indipendenti.');
      const dec = [...declared];
      if (dec.length) sec.item({ key: 'tempo.tickRateDichiarato', label: 'tick rate dichiarato (init.tickRate)', value: dec.length === 1 ? dec[0] : dec, unit: 'Hz', status: 'osservato' });
      const hz = this.measuredHz();
      if (hz) {
        sec.item({ key: 'tempo.tickHzMisurato', label: 'frequenza di gioco VERA del server', value: Number(hz.hz.toFixed(3)), unit: 'Hz', n: hz.ticks,
          detail: `${hz.ticks} tick contati dallo spostamento in ${motoPairs} intervalli, ${hz.localS.toFixed(1)} s di orologio locale (${hz.hzTs.toFixed(3)} Hz misurando col ts). Contarli arrotondando il ts li avrebbe sbagliati nel ${(tsWrong / Math.max(1, motoPairs) * 100).toFixed(1)} % degli intervalli` });
        sec.item({ key: 'tempo.msPerTickVero', label: 'durata vera di un tick', value: Number((1000 / hz.hz).toFixed(4)), unit: 'ms', n: hz.ticks });
      } else sec.missing('frequenza di gioco vera', 'tempo.tickHzMisurato', 'serve almeno una sessione con 10 s di snapshot consecutivi');
      if (perTickMs.length) {
        sec.item({ key: 'tempo.msPerTickTsServer', label: 'durata del tick secondo il ts del server', value: Number(median(perTickMs.v).toFixed(4)), unit: 'ms', n: perTickMs.length,
          detail: 'mediana di Δts/tick: il ts e\' preso all\'invio e ha jitter, ma il passo e\' un multiplo esatto del tick' });
      }
      const h = histogram(ticksPerSnap);
      if (h.length) {
        const tot = ticksPerSnap.length;
        sec.item({ key: 'rete.tickPerSnapshot', label: 'tick fra due snapshot (contati dallo spostamento)', value: Object.fromEntries(h.map(([k, v]) => [k, Number((v / tot).toFixed(4))])), n: tot, status: 'misurato',
          detail: `quota di intervalli per numero di tick; ${tsPairs} intervalli senza un serpente utile al conteggio sono esclusi` });
        sec.table('Δts del server per numero di tick (il ts non e\' l\'ora del tick)', ['tick', 'intervalli', 'Δts p05', 'Δts p50', 'Δts p95'],
          [...dtsByTicks.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, v.length, quantile(v, 0.05), quantile(v, 0.5), quantile(v, 0.95)]));
      }
      if (stateGaps.length) sec.item({ key: 'rete.snapshotHz', label: 'frequenza degli snapshot', value: Number((1000 / median(stateGaps.v)).toFixed(2)), unit: 'Hz', n: stateGaps.length, detail: `intervallo locale p05/p50/p95 ${quantile(stateGaps.v, 0.05).toFixed(1)}/${median(stateGaps.v).toFixed(1)}/${quantile(stateGaps.v, 0.95).toFixed(1)} ms` });
      if (stateBytes.length) sec.item({ key: 'rete.snapshotByte', label: 'dimensione di uno snapshot', value: Math.round(median(stateBytes.v)), unit: 'byte', n: stateBytes.length, status: 'osservato' });
      if (inputGaps.length) sec.item({ key: 'rete.inputHz', label: 'frequenza degli input del client', value: Number((1000 / median(inputGaps.v)).toFixed(2)), unit: 'Hz', n: inputGaps.length, status: 'osservato' });
      if (rtt.length) sec.item({ key: 'rete.rttMs', label: 'andata e ritorno (ping→pong)', value: Number(median(rtt.v).toFixed(1)), unit: 'ms', n: rtt.length, status: 'osservato', detail: `p95 ${quantile(rtt.v, 0.95).toFixed(1)} ms` });
      const jit = [...jitter.v];
      if (offsets.length > 50) { const base = quantile(offsets, 0.01); for (const o of offsets) jit.push(o - base); }
      if (jit.length > 50) {
        sec.item({ key: 'rete.jitterMs', label: 'ritardo variabile degli snapshot (jitter)', value: Number(quantile(jit, 0.95).toFixed(1)), unit: 'ms', n: jit.length, status: 'osservato', detail: 'p95 dell\'arrivo locale meno ts del server, rispetto al minimo della sessione' });
      }
      sec.note(`snapshot con il proprio serpente: ${ownStates}`);
      return sec;
    },
  };
  return mod;
}
