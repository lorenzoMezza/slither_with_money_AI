// Mondo isolato della pagina: unico tratto fra pagina.js (mondo della pagina) e lo sfondo dell'estensione.
// Con pagina.js si parla con eventi del DOM a nome fisso e testo semplice: niente postMessage, che
// arriverebbe anche agli ascoltatori del sito.
(() => {
  const EV_TX = 'ponte:tx', EV_RX = 'ponte:rx', EV_STATO = 'ponte:stato';
  let porta = null;
  const alla_pagina = (tipo, testo) => document.dispatchEvent(new CustomEvent(tipo, { detail: testo }));
  function collega() {
    try {
      porta = chrome.runtime.connect({ name: 'ponte' });
    } catch (_) { setTimeout(collega, 1000); return; }
    porta.onMessage.addListener((m) => {
      if (typeof m === 'string') alla_pagina(EV_RX, m);
      else if (m && m.__stato !== undefined) alla_pagina(EV_STATO, m.__stato ? '1' : '0');
    });
    porta.onDisconnect.addListener(() => {
      porta = null;
      alla_pagina(EV_STATO, '0');
      setTimeout(collega, 1000);                 // lo sfondo si è riavviato
    });
  }
  document.addEventListener(EV_TX, (e) => {
    if (typeof e.detail !== 'string') return;
    try { porta?.postMessage(e.detail); } catch (_) { /* porta chiusa: si ricollega da sola */ }
  });
  collega();
})();
