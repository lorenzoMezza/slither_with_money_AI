markdown

````
# CLAUDE.md — slither_with_money_AI

Contesto per riprendere il lavoro in una nuova sessione. Aggiornato al 2026-10-07.
**Rispondi sempre in italiano**, con gli accenti corretti.

## Cos'è il progetto

Un'AI che gioca a **moneyslither.com**: uno slither.io in cui si entra con una posta in
denaro, si guadagna mangiando il bottino d'oro di chi muore e si esce col cashout
(3 s, commissione 10 %). Morire vuol dire perdere tutto il saldo.

Tre tappe, tre cartelle: osservare il gioco vero (`analizer/`), riprodurlo fedelmente
(`simulatore/`), addestrarci l'AI (`allenamento/`).

**L'obiettivo dell'utente**: un agente che batte stabilmente un giocatore umano
professionista e massimizza il profitto per partita. Deve morire pochissimo, superare
il 100 % di profitto quando si può, non uscire troppo presto se ci sono occasioni
sicure, e capire da solo quando restare e quando uscire. Non conta uscire in positivo
di 20 centesimi due volte se poi si muore e se ne perde 1 euro. Ogni comportamento
deve nascere dalla ricompensa, non da regole scritte a mano. La paura più grande
dell'utente: un agente che, a forza di giocare contro sé stesso, sa battere solo sé
stesso. Deve battere chiunque.

## Vincoli da rispettare SEMPRE

- **Addestramento solo in locale.** L'agente si allena esclusivamente contro il
  simulatore e i bot interni. La verifica su sessioni registrate avviene offline con
  `allenamento/replay_reale.py`.
- **Dati personali, mai pubblicati.** `analizer/chrome-profile/` (login Google),
  `analizer/sessioni/` e `analizer/archivio/` restano sul disco (`.gitignore`): mai
  committati, caricati o mostrati in artifact. L'email dell'utente serve solo a
  identificarlo.
- **Commit e push**: dal 2026-10-05 sera l'utente li ha chiesti per ogni modifica; il
  lavoro è su `main`.
- **Backup del vecchio progetto** in `~/Desktop/slither_with_money_AI_backup_20261004/`:
  non cancellarlo.
- **Osservazione = solo ciò che il client vede online.** Niente timer del bottino (il
  bottino non scade mai), niente orologio di partita (`x[24]` = 0:
  la fine della partita in addestramento non va prevista). Ogni sensore nuovo deve
  essere calcolabile dallo snapshot.
- **La ricetta è `PIANO_ADDESTRAMENTO.md`** (radice): architettura, ricompensa a punti
  dell'utente (fase 1 predatore, fase 2 giocatore completo, affinamento), le quattro
  tappe con i comandi, i numeri attesi, come scalare, l'esperienza fatta. Non aggiungere
  termini di ricompensa che l'utente non ha chiesto. Il momento di chiudere una tappa lo
  decide Claude (stallo o regressione dopo un buon punto), seguendo la corsa ogni 10
  minuti, e lo propone all'utente.
- **I bot tengono il loro tempo di reazione**: è quello di una persona, non un costo.

## Struttura

```text
analizer/      Node ≥ 20. Registra il gioco dal browser (CDP: traffico WS, sorgente, sonda) e ne
               ricava fisica e regole. analizer.js (login | registra | analizza), src/…
               RESOCONTO-GIOCO.md = il gioco sul server, regola per regola, con fonte e certezza
simulatore/    Rust. src/: world (il server, tick per tick), snake, snapshot (JSON identico al
               server), env (una lobby vista da client con latenza; partite; situazioni), bots
               (11 stili, strato di sicurezza), features (osservazione dallo snapshot), vecenv,
               ffi (C per Python), viewer, record, validate. python/slither_sim (ctypes + numpy).
allenamento/   Python 3.13 + PyTorch (MPS).
               pannello.py + pannello/index.html   UI nel browser (l'utente non usa il terminale)
               allena.py      il ciclo: raccolta → PPO → lega/torneo → selezione → registri; cambio di fase
               finale.py      la finale: candidati alla pari, salva model_1.pt … model_N.pt
               medie.py       medie a blocchi di registro.csv (i controlli ogni 10 minuti)
               guarda.py / sfida.py / valuta.py / replay_reale.py   osservare, giocare, misurare
               ia/config.py   tutti i parametri (sezioni env, ppo, ricompensa, lega)
               ia/rete.py     la rete; ia/azioni.py la codifica delle azioni
               ia/raccolta.py il Collector (lobby parallele, inferenza a lotti, ricompense)
               ia/ppo.py      Learner e aggiornamento PPO ricorrente
               ia/punti.py    la ricompensa a punti (fase 1 e 2), uguale per passo e dal resoconto
               ia/lega.py     campioni e selezione a torneo, archivio (deboli), PFSP, Elo, stili dei bot
               ia/partite.py  Matchmaker (lobby, gironi del torneo, banco) e Benchmark
               ia/sessioni.py lettura delle sessioni registrate (per replay_reale.py)
               ia/carica.py   caricare e far giocare un modello; ia/registro.py CSV ed eventi
               ia/diario.py   corse/<nome>/diario.txt: il racconto compatto della corsa, da incollare per una diagnosi
               corse/<nome>/   ignorate da git
runpod/        Makefile (inoltrato dal Makefile di radice), config.json, strumenti.py (regolatore),
               riavvia.sh (lancia/riprende una tappa: NOME, IMPOSTA), README: il pod.
PIANO_ADDESTRAMENTO.md  architettura e ricetta completa (LEGGERE PRIMA DI TOCCARE L'ADDESTRAMENTO)
````

svgsvg

## Comandi

bash

```
cd analizer && npm install && node analizer.js login      # una volta; poi: node analizer.js (registra), analizza
cd simulatore && cargo build --release                    # serve anche al Python
cargo test --release                                      # 9 test
cargo test --release diagnosi -- --ignored --nocapture    # morti dei bot forti e classici (DIAG_SEED, DIAG_ENCIRCLE…)
./target/release/simulatore vedi|valida|registra|bench|parametri

cd allenamento                                            # di solito dal PANNELLO
.venv/bin/python pannello.py                              # http://127.0.0.1:8080 (o Allenamento.command)
.venv/bin/python allena.py --nome prima                   # nuova corsa, o la riprende; --piccola per la prova di fumo
.venv/bin/python valuta.py corse/prima                    # banco di prova del migliore
.venv/bin/python guarda.py corse/prima                    # 3 partite dal vivo, porte 8081–8083
.venv/bin/python sfida.py corse/prima                     # l'utente contro l'IA, porta 8084
.venv/bin/python replay_reale.py corse/prima              # l'agente sulle sessioni vere, offline
```

svgsvg

`--imposta sezione.chiave=valore` cambia qualunque parametro; ogni corsa salva la
propria `config.json` e la ricarica quando riparte.

## Fisica del server: VERITÀ data dall'utente il 2026-10-07 (`simulatore/src/config.rs`, campi [V])

Verità assoluta: nel simulatore è fissa, non si randomizza (si randomizzano solo rete e
tick) e l'estratto dell'analizzatore non la sovrascrive. Ogni file del repository la deve
rispecchiare; le regole che sostituisce non vanno più menzionate.

- **Movimento**: sterzata 8,1 rad/s = 0,135 rad/tick verso targetAngle; passo 4,8 + 5,7·boostAmount
  (288 u/s base, 630 u/s in boost); rampa 0,075/tick in salita e in discesa; boost solo con taglia > 40;
  raggio di curvatura 35,6 u (77,8 u in boost).
- **Corpo**: percorso ogni 1,6 u; anello i = punto 4·i (6,4 u), al massimo 1200 anelli; buffer
  max(800, anelli·4 + 200) punti, pre-riempito all'indietro alla nascita. Anelli: fino a taglia 100
  8 + (taglia − 40)·18/60, oltre 26 + (taglia − 100)·0,08, arrotondati, minimo 8. Spessore
  (7,5 + 0,55·√n + [n > 26]·0,17·(n − 26)^0,7)·1,43, minimo 10, uguale lungo tutto il corpo.
- **Taglia**: nascita 100 (saldo 1, posta 1), minimo 40, **tetto max(100, floor(saldo/posta·300))**
  a ogni tick. Boost: **10,8 % della taglia al secondo** (taglia·0,108/60 per tick) mentre è premuto,
  anche sulla rampa, non × boostAmount; sotto 40 si spegne. Cibo **3·(taglia/100)^0,6**, oro **+12**;
  coda di crescita ≤ 15 + 0,03·taglia per tick, sempre entro il tetto (la crescita oltre il tetto va persa).
- **Cibo**: **86 orb in campo contando il bottino**, rabbocco a ogni tick solo sotto 86; nascono
  uniformi entro 0,95·R; gli orb fuori dal muro vengono tolti; raccolta spessore + 29 (oro spessore + 42),
  l'oro aggiunge il suo valore al saldo; **il bottino non scade mai**.
- **Collisioni**: testa spessore·1,1995, corpo spessore·1,0165. Frontale (controllato per primo) se
  distanza ≤ (testa A + testa B)·1,07 e ciascuno punta verso l'altro entro 75° (cos > 0,2588): muore
  il più piccolo, a parità il caso (`smallest_wins` e `biggest_wins` fanno la stessa cosa). Altrimenti
  testa-corpo sugli anelli 2..min(anelli,1200)−1, senza arco frontale, mai col proprio corpo. Muro:
  distanza dal centro + 0,95·spessore > R.
- **Cashout**: tasto tenuto 3000 ms d'orologio del client; il server lo controlla ogni 30 ms; in carica
  direzione bloccata, boost spento, passo 4,8·(1 − 0,6·t^2,6) (fino al 40 %); rilascio prima dei 3 s =
  carica azzerata; a 3 s si incassa il saldo meno il **10 % di commissione**. Profitto +80 % ⇔ saldo 2,0
  all'uscita, +20 % ⇔ saldo 1,333.
- Non coperti dalla verità (misurati il 4–5 ottobre): 60 Hz, snapshot, RTT 35 ms, arena
  2000 + 100·(vivi − 1), bottino ceil(anelli/passo) orb = 100 % del saldo.
- Addestramento: `env.crescita_oro` = 12 come il server (guarda, sfida, valuta, addestramento e finale
  usano la stessa fisica); `env.taglia_grosso` (200, 300) e partenze «ricche» entro il tetto del saldo.

I modelli addestrati il 6 ottobre usavano una fisica precedente: vanno riaddestrati con questa.

## Addestramento: com'è fatto (dettaglio e motivazioni in `allenamento/README.md`)

**Osservazione** (10128 float, egocentrica, solo dallo snapshot; lo stesso `Featurizer`
gira sugli snapshot veri): sé stesso 40 (stato, velocità e sterzata con segno, budget e
costo del boost, muro che sta per stringersi, minacce più vicine, profitto se incassassi
ora, tempo minimo alla collisione, economia della lobby) · raggi 32×4 · avversari 8×36
(con posizione prevista a 0,5 s con la cinematica esatta del server, velocità, sterzata e dossier su \~20 s) · oro 8×5 ·
cibo 16×2 · griglia 6×32×32 da 20 u · mappa 6×24×24 da 200 u. Tutto derivato dagli
snapshot: niente che l'API del server non dia.

**Rete** (5,0 M parametri): MLP per sé stesso e cibo, Conv1d circolare per i raggi,
transformer 3×128 su io + avversari + ori, CNN a toppe per griglia e mappa, tronco
512, GRU 512. Codificatori in bf16, memoria e teste in fp32.

**Azioni**: svolta CONTINUA (gaussiana su u ∈ [−1, 1], deviazione imparata, angolo =
π·u·|u|: fine vicino a zero, piena fino a ±π; dal 2026-10-05 sera, su richiesta
dell'utente), boost Bernoulli, cashout = interruttore con due teste («inizia»,
«interrompi»); in carica svolta e boost sono fuori dal gradiente.

**DUE FASI + AFFINAMENTO + FINALE** (`PIANO_ADDESTRAMENTO.md`; corsa nuova da pesi casuali).
Fase 1 predatore: cashout bloccato per tutte le reti; lobby allievo + 2–3 avversari
neurali + 1–2 bot abilità 1, durata massima uniforme 60–300 s. Fase 2 giocatore
completo: allievo + 0–4 avversari + 1–2 bot, 80–320 s, lr 2e-4. Il cambio si fa
riprendendo con `--imposta fase=2` (`make addestra IMPOSTA="fase=2"`): l'allievo di
fine fase 1 diventa campione PROTETTO (gioca senza cashout), banco azzerato, 20
iterazioni di solo critico; `lega.fase_da_migliore=true` riparte da [migliore.pt](https://migliore.pt/).

**Ricompensa a punti** (`ia/punti.py`, per passo in `Collector._after_sim`, nessun altro
termine). Fase 1: 0,5 per uccisione (contatore `kills` del server; 0,375 = 75 % se vinta testa
contro testa, `kills_head_on`, info `uccisioni_frontali_passo`, INFO_SIZE 26), 1 per caduta intera
del bottino delle proprie uccisioni e 0,6 di quelle altrui (diviso per orb: ogni orb
d'oro porta `killer` e `share` = 1/orb della caduta, `world.rs`), 0,02 per orb di cibo
(raddoppiato il 2026-10-06), −0,5 alla morte testa contro testa (`Player.death_reason`,
info `frontale`; uguale nelle due fasi, chiesto dall'utente: non capiva che muore il più piccolo).
Fase 2: tutto × 0,7, più al cashout da sé 5,0 (profitto ≥ +80 % e nessun orb d'oro
dentro il muro), 2,6 (≥ +80 % con oro), 7,0 (> +20 % senza avversari vivi né oro; con
+80 % a lobby vuota vale 7,0), −5,0 (profitto sotto +20 %, `ricompensa.pena_sotto`, chiesta
dall'utente: uscire così va evitato assolutamente). Oro e avversari sono misurati nel momento del cashout
(`Player.exit_gold/exit_enemies`). Info nuove: `bottino_mio`, `bottino_altrui`,
`cibo_passo`, `oro_uscita`, `nemici_uscita`, `frontale` (INFO_SIZE 25). Verificato: la somma per
passo coincide con `punti_resoconto` del resoconto su 2.000 agenti, premi compresi.

**Lega a torneo** (`ia/lega.py`): ogni 20 iterazioni l'allievo entra fra i campioni;
gironi da 4 campioni sorteggiati, 16 partite fra loro (+ bot) sulle 16 lobby
`env.mondi_torneo`; restano i 2 migliori per punti medi (solo il primo sopra 16
campioni), gli altri cancellati. Archivio ogni 100 iterazioni (fino a 40) = versioni
deboli; in campo: avversario dal vivo 30 % o campione con PFSP, e nel 30 % delle lobby
una versione debole. **Banco** (16 lobby): bot:\<stile> (2 bot), campioni, deboli; punti
medi per scenario, fitness ½ media + ½ peggiore.

**Diversità** (`ia/diversita.py`, soglie e nicchie DELL'UTENTE, non cambiarle da soli):
impronta su una sonda fissa (96×48 passi veri, memoria vuota); cloni = Δsterzata e Δboost
< 0,05 → esce il peggiore; nicchie cacciatore (≥ 1 ucc/partita), sciacallo (bottino altrui
≥ proprio, < 1 ucc), corridore (boost ≥ 20 %), prudente (distanza dal nemico ≥ 600 u, misure
nuove del simulatore `boost_frazione`, `distanza_nemico`): l'ultimo di una nicchia non si
scarta; distanza media < 0,10 o un solo stile → 2 mutanti (rumore 1 % della deviazione per
strato, raddoppiato fino al 32 % finché non è più un clone: misurato, l'1 % non cambia nulla).

**Bot** (`bots.rs`): tattiche (raccolta, caccia, avvoltoio, ariete, esca, spinta al muro,
accerchiamento, affiancamento, fuga, varco, spirale, cashout col corridoio) sopra uno
strato di sicurezza che simula le rotte candidate. Accerchiamento opportunista di chi è
molto più lungo della preda. La diagnosi delle morti è deterministica per seme ma un
dettaglio diverso nel codice cambia tutte le partite (±15 morti su \~90): confrontare
SEMPRE la media su più semi (`DIAG_SEED`). Provati e scartati: latenza del comando
nelle traiettorie, orizzonti 8/24, margine 24, spazio libero dopo l'orizzonte. La
misura su 6 semi dell'accerchiamento è stata eseguita ma non letta (lettura bloccata
dal sistema): rifarla prima di toccare i bot.

**Su RunPod / CUDA** (`runpod/`): stesso codice, `dispositivo=auto` sceglie cuda; bf16
nei codificatori anche su CUDA; `torch.mps.*` solo se il dispositivo è mps. Testato qui
solo su CPU (niente GPU in questa sessione): setup, test, prova di fumo, avvio in
background, stato, fermata.

**Prestazioni sull'M5** (MacBook Air, senza ventola, 24 GB): \~3.000 campioni/s; dopo
pochi minuti la GPU rallenta del 35–50 %. Fatto: codificatori solo sui passi dell'allievo,
forme fisse per MPS, ori 16 → 8, rosa 6, niente entropie in raccolta, maschera GRU solo
se serve. `caffeinate` tiene sveglio il Mac; coperchio aperto e in carica.

**Raccolta veloce** (2026-10-06, misurata sul pod RunPod; il pod finale è una RTX 5090 32 GB, 112 core):
da 9.400 a \~23.400 campioni/s. Com'è fatta (`ia/raccolta.py`, `ia/rete.py`,
`slither_sim.SlitherVecEnvMeta`):

- tutti i controllori in UN passaggio: pesi impilati e `vmap` (`StackedPolicies`), due
  pile (allievi, copie) per non imbottire le copie; su CUDA ogni forma (K, M) è un CUDA
  graph; identica ai passaggi separati (fp32: scarto 2e-5);
- lobby in due metà: una viene simulata in un thread (ctypes lascia il GIL a Rust)
  mentre l'altra passa dalla rete; ricompense, episodi e partite nuove nel thread;
- solo le righe vive viaggiano verso la GPU, con `index_select` (tutti i core) in memoria
  bloccata; indici e posizioni in memoria bloccata, copie asincrone: l'unica attesa
  della GPU per mezzo passo è `act.cpu()`;
- thread di rayon e di torch limitati (`allena.py`), altrimenti il thread Python che
  guida la GPU resta senza core.
  Residuo: raccolta \~4,8 s per iterazione (GPU \~20 %), aggiornamento \~2 s (GPU 100 %).
  `env.inferenza_unica` ("auto" = su CUDA). Il regolatore di `runpod/` sceglie le lobby.

**Diario** (`ia/diario.py`, chiesto dall'utente il 2026-10-05 notte): `corse/<nome>/diario.txt`,
un solo testo che deve stare in una finestra di contesto: intestazione a ogni avvio
(commit, torch, dispositivo, comando, ricompensa, parametri diversi dai default), tutti gli
eventi, un riassunto aggregato a cadenza crescente (1/5/20/50/100/250 iterazioni) con
tempi, fase, per allievo episodi/punti/uccisioni/bottino/morte/cashout/KL/entropia/varianza spiegata, le
condizioni di promozione con i valori; un quadro ogni 10 riassunti (banco, bot,
rosa, campioni del torneo, iperparametri); anomalie «!!» automatiche; errori e chiusura. Sopra 600 kB
si diradano i riassunti vecchi. Il pannello ha «scarica il diario»; su RunPod `make diario`.
Quando l'utente passa un diario: leggere prima le righe «!!», poi le condizioni «NO».

## Pannello (`allenamento/pannello.py`)

Server HTTP con la sola libreria standard. `allena.py` gira in una sessione separata e
sopravvive alla chiusura del pannello (`processo.json`, `vivo.json`). Pausa =
SIGSTOP/SIGCONT; Ferma = SIGTERM (finisce l'iterazione, salva, esce). Osserva =
`guarda.py` (CPU, 1–3 finestre); Sfida = `sfida.py` (posto 0 comandato dal browser via
`sim_set_human`). Mostra fase, punti, uccisioni, cashout, torneo, grafici, banco, stili dei bot, eventi.

> **Nota sulla struttura:** il progetto comprende anche `ponte/`, descritto in dettaglio nella sezione **Ponte: agente sul gioco vero**. È il collegamento tra i modelli addestrati e il gioco reale.

## Ponte: agente sul gioco vero

Il `ponte/` è il componente che porta un modello addestrato dal simulatore al gioco reale su **moneyslither.com**. È separato dal simulatore e dall'addestramento: l'obiettivo è permettere all'IA di osservare il client reale e comandarlo attraverso gli stessi eventi di input che il sito usa normalmente.

### Struttura

```text
ponte/
  avvia.sh modello.pt        Avvia l'agente sul gioco vero usando il Chrome della persona.
  ponte.py                   Collegamento principale.
  cervello.py                Featurizer + rete + ActionCodec, eseguiti su CPU con 1 thread.
  browser.mjs                Parte Node che gestisce il collegamento al browser.
  estensione/                Estensione del browser.
  README.md                  Guida operativa del ponte.
  prove/                     Prove e test del collegamento.
```

Il collegamento locale usa un WebSocket su `127.0.0.1:8765`. L'IA guida il gioco come il controller del sito, usando eventi sintetici di `mousemove`, `mousedown` e del tasto `Q`. Il client accetta questi eventi anche con `isTrusted=false`, come avviene per il `gamepad-client.js`.

### Architettura attuale del ponte

Il ponte è stato rifatto il **2026-10-07** perché la versione precedente era lenta e faceva scattare il gioco.

La versione attuale deve rispettare questi punti:

- **Niente CDP**: non usare la modalità `--cdp`.
- **Niente `Runtime.enable`** sul sito vero: può attivare la trappola `console-getter` di `client-security.js` e provocare il rilevamento di «devtools aperti».
- **Niente sostituzione/intercettazione di WebSocket o `send`**.
- **Niente `postMessage`** per comandare il gioco.
- **Niente accesso a variabili su `window`**.
- La guida avviene tramite gli **eventi del controller del sito**, cioè lo stesso meccanismo concettualmente usato da `gamepad-client.js`.
- La rete neurale del ponte gira su **CPU, 1 thread**: non usare MPS per l'inferenza mentre il gioco è visualizzato, perché MPS sottraeva la GPU al disegno del gioco.
- Il collegamento locale del ponte è `127.0.0.1:8765`.

### Variabili/trappole del sito da non leggere

Sul sito vero **non devono essere lette** variabili interne o potenzialmente rilevanti per i sistemi di sicurezza. In particolare:

```text
_balance
_money
_score
__player
__cheat
godmode
cheats
_adminToken
...
```

Il principio è: il ponte deve utilizzare esclusivamente ciò che il client rende normalmente disponibile attraverso il proprio flusso osservabile, senza cercare scorciatoie o dati interni del gioco.

### Test già eseguiti

La prova automatica `ponte/prove/prova_ponte.mjs` ha dato:

```text
20/20
risposta: 4 ms
```

È stata inoltre completata una prova end-to-end con un gioco finto:

- IA al comando;
- movimento tramite X;
- verifica del silenzio dell'IA quando non deve comandare;
- cashout a 3000 ms.

### Stato della prova sul sito vero

Il ponte **non è ancora stato provato su moneyslither.com** al momento della stesura di questo documento.

Al primo test sul gioco reale verificare esplicitamente:

1. che il socket locale sia agganciato correttamente;
2. che l'ID del giocatore sia quello corretto (`myId` / `init.id`);
3. che il tasto **X** funzioni come previsto;
4. che l'IA riesca a guidare il personaggio senza introdurre scatti o rallentamenti;
5. che non venga attivato il meccanismo di sicurezza del sito.

### Modalità pratica

La **lobby 0** è supportata.

In questa modalità lo snapshot proviene dal simulatore del client (`snaps`) a cadenza di 2–3 tick. La fisica usata nella pratica è una copia della fisica del client, ma alcune parti sono state successivamente smentite o corrette dal server, in particolare:

- boost;
- crescita;
- oro;
- bottino;
- cashout.

Quindi la modalità pratica è utile per verificare il funzionamento tecnico del ponte, ma **non deve essere considerata la fonte definitiva della fisica del gioco**. Per la fisica di riferimento valgono le misure e le correzioni riportate nella sezione dedicata al server/simulatore.

### Regola operativa

Il ponte serve a **portare il modello già addestrato sul gioco reale**, non a cambiare la politica dell'agente a mano. La stessa codifica delle osservazioni e delle azioni deve rimanere compatibile con quella usata durante l'addestramento.

Prima di una prova reale, verificare sempre che il modello `.pt`, il `Featurizer` e `ActionCodec` siano compatibili con la versione corrente del simulatore e del ponte.

## Stato attuale e passi successivi

- **Addestramento del 6 ottobre 2026 concluso.**
  - Ricetta e cronologia completa: `PIANO_ADDESTRAMENTO.md`, §4 e §7.
  - Corsa «runpod»: fase 1 da 0 a 3141 iterazioni, fase 2 da 3141 a 7477.
  - Corsa «affinamento»: da 0 a 2059, partita da allievo\@7160 con i 4 migliori
    protetti; cibo 0,04 dall'iterazione 1152.
- **Finale fra 22 candidati.** I 10 migliori sono sul pod in
  `/workspace/finalissimallanemento/model_1.pt … model_10.pt`.
  - Ordine: @1100, @1800, @2000, @1900, @2059, @1700, @1000, @2040, @500, @1300, tutti
    dell'affinamento.
  - I vecchi migliori della fase 2 sono dal 16° al 21° posto.
  - Il 1° e il 2° sono alla pari.
- **Rifiutati dall'utente, non riproporli:**
  - il bot «fuggitivo»;
  - il «valore della taglia» (costo del boost, taglia dall'oro).
- **Chiesta e poi fermata dall'utente:** la morte a −5. Non è applicata.
- **Aperto:** gli agenti non vanno a cercare il cibo, nemmeno col cibo raddoppiato, ma
  nell'affinamento il boost è diventato più dosato. Idee non provate in §5 del piano:
  vanno proposte all'utente.
- **Pulizia del repository (2026-10-07):**
  - tolti i checkpoint vecchi `allenamento/partenza/` (ricompense abbandonate);
  - tolto `allenamento/FASI.md`, confluito nel piano;
  - aggiunti `finale.py`, `medie.py`, `runpod/riavvia.sh`.
- Le corse con la ricompensa vecchia ([stato.pt](https://stato.pt/) formato 2) non si riprendono.

text

````
Nota: quando ho incollato il contenuto c'erano dei blocchi di codice annidati (la sezione "Struttura" e i "Comandi" usano ` ``` ` dentro il file). Nel file sopra sono già nel formato corretto; se copi e incolli in un editor, verifica solo che i tre backtick di apertura/chiusura delle due sezioni siano rimasti integri.
````

svgsvg