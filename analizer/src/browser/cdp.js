import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Client minimo per il Chrome DevTools Protocol, in "flat session mode": una
 * sola connessione verso il browser, e ogni target figlio (pagina, iframe,
 * worker, service worker) viaggia sulla stessa socket distinto da `sessionId`.
 * E' l'unico modo di non perdere il traffico dei worker.
 */
export class CdpClient extends EventEmitter {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor(wsUrl, { timeoutMs = 60_000 } = {}) {
    super();
    this.setMaxListeners(0);
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
  }

  connect() {
    return new Promise((resolve, reject) => {
      // maxPayload 0: i body in base64 e gli snapshot di gioco sono grandi.
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 0 });
      this.#ws = ws;
      ws.once('error', reject);
      ws.once('open', () => {
        ws.off('error', reject);
        ws.on('error', (err) => this.emit('error', err));
        ws.on('message', (data) => this.#onMessage(data));
        ws.on('close', (code) => this.#onClose(code));
        resolve(this);
      });
    });
  }

  get connected() { return !this.#closed && this.#ws?.readyState === WebSocket.OPEN; }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(Object.assign(new Error(`${entry.method}: ${msg.error.message}`), { cdp: msg.error }));
      else entry.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) this.emit('event', { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
  }

  #onClose(code) {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`connessione CDP chiusa (${code}) durante ${entry.method}`));
    }
    this.#pending.clear();
    this.emit('disconnected', { code });
  }

  send(method, params = {}, sessionId) {
    if (!this.connected) return Promise.reject(new Error(`CDP non connesso (${method})`));
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout CDP su ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#ws.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Variante che non lancia mai: per i comandi best effort. */
  async trySend(method, params = {}, sessionId) {
    try { return { ok: true, result: await this.send(method, params, sessionId) }; }
    catch (error) { return { ok: false, error }; }
  }

  close() {
    this.#closed = true;
    try { this.#ws?.close(); } catch { /* gia' chiusa */ }
  }
}

/** Limita quante operazioni pesanti (download dei body) girano insieme. */
export class Semaphore {
  #max; #active = 0; #queue = [];
  constructor(max) { this.#max = Math.max(1, max); }
  async run(fn) {
    if (this.#active >= this.#max) await new Promise((r) => this.#queue.push(r));
    this.#active += 1;
    try { return await fn(); } finally {
      this.#active -= 1;
      this.#queue.shift()?.();
    }
  }
}
