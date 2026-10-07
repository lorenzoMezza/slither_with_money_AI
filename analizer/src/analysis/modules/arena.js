/**
 * L'arena: raggio del muro, legge con cui segue il numero di serpenti, ritmo
 * con cui ci arriva, e la soglia esatta della morte sul muro.
 *
 * Il raggio di equilibrio si legge a muro fermo; il ritmo si stima sui passi
 * di avvicinamento, una volta noto il bersaglio.
 *
 * La morte sul muro si inquadra con due disuguaglianze: nell'ultimo snapshot da
 * vivo `dist + k·spessore <= R`, alla morte (testa proiettata in avanti)
 * `dist + k·spessore > R`. Ogni morte stringe l'intervallo di `k`.
 */
import { isAlive, Section } from '../engine.js';
import { fitLine, hyp, median } from '../stats.js';

// Il raggio di equilibrio si legge quando il muro e' FERMO (raggio identico allo
// snapshot prima: arrivato al bersaglio si aggancia con uno scatto e smette di
// muoversi) e il numero di vivi non cambia da qualche snapshot. Si tiene poi il
// valore piu' frequente per ogni conteggio.
const STABLE_SNAPS = 5;

export function createArena() {
  const initR = new Set();
  const settled = { alive: new Map(), players: new Map() };   // conteggio -> Map(r -> n)
  const moves = [];          // {alive, players, r0, r1, ticks}
  let run = { alive: -1, players: -1, len: 0 };
  let prevR = null;
  const last = new Map();    // id -> ultimo stato da vivo
  const deaths = [];         // {name, ms, last, gapTicks, R}
  const wallKills = [];      // {victim, ms}

  return {
    id: 'arena',
    beginSession() { run = { alive: -1, players: -1, len: 0 }; prevR = null; last.clear(); },
    onMessage(msg, fr, ctx) {
      if (fr.d !== 'i') return;
      if (msg.t === 'init' && Number.isFinite(msg.world?.r)) initR.add(msg.world.r);
      if (msg.t === 'kill' && msg.killer === 'WALL') wallKills.push({ victim: msg.victim, ms: fr.ms });
      if (msg.t === 'you_died' && /border|wall/i.test(String(msg.reason ?? ''))) wallKills.push({ victim: ctx.ownName, ms: fr.ms, self: true });
    },
    onState(snap, pair, ctx) {
      const R = snap.r;
      if (!Number.isFinite(R)) return;
      const alive = snap.alive.length;
      const players = snap.list.filter((p) => !p.spectator).length;
      if (alive === run.alive && players === run.players) run.len += 1;
      else run = { alive, players, len: 0 };
      if (run.len >= STABLE_SNAPS && prevR !== null && Math.abs(R - prevR) < 1e-9) {
        for (const [k, c] of [['alive', alive], ['players', players]]) {
          const m = settled[k].get(c) ?? new Map();
          const key = Math.round(R * 100) / 100;
          m.set(key, (m.get(key) ?? 0) + 1);
          settled[k].set(c, m);
        }
      }
      if (prevR !== null && pair?.ok && Math.abs(R - prevR) > 1e-9 && moves.length < 50_000) {
        moves.push({ alive, players, r0: prevR, r1: R, ticks: pair.ticks });
      }
      prevR = R;

      // Morti: chi era vivo e ora non lo e' (o e' sparito).
      for (const [id, l] of last) {
        const p = snap.players.get(id);
        if (isAlive(p)) continue;
        if (p && p.alive === false) {
          deaths.push({ name: l.p.name, ms: snap.ms, last: l.p, R: l.R, gapTicks: Math.round((snap.ts - l.ts) / ctx.tickMs) });
          if (deaths.length > 5000) deaths.shift();
        }
        last.delete(id);
      }
      for (const p of snap.alive) last.set(p.id, { p, R, ts: snap.ts });
    },

    counts() {
      const matched = deaths.filter((d) => wallKills.some((k) => d.name === k.victim && Math.abs(d.ms - k.ms) < 2500)).length;
      return { aliveCounts: settled.alive.size, playerCounts: settled.players.size, wallDeaths: matched };
    },

    finalize(shared) {
      const sec = new Section('arena', 'Arena e muro', 'Il raggio del mondo, come segue il numero di serpenti, e la soglia della morte sul muro.');
      if (initR.size) sec.item({ key: 'arena.raggioInit', label: 'raggio dichiarato in init.world.r', value: [...initR].length === 1 ? [...initR][0] : [...initR], unit: 'u', status: 'osservato' });

      const rowsFor = (map) => [...map.entries()].map(([c, m]) => {
        let best = null; let n = 0; let tot = 0;
        for (const [r, k] of m) { tot += k; if (k > n) { n = k; best = r; } }
        return { c, r: best, n: tot };
      }).filter((x) => x.c > 0).sort((a, b) => a.c - b.c);
      // Il raggio segue i serpenti VIVI: e' la legge da misurare. Con due soli
      // conteggi la retta passa per i due punti; da tre in su e' un fit.
      const rows = rowsFor(settled.alive);
      let fit = null;
      if (rows.length === 2) {
        const b = (rows[1].r - rows[0].r) / (rows[1].c - rows[0].c);
        fit = { a: rows[0].r - b * (rows[0].c - 1), b, rmse: 0 };
      } else if (rows.length > 2) fit = fitLine(rows.map((x) => x.c - 1), rows.map((x) => x.r), rows.map((x) => x.n));
      if (fit) {
        sec.item({ key: 'arena.raggioBase', label: 'raggio con un solo serpente vivo', value: Number(fit.a.toFixed(2)), unit: 'u', n: rows.length });
        sec.item({ key: 'arena.raggioPerSerpente', label: 'raggio aggiunto per ogni serpente vivo in piu\'', value: Number(fit.b.toFixed(2)), unit: 'u', n: rows.length, detail: `bersaglio = base + per_serpente·(vivi − 1), scarto quadratico ${fit.rmse.toFixed(2)} su ${rows.length} conteggi di vivi` });
      } else {
        if (rows[0]) sec.item({ key: 'arena.raggioBase', label: `raggio con ${rows[0].c} serpenti vivi`, value: rows[0].r, unit: 'u', n: rows[0].n, status: rows[0].c === 1 ? 'misurato' : 'osservato', detail: 'un solo numero di vivi osservato stabile: la crescita col numero di serpenti non e\' misurabile' });
        sec.missing('raggio per serpente in piu\'', 'arena.raggioPerSerpente', 'serve vedere il numero di serpenti vivi cambiare e restare fermo ~8 s');
      }
      sec.table('Raggio di equilibrio per numero di serpenti vivi', ['vivi', 'raggio', 'campioni', 'legge'], rows.map((x) => [x.c, x.r, x.n, fit ? Number((fit.a + fit.b * (x.c - 1)).toFixed(2)) : '–']));
      sec.table('Raggio di equilibrio per numero di giocatori in lobby (vivi e morti, solo informativo)', ['giocatori', 'raggio', 'campioni'], rowsFor(settled.players).map((x) => [x.c, x.r, x.n]));

      // Ritmo di avvicinamento al bersaglio.
      if (fit && moves.length) {
        const ks = [];
        for (const mv of moves) {
          const target = fit.a + fit.b * (mv.alive - 1);
          const gap = target - mv.r0;
          if (Math.abs(gap) < 5) continue;
          const frac = (mv.r1 - mv.r0) / gap;
          if (frac > 0 && frac < 1) ks.push(1 - (1 - frac) ** (1 / mv.ticks));
        }
        if (ks.length >= 5) sec.item({ key: 'arena.rilassamentoPerTick', label: 'frazione della distanza dal bersaglio recuperata per tick', value: Number(median(ks).toFixed(5)), n: ks.length, detail: 'r += (bersaglio − r)·k a ogni tick' });
      }
      const small = moves.filter((m) => Math.abs(m.r1 - m.r0) < 1.2).length;
      if (small) sec.note(`passi del muro sotto 1,2 unita': ${small} (il muro si ferma con uno scatto finale quando e' vicino)`);

      // Soglia della morte sul muro.
      const steps = shared.steps ?? {};
      const brackets = [];
      const used = new Set();
      for (const k of wallKills) {
        const d = deaths.find((x) => x.name === k.victim && Math.abs(x.ms - k.ms) < 2500);
        if (!d || used.has(d) || !Number.isFinite(d.last.thickness)) continue;
        used.add(d);
        const p = d.last;
        const th = p.thickness;
        const dist0 = hyp(p.hx, p.hy);
        const ba = Number(p.boostAmount ?? 0);
        const step = Number.isFinite(steps.base) ? steps.base + ((steps.boost ?? steps.base) - steps.base) * ba : NaN;
        const fwd = Number.isFinite(step) ? hyp(p.hx + Math.cos(p.angle) * step * d.gapTicks, p.hy + Math.sin(p.angle) * step * d.gapTicks) : NaN;
        brackets.push({ name: p.name, th, hi: (d.R - dist0) / th, lo: Number.isFinite(fwd) ? (d.R - fwd) / th : NaN, gap: d.gapTicks });
      }
      if (brackets.length) {
        const lo = Math.max(...brackets.map((b) => b.lo).filter(Number.isFinite));
        const hi = Math.min(...brackets.map((b) => b.hi));
        sec.item({ key: 'arena.muroFattoreSpessore', label: 'la testa muore quando dist + k·spessore > R: intervallo di k', value: { min: Number(lo.toFixed(4)), max: Number(hi.toFixed(4)) }, n: brackets.length, status: 'stimato',
          detail: 'limite superiore dall\'ultimo snapshot da vivo, inferiore dalla testa proiettata dritta fino allo snapshot della morte' });
        sec.table('Morti sul muro', ['vittima', 'spessore', 'k minimo', 'k massimo', 'tick fra gli snapshot'], brackets.map((b) => [b.name, Number(b.th.toFixed(3)), Number(b.lo.toFixed(4)), Number(b.hi.toFixed(4)), b.gap]));
      } else sec.missing('soglia della morte sul muro', 'arena.muroFattoreSpessore', 'serve una morte sul muro (WALL) osservata');
      return sec;
    },
  };
}
