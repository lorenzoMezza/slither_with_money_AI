/**
 * Il ciclo di vita e l'economia: nascita, morte, bottino, scadenza del
 * bottino, uccisioni, uscita con cashout, saldo e posta.
 *
 * Il server non manda eventi per quasi nulla di questo: si deduce dagli
 * snapshot. Una morte e' un serpente che passa ad `alive: false`; il bottino
 * sono gli orb d'oro che compaiono lungo il suo corpo nello stesso momento; la
 * scadenza e' il bottino che sparisce senza che nessuna testa gli passi vicino.
 */
import { foodKey, isAlive, Section } from '../engine.js';
import { distToSegment, histogram, hyp, mean, median, quantile, Sample, wrap } from '../stats.js';

export function createLife() {
  const lastAlive = new Map();      // id -> {p, ms, ts}
  const deaths = [];                // morti con bottino
  const pendingLoot = [];           // morti in attesa del bottino (uno snapshot di tolleranza)
  const drops = new Map();          // chiave orb -> {death, ms}
  const lifetimes = [];             // {death, ms, how}
  const kills = [];
  const youDied = [];
  const spawns = [];
  const exits = [];                 // spariti da vivi
  const respawnDelay = new Sample(500);
  let ownDeathMs = null;
  let prevFoods = null;
  const buyIns = new Map();
  const spawnBalance = [];
  let sizePerStake = 0; let sizePerStakeWho = null;
  const bounty = new Map();
  const lobbies = new Set();
  const cashouts = [];
  const rain = [];
  const misc = new Map();           // tipo -> esempio, per i messaggi di economia
  let primed = false;               // il primo snapshot della sessione mostra chi c'era gia'
  let prevSnap = null;

  const lootNear = (orb, segs) => {
    let best = Infinity;
    for (let i = 1; i < segs.length; i += 1) {
      const d = distToSegment(orb[0], orb[1], segs[i - 1][0], segs[i - 1][1], segs[i][0], segs[i][1]);
      if (d < best) best = d;
    }
    if (segs.length === 1) best = hyp(orb[0] - segs[0][0], orb[1] - segs[0][1]);
    return best;
  };

  return {
    id: 'life',
    beginSession() { lastAlive.clear(); pendingLoot.length = 0; prevFoods = null; ownDeathMs = null; primed = false; prevSnap = null; },
    onMessage(msg, fr, ctx) {
      if (fr.d !== 'i') return;
      switch (msg.t) {
        case 'kill': kills.push({ ms: fr.ms, session: ctx.name, killer: msg.killer, victim: msg.victim, streak: msg.streak, keys: Object.keys(msg) }); break;
        case 'you_died': youDied.push({ ms: fr.ms, ...msg, t: undefined }); ctx.emit('morte_propria', { causa: msg.reason, da: msg.killer }, fr.ms); break;
        case 'init': if (Array.isArray(msg.lobbies)) msg.lobbies.forEach((l) => lobbies.add(JSON.stringify(l))); break;
        case 'cashout_result': {
          const pay = Number(msg.payoutLamports); const rake = Number(msg.rakeLamports);
          cashouts.push({ ms: fr.ms, ...msg, t: undefined, rakeFraction: pay + rake > 0 ? rake / (pay + rake) : null });
          ctx.emit('cashout', { pagato: msg.payoutUsd, trattenuto: msg.rakeUsd }, fr.ms);
          break;
        }
        case 'rain_started': case 'rain_ended': rain.push({ ms: fr.ms, t: msg.t, ...msg }); ctx.emit(msg.t, {}, fr.ms); break;
        case 'auth_ok': case 'join_ok': case 'xp_update': case 'respawn_ok': case 'respawn_err': case 'join_err': case 'join_error':
          if (!misc.has(msg.t)) misc.set(msg.t, Object.keys(msg));
          break;
        default: break;
      }
    },
    onState(snap, pair, ctx) {
      const cur = new Map();
      for (const f of snap.foods) if (Array.isArray(f)) cur.set(foodKey(f), f);
      const added = prevFoods ? [...cur.entries()].filter(([k]) => !prevFoods.has(k)).map(([, f]) => f) : [];

      // --- morti e uscite -----------------------------------------------------------
      for (const [id, l] of lastAlive) {
        const p = snap.players.get(id);
        if (isAlive(p)) continue;
        lastAlive.delete(id);
        // Chi completa il cashout passa ad alive:false come chi muore: lo
        // distingue la carica arrivata in fondo nell'ultimo snapshot da vivo.
        const cashedOut = l.p.cashingOut && Number(l.p.cashoutProgress) >= 0.95;
        if (p && p.alive === false && !cashedOut) {
          const segs = Array.isArray(l.p.segs) ? l.p.segs : [];
          // Variazioni di saldo degli altri nello stesso intervallo: e' cosi' che si
          // vede se l'uccisore incassa qualcosa direttamente, senza raccogliere.
          const deltas = [];
          for (const q of snap.alive) {
            const before = prevSnap?.players.get(q.id);
            if (before && Number.isFinite(q.balance) && Number.isFinite(before.balance)) deltas.push({ name: q.name, delta: q.balance - before.balance });
          }
          const d = { session: ctx.name, ms: snap.ms, id, name: l.p.name, size: l.p.size, balance: l.p.balance, buyIn: l.p.buyIn, rings: segs.length, thickness: l.p.thickness, segs, loot: [], self: id === ctx.ownId, cause: null, deltas };
          pendingLoot.push({ d, until: snap.idx + 2 });
          deaths.push(d);
          if (deaths.length > 3000) deaths.shift();
          if (d.self) ownDeathMs = snap.ms;
          ctx.emit('morte', { nome: d.name, taglia: d.size, saldo: d.balance }, snap.ms);
        } else {
          exits.push({ ms: snap.ms, name: l.p.name, cashed: cashedOut, progress: l.p.cashoutProgress, balance: l.p.balance, segs: l.p.segs ?? [], lootAfter: 0, until: snap.idx + 2, stillListed: Boolean(p) });
          if (cashedOut) ctx.emit('uscita_cashout', { nome: l.p.name, saldo: l.p.balance }, snap.ms);
          if (exits.length > 3000) exits.shift();
        }
      }

      // --- bottino: oro nuovo lungo il corpo di chi e' appena morto ---------------------
      for (let i = pendingLoot.length - 1; i >= 0; i -= 1) {
        const { d, until } = pendingLoot[i];
        for (const f of added) {
          if (d.segs.length && lootNear(f, d.segs) <= (d.thickness ?? 15) + 40) {
            let ring = 0; let best = Infinity;
            d.segs.forEach((g, i) => { const dd = hyp(f[0] - g[0], f[1] - g[1]); if (dd < best) { best = dd; ring = i; } });
            d.loot.push({ kind: f[2], value: Number(f[4]) || 0, dist: lootNear(f, d.segs), ring, ringDist: best });
            if (f[2] === 'gold') drops.set(foodKey(f), { d, ms: snap.ms });
          }
        }
        if (snap.idx >= until) pendingLoot.splice(i, 1);
      }
      for (const e of exits) {
        if (e.until < snap.idx || !e.segs.length) continue;
        for (const f of added) if (f[2] === 'gold' && lootNear(f, e.segs) <= 60) e.lootAfter += 1;
      }

      // --- scadenza del bottino ---------------------------------------------------------
      if (prevFoods && drops.size) {
        for (const [k, info] of drops) {
          if (cur.has(k)) continue;
          drops.delete(k);
          const orb = prevFoods.get(k);
          let eaten = false;
          if (orb && pair?.ok) {
            for (const t of pair.tx) {
              if (distToSegment(orb[0], orb[1], t.a.hx, t.a.hy, t.b.hx, t.b.hy) <= (t.b.thickness ?? 15) + 60) { eaten = true; break; }
            }
          }
          lifetimes.push({ d: info.d, ms: snap.ms - info.ms, how: eaten ? 'raccolto' : 'scaduto' });
        }
      }

      // --- nascite ---------------------------------------------------------------------
      for (const p of snap.alive) {
        if (!lastAlive.has(p.id) && primed) {
          const R = snap.r;
          const r = hyp(p.hx - snap.cx, p.hy - snap.cy);
          const inward = wrap(p.angle - Math.atan2(snap.cy - p.hy, snap.cx - p.hx));
          if (spawns.length < 5000) spawns.push({ ms: snap.ms, name: p.name, rNorm: Number.isFinite(R) ? r / R : null, r, inward, size: p.size, balance: p.balance, buyIn: p.buyIn, self: p.id === ctx.ownId });
          if (p.id === ctx.ownId) {
            if (ownDeathMs != null) respawnDelay.push(snap.ms - ownDeathMs);
            ownDeathMs = null;
            ctx.emit('nascita_propria', { taglia: p.size, saldo: p.balance }, snap.ms);
          }
          if (Number.isFinite(p.buyIn)) {
            buyIns.set(p.buyIn, (buyIns.get(p.buyIn) ?? 0) + 1);
            if (Number.isFinite(p.balance)) spawnBalance.push(p.balance / p.buyIn);
          }
        }
        lastAlive.set(p.id, { p, ms: snap.ms, ts: snap.ts });
        if (Number.isFinite(p.balance) && Number.isFinite(p.buyIn) && p.balance > 0 && p.buyIn > 0) {
          const v = p.size / (p.balance / p.buyIn);
          if (v > sizePerStake) { sizePerStake = v; sizePerStakeWho = { name: p.name, size: p.size, balance: p.balance, buyIn: p.buyIn }; }
        }
        if (p.bounty !== undefined) bounty.set(JSON.stringify(p.bounty), (bounty.get(JSON.stringify(p.bounty)) ?? 0) + 1);
      }
      prevFoods = cur;
      prevSnap = snap;
      primed = true;
    },

    finalize(shared) {
      const sec = new Section('vita', 'Nascita, morte, bottino ed economia', 'Dedotto dagli snapshot: il server non manda eventi per la maggior parte di queste cose.');
      const src = shared.source?.consts ?? {};

      // Cause: kill e you_died si legano alle morti per nome e tempo.
      for (const d of deaths) {
        const k = kills.find((x) => x.victim === d.name && Math.abs(x.ms - d.ms) < 2500 && x.session === d.session);
        if (k) d.cause = k.killer === 'WALL' ? 'muro' : `ucciso da ${k.killer}`;
      }
      const withLoot = deaths.filter((d) => d.loot.some((l) => l.kind === 'gold'));
      if (withLoot.length) {
        // Un orb che nasce dentro il raggio di raccolta di qualcuno viene mangiato
        // nello STESSO tick e non compare mai in uno snapshot. Si ricostruisce dai
        // saldi: chi nell'istante della morte guadagna un multiplo esatto del
        // valore di un orb ne ha raccolti tanti quanti quel multiplo.
        const rows = withLoot.map((d) => {
          const gold = d.loot.filter((l) => l.kind === 'gold');
          const per = gold[0]?.value ?? 0;
          let hidden = 0; let hiddenValue = 0; const takers = [];
          for (const x of d.deltas ?? []) {
            if (!(x.delta > 0) || !(per > 0)) continue;
            const k = Math.round(x.delta / per);
            if (k >= 1 && Math.abs(x.delta - k * per) < 1e-6) { hidden += k; hiddenValue += x.delta; takers.push(`${x.name}×${k}`); }
          }
          const value = gold.reduce((s, l) => s + l.value, 0) + hiddenValue;
          return { d, n: gold.length + hidden, visible: gold.length, hidden, takers, value, normals: d.loot.length - gold.length };
        });
        // Tutti i divisori compatibili con TUTTE le morti: con poche morti sono piu'
        // d'uno, e dirlo e' meglio che sceglierne uno a caso.
        const fits = [];
        for (let k = 1; k <= 30; k += 1) if (rows.every((r) => r.n === Math.ceil(r.d.rings / k))) fits.push(k);
        if (fits.length) {
          sec.item({ key: 'bottino.anelliPerOrb', label: 'un orb di bottino ogni N anelli (orb = ceil(anelli/N))', value: fits.length === 1 ? fits[0] : { min: fits[0], max: fits[fits.length - 1] }, n: rows.length,
            status: fits.length === 1 ? 'misurato' : 'stimato', detail: fits.length === 1 ? `l'unico N che spiega tutte le ${rows.length} morti` : `N fra ${fits[0]} e ${fits[fits.length - 1]} spiegano tutte le ${rows.length} morti: servono morti a taglie diverse per stringere` });
        } else sec.item({ key: 'bottino.anelliPerOrb', label: 'orb di bottino = ceil(anelli/N)', value: null, status: 'insufficiente', n: rows.length, detail: 'nessun N spiega tutte le morti: la regola non dipende (solo) dagli anelli' });
        const orbValue = rows.flatMap((r) => r.d.loot.filter((l) => l.kind === 'gold').map((l) => l.value));
        sec.item({ key: 'bottino.valoreOrb', label: 'valore di un orb di bottino', value: Object.fromEntries(histogram(orbValue.map((v) => Number(v.toFixed(6))))), n: orbValue.length, status: 'osservato' });
        const ratio = rows.filter((r) => r.d.balance > 0).map((r) => r.value / r.d.balance);
        if (ratio.length) sec.item({ key: 'bottino.frazioneDelSaldo', label: 'valore totale del bottino / saldo della vittima', value: Number(median(ratio).toFixed(5)), n: ratio.length });
        const even = rows.filter((r) => r.n > 1).map((r) => {
          const vals = r.d.loot.filter((l) => l.kind === 'gold').map((l) => l.value);
          return Math.max(...vals) - Math.min(...vals) < 1e-9;
        });
        if (even.length) sec.item({ key: 'bottino.valoreUguale', label: 'il valore e\' diviso in parti uguali fra gli orb', value: even.every(Boolean), n: even.length, status: 'osservato' });
        sec.item({ key: 'bottino.massaRilasciata', label: 'orb normali comparsi lungo il cadavere (massa rilasciata)', value: median(rows.map((r) => r.normals)), n: rows.length, status: 'osservato', detail: '0 = la morte lascia solo denaro, non taglia' });
        const dists = rows.flatMap((r) => r.d.loot.filter((l) => l.kind === 'gold').map((l) => l.dist));
        sec.item({ key: 'bottino.distanzaDalCorpo', label: 'distanza degli orb di bottino dalla linea del corpo', value: Number(quantile(dists, 0.95).toFixed(3)), unit: 'u', n: dists.length, status: 'osservato', detail: `p50 ${median(dists).toFixed(3)} · max ${quantile(dists, 1).toFixed(3)}` });
        // Distanza fra orb consecutivi lungo il corpo, in anelli (sul corpo dell'ultimo
        // snapshot da vivo: il cadavere nel frattempo e' avanzato di 2-3 tick, quindi
        // e' una stima con l'errore di un anello).
        const gaps = [];
        for (const r of rows) {
          const idx = r.d.loot.filter((l) => l.kind === 'gold').map((l) => l.ring).sort((x, y) => x - y);
          for (let i = 1; i < idx.length; i += 1) gaps.push(idx[i] - idx[i - 1]);
        }
        if (gaps.length) {
          const dev = rows.flatMap((r) => r.d.loot.filter((l) => l.kind === 'gold').map((l) => l.ringDist));
          sec.item({ key: 'bottino.spaziaturaInAnelli', label: 'anelli fra due orb di bottino consecutivi lungo il corpo', value: Number(mean(gaps).toFixed(2)), n: gaps.length, status: 'stimato',
            detail: `mediana ${median(gaps)}; scarto dell'orb dalla linea del corpo: mediana ${median(dev).toFixed(2)} u, massimo ${quantile(dev, 1).toFixed(2)} u` });
        }
        const hiddenTot = rows.reduce((a, r) => a + r.hidden, 0);
        sec.item({ key: 'bottino.raccoltoNelloStessoTick', label: 'orb di bottino mangiati nel tick stesso della morte (mai visibili)', value: hiddenTot, n: rows.length, status: 'osservato', detail: 'ricostruiti dai saldi: chi era col raggio di raccolta sul cadavere li prende prima che esistano in uno snapshot' });
        sec.table('Morti con bottino', ['vittima', 'causa', 'taglia', 'anelli', 'saldo', 'orb visibili', 'orb presi subito', 'orb totali', 'valore totale', 'orb normali'],
          rows.slice(-40).map((r) => [r.d.name, r.d.cause ?? '?', r.d.size, r.d.rings, r.d.balance, r.visible, r.hidden ? `${r.hidden} (${r.takers.join(', ')})` : 0, r.n, Number(r.value.toFixed(6)), r.normals]));
      } else sec.missing('bottino alla morte', 'bottino.anelliPerOrb', 'serve una morte osservata (anche sul muro)');

      const expired = lifetimes.filter((l) => l.how === 'scaduto');
      if (expired.length) {
        sec.item({ key: 'bottino.durataMs', label: 'durata del bottino non raccolto', value: Math.round(median(expired.map((l) => l.ms))), unit: 'ms', n: expired.length, detail: `p05 ${quantile(expired.map((l) => l.ms), 0.05).toFixed(0)} · p95 ${quantile(expired.map((l) => l.ms), 0.95).toFixed(0)} ms` });
        const byDeath = new Map();
        for (const l of expired) { const a = byDeath.get(l.d) ?? []; a.push(l.ms); byDeath.set(l.d, a); }
        const spreads = [...byDeath.values()].filter((a) => a.length > 1).map((a) => Math.max(...a) - Math.min(...a));
        if (spreads.length) sec.item({ key: 'bottino.scadeTuttoInsieme', label: 'il bottino di una morte scade tutto insieme', value: median(spreads) < 200, n: spreads.length, status: 'osservato', detail: `scarto mediano fra il primo e l'ultimo orb scaduto: ${median(spreads).toFixed(0)} ms` });
      } else sec.missing('durata del bottino', 'bottino.durataMs', 'serve lasciare un bottino a terra per qualche minuto');

      const cashExits = exits.filter((e) => e.cashed);
      if (cashExits.length) {
        sec.item({ key: 'cashout.lasciaBottino', label: 'chi completa il cashout lascia orb a terra', value: cashExits.some((e) => e.lootAfter > 0), n: cashExits.length, status: 'osservato' });
        sec.item({ key: 'cashout.restaNelloSnapshot', label: 'dopo il cashout il serpente resta nello snapshot con alive:false', value: cashExits.every((e) => e.stillListed), n: cashExits.length, status: 'osservato', detail: 'false = sparisce dalla lista dei giocatori' });
      }

      if (kills.length) {
        sec.item({ key: 'morte.campiKill', label: 'campi del messaggio kill', value: [...new Set(kills.flatMap((k) => k.keys))], n: kills.length, status: 'osservato' });
        sec.table('Uccisioni (ultime 30)', ['uccisore', 'vittima', 'serie'], kills.slice(-30).map((k) => [k.killer, k.victim, k.streak ?? '–']));
      }
      if (youDied.length) sec.table('Messaggi you_died', ['causa', 'uccisore', 'campi'], youDied.slice(-20).map((y) => [y.reason ?? '?', y.killer ?? '–', Object.keys(y).filter((k) => k !== 'ms' && k !== 't').join(', ')]));

      // --- nascita ---
      const sp = spawns.filter((s) => s.rNorm != null);
      if (sp.length >= 3) {
        sec.item({ key: 'nascita.tagliaIniziale', label: 'taglia alla nascita', value: median(spawns.map((s) => s.size)), n: spawns.length, status: 'osservato' });
        sec.item({ key: 'nascita.raggioRelativo', label: 'distanza dal centro alla nascita (frazione del raggio)', value: { p05: Number(quantile(sp.map((s) => s.rNorm), 0.05).toFixed(3)), p50: Number(median(sp.map((s) => s.rNorm)).toFixed(3)), max: Number(quantile(sp.map((s) => s.rNorm), 1).toFixed(3)) }, n: sp.length, status: 'osservato' });
        sec.item({ key: 'nascita.direzioneVersoCentro', label: 'angolo iniziale rispetto alla direzione del centro', value: Number(median(sp.map((s) => Math.abs(s.inward))).toFixed(3)), unit: 'rad', n: sp.length, status: 'osservato', detail: '0 = nasce puntando al centro; ~1,57 = direzione casuale' });
      }
      if (spawnBalance.length) sec.item({ key: 'nascita.saldoSuPosta', label: 'saldo alla nascita / posta', value: Number(median(spawnBalance).toFixed(4)), n: spawnBalance.length, status: 'osservato' });
      if (respawnDelay.length) sec.item({ key: 'nascita.ritardoRinascitaMs', label: 'dalla propria morte alla nuova nascita', value: Math.round(median(respawnDelay.v)), unit: 'ms', n: respawnDelay.length, status: 'osservato', detail: 'comprende il tempo che ci hai messo a premere «gioca»' });

      // --- economia ---
      if (lobbies.size) sec.item({ key: 'economia.lobby', label: 'lobby dichiarate in init', value: [...lobbies].map((l) => JSON.parse(l)), status: 'osservato' });
      if (buyIns.size) sec.item({ key: 'economia.posteViste', label: 'poste (buyIn) viste', value: Object.fromEntries(histogram([...buyIns.entries()].flatMap(([k, n]) => Array(n).fill(k)))), status: 'osservato' });
      if (sizePerStakeWho) {
        const cap = src.MAX_SIZE_PER_DOLLAR;
        sec.item({ key: 'economia.tagliaMaxPerPosta', label: 'taglia massima osservata per unita\' di saldo/posta', value: Number(sizePerStake.toFixed(1)), status: 'osservato',
          detail: `${sizePerStakeWho.name}: taglia ${sizePerStakeWho.size} con saldo ${sizePerStakeWho.balance} e posta ${sizePerStakeWho.buyIn}${Number.isFinite(cap) ? `. Il sorgente dichiara un tetto di ${cap}: ${sizePerStake > cap + 1 ? 'SUPERATO, quindi il server non lo applica' : 'mai superato'}` : ''}` });
      }
      if (cashouts.length) {
        const rk = cashouts.map((c) => c.rakeFraction).filter(Number.isFinite);
        if (rk.length) sec.item({ key: 'economia.rakeCashout', label: 'commissione trattenuta al cashout', value: Number(median(rk).toFixed(6)), n: rk.length, detail: 'rakeLamports / (payoutLamports + rakeLamports)' });
        sec.table('Cashout', ['saldo', 'pagato $', 'trattenuto $', 'prezzo SOL', 'campi'], cashouts.slice(-20).map((c) => [c.balance, c.payoutUsd, c.rakeUsd, c.solPrice, Object.keys(c).filter((k) => k !== 'ms').join(', ')]));
      }
      if (bounty.size) sec.item({ key: 'economia.taglieValoriBounty', label: 'valori del campo bounty', value: Object.fromEntries(bounty), status: 'osservato' });
      if (rain.length) sec.table('Money rain', ['evento', 'campi'], rain.map((r) => [r.t, Object.keys(r).filter((k) => k !== 'ms' && k !== 't').join(', ')]));
      else sec.missing('money rain', 'economia.moneyRain', 'nessun evento rain_started osservato');
      for (const [t, keys] of misc) sec.note(`${t}: campi ${keys.join(', ')}`);
      sec.note(`morti osservate ${deaths.length}, con bottino d'oro ${withLoot.length}, uscite da vivi ${exits.length} (di cui con cashout completo ${cashExits.length})`);
      return sec;
    },

    counts() { return { deaths: deaths.length, kills: kills.filter((k) => k.killer !== 'WALL').length, cashouts: cashouts.length, expired: lifetimes.filter((l) => l.how === 'scaduto').length, rain: rain.length, respawns: respawnDelay.length }; },
  };
}
