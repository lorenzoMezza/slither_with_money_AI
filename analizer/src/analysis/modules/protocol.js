/**
 * Il protocollo, dedotto dai messaggi veri: per ogni tipo e direzione, campo
 * per campo, tipi visti, presenza, intervallo dei numeri e loro PRECISIONE
 * (quante cifre decimali il server serializza: un simulatore fedele deve
 * produrre la stessa quantizzazione), valori delle stringhe finche' sembrano
 * un'enumerazione, forma degli array — omogenei o tuple posizionali, come
 * `foods`, che arriva come [x, y, tipo, colore, valore] senza nomi.
 */
import { Section } from '../engine.js';
import { decimals, quantile } from '../stats.js';

const MAX_ENUM = 24;
const FULL_FIRST = 80;       // messaggi per tipo analizzati sempre
const SAMPLE_EVERY = 25;     // poi uno ogni N
const MAX_ITEMS = 40;        // elementi ispezionati per array

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  return typeof v;
};

function node() {
  return { seen: 0, types: {}, num: null, strings: new Map(), freeText: false, strLen: null, children: null, items: null, tuple: null, arrLen: null };
}

function observe(n, v) {
  n.seen += 1;
  const t = typeOf(v);
  n.types[t] = (n.types[t] ?? 0) + 1;
  if (t === 'int' || t === 'float') {
    const d = decimals(v);
    if (!n.num) n.num = { min: v, max: v, maxDec: d, n: 0 };
    n.num.min = Math.min(n.num.min, v);
    n.num.max = Math.max(n.num.max, v);
    n.num.maxDec = Math.max(n.num.maxDec, d);
    n.num.n += 1;
  } else if (t === 'string') {
    if (!n.freeText) {
      n.strings.set(v.length > 80 ? `${v.slice(0, 77)}…` : v, (n.strings.get(v) ?? 0) + 1);
      if (n.strings.size > MAX_ENUM) { n.freeText = true; n.strings = new Map([...n.strings].slice(0, 5)); }
    }
    n.strLen = n.strLen ? { min: Math.min(n.strLen.min, v.length), max: Math.max(n.strLen.max, v.length) } : { min: v.length, max: v.length };
  } else if (t === 'object') {
    n.children ??= new Map();
    for (const [k, x] of Object.entries(v)) {
      if (!n.children.has(k)) n.children.set(k, node());
      observe(n.children.get(k), x);
    }
  } else if (t === 'array') {
    n.arrLen = n.arrLen ? { min: Math.min(n.arrLen.min, v.length), max: Math.max(n.arrLen.max, v.length) } : { min: v.length, max: v.length };
    const prim = v.length > 0 && v.length <= 8 && v.every((x) => x === null || typeof x !== 'object');
    if (prim && (n.tuple || !n.items)) {
      n.tuple ??= [];
      v.forEach((x, i) => { n.tuple[i] ??= node(); observe(n.tuple[i], x); });
    } else {
      n.items ??= node();
      const step = Math.max(1, Math.floor(v.length / MAX_ITEMS));
      for (let i = 0; i < v.length; i += step) observe(n.items, v[i]);
    }
  }
}

/** Il nodo in forma descrittiva. */
function describe(n, total) {
  const o = {
    presenza: total ? Number((n.seen / total).toFixed(4)) : 1,
    tipi: Object.keys(n.types),
  };
  if (n.num) Object.assign(o, { min: n.num.min, max: n.num.max, decimaliMax: n.num.maxDec });
  if (n.strings.size && !n.freeText) o.valori = Object.fromEntries(n.strings);
  if (n.freeText) { o.testoLibero = true; o.esempi = [...n.strings.keys()]; }
  if (n.strLen) o.lunghezza = n.strLen;
  if (n.arrLen) o.elementi = n.arrLen;
  if (n.children) o.campi = Object.fromEntries([...n.children].map(([k, c]) => [k, describe(c, n.types.object ?? n.seen)]));
  if (n.tuple) o.tupla = n.tuple.map((c) => describe(c, n.types.array ?? n.seen));
  if (n.items) o.elemento = describe(n.items, n.items.seen);
  return o;
}

/** Elenco piatto `percorso -> descrizione`, per le tabelle. */
function flatten(desc, prefix = '', out = []) {
  if (desc.campi) {
    for (const [k, c] of Object.entries(desc.campi)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push([p, c]);
      flatten(c, p, out);
    }
  }
  if (desc.tupla) desc.tupla.forEach((c, i) => { const p = `${prefix}[${i}]`; out.push([p, c]); flatten(c, p, out); });
  if (desc.elemento) { const p = `${prefix}[]`; out.push([p, desc.elemento]); flatten(desc.elemento, p, out); }
  return out;
}

/** Esempio compatto: gli array lunghi ridotti ai primi elementi. */
function shrink(v, depth = 0) {
  if (Array.isArray(v)) {
    const head = v.slice(0, depth === 0 ? 3 : 2).map((x) => shrink(x, depth + 1));
    return v.length > head.length ? [...head, `… altri ${v.length - head.length}`] : head;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, depth + 1)]));
  return v;
}

export function createProtocol() {
  const types = new Map();
  const raw = { binary: 0, nonJson: 0, bytes: 0 };
  const sockets = new Map();

  return {
    id: 'protocol',
    types,
    onRaw(ev) { if (ev.op === 1) raw.nonJson += 1; else raw.binary += 1; },
    onMessage(msg, fr, ctx) {
      const type = typeof msg.t === 'string' ? msg.t : Array.isArray(msg) ? '<array>' : '<senza t>';
      const key = `${fr.d}:${type}`;
      let b = types.get(key);
      if (!b) {
        b = { dir: fr.d, type, count: 0, bytes: 0, minBytes: Infinity, maxBytes: 0, gaps: [], lastMs: null, schema: node(), observed: 0, example: null, firstW: fr.w, lastW: fr.w };
        types.set(key, b);
        ctx.emit('nuovo_messaggio', { dir: fr.d === 'o' ? 'client→server' : 'server→client', t: type }, fr.ms);
      }
      b.count += 1;
      b.bytes += fr.n;
      b.minBytes = Math.min(b.minBytes, fr.n);
      b.maxBytes = Math.max(b.maxBytes, fr.n);
      b.lastW = fr.w;
      if (b.lastMs != null && b.gaps.length < 20_000) b.gaps.push(fr.ms - b.lastMs);
      b.lastMs = fr.ms;
      if (b.count <= FULL_FIRST || b.count % SAMPLE_EVERY === 0) { observe(b.schema, msg); b.observed += 1; }
      if (!b.example) b.example = shrink(msg);
      raw.bytes += fr.n;
      const s = ctx.sockets.get(fr.s);
      if (s) sockets.set(`${ctx.name}:${fr.s}`, { url: s.url, game: s.game });
    },
    beginSession() { for (const b of types.values()) b.lastMs = null; },

    /** Il protocollo completo in forma macchina-leggibile (protocollo.json). */
    document() {
      return {
        socket: [...sockets.values()].filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i),
        trasporto: { frameBinari: raw.binary, frameTestoNonJson: raw.nonJson, byteJson: raw.bytes },
        messaggi: [...types.values()].sort((a, b) => b.count - a.count).map((b) => {
          const desc = describe(b.schema, b.observed);
          return {
            direzione: b.dir === 'o' ? 'client→server' : 'server→client',
            t: b.type,
            conteggio: b.count,
            byteMedi: Math.round(b.bytes / b.count),
            byteMin: b.minBytes,
            byteMax: b.maxBytes,
            intervalloMs: b.gaps.length ? { p05: quantile(b.gaps, 0.05), p50: quantile(b.gaps, 0.5), p95: quantile(b.gaps, 0.95) } : null,
            hz: b.gaps.length > 5 ? Number((1000 / quantile(b.gaps, 0.5)).toFixed(2)) : null,
            campiOsservatiSu: b.observed,
            schema: desc,
            campi: flatten(desc).map(([p, c]) => ({ campo: p, ...c, campi: undefined, tupla: undefined, elemento: undefined })),
            esempio: b.example,
          };
        }),
      };
    },

    finalize() {
      const sec = new Section('protocollo', 'Protocollo di rete', 'Ogni tipo di messaggio osservato, con frequenza e dimensione. Lo schema campo per campo sta in protocollo.json e PROTOCOLLO.md.');
      const doc = this.document();
      sec.item({ key: 'rete.trasporto', label: 'formato dei messaggi', value: raw.binary ? 'misto JSON/binario' : 'JSON testuale', status: 'osservato', detail: `${raw.binary} frame binari, ${raw.nonJson} frame di testo non JSON` });
      sec.item({ key: 'rete.endpoint', label: 'socket di gioco', value: doc.socket.filter((s) => s.game).map((s) => s.url).join(', ') || doc.socket.map((s) => s.url).join(', '), status: 'osservato' });
      sec.table('Messaggi', ['direzione', 't', 'conteggio', 'Hz', 'byte medi', 'campi'],
        doc.messaggi.map((m) => [m.direzione, m.t, m.conteggio, m.hz ?? '–', m.byteMedi, (m.campi.filter((c) => !c.campo.includes('.') && !c.campo.includes('[')).map((c) => c.campo)).join(', ')]));
      const state = doc.messaggi.find((m) => m.t === 'state');
      if (state) {
        sec.table('Precisione dei campi di `state` (cifre decimali serializzate)', ['campo', 'tipi', 'min', 'max', 'decimali'],
          state.campi.filter((c) => c.decimaliMax !== undefined).map((c) => [c.campo, c.tipi.join('/'), c.min, c.max, c.decimaliMax]));
      }
      return sec;
    },
  };
}
