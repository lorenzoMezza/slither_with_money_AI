/**
 * Il corpo: quanti anelli per una taglia, quanto spessi, a che distanza.
 *
 * Gli snapshot portano il corpo intero di ogni serpente (`segs`) e lo spessore
 * a piena precisione, quindi le leggi si verificano esattamente: se la formula
 * del sorgente e' quella del server lo scarto e' l'errore di macchina.
 */
import { Section } from '../engine.js';
import { fitLine, hyp, mad, median, quantile, Sample } from '../stats.js';

export function createBody() {
  const spacing = new Sample();
  const headToFirst = new Sample(20_000);
  const sizeSegs = new Map();     // taglia -> Map(anelli -> conteggio)
  const segsThick = new Map();    // anelli -> Set(spessori)
  const sizeDecimals = new Set();
  let snaps = 0;

  return {
    id: 'body',
    onState(snap) {
      snaps += 1;
      const heavy = snaps % 4 === 0;     // le misure costose una volta ogni quattro snapshot
      for (const p of snap.alive) {
        const g = Array.isArray(p.segs) ? p.segs : null;
        if (!g?.length || !Number.isFinite(p.size)) continue;
        sizeDecimals.add(Number.isInteger(p.size));
        const m = sizeSegs.get(p.size) ?? new Map();
        m.set(g.length, (m.get(g.length) ?? 0) + 1);
        sizeSegs.set(p.size, m);
        if (Number.isFinite(p.thickness)) {
          const s = segsThick.get(g.length) ?? new Set();
          if (s.size < 8) s.add(p.thickness);
          segsThick.set(g.length, s);
        }
        if (heavy) {
          for (let i = 1; i < g.length; i += 1) spacing.push(hyp(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]));
          if (Number.isFinite(p.hx)) headToFirst.push(hyp(g[0][0] - p.hx, g[0][1] - p.hy));
        }
      }
    },

    finalize(shared) {
      const sec = new Section('corpo', 'Corpo del serpente', 'Anelli, spessore e spaziatura, dal corpo intero che ogni snapshot contiene.');
      const src = shared.source?.fn ?? {};
      if (spacing.length >= 50) {
        sec.item({ key: 'corpo.distanzaAnelli', label: 'distanza fra anelli consecutivi', value: Number(median(spacing.v).toFixed(5)), unit: 'u', n: spacing.length,
          detail: `dispersione (MAD) ${mad(spacing.v).toFixed(5)}, p01 ${quantile(spacing.v, 0.01).toFixed(3)}, p99 ${quantile(spacing.v, 0.99).toFixed(3)}` });
      } else sec.missing('distanza fra anelli', 'corpo.distanzaAnelli', 'nessun serpente osservato');
      if (headToFirst.length >= 20) {
        sec.item({ key: 'corpo.testaPrimoAnello', label: 'distanza testa (hx,hy) → primo anello', value: Number(median(headToFirst.v).toFixed(5)), unit: 'u', n: headToFirst.length, status: 'osservato', detail: `p99 ${quantile(headToFirst.v, 0.99).toFixed(4)}: zero = il primo anello E' la testa` });
      }

      // Anelli dalla taglia.
      const pairs = [];
      for (const [size, m] of sizeSegs) for (const [n, c] of m) pairs.push({ size, n, c });
      pairs.sort((a, b) => a.size - b.size || a.n - b.n);
      if (pairs.length >= 5) {
        if (typeof src.segmentsForSize === 'function') {
          let ok = 0; let near = 0; let tot = 0;
          for (const p of pairs) {
            const pred = src.segmentsForSize(p.size);
            tot += p.c;
            if (pred === p.n) ok += p.c;
            else if (Math.abs(pred - p.n) <= 1) near += p.c;
          }
          sec.item({ key: 'corpo.leggeAnelli', label: 'anelli = segmentsForSize(taglia) del sorgente', value: Number(((ok + near) / tot).toFixed(4)), n: tot, status: 'misurato',
            detail: `esatti ${(ok / tot * 100).toFixed(2)} %, a ±1 anello ${(near / tot * 100).toFixed(2)} % (la taglia nello snapshot e' arrotondata: ±1 e' atteso vicino ai gradini)` });
        }
        const lo = pairs.filter((p) => p.size <= 100); const hi = pairs.filter((p) => p.size > 100);
        const fit = (arr) => (arr.length >= 3 ? fitLine(arr.map((p) => p.size), arr.map((p) => p.n), arr.map((p) => p.c)) : null);
        const fl = fit(lo); const fh = fit(hi);
        if (fl) sec.item({ key: 'corpo.anelliFinoA100', label: 'anelli ≈ a + b·taglia (taglia ≤ 100)', value: { a: Number(fl.a.toFixed(3)), b: Number(fl.b.toFixed(4)) }, n: lo.length, status: 'stimato' });
        if (fh) sec.item({ key: 'corpo.anelliOltre100', label: 'anelli ≈ a + b·taglia (taglia > 100)', value: { a: Number(fh.a.toFixed(3)), b: Number(fh.b.toFixed(4)) }, n: hi.length, status: 'stimato' });
        const step = Math.max(1, Math.floor(pairs.length / 40));
        sec.table('Taglia → anelli (campione)', ['taglia', 'anelli', 'osservazioni', 'sorgente'],
          pairs.filter((_, i) => i % step === 0).map((p) => [p.size, p.n, p.c, typeof src.segmentsForSize === 'function' ? src.segmentsForSize(p.size) : '–']));
      } else sec.missing('anelli in funzione della taglia', 'corpo.leggeAnelli', 'pochi serpenti osservati');

      // Spessore dagli anelli.
      const thick = [...segsThick.entries()].sort((a, b) => a[0] - b[0]);
      if (thick.length >= 3) {
        const unique = thick.every(([, s]) => s.size === 1);
        sec.item({ key: 'corpo.spessoreDipendeSoloDagliAnelli', label: 'lo spessore dipende solo dal numero di anelli', value: unique, status: 'osservato', n: thick.length });
        if (typeof src.thicknessForSegments === 'function') {
          let worst = 0;
          for (const [n, s] of thick) for (const t of s) worst = Math.max(worst, Math.abs(t - src.thicknessForSegments(n)));
          sec.item({ key: 'corpo.leggeSpessore', label: 'spessore = thicknessForSegments(anelli) del sorgente', value: worst < 1e-6, n: thick.length, status: 'misurato', detail: `scarto massimo ${worst.toExponential(2)} u su ${thick.length} valori di anelli` });
        }
        sec.table('Anelli → spessore', ['anelli', 'spessore', 'sorgente'],
          thick.map(([n, s]) => [n, [...s].map((x) => Number(x.toFixed(6))).join(' / '), typeof src.thicknessForSegments === 'function' ? Number(src.thicknessForSegments(n).toFixed(6)) : '–']));
      }
      if (sizeDecimals.size) sec.item({ key: 'corpo.tagliaInteraNelloSnapshot', label: 'la taglia arriva arrotondata all\'intero', value: !sizeDecimals.has(false), status: 'osservato' });
      return sec;
    },
  };
}
