/**
 * Prova end-to-end del ponte, senza toccare il gioco vero. Un server WebSocket finto manda
 * snapshot nel formato del server (da prove/genera_snapshot.py); la pagina finta gestisce mouse,
 * boost, tasto Q e invio degli input COME il client vero (`client.js`: mousemove → mouse.x/y,
 * targetDir = atan2 dal centro dello schermo a ogni fotogramma, mousedown = boost, Q tenuto =
 * cashout chiuso dal client dopo 3000 ms). Chrome headless carica l'estensione vera; la
 * «persona» muove il mouse VERO (eventi fidati via CDP) sempre nello stesso punto.
 *
 *   node ponte/prove/prova_ponte.mjs tutte_le_versioni/migliore.pt
 *
 * Verifica: l'IA guida (input del client che seguono l'IA, mouse vero fermato); X → persona;
 * X → IA; IA muta → la persona riprende da sola; latenza snapshot → comando; nulla di visibile
 * alla pagina (window, WebSocket, postMessage); direzione esatta, boost e cashout a 3000 ms.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const qui = path.dirname(fileURLToPath(import.meta.url));
const radice = path.resolve(qui, '..', '..');
const modello = path.resolve(process.argv[2] || path.join(radice, 'tutte_le_versioni', 'model_1.pt'));
const py = path.join(radice, 'allenamento', '.venv', 'bin', 'python');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fallite = 0;
const ok = (c, m) => { console.log(`${c ? '  ok ' : '  KO '} ${m}`); if (!c) fallite += 1; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-prova-'));
const snapFile = path.join(tmp, 'snap.ndjson');
const g = spawnSync(py, [path.join(qui, 'genera_snapshot.py'), snapFile, '400'], { stdio: 'inherit' });
if (g.status !== 0) process.exit(1);
const righe = fs.readFileSync(snapFile, 'utf8').trim().split('\n');
const mioId = JSON.parse(righe[0]).id;
const snaps = righe.slice(1);

// ---- gioco finto: la gestione degli input è quella di client.js --------------------------
const log = [];                       // {t, m} messaggi ricevuti dal server
const PAGINA = `<!doctype html><meta charset=utf-8><title>gioco finto</title><body style="margin:0;background:#222;color:#ccc">gioco finto
<script>
let ws = null, myId = null, myLobby = 1, snaps = [], joined = false, spectatorMode = false, boosting = false, cashoutCharging = false,
    cashoutStart = 0, __cashoutLockedDir = 0, __lastAimDir = 0, _fpsEma = 60, _last = performance.now();
const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
var messaggiFinestra = 0;
window.addEventListener('message', () => { messaggiFinestra++; });
function connect() {
  ws = new WebSocket('ws://' + location.host + '/');
  ws.onmessage = (e) => { const t = JSON.parse(e.data); if (t.t === 'init') myId = t.id; if (t.t === 'join_ok') joined = true; };
  ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ t: 'join', name: 'prova', lobby: 1 })), 300);
}
connect();
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener('mousedown', (e) => { if (e.button === 0 || e.button === 2) boosting = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0 || e.button === 2) boosting = false; });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') boosting = true;
  if ((e.key === 'q' || e.key === 'Q' || e.code === 'KeyQ') && !cashoutCharging) { cashoutCharging = true; cashoutStart = performance.now(); __cashoutLockedDir = __lastAimDir; }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') boosting = false; if (e.key === 'q' || e.key === 'Q' || e.code === 'KeyQ') cashoutCharging = false; });
function frame() {
  requestAnimationFrame(frame);
  const n = performance.now(), dt = n - _last; _last = n; if (dt > 0) _fpsEma = 0.9 * _fpsEma + 100 / dt;
  const d = Math.atan2(mouse.y - innerHeight / 2, mouse.x - innerWidth / 2);
  if (ws && ws.readyState === 1 && joined) {
    __lastAimDir = d;
    ws.send(JSON.stringify({ t: 'input', targetDir: cashoutCharging ? __cashoutLockedDir : d, boost: !cashoutCharging && boosting, cashingOut: cashoutCharging }));
    if (cashoutCharging && n - cashoutStart >= 3000) { cashoutCharging = false; ws.send(JSON.stringify({ t: 'cashout' })); }
  }
}
requestAnimationFrame(frame);
</script>`;
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGINA); });
const wss = new WebSocketServer({ server: srv });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'init', id: mioId, tickRate: 60, world: { r: 2000 } }));
  let timer = null; let i = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    log.push({ t: Date.now(), m });
    if (m.t === 'join') {
      ws.send(JSON.stringify({ t: 'join_ok', lobby: 1 }));
      timer = setInterval(() => { if (ws.readyState === 1) ws.send(snaps[i++ % snaps.length].replace(/"ts":\d+/, `"ts":${Date.now()}`)); }, 42);
    }
  });
  ws.on('close', () => clearInterval(timer));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;
const inputDopo = (t0) => log.filter((x) => x.t >= t0 && x.m.t === 'input');
const attendi = async (cond, ms, msg) => { const f = Date.now() + ms; while (Date.now() < f) { if (cond()) return true; await sleep(100); } console.log(`  .. timeout: ${msg}`); return false; };

// ---- Chrome headless con l'estensione vera (più il permesso di girare su 127.0.0.1) ---------
const portaWs = 20000 + Math.floor(Math.random() * 20000);
const ext = path.join(tmp, 'ext');
fs.cpSync(path.join(qui, '..', 'estensione'), ext, { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
for (const c of man.content_scripts) c.matches.push('http://127.0.0.1/*');
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(man));
fs.writeFileSync(path.join(ext, 'sfondo.js'), fs.readFileSync(path.join(ext, 'sfondo.js'), 'utf8').replace('const PORTA = 8765', `const PORTA = ${portaWs}`));

console.log('avvio il ponte (Python) …');
const env = { ...process.env, PYTHONUNBUFFERED: '1' };
let ponte = spawn(py, [path.join(qui, '..', 'ponte.py'), modello, '--porta-ws', String(portaWs), '--non-aprire'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let consolePonte = '';
ponte.stdout.on('data', (d) => { consolePonte += d; });
ponte.stderr.on('data', (d) => { consolePonte += d; });
await attendi(() => /in ascolto per l'estensione/.test(consolePonte), 60000, 'ponte in ascolto');

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${path.join(tmp, 'profilo')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1200,800', 'about:blank'],
{ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const cdp = (() => {
  const wr = chrome.stdio[3], rd = chrome.stdio[4];
  let n = 1; const att = new Map(); let buf = '';
  rd.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && att.has(m.id)) { att.get(m.id)(m.result ?? m); att.delete(m.id); } } });
  return (method, params = {}, sessionId) => new Promise((r) => { const id = n++; att.set(id, r); wr.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
})();
const r = await cdp('Extensions.loadUnpacked', { path: ext });       // --load-extension non funziona più in Chrome ≥ 137
console.log(`estensione caricata: ${r.id}`);
const { targetInfos } = await cdp('Target.getTargets');
const { sessionId: sid } = await cdp('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
await cdp('Page.navigate', { url }, sid);
// Runtime.evaluate (senza Runtime.enable) solo per LEGGERE la pagina finta.
const valuta = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true }, sid)).result?.value;
const premiX = async () => {
  const k = { key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, text: 'x' };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...k }, sid);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, sid);
};
const etichetta = () => valuta(`[...document.querySelectorAll('div')].map(d => d.textContent).find(t => /al comando|non collegato/.test(t)) || ''`);

await attendi(() => log.some((x) => x.m.t === 'join'), 30000, 'join dalla pagina');
const [w, h] = await valuta('[innerWidth, innerHeight]');
// La «persona»: il mouse vero (eventi fidati) sempre in (cx+100, cy+156).
const px = Math.floor(w / 2) + 100, pyy = Math.floor(h / 2) + 156;      // pixel interi: il mouse vero non ha frazioni
const dirPersona = Math.atan2(pyy - h / 2, px - w / 2);
const diPersona = (x) => Math.abs(x.m.targetDir - dirPersona) < 1e-6;
const mano = setInterval(() => { cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: pyy }, sid); }, 50);

await attendi(() => inputDopo(0).some((x) => !diPersona(x)), 30000, 'primi input guidati dall\'IA');
await sleep(1500);

let t0 = Date.now(); await sleep(2000);
let a = inputDopo(t0);
ok(a.length > 60, `IA al comando: ${a.length} input dal client in 2 s (li manda il client, a ogni fotogramma)`);
ok(a.filter((x) => !diPersona(x)).length / a.length > 0.97, `quasi tutti seguono l'IA (${a.filter((x) => !diPersona(x)).length}/${a.length}) nonostante il mouse vero si muova`);
ok(new Set(a.map((x) => x.m.targetDir.toFixed(3))).size > 5, `la direzione cambia con le decisioni (${new Set(a.map((x) => x.m.targetDir.toFixed(3))).size} valori diversi)`);
ok(/IA al comando/.test(await etichetta()), 'etichetta: IA al comando');

await premiX();
await sleep(300); t0 = Date.now(); await sleep(1500);
a = inputDopo(t0);
ok(a.length > 40 && a.every(diPersona), `X → persona: ${a.length} input, tutti col mouse vero`);
ok(/TU al comando/.test(await etichetta()), 'etichetta: TU al comando');

await premiX();
await sleep(600); t0 = Date.now(); await sleep(1500);
a = inputDopo(t0);
ok(a.filter((x) => !diPersona(x)).length / Math.max(a.length, 1) > 0.97, `X di nuovo → IA: ${a.filter((x) => !diPersona(x)).length}/${a.length} input seguono l'IA`);

await sleep(5500);                                  // il ponte scrive le misure ogni 5 s
const diag = [...consolePonte.matchAll(/diagnosi IA · risposta (\d+)\/(\d+) ms.*· ponte nella pagina ([\d.]+) ms\/s/g)].at(-1);
ok(!!diag, diag ? `diagnosi: ${diag[0].replace(/^.*diagnosi /, '')}` : 'nessuna riga di diagnosi');
ok(diag && Number(diag[1]) < 15 && Number(diag[2]) < 40, 'risposta: mediana sotto 15 ms, peggiore sotto 40 ms');
ok(diag && Number(diag[3]) < 5, 'il ponte occupa la pagina meno di 5 ms al secondo (0,5 %)');
ok(fs.readFileSync(path.join(qui, '..', 'registro.txt'), 'utf8').includes('diagnosi IA'), 'la diagnosi è anche in ponte/registro.txt');

// Invisibilità per la pagina.
ok((await valuta(`Object.getOwnPropertyNames(window).filter(k => /ponte/i.test(k)).length`)) === 0, 'nessuna proprietà del ponte su window');
ok(await valuta(`/\\[native code\\]/.test(WebSocket.toString()) && /\\[native code\\]/.test(WebSocket.prototype.send.toString())`), 'WebSocket e send sono quelli nativi');
ok((await valuta('messaggiFinestra')) === 0, `nessun postMessage visibile alla pagina (${await valuta('messaggiFinestra')})`);

// IA muta: Python fermo → dopo 2,5 s la persona riprende da sola.
ponte.kill('SIGSTOP');
await sleep(3200); t0 = Date.now(); await sleep(1200);
a = inputDopo(t0);
ok(a.length > 30 && a.every(diPersona), `IA muta (processo fermo): la persona riprende da sola (${a.length} input col mouse vero)`);
ponte.kill('SIGCONT');
await sleep(1500);

// Modalità pratica: il server tace, il «simulatore» della pagina mette uno snapshot in `snaps` a ogni tick
// (come client.js con myLobby = 0) e legge la direzione da `mouse`.
await valuta(`(() => { ws.onclose = null; ws.close(); myLobby = 0; const L = ${JSON.stringify(snaps.slice(0, 120))};
  let i = 0; window.__praticaProva = setInterval(() => { const o = JSON.parse(L[i++ % L.length]); delete o.t; o.ts = Date.now(); snaps.push(o); if (snaps.length > 20) snaps.shift(); }, 1000 / 60); })()`);
await sleep(1000);
const m0 = await valuta('[mouse.x, mouse.y]');
await sleep(5500);
const m1 = await valuta('[mouse.x, mouse.y]');
const pr = [...fs.readFileSync(path.join(qui, '..', 'registro.txt'), 'utf8').matchAll(/diagnosi IA \(pratica\) · risposta (\d+)\/(\d+) ms.*snapshot (\d+)\/s/g)].at(-1);
ok(!!pr, pr ? `pratica: ${pr[0].replace(/^.*diagnosi /, '')}` : 'pratica: nessuna diagnosi');
ok(pr && Number(pr[3]) >= 18 && Number(pr[3]) <= 30, 'pratica: snapshot inoltrati alla cadenza del server (uno ogni 2–3 tick, non 60/s)');
ok(m0[0] !== m1[0] || m0[1] !== m1[1], "pratica: l'IA muove il puntatore che il simulatore della pagina legge");
await valuta('clearInterval(window.__praticaProva); myLobby = 1; connect()');
await sleep(1500);
ok(/in partita/.test(consolePonte), 'il ponte ha riconosciuto la partita (proprio serpente trovato negli snapshot)');
ok(/controllo → PERSONA/.test(consolePonte) && /controllo → IA/.test(consolePonte), 'i cambi di controllo arrivano a Python');
console.log('— registro del ponte —\n' + consolePonte.split('\n').filter((l) => l.trim()).slice(-8).join('\n'));
ponte.kill('SIGINT');
await attendi(() => ponte.exitCode !== null, 5000, 'chiusura del ponte');

// ---- direzione, boost e cashout: browser.mjs da solo, comandi scritti a mano ----------------
console.log('\ncomandi diretti (browser.mjs da solo) …');
const br = spawn('node', [path.join(qui, '..', 'browser.mjs'), JSON.stringify({ portaWs })], { stdio: ['pipe', 'pipe', 'inherit'] });
let brOut = '';
br.stdout.on('data', (d) => { brOut += d; });
await attendi(() => /"k":"pagina"/.test(brOut), 15000, 'pagina ricollegata');
const scrivi = (o) => br.stdin.write(JSON.stringify(o) + '\n');
scrivi({ c: 'cfg', modo: 'ai' });
let cmd = { dir: 0.5, boost: true, cash: false };
const rip = setInterval(() => scrivi({ c: 'cmd', ...cmd, n: 0 }), 40);
await sleep(800); t0 = Date.now(); await sleep(800);
a = inputDopo(t0);
const err = Math.max(...a.map((x) => Math.abs(x.m.targetDir - 0.5)));
ok(a.length > 20 && err < 3e-4, `direzione: il client manda targetDir = 0,5 rad (scarto massimo ${err.toExponential(1)} rad)`);
ok(a.every((x) => x.m.boost === true), 'boost: mousedown sintetico → boost del client');

log.length = 0;
const tIni = Date.now();
cmd = { dir: 0.5, boost: true, cash: true };
await attendi(() => log.some((x) => x.m.t === 'cashout'), 6000, 'messaggio cashout');
const co = log.find((x) => x.m.t === 'cashout');
const inCash = log.filter((x) => x.m.t === 'input' && x.m.cashingOut);
ok(!!co && Math.abs(co.t - tIni - 3000) < 200, `cashout: {"t":"cashout"} dal client dopo ${co ? co.t - tIni : '?'} ms (attesi ~3000)`);
ok(inCash.length > 100 && inCash.every((x) => x.m.boost === false && Math.abs(x.m.targetDir - 0.5) < 3e-4), `${inCash.length} input con cashingOut, boost spento e direzione bloccata`);

cmd = { dir: 0.2, boost: false, cash: false };
await sleep(500);
log.length = 0;
cmd = { dir: 0.2, boost: false, cash: true };
await sleep(1500);
cmd = { dir: 0.2, boost: false, cash: false };
await sleep(2500);
ok(!log.some((x) => x.m.t === 'cashout'), 'rilasciato a 1,5 s: nessun cashout (il client azzera la carica)');
clearInterval(rip);

clearInterval(mano);
scrivi({ c: 'esci' });
chrome.kill('SIGTERM');
await sleep(800);
srv.close(); wss.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fallite ? `\n${fallite} controlli FALLITI` : '\nTutto ok');
process.exit(fallite ? 1 : 0);
