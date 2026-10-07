/**
 * La specifica del simulatore: ogni parametro con il suo valore, da dove viene
 * e se la fonte e' stata verificata.
 *
 * Tre fonti, in ordine di autorita':
 *   1. MISURA   — dal traffico: e' cio' che il server ha fatto davvero;
 *   2. LIVE     — impostazioni mandate dal server (user_flags) e lette dalla pagina;
 *   3. SORGENTE — costanti e funzioni del client (il port dichiarato del server).
 * Dove misura e sorgente coesistono si confrontano, e il verdetto finisce nel
 * parametro: «confermato» o «smentito». Dove c'e' solo il sorgente il valore
 * resta, ma marcato come non verificato.
 */

/** Previsioni del sorgente per i parametri misurati: [chiave, funzione, come, tolleranza relativa]. */
const PREDICTIONS = [
  ['tempo.tickRateDichiarato', (c) => c.TICK_RATE, 'TICK_RATE', 1e-9],
  ['movimento.passoBase', (c) => c.BASE_SPEED / c.TICK_RATE, 'BASE_SPEED / TICK_RATE', 0.002],
  ['movimento.passoBoost', (c) => c.BOOST_SPEED / c.TICK_RATE, 'BOOST_SPEED / TICK_RATE', 0.003],
  ['movimento.rampaBoostSalita', (c) => c.BOOST_ACCEL_RATE / c.TICK_RATE, 'BOOST_ACCEL_RATE / TICK_RATE', 0.01],
  ['movimento.rampaBoostDiscesa', (c) => c.BOOST_ACCEL_RATE / c.TICK_RATE, 'BOOST_ACCEL_RATE / TICK_RATE', 0.01],
  ['movimento.sterzataMaxPerTick', (c) => c.TURN_SPEED_PER_SEC / c.TICK_RATE, 'TURN_SPEED_PER_SEC / TICK_RATE', 0.02],
  ['corpo.distanzaAnelli', (c) => c.POINT_DIST * c.SEGMENT_SPACING_TICKS, 'POINT_DIST · SEGMENT_SPACING_TICKS', 0.005],
  ['nascita.tagliaIniziale', (c) => c.START_SIZE, 'START_SIZE', 0.01],
  ['boost.costoProporzionalePerSec', (c) => c.BOOST_BURN_PERCENT_PER_SEC, 'BOOST_BURN_PERCENT_PER_SEC', 0.1],
  ['cibo.raggioRaccoltaNormale', (c, d) => c.MAGNET_RADIUS_BASE + (d.orbRadius?.normal ?? NaN), 'MAGNET_RADIUS_BASE + raggio orb normale', 0.06],
  ['cibo.raggioRaccoltaOro', (c, d) => c.MAGNET_RADIUS_BASE + c.MAGNET_RADIUS_GOLD_BONUS + (d.orbRadius?.gold ?? NaN), 'MAGNET_RADIUS_BASE + GOLD_BONUS + raggio orb oro', 0.06],
  ['cibo.guadagnoBase', (c) => c.BASE_FOOD_SIZE_GAIN, 'BASE_FOOD_SIZE_GAIN', 0.1],
  ['cibo.guadagnoEsponente', (_c, d) => d.gainExponent, 'esponente in proportionalGain()', 0.15],
  ['cibo.guadagnoOroRapporto', (c) => c.BASE_GOLD_SIZE_GAIN / c.BASE_FOOD_SIZE_GAIN, 'BASE_GOLD_SIZE_GAIN / BASE_FOOD_SIZE_GAIN', 0.15],
  ['cibo.guadagnoOro', (c) => c.BASE_GOLD_SIZE_GAIN, 'BASE_GOLD_SIZE_GAIN (il bottino del client usa questo valore fisso)', 0.05],
  ['cibo.inCampoDentroMuro', (c) => c.FOOD_TARGET, 'FOOD_TARGET', 0.1],
  ['arena.raggioInit', (c, _d, s) => c.WORLD_BASE_RADIUS ?? s.mapBaseRadius, 'WORLD_BASE_RADIUS', 1e-6],
  ['arena.raggioBase', (c, _d, s) => c.WORLD_BASE_RADIUS ?? s.mapBaseRadius, 'WORLD_BASE_RADIUS', 0.005],
  ['cashout.durataMs', (c) => c.CASHOUT_HOLD_MS, 'CASHOUT_HOLD_MS', 0.02],
  ['cashout.velocitaFinaleFrazione', (c) => c.CASHOUT_SLOW_MIN_MULT, 'CASHOUT_SLOW_MIN_MULT', 0.1],
  ['cashout.rallentamentoMassimo', (c) => 1 - c.CASHOUT_SLOW_MIN_MULT, '1 − CASHOUT_SLOW_MIN_MULT', 0.05],
  ['cashout.esponenteRallentamento', (_c, d) => d.cashoutExponent, 'esponente in Math.pow(t, ·) di stepMovement', 0.04],
  ['economia.tagliaMaxPerPosta', (c) => c.MAX_SIZE_PER_DOLLAR, 'MAX_SIZE_PER_DOLLAR (tetto: la misura deve restarci sotto)', 'tetto'],
  ['arena.muroFattoreSpessore', (_c, d) => d.wallHeadFactor, 'thickness · k in stepMovement (morte sul muro)', 'intervallo'],
  ['bottino.anelliPerOrb', (_c, d) => d.lootStep?.min, 'step = max(min, floor(anelli/divisore)) in killPlayer', 'intervallo'],
];

/** Parametri che esistono solo nel sorgente o nelle impostazioni live (nessuna misura possibile o fatta). */
const SOURCE_ONLY = [
  ['corpo.distanzaPuntiPercorso', (c) => c.POINT_DIST, 'POINT_DIST', 'u'],
  ['corpo.puntiPerAnello', (c) => c.SEGMENT_SPACING_TICKS, 'SEGMENT_SPACING_TICKS', 'punti'],
  ['corpo.tagliaMinima', (c) => c.MIN_SIZE, 'MIN_SIZE', 'taglia'],
  ['crescita.drenaggioPerTick', (_c, d) => d.growthDrainPerTick, 'maxPerTick = base + taglia·perSize in stepMovement', 'taglia/tick'],
  ['interpolazione.ritardoRenderMs', (c) => c.BUF, 'BUF', 'ms'],
  ['interpolazione.snapshotInBuffer', (c) => c.MAX_SNAPS, 'MAX_SNAPS', ''],
];

const COMBAT_KEYS = ['HITBOX_BASE', 'combatHitboxScale', 'combatHeadHitboxScale', 'combatHeadOnFacingDegrees', 'combatHeadOnRule', 'combatFrontArcOnly', 'combatFrontArcDegrees', 'combatHitboxGrowthRate'];

/** I parametri di combattimento in vigore: live se il server li ha mandati, altrimenti i default del sorgente. */
export function resolveCombat(runtime, model) {
  const live = runtime.get('server.gameSettings')?.value ?? runtime.get('window._gameSettings')?.value ?? null;
  const liveFlat = live ? { ...live, ...(live.combatSettings ?? {}) } : {};
  const fromServer = runtime.has('server.gameSettings');
  const out = { fonte: fromServer ? 'live (user_flags)' : live ? 'pagina (window._gameSettings)' : 'sorgente' };
  for (const k of COMBAT_KEYS) {
    if (liveFlat[k] !== undefined) out[k] = liveFlat[k];
    else if (model?.settings?.[k] !== undefined) out[k] = model.settings[k];
    else if (model?.consts?.[k] !== undefined) out[k] = model.consts[k];
  }
  if (out.HITBOX_BASE === undefined && model?.consts?.HITBOX_BASE !== undefined) out.HITBOX_BASE = model.consts.HITBOX_BASE;
  out.mapBaseRadius = liveFlat.mapBaseRadius ?? model?.settings?.mapBaseRadius;
  return out;
}

/** Le grandezze condivise che i moduli usano in finalize. */
export function sharedContext(analyzer, model) {
  const clock = analyzer.byId.clock;
  const mv = analyzer.byId.movement;
  const hz = clock.measuredHz()?.hz ?? null;
  const declared = analyzer.sessions.concat(analyzer.ctx ? [analyzer.ctx.info()] : []).map((s) => s.declaredTickRate).find(Number.isFinite);
  return {
    hz,
    declaredHz: declared ?? model?.consts?.TICK_RATE ?? 60,
    steps: { base: mv.baseStep(), boost: mv.boostStep() },
    combat: resolveCombat(analyzer.runtime, model),
    source: model ? { consts: model.consts, fn: model.fn, derived: model.derived } : null,
    arenaBase: model?.consts?.WORLD_BASE_RADIUS,
  };
}

function verdict(measured, predicted, tol) {
  if (typeof measured === 'number' && !Number.isFinite(measured)) return null;
  if (predicted === undefined || predicted === null || (typeof predicted === 'number' && !Number.isFinite(predicted))) return null;
  if (measured === null || measured === undefined) return null;
  // Un tetto non superato non prova che esista: solo superarlo dice qualcosa.
  if (tol === 'tetto') return typeof measured === 'number' ? (measured <= predicted * 1.01 ? 'non superato' : 'smentito') : null;
  if (tol === 'intervallo') {
    if (measured && typeof measured === 'object' && Number.isFinite(measured.min)) return predicted >= measured.min - 1e-6 && predicted <= measured.max + 1e-6 ? 'compatibile' : 'smentito';
    if (typeof measured === 'number') return measured === predicted ? 'confermato' : 'smentito';
    return null;
  }
  if (typeof measured !== 'number' || typeof predicted !== 'number') return measured === predicted ? 'confermato' : 'smentito';
  const r = Math.abs(measured - predicted) / Math.max(Math.abs(predicted), 1e-12);
  return r <= tol ? 'confermato' : 'smentito';
}

/**
 * Costruisce `simulatore.json`: parametri, formule, ordine del tick,
 * impostazioni live. `report` e' l'uscita di analyzer.finalize().
 */
export function buildSpec({ report, model, shared, runtime }) {
  const params = {};
  for (const sec of report.sections) {
    for (const it of sec.items) {
      if (!it.key) continue;
      const bad = typeof it.value === 'number' && !Number.isFinite(it.value);
      params[it.key] = {
        valore: bad ? null : it.value, unita: it.unit ?? null, fonte: it.value === null || bad ? null : 'misura', stato: it.status,
        n: it.n ?? null, descrizione: it.label, dettaglio: it.detail ?? null, sezione: sec.id,
      };
    }
  }
  const c = model?.consts ?? {};
  const d = model?.derived ?? {};
  const s = model?.settings ?? {};
  for (const [key, f, how, tol] of PREDICTIONS) {
    let pred;
    try { pred = f(c, d, s); } catch { pred = undefined; }
    if (pred === undefined || (typeof pred === 'number' && !Number.isFinite(pred))) continue;
    const p = params[key] ?? { valore: null, fonte: null, stato: 'non misurato', descrizione: key };
    p.sorgente = { valore: typeof pred === 'number' ? Number(pred.toPrecision(10)) : pred, come: how };
    p.verdetto = verdict(p.valore, pred, tol) ?? (p.valore === null ? 'solo sorgente' : null);
    if (p.valore === null || p.valore === undefined) { p.valore = p.sorgente.valore; p.fonte = 'sorgente (non verificato)'; }
    params[key] = p;
  }
  for (const [key, f, how, unit] of SOURCE_ONLY) {
    if (params[key]) continue;
    let v; try { v = f(c, d, s); } catch { v = undefined; }
    if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) continue;
    params[key] = { valore: v, unita: unit, fonte: 'sorgente (non verificato)', stato: 'non misurabile dal traffico', descrizione: how, sorgente: { valore: v, come: how }, verdetto: 'solo sorgente' };
  }
  for (const [k, v] of Object.entries(shared.combat)) {
    if (k === 'fonte' || v === undefined) continue;
    params[`combattimento.${k}`] = { valore: v, fonte: shared.combat.fonte, stato: 'impostazione', descrizione: k };
  }

  // Nelle formule un valore che non viene dalla misura porta un asterisco:
  // mescolare un numero verificato con uno solo dichiarato non deve passare inosservato.
  const unverified = (k) => params[k] && params[k].fonte !== 'misura' && !String(params[k].fonte ?? '').startsWith('live');
  const P = (k) => params[k]?.valore;
  const num = (x, dgt = 6) => (Number.isFinite(x) ? Number(x.toPrecision(dgt)) : '?');
  const V = (k, dgt = 6) => {
    const v = P(k);
    const txt = typeof v === 'number' ? num(v, dgt) : v === undefined || v === null ? '?' : typeof v === 'object' ? JSON.stringify(v) : v;
    return unverified(k) ? `${txt}*` : `${txt}`;
  };
  const hz = shared.hz;
  const formule = [
    `tick: il mondo avanza a passi discreti. Dichiarati ${V('tempo.tickRateDichiarato')} Hz; frequenza vera ${num(hz)} Hz. TUTTO va simulato in tick; i secondi servono solo dove il client usa l'orologio (cashout).`,
    `sterzata per tick: angolo += segno(diff)·min(|diff|, ${V('movimento.sterzataMaxPerTick')}), diff = normalizza(targetDir − angolo). Prima si ruota, poi si avanza.`,
    `boost: boostAmount += ${V('movimento.rampaBoostSalita')} per tick se premuto, −= ${V(params['movimento.rampaBoostDiscesa'] ? 'movimento.rampaBoostDiscesa' : 'movimento.rampaBoostSalita')} se rilasciato, in [0, 1].`,
    `passo per tick: ${V('movimento.passoBase')} + (${V('movimento.passoBoost')} − ${V('movimento.passoBase')})·boostAmount; posizione += (cos, sin)(angolo)·passo.`,
    `corpo: un punto di percorso ogni ${V('corpo.distanzaPuntiPercorso')} u percorse; un anello ogni ${V('corpo.puntiPerAnello')} punti (= ${V('corpo.distanzaAnelli')} u). Anelli e spessore: segmentsForSize() e thicknessForSegments() del sorgente (sorgente/funzioni/).`,
    `costo del boost per tick: taglia −= (b + a·taglia)·boostAmount con ${V('boost.costo')}; taglia minima ${V('corpo.tagliaMinima')}.`,
    `cibo: raggio di raccolta = spessore + ${V('cibo.raggioRaccoltaNormale')} (oro: + ${V('cibo.raggioRaccoltaOro')}); crescita = ${V('cibo.guadagnoBase')}·(taglia/100)^${V('cibo.guadagnoEsponente')}, un orb d'oro +${V('cibo.guadagnoOro')} fissi; la crescita entra in coda e si applica al massimo ${V('crescita.drenaggioPerTick')} per tick.`,
    `cibo in campo: ${V('cibo.inCampoDentroMuro')} orb dentro il muro, seminati uniformi per area fino a raggio ${V('cibo.raggioDiscoSeminato')}; oro spontaneo osservato: ${V('cibo.oroSpontaneo')}.`,
    `arena: raggio bersaglio = ${V('arena.raggioBase')} + ${V('arena.raggioPerSerpente')}·(n − 1); r += (bersaglio − r)·${V('arena.rilassamentoPerTick')} per tick.`,
    `muro: morte se dist(testa, centro) + k·spessore > r, k = ${V('arena.muroFattoreSpessore')}.`,
    `collisioni: testa-corpo se d ≤ spessoreA·${V('combattimento.HITBOX_BASE')}·${V('combattimento.combatHitboxScale')}·${V('combattimento.combatHeadHitboxScale')} + spessoreB·${V('combattimento.HITBOX_BASE')}·${V('combattimento.combatHitboxScale')}; frontale (entrambi entro ${V('combattimento.combatHeadOnFacingDegrees')}°) regola «${V('combattimento.combatHeadOnRule')}».`,
    `morte: ceil(anelli/${V('bottino.anelliPerOrb')}) orb d'oro sugli anelli 0, N, 2N… per ${V('bottino.frazioneDelSaldo')}·saldo, divisi in parti uguali; chi ha il raggio di raccolta sopra li prende nello stesso tick; scadono dopo ${V('bottino.durataMs')} ms. L'uccisore non riceve altro.`,
    `cashout: ${V('cashout.tick')} tick (${V('cashout.durataMs')} ms); velocita' = base·(1 − ${V('cashout.rallentamentoMassimo')}·t^${V('cashout.esponenteRallentamento')}); sterzo bloccato; commissione ${V('economia.rakeCashout')}.`,
    '* = valore dal sorgente o non misurato: da verificare. ? = non ancora disponibile.',
  ];


  const protocol = report.sections.find((x) => x.id === 'protocollo');
  return {
    generato: new Date().toISOString(),
    sessioni: report.sessions.map((x) => ({ nome: x.name, durataS: x.durationS, snapshot: x.snapshots, inizio: x.start })),
    leggimi: 'valore = cio\' che il simulatore deve usare. fonte: misura (traffico) > live (server) > sorgente (client, non verificato). verdetto: confronto fra misura e sorgente.',
    parametri: Object.fromEntries(Object.entries(params).sort((a, b) => a[0].localeCompare(b[0]))),
    formule,
    ordineTick: model?.tickOrder ?? [],
    impostazioniLive: Object.fromEntries([...runtime.entries()].filter(([k]) => /Settings|MS_REGION/.test(k)).map(([k, v]) => [k, v])),
    funzioniEseguibili: Object.keys(model?.fn ?? {}),
    messaggi: protocol?.tables?.[0]?.rows?.map((r) => ({ direzione: r[0], t: r[1], conteggio: r[2], hz: r[3] })) ?? [],
  };
}
