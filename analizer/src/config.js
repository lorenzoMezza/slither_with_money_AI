import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const bool = (v, def) => {
  if (v === undefined || v === '') return def;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
};
const int = (v, def) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
};

/** Tutto si regola da variabili d'ambiente: il codice non va mai toccato. */
export const config = {
  // --- gioco ------------------------------------------------------------------
  targetUrl: process.env.TARGET_URL || 'https://moneyslither.com/',
  /** Host del gioco: i loro script vengono analizzati come sorgente del client. */
  gameHosts: (process.env.GAME_HOSTS || 'moneyslither.com').split(',').map((s) => s.trim()).filter(Boolean),

  // --- browser ----------------------------------------------------------------
  chromePath: process.env.CHROME_PATH || '',
  /** Profilo persistente: il login sopravvive fra una sessione e l'altra. */
  profileDir: process.env.PROFILE_DIR || path.join(ROOT, 'chrome-profile'),
  /** Porta DevTools di un Chrome gia' aperto a cui agganciarsi (0 = lo avvio io). */
  debugPort: int(process.env.DEBUG_PORT, 0),
  closeBrowserOnExit: bool(process.env.CLOSE_BROWSER, true),

  // --- cartelle ---------------------------------------------------------------
  sessionsDir: process.env.SESSIONS_DIR || path.join(ROOT, 'sessioni'),
  /** L'estratto complessivo, su tutte le sessioni: e' la cartella da cui si costruisce il simulatore. */
  extractDir: process.env.EXTRACT_DIR || path.join(ROOT, 'estratto'),

  // --- cosa registrare --------------------------------------------------------
  /** Sorgenti di ogni script compilato da V8 (inline, eval, worker, blob). */
  captureV8Scripts: bool(process.env.V8_SCRIPTS, true),
  /** Corpo di ogni risposta HTTP. */
  captureHttpBodies: bool(process.env.HTTP_BODIES, true),
  /** Lettura periodica dello stato del client (impostazioni live, globali). */
  runtimeProbeMs: int(process.env.RUNTIME_MS, 2000),
  /** Oscura token e cookie prima che tocchino il disco. */
  redact: bool(process.env.REDACT, true),
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 64 * 1024 * 1024),

  // --- analisi ----------------------------------------------------------------
  /** Riscrittura periodica dell'estratto durante la sessione (ms). */
  analysisMs: int(process.env.ANALYSIS_MS, 15_000),
  /** All'avvio si ricaricano le sessioni precedenti: l'estratto live e' cumulativo. */
  includeHistory: bool(process.env.STORICO, true),
  statusMs: int(process.env.STATUS_MS, 5000),
  autoStopMs: int(process.env.AUTO_STOP_MS, 0),
};

export function newSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
