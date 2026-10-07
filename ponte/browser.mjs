/**
 * Il tubo fra l'estensione (nel Chrome della persona) e il cervello Python.
 *
 * Un WebSocket su 127.0.0.1 a cui si collega lo sfondo dell'estensione (`ponte/estensione/sfondo.js`):
 *   estensione → qui → Python (stdout, una riga per messaggio, così com'è):
 *     snapshot e messaggi del server  `{"k":"rx","ty":…,"n":…}` TAB testo del server
 *     tutto il resto                  una riga JSON ({"k":"modo"}, {"k":"stat"}, {"k":"pagina"}, …)
 *   Python → qui → estensione (stdin, una riga JSON per comando):
 *     {"c":"cmd","dir":rad,"boost":bool,"cash":bool,"n":k}   decisione dell'IA sullo snapshot k
 *     {"c":"modo","modo":"ai"|"umano"} · {"c":"cfg",…} · {"c":"testo","t":"…"} · {"c":"esci"}
 *   Eventi di qui: {"k":"in_ascolto"}, {"k":"ws","ev"}, {"k":"errore","m"}. Messaggi per le persone: stderr.
 *
 * Nessun protocollo di debug (CDP): niente Chrome avviato da qui, niente `Runtime.enable`.
 */
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

const opt = JSON.parse(process.argv[2] || '{}');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const log = (s) => process.stderr.write(`[browser] ${s}\n`);

const porta = opt.portaWs || 8765;
let attivo = null;
const wss = new WebSocketServer({
  host: '127.0.0.1', port: porta, perMessageDeflate: false,
  // Un sito qualunque non deve poter comandare il gioco: solo l'estensione (origine chrome-extension://).
  verifyClient: ({ origin }) => /^chrome-extension:\/\//.test(origin || ''),
});
wss.on('error', (e) => { out({ k: 'errore', m: e.code === 'EADDRINUSE' ? `la porta ${porta} è occupata (un altro ponte è già in esecuzione?)` : String(e) }); process.exit(1); });
wss.on('listening', () => { log(`in ascolto su 127.0.0.1:${porta} per l'estensione`); out({ k: 'in_ascolto', porta }); });
wss.on('connection', (ws) => {
  if (attivo && attivo.readyState === 1) attivo.close();
  attivo = ws;
  ws._socket?.setNoDelay(true);
  out({ k: 'ws', ev: 'estensione collegata' });
  ws.on('message', (d) => process.stdout.write(d.toString() + '\n'));
  ws.on('close', () => { if (attivo === ws) { attivo = null; out({ k: 'ws', ev: 'estensione scollegata' }); } });
});
setInterval(() => { if (attivo?.readyState === 1) attivo.send('{"c":"ping"}'); }, 20_000);   // tiene sveglio lo sfondo

const righe = readline.createInterface({ input: process.stdin });
righe.on('line', (riga) => {
  if (riga.startsWith('{"c":"esci"')) process.exit(0);
  if (attivo?.readyState === 1) attivo.send(riga);
});
// Python morto: si chiude; la pagina dopo 2,5 s di silenzio rende il controllo alla persona.
righe.on('close', () => process.exit(0));
