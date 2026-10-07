/**
 * Il motore dell'analisi. Consuma le righe dello stream di rete — dal vivo,
 * mentre il registratore le scrive, oppure rileggendo una sessione salvata: il
 * codice e' lo stesso — e le passa ai moduli di misura gia' interpretate:
 *
 *   onMessage(msg, fr, ctx)   ogni messaggio JSON, in entrambe le direzioni
 *   onState(snap, pair, ctx)  ogni snapshot di stato, con la transizione dal precedente
 *   finalize(shared)          riduzione a numeri: una sezione del rapporto
 *
 * IL METODO, che vale per ogni modulo: il server avanza a tick discreti, quindi
 * quasi ogni grandezza osservabile e' QUANTIZZATA, e una grandezza quantizzata
 * si misura contando i gradini (esatto) invece di mediarne il rumore (distorto).
 *
 * Il numero di tick fra due snapshot NON si ricava dal `ts`: il `ts` e' l'ora
 * d'invio dello snapshot, presa da un timer diverso da quello del tick (uno
 * snapshot con Δts = 48 ms puo' contenere 2 tick, uno con 33 ms anche 1). Si
 * ricava dallo SPOSTAMENTO: un serpente che va dritto a boost costante avanza di
 * un multiplo esatto del passo. Solo dove nessuno lo permette si ripiega sul `ts`
 * (`pair.ticksFrom` dice quale dei due).
 */
import { createModules } from './modules/index.js';
import { capPush, hyp, stepFromChord, wrap } from './stats.js';

/** Oltre questo numero di tick fra due snapshot l'intervallo non serve alla fisica. */
export const MAX_PAIR_TICKS = 8;

export const isAlive = (p) => !!p && p.alive !== false && !p.spectator;
export const foodKey = (f) => `${f[0]},${f[1]}`;

export class SessionContext {
  constructor(name, analyzer) {
    this.name = name;
    this.analyzer = analyzer;
    this.sockets = new Map();
    this.ownId = null;
    this.ownName = null;
    this.declaredTickRate = null;
    this.inputs = [];          // propri: {ms, dir, boost, cashing}
    this.sent = [];            // altri messaggi propri: {ms, t}
    this.prevSnap = null;
    this.gameSocket = null;
    this.snapCount = 0;
    this.firstMs = null;
    this.lastMs = null;
    this.firstW = null;
    this.lastW = null;
    this.markers = [];
    this.parseErrors = 0;
    this.binaryFrames = 0;
  }

  /** Durata del tick in ms secondo il `ts` del server (raffinata dal modulo clock). */
  get tickMs() { return this.analyzer.tickMs; }

  me(snap) { return this.ownId ? snap.players.get(this.ownId) ?? null : null; }

  emit(type, data, ms) { return this.analyzer.emit(type, data, ms, this); }

  /** Ultimo input proprio inviato prima dell'istante `ms`. */
  inputBefore(ms) {
    for (let i = this.inputs.length - 1; i >= 0; i -= 1) if (this.inputs[i].ms <= ms) return this.inputs[i];
    return null;
  }

  info() {
    return {
      name: this.name,
      snapshots: this.snapCount,
      durationS: this.firstMs != null ? Math.round(this.lastMs - this.firstMs) / 1000 : 0,
      start: this.firstW ? new Date(this.firstW).toISOString() : null,
      ownName: this.ownName,
      declaredTickRate: this.declaredTickRate,
      sockets: [...this.sockets.entries()].map(([s, v]) => ({ s, ...v })),
      markers: this.markers,
      parseErrors: this.parseErrors,
      binaryFrames: this.binaryFrames,
    };
  }
}

export class Analyzer {
  constructor({ onEvent } = {}) {
    this.modules = createModules();
    this.byId = Object.fromEntries(this.modules.map((m) => [m.id, m]));
    this.onEvent = onEvent ?? null;
    this.tickMs = 1000 / 60;
    this.sessions = [];
    this.ctx = null;
    this.events = [];
    this.runtime = new Map();      // chiave -> {value, w, from}
  }

  beginSession(name) {
    if (this.ctx) this.endSession();
    this.ctx = new SessionContext(name, this);
    for (const m of this.modules) m.beginSession?.(this.ctx);
    return this.ctx;
  }

  endSession() {
    if (!this.ctx) return;
    for (const m of this.modules) m.endSession?.(this.ctx);
    this.sessions.push(this.ctx.info());
    this.ctx = null;
  }

  emit(type, data, ms, ctx = this.ctx) {
    const ev = { type, session: ctx?.name ?? null, ms: ms ?? null, w: ctx?.lastW ?? Date.now(), ...data };
    capPush(this.events, ev, 20_000);
    if (this.onEvent) { try { this.onEvent(ev); } catch { /* un consumatore rotto non ferma l'analisi */ } }
    return ev;
  }

  /**
   * Passi di riferimento per contare i tick dallo spostamento. Si usano le mediane
   * gia' misurate (robuste anche se qualche conteggio iniziale dal `ts` e' sbagliato):
   * nessun numero scritto a mano.
   */
  stepRef() {
    const mv = this.byId.movement;
    if (!this._steps || (this._stepsAt ?? 0) + 500 < (this.byId.clock?.pairs ?? 0)) {
      this._steps = { base: mv?.baseStep?.() ?? NaN, boost: mv?.boostStep?.() ?? NaN };
      this._stepsAt = this.byId.clock?.pairs ?? 0;
    }
    return this._steps;
  }

  /** Stato del client letto dalla pagina (impostazioni live, globali). */
  noteRuntime(key, value, w = Date.now(), from = 'pagina') {
    this.runtime.set(key, { value, w, from });
    for (const m of this.modules) m.onRuntime?.(key, value, this.ctx);
  }

  /** Una riga dello stream di rete (formato di capture/store.js). */
  ingest(ev) {
    const ctx = this.ctx ?? this.beginSession('senza-nome');
    if (ev.w != null) { ctx.firstW ??= ev.w; ctx.lastW = ev.w; }
    switch (ev.k) {
      case 'ws': ctx.sockets.set(ev.s, { url: ev.url, game: false }); return;
      case 'mark': ctx.markers.push({ w: ev.w, label: ev.label }); this.emit('marcatore', { label: ev.label }); return;
      case 'f': this.#frame(ev, ctx); return;
      default: return;
    }
  }

  #frame(ev, ctx) {
    const ms = ev.m != null ? ev.m * 1000 : ev.w;
    ctx.firstMs ??= ms;
    ctx.lastMs = ms;
    const fr = { s: ev.s, d: ev.d, ms, w: ev.w, n: ev.p ? ev.p.length : Math.floor(((ev.b ?? '').length * 3) / 4) };
    if (ev.op !== 1 || typeof ev.p !== 'string') {
      ctx.binaryFrames += 1;
      for (const m of this.modules) m.onRaw?.(ev, fr, ctx);
      return;
    }
    const c = ev.p.charCodeAt(0);
    let msg = null;
    if (c === 123 || c === 91) { try { msg = JSON.parse(ev.p); } catch { ctx.parseErrors += 1; } }
    if (!msg || typeof msg !== 'object') {
      for (const m of this.modules) m.onRaw?.(ev, fr, ctx);
      return;
    }

    if (fr.d === 'o') {
      if (msg.t === 'input') {
        capPush(ctx.inputs, { ms, dir: Number(msg.targetDir), boost: !!msg.boost, cashing: !!msg.cashingOut }, 20_000);
      } else {
        capPush(ctx.sent, { ms, t: msg.t }, 5000);
        if (msg.t === 'join' && typeof msg.name === 'string') ctx.ownName = msg.name;
      }
    } else if (msg.t === 'init') {
      const s = ctx.sockets.get(fr.s) ?? { url: '?' };
      s.game = true;
      ctx.sockets.set(fr.s, s);
      if (msg.id) ctx.ownId = msg.id;
      if (Number.isFinite(msg.tickRate)) {
        ctx.declaredTickRate = msg.tickRate;
        // Finche' il modulo clock non ha una misura sua, vale quella dichiarata.
        if (!this.byId.clock?.calibrated) this.tickMs = 1000 / msg.tickRate;
      }
    } else if (msg.t === 'user_flags') {
      if (msg.gameSettings) this.noteRuntime('server.gameSettings', msg.gameSettings, fr.w, 'user_flags');
      if (msg.renderSettings) this.noteRuntime('server.renderSettings', msg.renderSettings, fr.w, 'user_flags');
    }

    for (const m of this.modules) m.onMessage?.(msg, fr, ctx);

    if (fr.d === 'i' && msg.t === 'state') {
      if (ctx.gameSocket !== fr.s) { ctx.gameSocket = fr.s; ctx.prevSnap = null; }
      const snap = buildSnap(msg, fr, ctx);
      if (!Number.isFinite(snap.ts)) return;
      // Agganciati a meta' partita, init non si e' visto: l'id proprio lo da' la pagina.
      if (!ctx.ownId) {
        const id = this.runtime.get('client.myId')?.value;
        if (typeof id === 'string' && snap.players.has(id)) ctx.ownId = id;
      }
      const pair = ctx.prevSnap && snap.ts > ctx.prevSnap.ts ? buildPair(ctx.prevSnap, snap, this.tickMs, this.stepRef()) : null;
      for (const m of this.modules) m.onState?.(snap, pair, ctx);
      ctx.prevSnap = snap;
    }
  }

  /** Riduce tutto a sezioni del rapporto. `shared` porta il modello del sorgente e il resto. */
  finalize(shared = {}) {
    const all = { ...shared, sessions: [...this.sessions, ...(this.ctx ? [this.ctx.info()] : [])], runtime: this.runtime, analyzer: this };
    const sections = [];
    for (const m of this.modules) {
      try {
        const s = m.finalize(all);
        if (s) sections.push(s);
      } catch (err) {
        sections.push({ id: m.id, title: m.id, error: String(err?.stack ?? err), items: [], tables: [], notes: [] });
      }
    }
    return { sessions: all.sessions, sections, events: this.events };
  }
}

function buildSnap(msg, fr, ctx) {
  const list = Array.isArray(msg.players) ? msg.players.filter((p) => p && typeof p === 'object' && p.id != null) : [];
  const players = new Map();
  for (const p of list) players.set(p.id, p);
  ctx.snapCount += 1;
  return {
    idx: ctx.snapCount,
    msg,
    ts: Number(msg.ts),
    ms: fr.ms,
    w: fr.w,
    bytes: fr.n,
    list,
    players,
    alive: list.filter(isAlive),
    foods: Array.isArray(msg.foods) ? msg.foods : [],
    r: Number(msg.world?.r),
    cx: Number(msg.world?.cx ?? 0),
    cy: Number(msg.world?.cy ?? 0),
  };
}

/**
 * Tick fra due snapshot contati dallo spostamento: il primo serpente che va dritto
 * con boostAmount fermo a 0 o a 1 avanza di un multiplo esatto del passo.
 */
function ticksFromMotion(a, b, steps) {
  if (!(steps.base > 0)) return null;
  for (const p of b.alive) {
    const q = a.players.get(p.id);
    if (!isAlive(q) || p.cashingOut || q.cashingOut || !Number.isFinite(p.hx) || !Number.isFinite(q.hx)) continue;
    if (Math.abs(wrap(p.angle - q.angle)) > 0.0015) continue;
    const ba0 = Number(q.boostAmount ?? 0); const ba1 = Number(p.boostAmount ?? 0);
    const step = ba0 === 0 && ba1 === 0 ? steps.base : ba0 >= 1 && ba1 >= 1 ? steps.boost : NaN;
    if (!(step > 0)) continue;
    const k = hyp(p.hx - q.hx, p.hy - q.hy) / step;
    const n = Math.round(k);
    if (n >= 1 && n <= MAX_PAIR_TICKS && Math.abs(k - n) < 0.005) return n;
  }
  return null;
}

function buildPair(a, b, tickMs, steps) {
  const dts = b.ts - a.ts;
  const moto = ticksFromMotion(a, b, steps);
  const ticks = moto ?? Math.round(dts / tickMs);
  const pair = { a, b, dts, dms: b.ms - a.ms, ticks, ticksFrom: moto ? 'moto' : 'ts', ok: ticks >= 1 && ticks <= MAX_PAIR_TICKS, tx: [] };
  if (!pair.ok) return pair;
  for (const p of b.alive) {
    const q = a.players.get(p.id);
    if (!isAlive(q) || !Number.isFinite(p.hx) || !Number.isFinite(q.hx)) continue;
    const chord = hyp(p.hx - q.hx, p.hy - q.hy);
    // Molto oltre il passo in boost non si e' mosso: e' rinato altrove.
    if (chord > 40 * ticks + 10) continue;
    const da = wrap(p.angle - q.angle);
    const half = Math.abs(da) / 2;
    pair.tx.push({
      id: p.id, a: q, b: p, ticks, chord, da,
      arc: half > 1e-9 ? chord * (half / Math.sin(half)) : chord,
      step: stepFromChord(chord, da, ticks),
    });
  }
  return pair;
}

/** Contenitore della sezione di rapporto di un modulo. */
export class Section {
  constructor(id, title, intro = '') {
    this.id = id;
    this.title = title;
    this.intro = intro;
    this.items = [];
    this.tables = [];
    this.notes = [];
  }

  /**
   * Una misura. Se ha `key` finisce anche nella specifica del simulatore.
   * status: misurato | osservato | stimato | insufficiente
   */
  item(o) { this.items.push({ status: 'misurato', ...o }); return this; }
  missing(label, key, why) { return this.item({ label, key, value: null, status: 'insufficiente', detail: why }); }
  table(title, columns, rows) { if (rows?.length) this.tables.push({ title, columns, rows }); return this; }
  note(text) { this.notes.push(text); return this; }
}
