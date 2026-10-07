/**
 * Lettura dello stato del client dalla pagina, via Runtime.evaluate.
 *
 * Non inietta nulla e non modifica nulla: valuta un'espressione in sola
 * lettura nel contesto globale della pagina. Serve a vedere cio' che il
 * traffico non mostra, prima di tutto le IMPOSTAZIONI LIVE che il server manda
 * con `user_flags` e che il client conserva in `window._gameSettings`: sono i
 * valori che sovrascrivono i default scritti nel sorgente (hitbox, regola del
 * frontale, ...), e quindi quelli che valgono davvero.
 *
 * Le variabili `let`/`const` di primo livello del client non stanno su
 * `window` ma nell'ambiente lessicale globale: un'espressione valutata li' le
 * legge per nome, come qualunque altro codice della pagina.
 */

/** Variabili di primo livello del client utili all'analisi (si estende con PROBE_VARS). */
const LEXICAL = [
  'myId', 'myName', 'connected', 'joined', 'spectatorMode', 'overlayVisible',
  'boosting', 'cashoutCharging', 'pendingCashout', 'myAimAngle', '__lastAimDir',
  'currentLobby', 'myLobby', 'selectedLobby', 'lowGraphicsMode', 'gfxSettings',
  ...(process.env.PROBE_VARS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));

const WINDOW_KEYS = ['_gameSettings', '_renderSettings', 'MS_REGION', '_gfxViewDist', '_gfxFpsCap', '_isRenderTester'];

export const PROBE_EXPRESSION = `(() => {
  const out = {};
  const safe = (v) => {
    if (v === undefined) return undefined;
    try { const s = JSON.stringify(v); return s && s.length < 200000 ? JSON.parse(s) : '<troppo grande>'; }
    catch (e) { return String(v); }
  };
  try { out.href = location.href; } catch (e) {}
  ${WINDOW_KEYS.map((k) => `try { out['window.${k}'] = safe(window[${JSON.stringify(k)}]); } catch (e) {}`).join('\n  ')}
  ${LEXICAL.map((n) => `try { out['client.${n}'] = safe(typeof ${n} !== 'undefined' ? ${n} : undefined); } catch (e) {}`).join('\n  ')}
  try { out.view = { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, hidden: document.hidden, focus: document.hasFocus() }; } catch (e) {}
  return JSON.stringify(out);
})()`;

/**
 * Le globali che il client aggiunge a `window`, una volta per caricamento: e'
 * la mappa dello stato del client. Il confronto e' con un iframe vuoto, cioe'
 * con cio' che una pagina qualunque ha gia' di suo.
 */
export const GLOBALS_EXPRESSION = `(() => {
  let base = new Set();
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.documentElement.appendChild(f);
    base = new Set(Object.getOwnPropertyNames(f.contentWindow));
    f.remove();
  } catch (e) {}
  const out = {};
  for (const k of Object.getOwnPropertyNames(window)) {
    if (base.has(k)) continue;
    let v;
    try { v = window[k]; } catch (e) { out[k] = { type: 'inaccessibile' }; continue; }
    const t = typeof v;
    const rec = { type: v === null ? 'null' : Array.isArray(v) ? 'array' : t };
    if (t === 'function') rec.arity = v.length;
    else if (t !== 'object' || v === null) rec.value = v;
    else {
      try {
        const s = JSON.stringify(v);
        if (s && s.length <= 20000) rec.value = JSON.parse(s);
        else rec.keys = Object.keys(v).slice(0, 80);
      } catch (e) { rec.keys = Object.keys(v).slice(0, 80); }
    }
    out[k] = rec;
  }
  return JSON.stringify(out);
})()`;
