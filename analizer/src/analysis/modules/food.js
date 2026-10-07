/**
 * Il cibo: quanto ce n'e', dove nasce, chi lo raccoglie e da che distanza,
 * quanto fa crescere, quanto denaro accredita.
 *
 * Gli orb non hanno identificatore: l'identita' e' la coordinata, stabile
 * finche' l'orb esiste. Un orb che sparisce fra due snapshot e' stato raccolto
 * dal serpente la cui testa e' passata piu' vicino — misurando la distanza dal
 * SEGMENTO percorso dalla testa nell'intervallo, non dalla sua posizione
 * iniziale, che sovrastimerebbe il raggio di quanto il serpente si e' mosso.
 */
import { foodKey, isAlive, Section } from '../engine.js';
import { distToSegment, fitLine, hyp, mean, median, quantile, Sample } from '../stats.js';

export function createFood() {
  const inside = new Sample(); const outside = new Sample(); const total = new Sample();
  const goldInField = new Sample();
  let maxRadius = 0;
  const kinds = new Map();          // tipo -> conteggio
  const colors = new Map();         // `${tipo} ${colore}` -> conteggio
  const normalValues = new Map();   // valore del campo [4] sugli orb normali
  const spawnR2 = new Sample();     // (r/R)^2 degli orb normali nati dentro il muro: uniforme per area -> media 0,5
  const spawnRmax = new Sample();
  const addedPerSnap = new Sample(); const removedPerSnap = new Sample();
  const reach = { normal: new Sample(), gold: new Sample() };
  const gains = { normal: [], gold: [] };   // {size, gain}
  const credit = [];                         // {value, delta}
  // La crescita entra in coda e si applica a rate limitato: un orb d'oro (~23) si
  // vede in piu' snapshot. Si misura quindi su una FINESTRA che si chiude quando la
  // taglia smette di salire: guadagno = (taglia finale − iniziale) / orb d'oro.
  const windows = new Map();                 // id -> {start, gold, normal, clean, stable}
  const goldGains = [];                      // {size, gain}
  const drain = [];                          // {size, rate} crescita per tick, senza boost
  let spontaneousGold = 0; let lootGold = 0;
  let unattributed = 0; let attributed = 0;
  let prevFoods = null; let prevSnap = null; let lastDeathMs = -Infinity;

  return {
    id: 'food',
    beginSession() { prevFoods = null; prevSnap = null; },
    onState(snap, pair) {
      const R = snap.r; const cx = snap.cx; const cy = snap.cy;
      let ins = 0; let gold = 0;
      const cur = new Map();
      for (const f of snap.foods) {
        if (!Array.isArray(f)) continue;
        cur.set(foodKey(f), f);
        const r = hyp(f[0] - cx, f[1] - cy);
        if (r > maxRadius) maxRadius = r;
        if (Number.isFinite(R) && r <= R) ins += 1;
        if (f[2] === 'gold') gold += 1;
      }
      total.push(snap.foods.length); goldInField.push(gold);
      if (Number.isFinite(R)) { inside.push(ins); outside.push(snap.foods.length - ins); }

      // Morti in questo snapshot: servono a separare l'oro dei cadaveri da quello spontaneo.
      if (prevSnap) {
        for (const q of prevSnap.alive) {
          const p = snap.players.get(q.id);
          if (!isAlive(p)) lastDeathMs = snap.ms;
        }
      }

      if (prevFoods) {
        const added = []; const removed = [];
        for (const [k, f] of cur) if (!prevFoods.has(k)) added.push(f);
        for (const [k, f] of prevFoods) if (!cur.has(k)) removed.push(f);
        addedPerSnap.push(added.length); removedPerSnap.push(removed.length);
        for (const f of added) {
          kinds.set(f[2], (kinds.get(f[2]) ?? 0) + 1);
          colors.set(`${f[2]} ${f[3]}`, (colors.get(`${f[2]} ${f[3]}`) ?? 0) + 1);
          if (f[2] === 'gold') {
            if (snap.ms - lastDeathMs < 1500) lootGold += 1; else spontaneousGold += 1;
          } else {
            const v = f[4] ?? null;
            normalValues.set(v, (normalValues.get(v) ?? 0) + 1);
            const r = hyp(f[0] - cx, f[1] - cy);
            if (Number.isFinite(R) && r <= R) { spawnR2.push((r / R) ** 2); spawnRmax.push(r / R); }
          }
        }
        if (pair?.ok) {
          this.attribute(removed, pair);
          this.trackGrowth(pair);
        }
      }
      prevFoods = cur;
      prevSnap = snap;
    },

    attribute(removed, pair) {
      // Se nell'intervallo qualcuno muore o esce, un orb sparito puo' essere stato
      // mangiato da lui (che non e' fra i vivi alla fine): l'attribuzione e'
      // ambigua e la misura del raggio verrebbe falsata. Quegli intervalli si saltano.
      const gone = pair.a.alive.some((q) => !pair.b.players.get(q.id)?.alive);
      if (gone) { unattributed += removed.length; return; }
      const movers = pair.tx;
      const eatenBy = new Map();
      for (const f of removed) {
        // Il mangiatore e' quello con l'orb piu' dentro la propria zona di raccolta
        // (distanza MENO spessore), non il piu' vicino: un serpente grosso raccoglie
        // da piu' lontano di uno sottile.
        let best = null; let bestD = Infinity; let bestEx = Infinity;
        for (const t of movers) {
          const d = distToSegment(f[0], f[1], t.a.hx, t.a.hy, t.b.hx, t.b.hy);
          const ex = d - (t.b.thickness ?? 15);
          if (ex < bestEx) { bestEx = ex; bestD = d; best = t; }
        }
        const th = best?.b.thickness ?? 15;
        // Oltre questa distanza non e' stato raccolto: e' bottino scaduto (sparisce tutto
        // insieme dopo due minuti). Il limite e' largo rispetto ai raggi attesi (29 e 42)
        // ma non tanto da scambiare una scadenza per una raccolta da lontano.
        const limit = th + (f[2] === 'gold' ? 75 : 60);
        if (!best || bestD > limit) { unattributed += 1; continue; }
        attributed += 1;
        const kind = f[2] === 'gold' ? 'gold' : 'normal';
        reach[kind].push(bestD - th);
        const acc = eatenBy.get(best.id) ?? { t: best, normal: 0, gold: 0, value: 0 };
        acc[kind] += 1;
        acc.value += Number(f[4]) || 0;
        eatenBy.set(best.id, acc);
      }
      for (const { t, normal, gold } of eatenBy.values()) {
        const w = windows.get(t.id);
        if (gold > 0 && !w) windows.set(t.id, { start: t.a.size, gold, normal, clean: true, stable: 0 });
        else if (w) { w.gold += gold; w.normal += normal; w.stable = 0; }
      }
      for (const { t, normal, gold, value } of eatenBy.values()) {
        if (value > 0 && Number.isFinite(t.a.balance) && Number.isFinite(t.b.balance) && credit.length < 5000) {
          credit.push({ value, delta: t.b.balance - t.a.balance });
        }
        // Un orb solo, niente boost, niente cashout: la crescita e' quella di quell'orb.
        if (normal + gold !== 1) continue;
        if ((t.a.boostAmount ?? 0) > 0 || (t.b.boostAmount ?? 0) > 0 || t.a.cashingOut || t.b.cashingOut) continue;
        const arr = gains[gold ? 'gold' : 'normal'];
        if (arr.length < 50_000) arr.push({ size: t.a.size, gain: t.b.size - t.a.size });
      }
    },

    /** Chiude le finestre di crescita dell'oro e misura il rate massimo di crescita. */
    trackGrowth(pair) {
      for (const t of pair.tx) {
        const a0 = Number(t.a.boostAmount ?? 0); const a1 = Number(t.b.boostAmount ?? 0);
        if (pair.ticksFrom === 'moto' && a0 === 0 && a1 === 0 && t.b.size > t.a.size && drain.length < 20_000) {
          drain.push({ size: t.a.size, rate: (t.b.size - t.a.size) / t.ticks });
        }
        const w = windows.get(t.id);
        if (!w) continue;
        if (a0 > 0 || a1 > 0 || t.a.cashingOut || t.b.cashingOut) w.clean = false;
        if (t.b.size !== t.a.size) w.stable = 0; else w.stable += 1;
        if (w.stable >= 3) {
          windows.delete(t.id);
          if (w.clean && w.normal === 0 && goldGains.length < 5000) goldGains.push({ size: w.start, gain: (t.b.size - w.start) / w.gold, n: w.gold });
        }
      }
      for (const id of [...windows.keys()]) if (!pair.b.players.get(id)?.alive) windows.delete(id);
    },

    counts() { return { reachNormal: reach.normal.length, reachGold: reach.gold.length, gains: gains.normal.length, goldGains: goldGains.length }; },

    /** Legge del guadagno gain = A·(taglia/100)^k, regressione log-log pesata per fasce. */
    gainLaw() {
      const bins = new Map();
      for (const g of gains.normal) {
        const k = Math.floor(g.size / 25) * 25;
        const b = bins.get(k) ?? { n: 0, gain: 0, size: 0 };
        b.n += 1; b.gain += g.gain; b.size += g.size;
        bins.set(k, b);
      }
      const rows = [...bins.entries()].filter(([, b]) => b.n >= 5 && b.gain > 0).sort((a, b) => a[0] - b[0])
        .map(([k, b]) => ({ bin: k, n: b.n, size: b.size / b.n, gain: b.gain / b.n }));
      if (rows.length < 2) return { rows, fitted: false };
      const f = fitLine(rows.map((r) => Math.log(r.size / 100)), rows.map((r) => Math.log(r.gain)), rows.map((r) => r.n));
      return { rows, fitted: true, A: Math.exp(f.a), k: f.b, seK: f.seB };
    },

    finalize(shared) {
      const sec = new Section('cibo', 'Cibo', 'Quantita\' in campo, nascita, raccolta, crescita e denaro accreditato.');
      const src = shared.source?.consts ?? {};
      if (inside.length) {
        const R0 = shared.arenaBase ?? 2000;
        sec.item({ key: 'cibo.inCampoDentroMuro', label: 'orb dentro il muro', value: Math.round(median(inside.v)), n: inside.length, status: 'misurato', detail: `p01 ${quantile(inside.v, 0.01)} · p99 ${quantile(inside.v, 0.99)}: stabile = il server rimpiazza subito ogni orb` });
        sec.item({ key: 'cibo.fuoriMuro', label: 'orb fuori dal muro (irraggiungibili)', value: Math.round(median(outside.v)), n: outside.length, status: 'osservato' });
        sec.item({ key: 'cibo.totaleNelloSnapshot', label: 'orb totali nello snapshot', value: Math.round(median(total.v)), n: total.length, status: 'osservato' });
        sec.item({ key: 'cibo.raggioDiscoSeminato', label: 'raggio massimo a cui esiste cibo', value: Number(maxRadius.toFixed(1)), unit: 'u', status: 'osservato' });
        const dens = median(total.v) / (Math.PI * maxRadius * maxRadius) * 1e6;
        sec.item({ key: 'cibo.densitaPerMilioneU2', label: 'densita\' sul disco seminato', value: Number(dens.toFixed(3)), unit: 'orb/Mu²', status: 'stimato', detail: `dentro il muro: ${(median(inside.v) / (Math.PI * R0 * R0) * 1e6).toFixed(3)} orb/Mu² (con raggio ${R0})` });
      }
      if (spawnR2.length >= 30) {
        sec.item({ key: 'cibo.nascitaUniformePerArea', label: 'media di (r/R)² degli orb nati dentro il muro', value: Number(mean(spawnR2.v).toFixed(4)), n: spawnR2.length, status: 'misurato', detail: `0,5 = uniforme per area (raggio = R·√u). Raggio massimo di nascita ${quantile(spawnRmax.v, 1).toFixed(4)}·R` });
      }
      sec.item({ key: 'cibo.oroSpontaneo', label: 'orb d\'oro nati senza una morte vicina', value: spontaneousGold, status: 'osservato', detail: `orb d'oro nati entro 1,5 s da una morte: ${lootGold}` });
      sec.table('Tipi e colori degli orb nati', ['tipo colore', 'nati'], [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30));
      if (normalValues.size) sec.item({ key: 'cibo.valoreOrbNormale', label: 'valore in denaro (campo [4]) degli orb normali', value: Object.fromEntries([...normalValues].slice(0, 6).map(([k, v]) => [String(k), v])), status: 'osservato' });

      for (const [kind, label, key, srcVal] of [
        ['normal', 'normale', 'cibo.raggioRaccoltaNormale', (src.MAGNET_RADIUS_BASE ?? NaN) + 7],
        ['gold', 'oro', 'cibo.raggioRaccoltaOro', (src.MAGNET_RADIUS_BASE ?? NaN) + (src.MAGNET_RADIUS_GOLD_BONUS ?? NaN) + 10],
      ]) {
        const s = reach[kind];
        if (s.length >= 15) {
          sec.item({ key, label: `raggio di raccolta oltre lo spessore (${label})`, value: Number(quantile(s.v, 1).toFixed(3)), unit: 'u', n: s.length,
            detail: `massimo osservato della distanza minima testa-orb meno lo spessore (p99 ${quantile(s.v, 0.99).toFixed(2)}). E' un limite inferiore stretto del raggio vero${Number.isFinite(srcVal) ? `; il sorgente implica ${srcVal}` : ''}` });
        } else sec.missing(`raggio di raccolta (${label})`, key, `solo ${s.length} raccolte osservate`);
      }

      const law = this.gainLaw();
      if (law.fitted) {
        sec.item({ key: 'cibo.guadagnoBase', label: 'guadagno di taglia per orb a taglia 100 (A)', value: Number(law.A.toFixed(4)), unit: 'taglia', n: gains.normal.length, detail: 'gain = A·(taglia/100)^k, regressione log-log pesata sulle fasce di taglia' });
        sec.item({ key: 'cibo.guadagnoEsponente', label: 'esponente della crescita con la taglia (k)', value: Number(law.k.toFixed(4)), n: gains.normal.length, detail: `± ${(1.96 * law.seK).toFixed(3)} (95 %)` });
        sec.table('Guadagno per orb normale per fascia di taglia', ['taglia', 'eventi', 'taglia media', 'guadagno medio', 'legge'],
          law.rows.map((r) => [r.bin, r.n, Number(r.size.toFixed(1)), Number(r.gain.toFixed(3)), Number((law.A * (r.size / 100) ** law.k).toFixed(3))]));
        if (goldGains.length >= 2) {
          const orbs = goldGains.reduce((a, g) => a + g.n, 0);
          const avg = goldGains.reduce((a, g) => a + g.gain * g.n, 0) / orbs;
          const ratio = mean(goldGains.map((g) => g.gain / (law.A * (g.size / 100) ** law.k)));
          // Costante o proporzionale alla legge normale? Si guarda se il guadagno sale con la taglia.
          const f = goldGains.length >= 3 ? fitLine(goldGains.map((g) => g.size), goldGains.map((g) => g.gain), goldGains.map((g) => g.n)) : null;
          sec.item({ key: 'cibo.guadagnoOro', label: 'crescita per orb d\'oro (a coda svuotata)', value: Number(avg.toFixed(3)), unit: 'taglia', n: orbs,
            detail: `${goldGains.length} finestre, taglie ${Math.min(...goldGains.map((g) => g.size))}–${Math.max(...goldGains.map((g) => g.size))}${f ? `; pendenza con la taglia ${f.b.toFixed(4)} (0 = costante)` : ''}` });
          sec.item({ key: 'cibo.guadagnoOroRapporto', label: 'un orb d\'oro fa crescere come N orb normali (alla stessa taglia)', value: Number(ratio.toFixed(3)), n: orbs, status: 'stimato', detail: 'se il guadagno dell\'oro e\' costante, questo rapporto scende con la taglia' });
          sec.table('Crescita da orb d\'oro', ['taglia iniziale', 'orb', 'crescita per orb', 'legge normale ×4'],
            goldGains.map((g) => [g.size, g.n, Number(g.gain.toFixed(2)), Number((4 * law.A * (g.size / 100) ** law.k).toFixed(2))]));
        } else sec.missing('crescita per orb d\'oro', 'cibo.guadagnoOro', 'serve raccogliere un bottino senza boost');
      } else if (gains.normal.length) {
        sec.item({ key: 'cibo.guadagnoMedio', label: 'guadagno medio per orb normale', value: Number(mean(gains.normal.map((g) => g.gain)).toFixed(3)), n: gains.normal.length, status: 'stimato', detail: `a taglia media ${mean(gains.normal.map((g) => g.size)).toFixed(0)}; una sola fascia di taglia: base ed esponente non sono separabili` });
      } else sec.missing('guadagno per orb', 'cibo.guadagnoBase', 'servono raccolte di un orb solo senza boost');

      // Il limite della coda di crescita, confrontato con quello del sorgente (se c'e').
      const dr = shared.source?.derived?.growthDrainPerTick;
      if (drain.length >= 10 && dr) {
        const cap = (size) => dr.base + dr.perSize * size;
        const ratios = drain.map((d) => d.rate / cap(d.size));
        const sat = ratios.filter((r) => r > 0.8).length;
        sec.item({ key: 'crescita.drenaggioMassimoRapporto', label: `crescita massima per tick / (${dr.base} + ${dr.perSize}·taglia) del sorgente`, value: Number(quantile(ratios, 1).toFixed(3)), n: drain.length,
          detail: `≈ 1 se il limite della coda e' quello del server; ${sat} intervalli saturi (> 0,8). La taglia arriva arrotondata: ±1 per intervallo` });
      }

      if (credit.length) {
        const ratios = credit.map((c) => c.delta / c.value);
        sec.item({ key: 'economia.accreditoOro', label: 'saldo accreditato / valore degli orb d\'oro raccolti', value: Number(median(ratios).toFixed(5)), n: credit.length, detail: '1 = il valore dell\'orb finisce intero nel saldo di chi lo raccoglie' });
      }
      sec.note(`raccolte attribuite ${attributed}, sparizioni non attribuite (bottino scaduto o fuori vista) ${unattributed}; nati per snapshot p50 ${median(addedPerSnap.v) || 0}, spariti p50 ${median(removedPerSnap.v) || 0}`);
      return sec;
    },
  };
}
