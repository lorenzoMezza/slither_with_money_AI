/**
 * Il registratore: si aggancia via DevTools a ogni contesto del browser
 * (pagine, iframe, popup, worker, service worker) e scrive su disco
 *
 *  - ogni frame WebSocket, in entrambe le direzioni, con il tempo della rete;
 *  - ogni richiesta HTTP con il corpo della risposta;
 *  - il sorgente di ogni script compilato da V8 (anche inline, eval, blob, worker);
 *  - console ed eccezioni;
 *  - lo stato del client letto periodicamente dalla pagina (vedi probe.js).
 *
 * E' passivo: non manda nulla al server di gioco e non tocca i messaggi.
 * Ogni handler e' isolato: un errore su un frame non ferma la registrazione.
 */
import { EventEmitter } from 'node:events';
import { Semaphore } from '../browser/cdp.js';
import { PROBE_EXPRESSION, GLOBALS_EXPRESSION } from './probe.js';
import { redactHeaders, redactText, sha256 } from './store.js';

const PAGE_LIKE = new Set(['page', 'iframe']);
const WORKER_LIKE = new Set(['worker', 'shared_worker', 'service_worker']);
const NO_BODY = new Set(['WebSocket', 'EventSource', 'Preflight', 'Ping', 'CSPViolationReport']);
const isInternal = (url) => /^(chrome|chrome-extension|devtools|chrome-untrusted|edge):/i.test(url ?? '');

export class Recorder extends EventEmitter {
  #cdp; #store; #cfg;
  #targets = new Map();          // sessionId -> targetInfo
  #sessionByTarget = new Map();  // targetId -> sessionId
  #waiters = new Map();
  #requests = new Map();         // `${sid}:${requestId}` -> record
  #sockets = new Map();          // `${sid}:${requestId}` -> {s, url}
  #nextSocket = 1;
  #bodySem = new Semaphore(6);
  #probeTimer = null;
  #lastProbe = new Map();        // chiave -> hash, per scrivere solo i cambiamenti
  #globalsDone = new Set();
  #stopped = false;

  constructor({ cdp, store, config }) {
    super();
    this.setMaxListeners(0);
    this.#cdp = cdp;
    this.#store = store;
    this.#cfg = config;
    this.startedAt = Date.now();
    this.counters = {
      framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, sockets: 0,
      http: 0, bodies: 0, scripts: 0, console: 0, probes: 0, errors: 0,
    };
  }

  async start() {
    this.#cdp.on('event', (e) => this.#dispatch(e));
    await this.#cdp.send('Target.setDiscoverTargets', { discover: true });
    await this.#cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (this.#cfg.runtimeProbeMs > 0) {
      this.#probeTimer = setInterval(() => this.#probeAll().catch(() => {}), this.#cfg.runtimeProbeMs);
      this.#probeTimer.unref?.();
    }
  }

  /**
   * Scheda del gioco: se ce n'e' gia' una aperta la si usa (agganciata a meta'
   * partita: l'analisi lo sa gestire), altrimenti se ne apre una in due tempi —
   * about:blank, poi la navigazione — cosi' nemmeno il documento HTML sfugge.
   */
  async openGame(url) {
    const host = new URL(url).host;
    const { targetInfos = [] } = (await this.#cdp.trySend('Target.getTargets')).result ?? {};
    const existing = targetInfos.find((t) => t.type === 'page' && t.url.includes(host));
    if (existing) {
      this.emit('note', `scheda del gioco gia' aperta: mi aggancio (${existing.url})`);
      return existing.targetId;
    }
    const { targetId } = await this.#cdp.send('Target.createTarget', { url: 'about:blank' });
    const sid = await this.#waitTarget(targetId, 15_000);
    for (const t of targetInfos) {
      if (t.type === 'page' && t.url === 'about:blank' && t.targetId !== targetId) {
        await this.#cdp.trySend('Target.closeTarget', { targetId: t.targetId });
      }
    }
    if (!sid) throw new Error('la scheda non si e\' agganciata in tempo');
    const nav = await this.#cdp.send('Page.navigate', { url }, sid);
    if (nav.errorText) throw new Error(`navigazione fallita: ${nav.errorText}`);
    await this.#cdp.trySend('Target.activateTarget', { targetId });
    return targetId;
  }

  mark(label) {
    const ev = { k: 'mark', label, w: Date.now() };
    this.#store.frame(ev);
    this.emit('mark', ev);
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#probeTimer);
  }

  #waitTarget(targetId, ms) {
    const known = this.#sessionByTarget.get(targetId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.#waiters.delete(targetId); resolve(null); }, ms);
      this.#waiters.set(targetId, (sid) => { clearTimeout(t); resolve(sid); });
    });
  }

  #dispatch({ method, params, sessionId }) {
    if (this.#stopped) return;
    const h = this.#handlers[method];
    if (!h) return;
    try {
      const out = h.call(this, params, sessionId);
      if (out?.catch) out.catch((err) => this.#fail(method, err));
    } catch (err) { this.#fail(method, err); }
  }

  #fail(where, err) {
    this.counters.errors += 1;
    this.#store.append('runtime/errori.ndjson', { w: Date.now(), where, error: String(err?.message ?? err) });
  }

  #handlers = {
    'Target.attachedToTarget': (p) => this.#onAttached(p),
    'Target.detachedFromTarget': (p) => this.#targets.delete(p.sessionId),
    'Target.targetInfoChanged': (p) => this.#onTargetChanged(p.targetInfo),
    'Network.requestWillBeSent': (p, s) => this.#onRequest(p, s),
    'Network.responseReceived': (p, s) => this.#onResponse(p, s),
    'Network.loadingFinished': (p, s) => this.#onLoaded(p, s),
    'Network.loadingFailed': (p, s) => this.#onFailed(p, s),
    'Network.webSocketCreated': (p, s) => this.#socket(s, p.requestId, p.url),
    'Network.webSocketHandshakeResponseReceived': (p, s) => this.#onHandshake(p, s),
    'Network.webSocketFrameSent': (p, s) => this.#onFrame('o', p, s),
    'Network.webSocketFrameReceived': (p, s) => this.#onFrame('i', p, s),
    'Network.webSocketFrameError': (p, s) => this.#onWsError(p, s),
    'Network.webSocketClosed': (p, s) => this.#onWsClosed(p, s),
    'Network.eventSourceMessageReceived': (p, s) => this.#onSse(p, s),
    'Debugger.scriptParsed': (p, s) => this.#onScriptParsed(p, s),
    'Debugger.paused': (_p, s) => this.#cdp.trySend('Debugger.resume', {}, s),
    'Runtime.consoleAPICalled': (p, s) => this.#onConsole(p, s),
    'Runtime.exceptionThrown': (p, s) => this.#onException(p, s),
    'Page.frameNavigated': (p, s) => this.#onNavigated(p, s),
  };

  // --- target --------------------------------------------------------------------

  async #onAttached({ sessionId, targetInfo, waitingForDebugger }) {
    const cdp = this.#cdp;
    const internal = isInternal(targetInfo.url);
    this.#targets.set(sessionId, { ...targetInfo, internal });
    try {
      await cdp.trySend('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      if (internal) return;
      this.#store.append('runtime/target.ndjson', { w: Date.now(), type: targetInfo.type, url: targetInfo.url, title: targetInfo.title });
      const isPage = PAGE_LIKE.has(targetInfo.type);
      if (isPage || WORKER_LIKE.has(targetInfo.type)) {
        await cdp.trySend('Network.enable', {
          maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024, maxPostDataSize: 1024 * 1024,
        }, sessionId);
        // Senza cache ogni corpo passa dalla rete ed e' quindi recuperabile.
        await cdp.trySend('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
      }
      if (isPage) await cdp.trySend('Page.enable', {}, sessionId);
      await cdp.trySend('Runtime.enable', {}, sessionId);
      if (this.#cfg.captureV8Scripts) {
        const dbg = await cdp.trySend('Debugger.enable', {}, sessionId);
        // Un `debugger;` nel codice del gioco non deve poter bloccare la pagina.
        if (dbg.ok) await cdp.trySend('Debugger.setSkipAllPauses', { skip: true }, sessionId);
      }
    } finally {
      if (waitingForDebugger) await cdp.trySend('Runtime.runIfWaitingForDebugger', {}, sessionId);
      this.#sessionByTarget.set(targetInfo.targetId, sessionId);
      const w = this.#waiters.get(targetInfo.targetId);
      if (w) { this.#waiters.delete(targetInfo.targetId); w(sessionId); }
    }
  }

  /** L'URL di un target cambia con la navigazione: senza aggiornarlo la scheda del gioco resterebbe «about:blank». */
  #onTargetChanged(info) {
    const sid = info?.targetId ? this.#sessionByTarget.get(info.targetId) : null;
    const t = sid ? this.#targets.get(sid) : null;
    if (t && info.url) t.url = info.url;
  }

  #ignored(sessionId, url) {
    return this.#targets.get(sessionId)?.internal || isInternal(url);
  }

  // --- HTTP ----------------------------------------------------------------------

  #onRequest(p, sid) {
    const url = p.request?.url ?? '';
    if (this.#ignored(sid, url)) return;
    const rec = {
      w: Date.now(), m: p.timestamp, url, method: p.request?.method,
      type: p.type ?? 'Other', target: this.#targets.get(sid)?.type ?? 'browser',
      initiator: p.initiator?.type ?? null,
      requestHeaders: redactHeaders(p.request?.headers, this.#cfg.redact),
    };
    this.#requests.set(`${sid}:${p.requestId}`, rec);
    this.counters.http += 1;
    if (p.request?.hasPostData) this.#savePost(rec, p, sid);
  }

  async #savePost(rec, p, sid) {
    let data = p.request?.postData;
    if (data === undefined) {
      const r = await this.#cdp.trySend('Network.getRequestPostData', { requestId: p.requestId }, sid);
      if (!r.ok) return;
      data = r.result.postData;
    }
    if (typeof data !== 'string' || !data) return;
    const text = this.#cfg.redact ? redactText(data) : data;
    const name = `rete/post/${Date.now()}-${sha256(rec.url + text).slice(0, 8)}.txt`;
    await this.#store.writeJson(name.replace(/\.txt$/, '.json'), { url: rec.url, method: rec.method, body: text });
    rec.postData = name.replace(/\.txt$/, '.json');
  }

  #onResponse(p, sid) {
    const rec = this.#requests.get(`${sid}:${p.requestId}`);
    if (!rec) return;
    const r = p.response ?? {};
    Object.assign(rec, {
      status: r.status, mimeType: r.mimeType, protocol: r.protocol, remote: r.remoteIPAddress,
      fromServiceWorker: Boolean(r.fromServiceWorker),
      responseHeaders: redactHeaders(r.headers, this.#cfg.redact),
      type: p.type ?? rec.type,
    });
  }

  async #onLoaded(p, sid) {
    const key = `${sid}:${p.requestId}`;
    const rec = this.#requests.get(key);
    if (!rec) return;
    this.#requests.delete(key);
    rec.bytes = p.encodedDataLength;
    rec.ms = p.timestamp && rec.m ? Math.round((p.timestamp - rec.m) * 1000) : null;
    if (!this.#cfg.captureHttpBodies || NO_BODY.has(rec.type) || rec.method === 'OPTIONS' || rec.status === 204 || rec.status === 304) {
      this.#store.append('rete/http.ndjson', rec);
      return;
    }
    await this.#bodySem.run(async () => {
      const r = await this.#cdp.trySend('Network.getResponseBody', { requestId: p.requestId }, sid);
      if (!r.ok) {
        rec.bodyError = r.error.message;
        this.#store.append('rete/http.ndjson', rec);
        return;
      }
      let buf = r.result.base64Encoded ? Buffer.from(r.result.body, 'base64') : Buffer.from(r.result.body ?? '', 'utf8');
      if (buf.length > this.#cfg.maxBodyBytes) {
        rec.bodyError = `oltre il limite (${buf.length} byte)`;
        this.#store.append('rete/http.ndjson', rec);
        return;
      }
      const isJs = rec.type === 'Script' || /javascript|ecmascript/.test(rec.mimeType ?? '');
      if (this.#cfg.redact && /json/.test(rec.mimeType ?? '')) buf = Buffer.from(redactText(buf.toString('utf8')), 'utf8');
      const saved = await this.#store.saveBlob(isJs ? 'script' : 'http', rec.url, buf, extFor(rec.mimeType));
      rec.body = saved.rel;
      rec.sha256 = saved.sha;
      this.counters.bodies += 1;
      this.#store.append('rete/http.ndjson', rec);
      if (isJs && !saved.duplicate) this.#noteScript({ url: rec.url, rel: saved.rel, sha: saved.sha, text: buf.toString('utf8'), via: 'http', target: rec.target });
    });
  }

  #onFailed(p, sid) {
    const key = `${sid}:${p.requestId}`;
    const rec = this.#requests.get(key);
    if (!rec) return;
    this.#requests.delete(key);
    Object.assign(rec, { failed: true, errorText: p.errorText, canceled: Boolean(p.canceled) });
    this.#store.append('rete/http.ndjson', rec);
  }

  // --- WebSocket -----------------------------------------------------------------

  /**
   * Record del socket. Viene creato anche al primo frame di un socket mai visto:
   * succede agganciandosi a una partita gia' in corso, e quei frame valgono
   * quanto gli altri.
   */
  #socket(sid, requestId, url) {
    const key = `${sid}:${requestId}`;
    let s = this.#sockets.get(key);
    if (s) {
      if (url && s.url === '?') s.url = url;
      return s;
    }
    if (this.#ignored(sid, url)) return null;
    s = { s: this.#nextSocket++, url: url ?? '?' };
    this.#sockets.set(key, s);
    this.counters.sockets += 1;
    this.#store.frame({ k: 'ws', s: s.s, url: s.url, target: this.#targets.get(sid)?.type ?? null, w: Date.now() });
    this.emit('socket', s);
    return s;
  }

  #onHandshake(p, sid) {
    const s = this.#socket(sid, p.requestId);
    if (!s) return;
    this.#store.frame({ k: 'hs', s: s.s, m: p.timestamp, status: p.response?.status ?? null, w: Date.now() });
    this.emit('open', { ...s, status: p.response?.status });
  }

  #onFrame(d, p, sid) {
    const s = this.#socket(sid, p.requestId);
    if (!s) return;
    const fr = p.response ?? {};
    const op = Number.isInteger(fr.opcode) ? fr.opcode : 1;
    const raw = String(fr.payloadData ?? '');
    const ev = { k: 'f', s: s.s, d, m: p.timestamp, w: Date.now(), op };
    let n;
    if (op === 1) {
      ev.p = this.#cfg.redact ? redactText(raw) : raw;
      n = Buffer.byteLength(raw, 'utf8');
    } else {
      ev.b = raw;   // CDP lo da' gia' in base64
      n = Math.floor((raw.length * 3) / 4);
    }
    this.#store.frame(ev);
    if (d === 'i') { this.counters.framesIn += 1; this.counters.bytesIn += n; }
    else { this.counters.framesOut += 1; this.counters.bytesOut += n; }
    this.emit('frame', ev);
  }

  #onWsError(p, sid) {
    const s = this.#socket(sid, p.requestId);
    if (s) this.#store.frame({ k: 'wserr', s: s.s, m: p.timestamp, e: p.errorMessage ?? '', w: Date.now() });
  }

  #onWsClosed(p, sid) {
    const key = `${sid}:${p.requestId}`;
    const s = this.#sockets.get(key);
    if (!s) return;
    this.#store.frame({ k: 'wsclose', s: s.s, m: p.timestamp, w: Date.now() });
    this.#sockets.delete(key);
    this.emit('close', s);
  }

  #onSse(p, sid) {
    if (this.#ignored(sid)) return;
    this.#store.frame({ k: 'sse', m: p.timestamp, w: Date.now(), event: p.eventName, data: redactText(String(p.data ?? '')).slice(0, 65536) });
  }

  // --- sorgente ------------------------------------------------------------------

  async #onScriptParsed(p, sid) {
    if (this.#ignored(sid, p.url)) return;
    // Gli iframe di terze parti (pubblicita', widget) non sono codice del gioco:
    // il loro traffico HTTP resta registrato, il sorgente V8 no.
    const tgt = this.#targets.get(sid);
    if (tgt?.type === 'iframe' && !this.#isGameUrl(tgt.url)) return;
    const r = await this.#cdp.trySend('Debugger.getScriptSource', { scriptId: p.scriptId }, sid);
    const text = r.ok ? r.result.scriptSource ?? '' : '';
    if (!text) return;
    const target = this.#targets.get(sid);
    const url = p.url || `inline:${target?.url ?? 'sconosciuto'}#${sha256(text).slice(0, 10)}`;
    const saved = await this.#store.saveBlob('script', url, Buffer.from(text, 'utf8'), '.js');
    if (saved.duplicate) return;
    this.#noteScript({ url, rel: saved.rel, sha: saved.sha, text, via: 'v8', target: target?.type, inline: !p.url, isModule: Boolean(p.isModule), sourceMapURL: p.sourceMapURL || null });
  }

  #noteScript(info) {
    const { text, ...meta } = info;
    this.counters.scripts += 1;
    this.#store.append('sorgente/script.ndjson', { w: Date.now(), length: text.length, ...meta });
    this.emit('script', info);
  }

  // --- console e navigazione -----------------------------------------------------

  #onConsole(p, sid) {
    if (this.#ignored(sid)) return;
    this.counters.console += 1;
    this.#store.append('runtime/console.ndjson', {
      w: Date.now(), level: p.type, target: this.#targets.get(sid)?.type,
      args: (p.args ?? []).slice(0, 10).map((a) => ('value' in a ? a.value : a.description ?? a.type)),
      at: p.stackTrace?.callFrames?.[0] ? `${p.stackTrace.callFrames[0].url}:${p.stackTrace.callFrames[0].lineNumber}` : null,
    });
  }

  #onException(p, sid) {
    if (this.#ignored(sid)) return;
    const d = p.exceptionDetails ?? {};
    this.#store.append('runtime/console.ndjson', {
      w: Date.now(), level: 'exception', text: d.text, error: d.exception?.description?.slice(0, 4000), url: d.url, line: d.lineNumber,
    });
  }

  #onNavigated(p, sid) {
    const f = p.frame ?? {};
    if (f.parentId || this.#ignored(sid, f.url)) return;
    const t = this.#targets.get(sid);
    if (t && f.url) t.url = f.url;
    this.#store.append('runtime/target.ndjson', { w: Date.now(), event: 'navigazione', url: f.url });
    this.#globalsDone.delete(sid);
  }

  // --- stato del client ------------------------------------------------------------

  #isGameUrl(url) {
    try {
      const host = new URL(url).hostname;
      return this.#cfg.gameHosts.some((h) => host === h || host.endsWith(`.${h}`));
    } catch { return false; }
  }

  #gameSessions() {
    const out = [];
    for (const [sid, t] of this.#targets) if (t.type === 'page' && !t.internal && this.#isGameUrl(t.url)) out.push(sid);
    return out;
  }

  async #probeAll() {
    for (const sid of this.#gameSessions()) {
      const r = await this.#cdp.trySend('Runtime.evaluate', { expression: PROBE_EXPRESSION, returnByValue: true, silent: true }, sid);
      const raw = r.ok ? r.result?.result?.value : null;
      if (typeof raw !== 'string') continue;
      let probe;
      try { probe = JSON.parse(raw); } catch { continue; }
      this.counters.probes += 1;
      this.emit('probe', probe);
      // Su disco solo cio' che cambia: lo stato e' quasi sempre identico.
      for (const [k, v] of Object.entries(probe)) {
        const h = JSON.stringify(v);
        if (this.#lastProbe.get(k) === h) continue;
        this.#lastProbe.set(k, h);
        this.#store.append('runtime/stato.ndjson', { w: Date.now(), key: k, value: v });
      }
      if (!this.#globalsDone.has(sid)) {
        const g = await this.#cdp.trySend('Runtime.evaluate', { expression: GLOBALS_EXPRESSION, returnByValue: true, silent: true }, sid);
        const val = g.ok ? g.result?.result?.value : null;
        if (typeof val === 'string') {
          this.#globalsDone.add(sid);
          await this.#store.writeJson('runtime/globali.json', JSON.parse(val));
        }
      }
    }
  }
}

function extFor(mime = '') {
  if (/javascript|ecmascript/.test(mime)) return '.js';
  if (/json/.test(mime)) return '.json';
  if (/html/.test(mime)) return '.html';
  if (/css/.test(mime)) return '.css';
  if (/wasm/.test(mime)) return '.wasm';
  if (/svg/.test(mime)) return '.svg';
  if (/png/.test(mime)) return '.png';
  if (/jpe?g/.test(mime)) return '.jpg';
  if (/webp/.test(mime)) return '.webp';
  if (/gif/.test(mime)) return '.gif';
  if (/woff2/.test(mime)) return '.woff2';
  if (/mpeg|mp3/.test(mime)) return '.mp3';
  if (/ogg/.test(mime)) return '.ogg';
  return '';
}
