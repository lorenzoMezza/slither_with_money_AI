/** Statistica robusta e geometria: le sole due cose che servono a tutti i moduli. */

export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (a) => quantile(a, 0.5);
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const sum = (a) => a.reduce((x, y) => x + y, 0);

/** Deviazione assoluta mediana riscalata a sigma: un valore storto non la sposta. */
export function mad(a) {
  if (!a.length) return NaN;
  const m = median(a);
  return 1.4826 * median(a.map((x) => Math.abs(x - m)));
}

export function summarize(a) {
  if (!a.length) return { n: 0 };
  const s = Float64Array.from(a).sort();
  const q = (p) => quantile(s, p);
  return {
    n: a.length, min: s[0], p01: q(0.01), p05: q(0.05), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], mean: mean(a),
  };
}

/** Conteggi per valore, ordinati per valore. */
export function histogram(a, key = (x) => x) {
  const m = new Map();
  for (const x of a) { const k = key(x); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

/** Minimi quadrati y = a + b·x con errori standard: distingue «zero» da «non so». */
export function fitLine(xs, ys, ws = null) {
  const n = xs.length;
  if (n < 3) return { a: NaN, b: NaN, seA: NaN, seB: NaN, n, r2: NaN, rmse: NaN };
  let sw = 0; let sx = 0; let sy = 0;
  for (let i = 0; i < n; i += 1) { const w = ws ? ws[i] : 1; sw += w; sx += w * xs[i]; sy += w * ys[i]; }
  const mx = sx / sw; const my = sy / sw;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const w = ws ? ws[i] : 1;
    sxx += w * (xs[i] - mx) ** 2; sxy += w * (xs[i] - mx) * (ys[i] - my); syy += w * (ys[i] - my) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ws ? ws[i] : 1) * (ys[i] - a - b * xs[i]) ** 2;
  const s2 = sse / Math.max(1, sw - 2);
  return {
    a, b, n, seB: Math.sqrt(s2 / sxx), seA: Math.sqrt(s2 * (1 / sw + (mx * mx) / sxx)),
    r2: syy > 0 ? 1 - sse / syy : 1, rmse: Math.sqrt(sse / sw),
  };
}

/** Minimi quadrati senza intercetta a due regressori: y = a·x1 + b·x2. */
export function fit2(x1, x2, y) {
  let s11 = 0; let s12 = 0; let s22 = 0; let s1y = 0; let s2y = 0;
  for (let i = 0; i < y.length; i += 1) {
    s11 += x1[i] * x1[i]; s12 += x1[i] * x2[i]; s22 += x2[i] * x2[i]; s1y += x1[i] * y[i]; s2y += x2[i] * y[i];
  }
  const det = s11 * s22 - s12 * s12;
  if (!(Math.abs(det) > 1e-12)) return { a: NaN, b: NaN };
  return { a: (s1y * s22 - s2y * s12) / det, b: (s2y * s11 - s1y * s12) / det };
}

export const rel = (x, ref) => Math.abs(x - ref) / Math.max(Math.abs(ref), 1e-12);

/** Campione a tetto fisso: oltre il tetto sostituisce a caso (reservoir). */
export class Sample {
  constructor(cap = 50_000) { this.cap = cap; this.v = []; this.n = 0; }
  push(x) {
    if (!Number.isFinite(x)) return;
    this.n += 1;
    if (this.v.length < this.cap) this.v.push(x);
    else { const j = Math.floor(Math.random() * this.n); if (j < this.cap) this.v[j] = x; }
  }
  get length() { return this.v.length; }
}

/** Lista a tetto fisso che tiene gli ultimi elementi. */
export function capPush(arr, x, cap) {
  arr.push(x);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// --- geometria -------------------------------------------------------------------

export const TAU = 2 * Math.PI;

export function wrap(a) {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}

export const hyp = (dx, dy) => Math.sqrt(dx * dx + dy * dy);

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return hyp(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Passo per tick ESATTO da una corda: in k tick, ruotando di δ per tick prima
 * di avanzare, la corda vale s·sin(kδ/2)/sin(δ/2). Con δ = 0 e' corda/k.
 */
export function stepFromChord(chord, da, k) {
  const d = Math.abs(da) / k;
  if (d < 1e-9) return chord / k;
  const den = Math.sin((k * d) / 2);
  return den > 1e-9 ? (chord * Math.sin(d / 2)) / den : chord / k;
}

/** Cifre decimali con cui un numero e' stato serializzato: rivela la quantizzazione. */
export function decimals(x) {
  if (!Number.isFinite(x) || Number.isInteger(x)) return 0;
  const s = String(x);
  if (s.includes('e')) return 17;
  return s.length - s.indexOf('.') - 1;
}

/** Numero leggibile all'italiana. */
export function fmt(v, d = 3) {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'boolean') return v ? 'sì' : 'no';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return '–';
  return v.toLocaleString('it-IT', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
