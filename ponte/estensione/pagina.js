/**
 * Il ponte DENTRO la pagina del gioco (mondo della pagina, prima di ogni script del sito).
 *
 * L'IA guida il gioco come lo guida il controller del sito stesso (`gamepad-client.js`):
 * con eventi `mousemove` (la direzione), `mousedown`/`mouseup` (il boost) e il tasto Q
 * tenuto (il cashout). È il client a calcolare `targetDir`, a mandare l'input a ogni
 * fotogramma, a disegnare il serpente e a chiudere il cashout dopo 3 s: niente input
 * paralleli, niente messaggi scartati, niente WebSocket o `send` sostituiti.
 *
 * Fa quattro cose:
 *  1. ascolta il socket del client (la variabile `ws` del gioco, come fa il modulo
 *     «money rain» del sito) e passa al ponte gli snapshot `state` così come arrivano;
 *  2. applica le decisioni dell'IA con gli eventi qui sopra;
 *  3. mentre guida l'IA ferma mouse e tasti VERI della persona (non gli eventi sintetici),
 *     perché non si mescolino; il tasto X passa il controllo, subito;
 *  4. misura quanto ci mette una decisione a tornare (dallo snapshot arrivato al comando
 *     applicato) e gli FPS del gioco, e lo mostra nell'etichetta.
 *
 * Nulla finisce su `window`: lo stato vive in questa chiusura e con l'altra metà
 * dell'estensione (relay.js) si parla con eventi del DOM a nome fisso, non con postMessage.
 * Se l'IA tace per più di 2,5 s la persona riprende il controllo da sola.
 */
(() => {
  'use strict';
  const EV_TX = 'ponte:tx', EV_RX = 'ponte:rx', EV_STATO = 'ponte:stato';
  const SILENZIO_IA_MS = 2500;
  const RAGGIO = 4096;              // px: il puntatore sintetico è lontano dal centro, l'angolo resta preciso
  const TIPI = /^\{\s*"t"\s*:\s*"(state|init|join_ok|join_err|you_died|cashout_result)"/;

  const ora = () => performance.now();
  const leggi = (f) => { try { return f(); } catch (_) { return undefined; } };   // variabili del client (let globali)

  const S = {
    modo: 'umano', connesso: false,
    sock: null, n: 0, arrivi: new Float64Array(64),
    cmdAt: -1e9, boostGiu: false, qGiu: false,
    vero: { x: innerWidth / 2, y: innerHeight / 2 },     // dove sta davvero il mouse della persona
    lat: 0, latN: 0, costo: 0,                            // risposta (ms) e tempo speso qui (ms/s)
    // diagnosi del secondo in corso: risposte, fotogrammi, intervalli fra snapshot
    D: { lat: [], dtMax: 0, lenti: 0, persi: 0, gapMax: 0, buchi: 0, ultimoSnap: 0, cmd: 0, snap: 0, pratica: 0 },
  };
  const guidaIA = () => S.modo === 'ai' && ora() - S.cmdAt < SILENZIO_IA_MS;
  const tx = (testo) => { document.dispatchEvent(new CustomEvent(EV_TX, { detail: testo })); };
  const txo = (o) => tx(JSON.stringify(o));

  // ---------- 1. gli snapshot dal socket del client -------------------------------------
  function suMessaggio(ev) {
    const d = ev.data;
    if (typeof d !== 'string') return;
    const m = TIPI.exec(d);
    if (m) arrivo(m[1], d);
  }
  function arrivo(tipo, d) {
    const t0 = ora();
    if (tipo === 'state') {
      const n = ++S.n;
      if (S.D.ultimoSnap) { const gap = t0 - S.D.ultimoSnap; if (gap > S.D.gapMax) S.D.gapMax = gap; if (gap > 100) S.D.buchi += 1; }
      S.D.ultimoSnap = t0; S.D.snap += 1;
      S.arrivi[n & 63] = t0;
      const mio = leggi(() => myId);                                      // eslint-disable-line no-undef
      const testa = { k: 'rx', ty: 'state', n, id: mio ?? null, modo: S.modo };
      if (S.modo !== 'ai') testa.hum = azioneClient();
      tx(JSON.stringify(testa) + '\t' + d);                               // lo snapshot viaggia così com'è
    } else {
      tx(JSON.stringify({ k: 'rx', ty: tipo }) + '\t' + d);
    }
    S.costo += ora() - t0;
  }
  // Il socket del gioco è la variabile `ws` del client: la si guarda ogni mezzo secondo e
  // ci si aggiunge un ascoltatore (il client ricrea il socket quando si riconnette).
  setInterval(() => {
    const w = leggi(() => ws);                                            // eslint-disable-line no-undef
    if (!w || w === S.sock || typeof w.addEventListener !== 'function') return;
    S.sock = w;
    w.addEventListener('message', suMessaggio);
    txo({ k: 'ws', ev: 'agganciato' });
  }, 500);

  /** L'input che il client sta mandando adesso (per l'osservazione mentre guida la persona). */
  function azioneClient() {
    /* eslint-disable no-undef */
    const cash = !!leggi(() => cashoutCharging);
    const dir = leggi(() => (cash ? __cashoutLockedDir : __lastAimDir));
    return { dir: typeof dir === 'number' ? dir : null, boost: !!leggi(() => boosting) && !cash, cash };
    /* eslint-enable no-undef */
  }

  // ---------- 2. le decisioni dell'IA come eventi del controller ---------------------------
  const evento = (e) => window.dispatchEvent(e);
  // La direzione cambia a ogni snapshot: si scrive dove il client tiene il puntatore (`mouse`,
  // che il suo ascoltatore di mousemove aggiorna e basta), senza far girare gli altri ascoltatori
  // della pagina. Se `mouse` non c'è (client cambiato) si torna all'evento, come il controller.
  const punta = (x, y) => {
    const mo = leggi(() => mouse);                                        // eslint-disable-line no-undef
    if (mo && typeof mo.x === 'number') { mo.x = x; mo.y = y; } else evento(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  };
  const boost = (giu) => { evento(new MouseEvent(giu ? 'mousedown' : 'mouseup', { button: 0, bubbles: true })); S.boostGiu = giu; };
  const tastoQ = (giu) => { evento(new KeyboardEvent(giu ? 'keydown' : 'keyup', { key: 'q', code: 'KeyQ', bubbles: true })); S.qGiu = giu; };

  function applica(c) {
    const t0 = ora();
    S.cmdAt = t0;
    S.D.cmd += 1;
    if (S.modo === 'ai') {
      const dir = Number(c.dir);
      if (Number.isFinite(dir)) punta(innerWidth / 2 + RAGGIO * Math.cos(dir), innerHeight / 2 + RAGGIO * Math.sin(dir));
      const cash = !!c.cash, b = !!c.boost && !cash;
      if (cash !== S.qGiu) tastoQ(cash);                // rilasciare prima dei 3 s azzera la carica (lo fa il client)
      if (b !== S.boostGiu) boost(b);
      if (c.n) {
        const lat = t0 - S.arrivi[c.n & 63];
        if (S.n - c.n < 64 && lat >= 0) { S.lat = S.latN ? 0.9 * S.lat + 0.1 * lat : lat; S.latN += 1; S.D.lat.push(lat); }
      }
    }
    S.costo += ora() - t0;
  }
  /** Lascia tutto: boost, Q, e il puntatore torna dov'è il mouse vero della persona. */
  function rilascia() {
    boost(false);
    tastoQ(false);
    punta(S.vero.x, S.vero.y);
  }

  // ---------- 3. chi guida ----------------------------------------------------------------
  let eraIA = false;
  setInterval(() => {                                    // silenzio dell'IA → la persona riprende da sola
    const ia = guidaIA();
    if (eraIA && !ia) rilascia();
    eraIA = ia;
  }, 100);

  function imposta(modo, perche) {
    if ((modo !== 'ai' && modo !== 'umano') || modo === S.modo) return;
    S.modo = modo;
    rilascia();                                           // in entrambi i sensi si riparte puliti
    eraIA = guidaIA();
    disegna();
    txo({ k: 'modo', modo, perche: perche || 'comando' });
  }

  // Mentre guida l'IA, mouse e tasti VERI non arrivano al gioco (gli eventi sintetici sì).
  const TASTI_LIBERI = new Set(['KeyX', 'Escape', 'Tab']);
  const ferma = (e) => { e.stopImmediatePropagation(); };
  for (const tipo of ['mousemove', 'mousedown', 'mouseup']) {
    window.addEventListener(tipo, (e) => {
      if (!e.isTrusted) return;
      if (tipo === 'mousemove') { S.vero.x = e.clientX; S.vero.y = e.clientY; }
      if (guidaIA() && inPartita()) ferma(e);
    }, true);
  }
  for (const tipo of ['keydown', 'keyup']) {
    window.addEventListener(tipo, (e) => {
      if (!e.isTrusted || !guidaIA() || !inPartita()) return;
      if (TASTI_LIBERI.has(e.code) || e.metaKey || e.ctrlKey) return;
      ferma(e);
    }, true);
  }
  const inPartita = () => !!leggi(() => joined) && !leggi(() => spectatorMode);   // eslint-disable-line no-undef

  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.code !== 'KeyX' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;   // si sta scrivendo (nome, chat)
    if (!S.connesso) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    imposta(S.modo === 'ai' ? 'umano' : 'ai', 'tasto');
  }, true);

  // ---------- comandi da Python (via relay.js) ----------------------------------------------
  document.addEventListener(EV_RX, (e) => {
    let c; try { c = JSON.parse(e.detail); } catch (_) { return; }
    if (c.c === 'cmd') applica(c);
    else if (c.c === 'modo') imposta(c.modo, 'python');
    else if (c.c === 'testo') { testo = String(c.t || ''); disegna(); }
    else if (c.c === 'cfg') { S.connesso = true; imposta(c.modo === 'ai' ? 'ai' : 'umano', 'avvio'); disegna(); }
  });
  document.addEventListener(EV_STATO, (e) => {
    S.connesso = e.detail === '1';
    if (!S.connesso && S.modo === 'ai') { S.modo = 'umano'; rilascia(); }
    if (S.connesso) txo({ k: 'pagina', ev: 'collegata', modo: S.modo, href: String(location.href) });   // Python risponde con `cfg`
    disegna();
  });

  // ---------- 4. misure ed etichetta ----------------------------------------------------------
  // Fotogrammi: un solo rAF che misura l'intervallo (a 60 Hz sono 16,7 ms; > 25 ms = fotogramma perso).
  let ultimoFot = 0, ultimaPratica = null, tsPratica = 0, passoPratica = 33;
  // Modalità pratica (lobby 0): la partita è simulata nella pagina e il server non manda snapshot.
  // Il simulatore del client mette i suoi in `snaps` a ogni tick (stessa forma di quelli del server,
  // senza il valore dell'oro). Il server invece ne manda uno ogni 2 o 3 tick (45,8 % e 53,1 %), e l'IA
  // è addestrata così: se ne inoltra uno ogni 2 o 3 tick estratti allo stesso modo, saltando i replay
  // di morte e uccisione.
  function pratica() {
    if (leggi(() => myLobby) !== 0) return;                              // eslint-disable-line no-undef
    const arr = leggi(() => snaps);                                      // eslint-disable-line no-undef
    const ult = arr && arr[arr.length - 1];
    if (!ult || ult === ultimaPratica || typeof ult !== 'object') return;
    ultimaPratica = ult;
    const ts = Number(ult.ts) || 0;
    if (ts - tsPratica < passoPratica - 4) return;
    tsPratica = ts;
    passoPratica = Math.random() < 0.46 ? 33 : 50;
    if (leggi(() => window._simSIM && window._simSIM._dcPlaying) || leggi(() => window._kcState && window._kcState.playing)) return;
    S.D.pratica += 1;
    let testo;
    try { testo = JSON.stringify(ult); } catch (_) { return; }
    arrivo('state', '{"t":"state","pratica":true,' + testo.slice(1));
  }
  const fotogramma = (t) => {
    pratica();
    if (ultimoFot && !document.hidden) {
      const dt = t - ultimoFot;
      if (dt > S.D.dtMax) S.D.dtMax = dt;
      if (dt > 25) { S.D.lenti += 1; S.D.persi += Math.round(dt / 16.7) - 1; }
    }
    ultimoFot = t;
    requestAnimationFrame(fotogramma);
  };
  requestAnimationFrame(fotogramma);

  const r1 = (x) => Math.round(x * 10) / 10;
  setInterval(() => {
    const D = S.D;
    if (S.connesso) {
      const l = D.lat.sort((a, b) => a - b);
      const fps = leggi(() => _fpsEma);                                   // eslint-disable-line no-undef
      txo({ k: 'stat', modo: S.modo, lat: S.latN ? r1(S.lat) : null, lat50: l.length ? r1(l[l.length >> 1]) : null,
        latMax: l.length ? r1(l[l.length - 1]) : null, fps: typeof fps === 'number' ? Math.round(fps) : null,
        lenti: D.lenti, persi: D.persi, dtMax: r1(D.dtMax), gapMax: r1(D.gapMax), buchi: D.buchi,
        snap: D.snap, cmd: D.cmd, pratica: D.pratica, costo: Math.round(S.costo * 100) / 100 });
    }
    S.costo = 0;
    S.D = { lat: [], dtMax: 0, lenti: 0, persi: 0, gapMax: 0, buchi: 0, ultimoSnap: D.ultimoSnap, cmd: 0, snap: 0, pratica: 0 };
  }, 1000);

  let etichetta = null, testo = '', ultimo = '';
  function disegna() {
    if (!document.documentElement) return;
    if (!etichetta) {
      etichetta = document.createElement('div');
      etichetta.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483647;pointer-events:none;' +
        'font:600 12px/1.35 -apple-system,system-ui,sans-serif;color:#fff;padding:6px 10px;border-radius:8px;opacity:.9;white-space:pre';
    }
    if (!etichetta.isConnected) document.documentElement.appendChild(etichetta);
    const ia = S.modo === 'ai';
    const t = !S.connesso ? '○ ponte non collegato: guidi tu'
      : (ia ? '● IA al comando' : '● TU al comando') + '   [X] cambia' + (testo ? '\n' + testo : '');
    const sfondo = !S.connesso ? '#555' : ia ? '#0f7b4a' : '#b45f06';
    if (t === ultimo && etichetta.style.background) return;
    ultimo = t;
    etichetta.style.background = sfondo;
    etichetta.textContent = t;
  }
  document.addEventListener('DOMContentLoaded', disegna);
  setInterval(disegna, 2000);
})();
