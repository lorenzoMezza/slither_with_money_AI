# analizer

Analizzatore in tempo reale di **moneyslither.com**. Mentre giochi nel browser
registra tutto ciò che passa — ogni frame WebSocket, ogni risposta HTTP, il
sorgente di ogni script, lo stato del client — e ne ricava, man mano, le regole
e la fisica del **server**: quelle che servono a costruire un simulatore fedele.

Il risultato è una cartella, `estratto/`, da cui il simulatore si costruisce
partendo da `simulatore.json`.

## Uso

```bash
cd analizer
npm install                     # una volta: l'unica dipendenza è `ws`
node analizer.js login          # una volta: login con Google in un Chrome normale
node analizer.js                # apre il gioco, registra e analizza mentre giochi
```

Durante la sessione, nel terminale:

| comando | effetto |
|---|---|
| `s` | stato della registrazione e copertura |
| `c` | cosa è già stato osservato e cosa manca, con l'azione che lo provoca |
| `m <nota>` | marcatore nella cronologia |
| `a` | riscrive subito l'estratto (lo fa comunque ogni 15 s) |
| `q` / CTRL+C | chiusura pulita (o chiudi Chrome) |

Altri comandi:

```bash
node analizer.js analizza            # rigenera estratto/ da tutte le sessioni registrate
node analizer.js analizza 20261004   # solo le sessioni il cui nome contiene questo testo
node analizer.js importa <cartella>  # importa catture del vecchio registratore (capture/<id>/)
```

## Perché il login è un passo a parte

Google blocca l'inserimento della password nei browser collegati a DevTools
(«This browser or app may not be secure»). È una protezione legittima e il
programma non la aggira: il login si fa in un Chrome del tutto normale sullo
stesso profilo (`chrome-profile/`), e la registrazione riusa la sessione salvata.

## Cosa fa, in tre vie indipendenti che si controllano a vicenda

1. **Traffico.** Si aggancia a Chrome con il DevTools Protocol (una connessione
   sola, tutti i contesti: pagina, iframe, worker) e salva ogni frame con il
   timestamp monotono della rete. Ogni messaggio viene interpretato subito: lo
   schema di ogni tipo campo per campo, e il mondo ricostruito snapshot dopo
   snapshot.
2. **Sorgente.** Ogni script del gioco viene salvato e analizzato: costanti con
   il blocco di provenienza (il client dichiara da sé quali parti sono un
   «server port»), sezioni marcate, funzioni della fisica, messaggi che sa
   mandare e gestire, endpoint. Le funzioni pure della fisica vengono **eseguite
   in una sandbox** (`node:vm`) per confrontarle con i dati veri.
3. **Stato del client.** Una lettura periodica e in sola lettura della pagina
   (`Runtime.evaluate`) recupera ciò che il traffico non mostra, prima di tutto
   le impostazioni live che il server manda con `user_flags` e che sovrascrivono
   i default del sorgente.

Il metodo delle misure: il server avanza a **tick discreti**, quindi quasi ogni
grandezza è quantizzata, e si misura contando i gradini invece di mediare il
rumore. Il numero di tick fra due snapshot è esatto (lo spostamento è un
multiplo esatto del passo); il tempo vero viene dall'orologio della rete. Ogni
velocità è prima «unità per tick», i secondi arrivano dopo, con la frequenza
**misurata**. Il numero di tick fra due snapshot si conta dallo SPOSTAMENTO, mai dal `ts`: il `ts` è l'ora d'invio dello snapshot, presa da un timer diverso da quello del tick, e arrotondarlo sbaglia il conteggio nel 7 % degli intervalli (è così che in passato erano venuti fuori «61,25 Hz»: sono 60,0).

Dove misura e sorgente coesistono si confrontano, e ogni parametro di
`simulatore.json` porta il verdetto: *confermato*, *smentito* (vale la misura),
*solo sorgente* (da verificare).

## Cosa viene misurato

| ambito | grandezze |
|---|---|
| tempo e rete | frequenza vera del server, tick per snapshot, Hz degli snapshot e degli input, RTT, jitter, ritardo comando → server |
| movimento | passo per tick base e in boost, linearità col boost, rampa del boost, sterzata massima (e se dipende da taglia o boost), legge di sterzata verificata sul proprio serpente |
| corpo | distanza fra anelli, anelli in funzione della taglia, spessore in funzione degli anelli (confrontati con le funzioni del client eseguite) |
| boost | costo per tick su tratti puliti, confronto fra legge costante, proporzionale e a due termini |
| cibo | orb dentro e fuori dal muro, densità, distribuzione di nascita, raggio di raccolta (normale e oro), legge di crescita, accredito del valore |
| arena | raggio in funzione dei serpenti vivi, ritmo di avvicinamento, soglia della morte sul muro |
| vita ed economia | bottino alla morte (numero di orb, valore, massa), scadenza, nascite, poste, tetto di taglia, commissione del cashout, money rain |
| combattimento | soglie delle hitbox inquadrate fra quasi-contatti dei sopravvissuti e uccisioni, regola del frontale |
| cashout | durata in tick, curva di rallentamento, sterzo e boost durante, interruzione, sequenza dei messaggi |
| protocollo | ogni messaggio, campo per campo, con presenza, intervalli, **precisione numerica** ed esempi |

**Il server cambia.** Fra settembre e ottobre 2026 il cibo in campo e' sceso da
430 a 86 orb e l'uccisore ha cominciato a incassare il 40 % del saldo della
vittima. Mescolare sessioni di versioni diverse falsa le misure: quando le regole
cambiano, sposta le sessioni vecchie fuori da `sessioni/` (per esempio in
`archivio/`), e l'estratto torna a descrivere solo il server attuale.

Alcune regole esistono solo quando succede qualcosa in partita (una morte per
collisione, un cashout, un money rain): il comando `c` dice cosa manca e come
provocarlo.

## Dove finiscono i dati

```text
analizer/
├── estratto/                 ← L'USCITA: si parte da simulatore.json (vedi estratto/LEGGIMI.md)
├── sessioni/<id>/            i dati grezzi di ogni sessione
│   ├── rete/frames.ndjson.gz     ogni frame WebSocket, in ordine
│   ├── rete/http.ndjson, http/   ogni richiesta HTTP e il suo corpo
│   ├── sorgente/script/          ogni script visto (HTTP e V8: inline, eval, worker)
│   ├── runtime/                  stato del client, globali, console
│   └── estratto/                 l'analisi di questa sola sessione
├── archivio/server-2026-09/  catture di settembre: server con regole diverse, escluse dall'estratto
├── chrome-profile/           profilo Chrome con il login (dati personali, non versionato)
├── analizer.js               il programma
└── src/
    ├── browser/              Chrome e DevTools Protocol
    ├── capture/              registratore, formato su disco, lettura dello stato del client
    ├── source/               analisi statica del sorgente e modello eseguibile
    ├── analysis/             motore, moduli di misura, specifica del simulatore
    └── report/               scrittura dell'estratto
```

Token e cookie vengono oscurati prima di toccare il disco (`REDACT=0` per
disattivare). Il programma è passivo: non manda nulla al server di gioco.

## Configurazione

| variabile | default | |
|---|---|---|
| `TARGET_URL` | `https://moneyslither.com/` | pagina del gioco |
| `GAME_HOSTS` | `moneyslither.com` | host i cui script sono il sorgente del gioco |
| `CHROME_PATH` | rilevato | eseguibile di Chrome |
| `PROFILE_DIR` | `./chrome-profile` | profilo persistente |
| `DEBUG_PORT` | — | aggancia un Chrome già aperto con questa porta DevTools |
| `ANALYSIS_MS` | `15000` | ogni quanto si riscrive l'estratto |
| `STORICO` | `1` | l'estratto live comprende le sessioni precedenti |
| `V8_SCRIPTS` | `1` | sorgente di ogni script compilato (disattiva se il gioco rallenta) |
| `RUNTIME_MS` | `2000` | lettura dello stato del client |
| `PROBE_VARS` | — | altre variabili globali del client da leggere (separate da virgola) |
| `AUTO_STOP_MS` | `0` | chiusura automatica dopo N ms |
| `CLOSE_BROWSER` | `1` | chiude Chrome all'uscita |
