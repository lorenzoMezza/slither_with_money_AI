# ponte: l'IA che gioca su moneyslither.com

Tutto ciò che serve al ponte sta in questa cartella:

```text
ponte/
  avvia.sh               lancia il ponte (questo è l'unico comando che serve)
  ponte.py               il programma: carica il modello, riceve gli snapshot, manda le decisioni
  cervello.py            snapshot → osservazione → decisione (Featurizer, rete, ActionCodec)
  browser.mjs            tubo fra l'estensione di Chrome e Python (WebSocket su 127.0.0.1:8765)
  estensione/            l'estensione da caricare in Chrome (pagina.js, relay.js, sfondo.js, manifest.json)
  prove/                 prova_ponte.mjs (end-to-end), prova_cervello.py, genera_snapshot.py
  CONTRATTO-MODELLO.md   cosa il modello riceve e produce, condizioni di rete
  registro.txt           le righe dell'ultima sessione (si riscrive a ogni avvio)
```

Usa però il simulatore (`../simulatore/python`, per il Featurizer) e il codice dell'addestramento
(`../allenamento/ia`, per caricare il modello): la cartella va lasciata dentro il progetto.

## Come usarlo

### Una volta sola
1. In Chrome apri `chrome://extensions`, attiva **Modalità sviluppatore** (in alto a destra).
2. **Carica estensione non pacchettizzata** → scegli `slither_with_money_AI/ponte/estensione` → Seleziona.
   (Se c'era già una scheda «Ponte IA per moneyslither» con un'altra cartella, rimuovila prima.)
3. Se manca `ponte/node_modules`: nel Terminale `cd ~/Desktop/slither_with_money_AI/ponte && npm install`.

### Ogni volta
1. Nel Terminale:
   ```bash
   cd ~/Desktop/slither_with_money_AI && ponte/avvia.sh tutte_le_versioni/model_1.pt
   ```
   (`model_1.pt` = primo in `tutte_le_versioni/CLASSIFICA.txt`; va bene qualunque `.pt` o la cartella di una corsa.)
2. Si apre moneyslither.com in Chrome. Se era già aperto, ricarica la pagina con **⌘R**.
3. Controlla: etichetta **verde** in alto a sinistra («● IA al comando») e, nel Terminale,
   `pagina del gioco collegata` e `socket del gioco agganciato`.
4. Entra in partita **tu** (lobby, posta, Gioca), oppure in **pratica** per provare senza soldi.
   Da lì guida l'IA: nel Terminale compare `in partita · … · guida: IA`.
5. **X** = passa il controllo a te / di nuovo all'IA. **Ctrl+C** nel Terminale = ferma il ponte
   (dopo 2,5 s il controllo torna a te da solo, anche a metà partita).

### Dopo aver cambiato i file dell'estensione
`chrome://extensions` → **↻** sulla scheda «Ponte IA» → ricarica la pagina del gioco.

### Se qualcosa non va
| sintomo | causa |
|---|---|
| `la porta 8765 è occupata` | c'è già un ponte acceso: chiudilo (Ctrl+C nel suo Terminale) |
| etichetta grigia, niente `pagina del gioco collegata` | estensione non caricata o non ricaricata, o pagina non ricaricata |
| `snapshot 0/s` nella diagnosi | non sei in partita (menu) |
| `No such file` all'avvio | il percorso del modello è sbagliato |

Opzioni: `--parti-umano` (all'avvio guidi tu), `--greedy` (azioni deterministiche), `--dispositivo cpu|mps|cuda|auto`
(predefinito cpu), `--thread N` (predefinito 1), `--porta-ws N`, `--non-aprire`, `--url`.

## Come guida: dall'interno del gioco, come un controller

Il sito ha un supporto per i controller (`gamepad-client.js`): legge le levette e le trasforma in
eventi `mousemove`, `mousedown`/`mouseup` (boost) e nel tasto Q tenuto (cashout). Il ponte fa la
stessa cosa con le decisioni dell'IA:

| decisione | evento nella pagina | cosa fa il client |
|---|---|---|
| direzione `dir` | `mousemove` a centro + 4096 px·(cos, sin) | `targetDir = atan2(…)`, scarto < 2·10⁻⁵ rad |
| boost | `mousedown` / `mouseup` (tasto 0) | `boosting` |
| cashout tenuto | `keydown` / `keyup` di Q | carica, direzione bloccata, `{"t":"cashout"}` a 3000 ms |

È il client a mandare l'input a ogni fotogramma, a disegnare il serpente e a chiudere il cashout,
proprio come quando gioca una persona. Il ponte non sostituisce WebSocket né `send`, non scarta
messaggi e non mette nulla su `window`. Legge gli snapshot aggiungendo un ascoltatore al socket
del client (la variabile `ws` del gioco), come fa il modulo «money rain» del sito. Con l'altra metà
dell'estensione parla attraverso eventi del DOM a nome fisso, non con `postMessage`, che
arriverebbe anche agli ascoltatori del sito.

Mentre guida l'IA, mouse e tasti **veri** non arrivano al gioco (gli eventi sintetici sì). Fanno
eccezione X, Esc, Tab e le scorciatoie con ⌘/Ctrl.

1. Python carica il modello sulla **CPU, con 1 thread** (≈1 ms a decisione, misurato; su MPS
   sono 3 ms e la GPU va condivisa col disegno del gioco). Poi ascolta su 127.0.0.1:8765 e accetta
   solo l'estensione (controllo dell'origine).
2. **In partita entri tu**, come sempre (lobby, posta, «Gioca»). Il ponte non entra mai da solo e
   non sceglie la posta: sono soldi veri.
3. Da lì guida l'IA. Ogni snapshot `state` arriva a Python così com'è (testa JSON + TAB + testo
   del server) e diventa l'osservazione (lo stesso `Featurizer` dell'addestramento). La decisione
   torna alla pagina col numero dello snapshot a cui risponde.
4. **X** passa il controllo dall'IA alla persona e ritorno. Al cambio boost e Q vengono rilasciati
   e il puntatore torna dov'è il mouse vero. Mentre guidi tu, l'IA continua a osservare con le tue
   azioni (lette dal client: `__lastAimDir`, `boosting`, `cashoutCharging`).
5. Morte o cashout vengono riconosciuti dagli snapshot. Memoria e dossier si azzerano e il ponte
   aspetta la partita dopo.

**Diagnosi dal vivo**: ogni 5 s una riga «diagnosi IA|TU» in console e in `ponte/registro.txt` (azzerato a
ogni avvio, solo sul disco). Contiene: `risposta` mediana/peggiore = ms dallo snapshot arrivato nella pagina
al comando applicato (di cui `python` = dalla riga ricevuta al comando scritto, `rete` = calcolo); `gioco` =
FPS del client; `fotogrammi persi` (intervalli > 25 ms) e il peggiore; `snapshot`/s e il `buco` più lungo fra
due snapshot, che è la rete o il server, non il ponte; `ponte nella pagina` = ms al secondo spesi dal ponte
nel thread del gioco. Premendo X si confrontano IA e persona sulle stesse misure. La direzione si scrive
direttamente nella variabile `mouse` del client (niente eventi a 24 Hz); se non c'è, si usa l'evento.

## Modalità pratica

In pratica (lobby 0) la partita è simulata nella pagina dal client (`simTick`, `buildSnap` in `client.js`)
e il server non manda nulla. Il ponte prende gli snapshot del simulatore da `snaps` e ne inoltra uno ogni
2 o 3 tick come fa il server (il simulatore ne fa uno a tick); il simulatore legge la direzione da `mouse`,
boost e Q come nel gioco vero. La diagnosi lo segnala con «(pratica)». Serve a provare il ponte senza
soldi, NON a giudicare l'IA: la fisica della pratica è la copia del client, che il server smentisce su
costo del boost, crescita, oro, bottino e cashout (`analizer/RESOCONTO-GIOCO.md`, voci [✗S]), e i bot
sono quelli del tutorial.

## Sicurezza e limiti

- **Un sito qualunque non può comandare il gioco**: il server locale accetta solo l'origine `chrome-extension://`.
- **Silenzio dell'IA = controllo alla persona.** Se per 2,5 s l'IA non manda comandi (ponte morto,
  modello bloccato, Ctrl+C), l'estensione rilascia boost e Q e rende mouse e tasti alla persona.
- **Niente CDP.** Il vecchio modo «Chrome a parte via DevTools» è stato tolto: `Runtime.enable` fa
  leggere a Chrome l'oggetto-trappola che il sito stampa ogni 4 s (`client-security.js`,
  «console-getter»), e il sito segnala «devtools aperti». Attenzione: l'analizzatore
  (`analizer/src/capture/recorder.js`) usa ancora `Runtime.enable` e `Debugger.enable`.
- La pagina non deve leggere le variabili-trappola del sito (`_balance`, `_money`, `_score`, `__player`,
  `__cheat`, `godmode`, `cheats`, `_adminToken`, …): leggerle le segnala al server. Il ponte legge solo
  `ws`, `myId`, `joined`, `spectatorMode`, `boosting`, `cashoutCharging`, `__lastAimDir`,
  `__cashoutLockedDir`, `_fpsEma`.
- Gli eventi sintetici hanno `isTrusted = false`, come quelli del controller del sito: il client non
  lo controlla (verificato su `client.js?v=killcam4`, 2026-10-07). Se un giorno lo controllasse,
  l'IA smetterebbe di guidare e la persona resterebbe al comando.
- Registro a console; niente degli snapshot (dati personali) viene scritto su disco.

## Prove

```bash
node ponte/prove/prova_ponte.mjs tutte_le_versioni/model_1.pt       # ~1 min, Chrome headless + estensione vera
allenamento/.venv/bin/python ponte/prove/prova_cervello.py tutte_le_versioni/model_1.pt
```

`prova_ponte.mjs` usa una pagina finta che gestisce gli input con il codice del client vero, e un
mouse «vero» (eventi fidati via CDP: la prova, non il ponte, usa CDP sulla pagina finta). Controlla
20 cose: l'IA guida, il mouse vero viene fermato, X nei due sensi, silenzio dell'IA, latenza,
invisibilità (window, WebSocket nativo, nessun postMessage), direzione esatta, boost, cashout a
3000 ms e rilascio. Misurato il 2026-10-07 sul Mac: rete ~3 ms (con Chrome acceso accanto),
risposta 4 ms, gioco a 60 FPS.
**Non ancora provato sul sito vero.** Al primo avvio controlla nel registro «socket del gioco
agganciato», «in partita», e che l'etichetta cambi con X e mostri `risposta` e `gioco … FPS`.
