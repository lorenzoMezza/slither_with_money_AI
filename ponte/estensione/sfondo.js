// Service worker: tiene il WebSocket verso il ponte locale (browser.mjs, 127.0.0.1) e fa da tubo con le pagine.
// I messaggi sono testo e passano così come sono, nei due sensi.
const PORTA = 8765;
const porte = new Set();
let ws = null;
let timer = null;

const aperto = () => ws && ws.readyState === WebSocket.OPEN;
const alle_pagine = (m) => { for (const p of porte) { try { p.postMessage(m); } catch (_) { /* pagina chiusa */ } } };

function apri() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORTA}/`); } catch (_) { riprova(); return; }
  ws.onopen = () => alle_pagine({ __stato: 1 });
  ws.onmessage = (e) => { if (typeof e.data === 'string' && e.data !== '{"c":"ping"}') alle_pagine(e.data); };
  ws.onclose = () => { ws = null; alle_pagine({ __stato: 0 }); riprova(); };
  ws.onerror = () => { try { ws.close(); } catch (_) { /* già chiuso */ } };
}
function riprova() {
  clearTimeout(timer);
  if (porte.size) timer = setTimeout(apri, 1000);
}

chrome.runtime.onConnect.addListener((p) => {
  porte.add(p);
  p.onDisconnect.addListener(() => porte.delete(p));
  p.onMessage.addListener((m) => { if (aperto() && typeof m === 'string') ws.send(m); });
  p.postMessage({ __stato: aperto() ? 1 : 0 });
  apri();
});
