# moneyslither.com — come funziona il gioco sul server

**Resoconto per riprodurlo fedelmente in un simulatore di addestramento.**

Basato **solo sui dati del 4 ottobre 2026**: 4 sessioni registrate con `analizer`, di cui tre in partita (52 s, 37 s e 168 s), per un totale di 5464 snapshot del server, 14 345 tick contati, 166 tratti di boost misurati, 252 orb raccolti, 2 uccisioni, 3 cashout completati (uno tuo) e 20 cariche di cashout interrotte. Le catture di settembre **non sono usate**: il server da allora è cambiato (vedi §13).

Il client analizzato è `client.js?v=1786232918d` (277 KB, non offuscato). Le sue costanti di fisica sono identiche a quelle della versione di settembre.

---

## 0. Come leggere questo documento

Ogni regola porta la sua **fonte**. È la cosa più importante del documento, perché un agente addestrato su una fisica sbagliata sbaglia in modo sistematico e silenzioso.

| marchio | significato |
|---|---|
| **[M]** | **misurato oggi sul traffico del server**: è ciò che il server ha fatto davvero |
| **[M~]** | misurato, ma su un campione piccolo: valore buono, precisione limitata |
| **[S✓]** | scritto nel sorgente del client e **coerente** con i dati di oggi, che però non bastano a confermarlo al 100 % |
| **[S]** | scritto nel sorgente del client (sezione dichiarata «server port») e **non verificabile** con i dati di oggi |
| **[✗S]** | il sorgente del client dice una cosa e **il server ne fa un'altra**: vale la misura |
| **[?]** | ignoto: serve osservarlo |

Il client contiene una copia della fisica del server, dichiarata dall'autore stesso: `// Server constants - copied exactly from server.js`, `// ===== MOVEMENT (server stepMovement port) =====` e `// ===== COLLISIONS (server port) =====`. Quella copia è affidabile per il **movimento** e il **corpo**, dove ogni numero è confermato. Non lo è per **crescita, cibo, cashout e bottino**, dove il server fa cose diverse.

Tutti i numeri qui sotto si rigenerano con `node analizer.js analizza`. Il dettaglio di ogni misura (metodo, campione, tabelle) sta in `estratto/MISURE.md`, e il formato di ogni messaggio in `estratto/PROTOCOLLO.md`.

---

## 1. Il tempo: 60 tick al secondo, e il `ts` non è l'ora del tick

> **Rettifica (stessa sera, dopo la validazione col simulatore).** La prima versione di questo documento diceva «61,7 Hz» e «cashout di 183,7 tick». Erano sbagliati, per la stessa ragione: i tick erano contati arrotondando il `ts` dello snapshot. Il `ts` però è l'ora d'**invio** dello snapshot, presa da un timer diverso da quello del tick. Rigiocando i tuoi input reali nel simulatore, gli intervalli sbagliati sono emersi uno per uno. I numeri qui sotto sono quelli corretti, e l'analizzatore ora conta i tick dallo spostamento.

Il server simula il mondo a **passi discreti (tick)**. Ogni grandezza del gioco è definita per tick, e il simulatore deve contare in tick.

| grandezza | valore | fonte |
|---|---|---|
| tick rate dichiarato (`init.tickRate`) | 60 Hz | [M] |
| **frequenza vera** | **60,0 Hz** (59,98; 60,01 a settembre) | [M] 3249 tick contati dallo spostamento |
| durata di un tick | 16,67 ms | [M] |
| `ts` dello snapshot | ora di **invio** in ms reali, su una griglia di ~33 / 48 / 64 ms; **non** l'ora del tick | [M] |

**Come si sa.** Un serpente che va dritto a boost costante avanza fra due snapshot di un multiplo **esatto** del passo: 4,8 unità per tick senza boost, 10,5 a boost pieno. È il conteggio certo dei tick. Il tempo lo dà l'orologio di rete: 60,0 tick al secondo, come dichiarato.

**Perché il `ts` inganna:**

| tick veri nell'intervallo | Δts osservati |
|---|---|
| 1 | 33 ms (8 casi) |
| 2 | 33–35 ms (449), ma anche **47–49 ms** (59) |
| 3 | 47–50 ms (582), ma anche 34–35 (2) e 63–64 (9) |
| 4 | 65 ms (3) |

Arrotondare Δts a 16,67 ms sbaglia il conteggio nel **7,1 %** degli intervalli. È da lì che venivano i 61,7 Hz.

**Conseguenze per il simulatore:** simula in tick a 60 Hz. Le velocità «al secondo» del client (288 u/s, 630 u/s, 8,1 rad/s) sono **esatte**. Per misurare sui dati veri, non dedurre mai i tick dal `ts`.

---

## 2. Rete: cosa vede il client e quando

| grandezza | valore | fonte |
|---|---|---|
| trasporto | un solo WebSocket `wss://eu.moneyslither.com/`, **JSON testuale**, nessun frame binario | [M] |
| snapshot `state` | in media **23,7 al secondo**; tick veri per snapshot: **1: 0,9 % · 2: 45,8 % · 3: 52,9 % · 4: 0,4 %** (media 2,53) | [M] 1285 intervalli contati dallo spostamento |
| intervallo fra snapshot (locale) | p05 31,6 · p50 46,8 · p95 51,0 ms | [M] |
| tipo di snapshot | **stato completo** ogni volta, mai un delta | [M] |
| dimensione | ~9,3 KB | [M] |
| visibilità | **tutto il mondo**: tutti i giocatori della lobby con il corpo intero, tutti gli orb (anche quelli fuori dal muro); avversari visti fino a 1153 u di distanza | [M] |
| input del client | 60 Hz (uno per fotogramma) | [M] |
| ping/pong | 1 Hz; il server rimanda lo stesso `ts`; RTT 35,3 ms (p95 41,7) | [M] |
| jitter degli snapshot (arrivo − `ts`) | p95 5 ms | [M] |
| ritardo comando → applicazione | **40 ms** (rigiocando i tuoi input nel simulatore: errore minimo a 40 ms) | [M] |

**Per l'addestramento.** L'agente vero vede il mondo ogni **1–4 tick** (quasi sempre 2 o 3), non a ogni tick. Il suo comando arriva al server **circa 2–3 tick dopo**. Il simulatore riproduce entrambe le cose, con il `ts` sulla stessa griglia del server.

---

## 3. Il mondo

| grandezza | valore | fonte |
|---|---|---|
| forma | cerchio centrato in (0, 0) | [M] |
| raggio con 1 serpente vivo | **2000** | [M] |
| **raggio bersaglio** | **2000 + 100 · (serpenti vivi − 1)** | [M] equilibri esatti: 1 vivo → 2000, 2 vivi → 2100 |
| avvicinamento al bersaglio | **r ← r + (bersaglio − r) · 0,02 per tick** | [M] 460 passi |
| chi conta | solo i serpenti **vivi**: con 2 giocatori in lobby di cui 1 morto il raggio resta 2000 | [M] |

Il muro **respira**: quando entra qualcuno si allarga (il 90 % dello scalino in circa 114 tick, 1,9 s), quando uno muore o esce si stringe addosso a chi resta. È prevedibile: chi conta gli avversari sa dove andrà il bordo.

Il raggio arriva negli snapshot come `world.r`, a piena precisione mentre si muove e intero quando è fermo.

---

## 4. Il serpente: stato e movimento

### 4.1 Lo stato di un serpente

Ogni serpente ha: posizione della testa (`hx`, `hy`), direzione (`angle`), direzione desiderata (`targetDir`, dall'input), `boostAmount` ∈ [0, 1], `size` (la taglia, un numero reale), corpo (percorso campionato), `balance` (denaro), `buyIn` (posta), `cashingOut` e `cashoutProgress`.

### 4.2 Sterzata — [M] esatta

```
maxTurn = 0,135 rad per tick            (TURN_SPEED_PER_SEC / TICK_RATE = 8,1 / 60)
diff    = normalizza(targetDir − angle)  in (−π, π]
angle  += segno(diff) · min(|diff|, maxTurn)
```

| verifica | risultato |
|---|---|
| sterzata massima per tick | **0,13509** rad (p99,9 su 7887 intervalli) [M] |
| dipende dalla taglia? | **no**: 0,13506–0,13509 da taglia 50 a 250 [M] |
| dipende dal boost? | **no**: rapporto 1,000 [M] |
| la legge spiega il tuo serpente | 91,3 % degli intervalli entro 0,0025 rad, con 40 ms di ritardo del comando (errore mediano 0,0003 rad) [M] |

La sterzata è **costante in radianti per tick**. Dato che in boost il passo è più lungo, il **raggio di curvatura** in boost è 2,19 volte più grande (77,8 u contro 35,6 u). Da qui nascono quasi tutte le tattiche: un serpente in boost non può rientrare in una curva stretta.

L'ordine è **prima si ruota, poi si avanza**: il passo misurato anche in curva, con questa ipotesi, è 4,8000 esatto [M].

### 4.3 Boost — [M] esatto

```
se boost premuto (e taglia > taglia minima):  boostAmount = min(1, boostAmount + 0,075)
altrimenti:                                     boostAmount = max(0, boostAmount − 0,075)
```

| grandezza | valore | fonte |
|---|---|---|
| rampa in salita | **0,075 per tick** (0→1 in 13,3 tick) | [M] 677 intervalli |
| rampa in discesa | **0,075 per tick** | [M] 726 intervalli |
| taglia minima per il boost | 40 (`MIN_SIZE`); il boost è stato visto partire fino a taglia 49 | [S] |

### 4.4 Passo — [M] esatto

```
passo = 4,8 + 5,7 · boostAmount   unità per tick
hx += cos(angle) · passo
hy += sin(angle) · passo
```

| grandezza | valore | fonte |
|---|---|---|
| passo senza boost | **4,8000** u/tick (dispersione 0,00000 su 1194 tratti) | [M] |
| passo a boost pieno | **10,5000** u/tick | [M] 472 tratti |
| linearità | passo = 4,8011 + 5,7152 · boostAmount, R² 0,99926 | [M] |

Al secondo vero: 296 u/s senza boost e 648 u/s in boost.

### 4.5 Costo del boost — [M], la legge del client è smentita

La taglia si consuma **in proporzione a `boostAmount`**, quindi anche durante la rampa. Su 166 tratti di boost puliti (nessun orb raggiungibile, nessun cashout; 6446 tick in tutto):

```
per tick:  taglia −= (0,1425 + 0,00039 · taglia) · boostAmount
           (al secondo a 60 Hz: 8,55 + 0,0234 · taglia)
```

| legge | errore quadratico medio (unità di taglia) |
|---|---:|
| **due termini (costante + proporzionale)** | **0,81** |
| solo costante (11,28/s) | 1,06 |
| solo proporzionale (0,0877·taglia/s) | 2,16 |
| client: `taglia · 0,108 / s` | peggiore |

[✗S] Il client dice `size −= size · 0,108 · DT`, cioè un costo puramente proporzionale. Il server invece fa pagare un costo **quasi costante**: a taglia 100 sono circa 10,9 al secondo, a taglia 250 circa 14,4.

La conseguenza strategica: il boost costa relativamente di più ai serpenti piccoli.

Precisione limitata: la taglia nello snapshot è arrotondata all'intero, quindi ogni tratto ha ±1 di errore. Randomizza i due coefficienti di ±20 %.

---

## 5. Il corpo — [M] esatto, formule del client confermate

### 5.1 Il percorso

Il corpo **non** è simulato a segmenti rigidi. La testa lascia un **percorso campionato a distanza fissa**:

```
ogni 1,6 unità percorse si aggiunge un punto al percorso       (POINT_DIST = 1,6)       [S✓]
l'anello i del corpo è il punto di percorso numero 4·i            (SEGMENT_SPACING_TICKS = 4) [S✓]
→ distanza fra anelli consecutivi = 6,4 u                                                 [M] 6,40000, dispersione 0
```

Il primo anello coincide con la testa: distanza mediana 0,44 u, cioè meno di un punto di percorso [M].

Lunghezza del buffer del percorso: `max(800, anelli·4 + 200)` punti [S]. Alla nascita il percorso è pre-riempito all'indietro lungo la direzione iniziale [S].

Codice del client, riportato in `estratto/sorgente/funzioni/stepMovement.js`:

```js
var dxp = s.x - s._lastPathX, dyp = s.y - s._lastPathY;
var d = Math.sqrt(dxp*dxp + dyp*dyp);
if (d > 0) {
  s._pathAcc += d;
  var ux = dxp / d, uy = dyp / d, remaining = s._pathAcc;
  while (remaining >= POINT_DIST) {
    s._lastPathX += ux * POINT_DIST; s._lastPathY += uy * POINT_DIST;
    s.path.unshift({ x: s._lastPathX, y: s._lastPathY });
    remaining -= POINT_DIST;
  }
  s._pathAcc = remaining;
}
```

### 5.2 Numero di anelli — [M] il codice del client è esatto

```js
function segmentsForSize(size) {
  var sz = Math.max(MIN_SIZE, Number(size) || MIN_SIZE);        // MIN_SIZE = 40
  var seg = 8 + (sz - 40) * (26 - 8) / (100 - 40);              // 0,3 anelli per unità di taglia
  if (sz > 100) seg = 26 + (sz - 100) * 0.08;                   // poi 0,08: ginocchio a taglia 100
  return Math.max(8, Math.round(seg));
}
```

È verificata su 8366 osservazioni: esatta nel 95,9 % dei casi, e il restante 4,1 % è a ±1 anello, perché la taglia arriva arrotondata all'intero vicino ai gradini [M].

### 5.3 Spessore — [M] esatto a tutte le cifre

```js
function thicknessForSegments(n) {
  n = Math.max(1, Number(n) || 1);
  var t = 7.5 + 0.55 * Math.sqrt(n);
  if (n > 26) t += Math.pow(n - 26, 0.7) * 0.17;
  t *= 1.43;
  return Math.max(10, t);
}
```

Lo scarto è **0** su tutti i 28 valori di anelli osservati, da 11 a 39 [M]. Lo spessore dipende solo dal numero di anelli, ed è **uguale per tutto il corpo**: nessun assottigliamento verso la coda.

| taglia | anelli | spessore |
|---:|---:|---:|
| 40 | 8 | 12,95 |
| 61 | 14 | 13,67 |
| 79 | 20 | 14,24 |
| 100 | 26 | 14,74 |
| 151 | 30 | 15,67 |
| 200 | 34 | 16,35 |
| 262 | 39 | 17,10 |

### 5.4 Taglia

| grandezza | valore | fonte |
|---|---|---|
| taglia alla nascita | **100** | [M] |
| taglia minima | 40 | [S] |
| taglia massima vista oggi | 263 | [M] |
| tetto di taglia legato al saldo (`MAX_SIZE_PER_DOLLAR = 300`) | mai superato oggi (massimo 183 per unità di posta) | [?] (a settembre era stato superato: probabilmente non esiste) |
| taglia nello snapshot | **arrotondata all'intero**, mentre il server la tiene reale | [M] |

---

## 6. Il cibo

### 6.1 Quanto e dove — [M], il server è cambiato da settembre

| grandezza | valore | fonte |
|---|---|---|
| **orb normali dentro il muro** | **86, costanti** (p01 86 · p99 90), sia con raggio 2000 sia con 2100 | [M] 5464 snapshot |
| orb fuori dal muro | **83, immobili per sempre** (0 cambi su 5463 snapshot), tutti **oltre 2100**: la fascia 2000–2100 è vuota | [M] |
| totale nello snapshot | 169 | [M] |
| raggio massimo degli orb | 2798,8 (= l'arena con 9 serpenti vivi) | [M] |
| densità iniziale | ~6,9 orb per milione di u² su tutto il disco fino a 2800 | [M] |

`FOOD_TARGET = 86` del client **ora coincide** con il server [S✓].

**Ricostruzione.** All'avvio il server semina circa 169 orb uniformi sul disco di raggio 2800. Da lì in poi mantiene **86 orb dentro il muro corrente**: ogni orb mangiato viene rimpiazzato subito da uno nuovo dentro il muro. Quelli fuori dal muro restano lì, immangiabili, finché il muro non si allarga fino a loro. Quando il muro si allarga, gli orb dell'anello appena incluso si aggiungono (il conteggio sale fino a 94) e non vengono rimpiazzati finché il totale non torna sotto 86.

### 6.2 Dove nasce — [M]

```
angolo   = uniforme in [0, 2π)
distanza = √u · c·R      con u uniforme in [0, 1], R = raggio corrente del muro, c ≈ 0,98
```

| verifica | risultato |
|---|---|
| media di (r/R)² dei nati | 0,484 (0,5 = uniforme per area) [M] 252 nascite |
| raggio massimo di nascita | 0,983 · R [M] (il client dice 0,95·R) |
| nascite fuori dal muro | 0 [M] |

Colori degli orb normali: `#ff4d4d #4dff4d #4d4dff #ff4dff #4dffff #ffffff`, scelti uniformemente. Gli orb d'oro sono `#ffd700` [M]. Il colore è solo grafico.

### 6.3 Oro spontaneo — [M]

**Non esiste.** I nuovi orb d'oro senza una morte vicina sono stati 0 su 11. L'oro viene solo dai cadaveri (§8) e, secondo il client, dal money rain (§11).

### 6.4 Raccolta

```
raccolto se  distanza(testa, orb) ≤ spessore + R_raccolta
R_raccolta = 29 per un orb normale     [M] massimo osservato 28,93 su 241 raccolte; il client dice 22 (magnete) + 7 (raggio orb)
R_raccolta = 42 per un orb d'oro       [M] massimo osservato 41,01 su 17 raccolte (partita del 5 ottobre); il client dice 22 + 10 + 10
```

La distanza va misurata dalla posizione della testa **a ogni tick**, non da quella dello snapshot. Il raggio usa lo spessore **grezzo**, senza i moltiplicatori delle hitbox.

Il raggio di raccolta, quasi 3 volte lo spessore, è anche ciò che fa sparire il bottino «prima che esista» (§8.2).

### 6.5 Crescita — [M], la legge del client è smentita

```
guadagno di taglia per orb normale = 6,03 · (taglia / 100)^0,151        (93 raccolte, aggiornato il 5 ottobre)
```

Il fit è stato fatto su 74 raccolte di un orb solo, senza boost, a taglie fra 55 e 180:

| taglia media | guadagno misurato | legge |
|---:|---:|---:|
| 63 | 5,64 | 5,60 |
| 89 | 5,85 | 5,92 |
| 111 | 6,20 | 6,13 |
| 138 | 6,33 | 6,35 |
| 162 | 6,50 | 6,51 |

[✗S] Il client dice `3 · (taglia/100)^0,6`. Il server dà circa il **doppio** del guadagno base, con una crescita quasi piatta rispetto alla taglia: crescere mangiando non accelera.

| | |
|---|---|
| guadagno di un orb d'oro | **[M] 23 fissi, indipendente dalla taglia** (misurato da taglia 80 a 319, a coda di crescita svuotata). [✗S] il client dice «4 volte un orb normale»: a taglia 300 darebbe 28,4. Siccome la crescita arriva a rate, uno snapshot subito dopo la raccolta ne mostra solo una parte |
| crescita graduale | [S] la crescita entra in una coda e si applica al massimo `15 + 0,03·taglia` per tick. Per gli orb normali (~6) è irrilevante; conta solo per molto oro tutto insieme |
| valore in denaro di un orb normale | 0 (campo `[4]` sempre 0) [M] |
| accredito dell'oro | il valore dell'orb d'oro finisce **intero** nel saldo di chi lo raccoglie (rapporto 1,000) [M] 5 raccolte |

---

## 7. Collisioni e morte

### 7.1 Le hitbox — [S✓] formula del client coerente con i dati

I parametri arrivano da `window._gameSettings`. Il server oggi **non** li ha sovrascritti con `user_flags`, quindi sono i default del client:

```
HITBOX_BASE = 0,95   combatHitboxScale = 1,07   combatHeadHitboxScale = 1,18
combatHeadOnFacingDegrees = 75   combatHeadOnRule = "smallest_wins"   combatFrontArcOnly = false

raggio testa (combattimento) = spessore · 0,95 · 1,07 · 1,18 = spessore · 1,19947
raggio corpo (combattimento) = spessore · 0,95 · 1,07        = spessore · 1,01650
raggio testa (muro)          = spessore · 0,95
raggio testa (raccolta cibo) = spessore · 1                   (+ R_raccolta)
```

**Testa contro corpo.** Muore A se la testa di A è entro `raggioTesta(A) + raggioCorpo(B)` da uno qualunque dei punti di percorso di B con indice `4·k`, per k da 2 a `min(anelli(B), 1200) − 1`. I primi due anelli, attaccati alla testa di B, sono esclusi.

**Testa contro testa** (controllata per prima). Le teste sono a distanza ≤ `(raggioTesta(A) + raggioTesta(B)) · 1,07` **e** entrambe puntano l'una verso l'altra entro 75°, cioè `cos > 0,2588`. Allora **vince il più grande** e muore il più piccolo (regola confermata dall'utente; nel client si chiama `smallest_wins`). A taglia uguale si tira a sorte 50/50. Se le teste non si guardano entrambe, si passa al controllo testa-corpo.

**Cosa dicono i dati di oggi:**

| verifica | risultato |
|---|---|
| quasi-contatto testa-corpo più stretto di un serpente sopravvissuto | **1,018 ×** la soglia prevista (25 quasi-contatti): nessun sopravvissuto è mai entrato nella soglia [M] |
| le 2 uccisioni | uno snapshot prima la testa della vittima era a 33,4 e 34,4 dal corpo dell'uccisore, contro soglie previste di 31,98 e 33,79 (cioè 1,04 e 1,02 ×); allo snapshot della morte era dentro [M] |
| tipo delle 2 uccisioni | testa-corpo (`you_died.reason = "hit"`), entrambe da imYeat |
| frontali | nessuno osservato oggi: regola e soglia frontale [S] |

Il risultato inquadra la scala vera della soglia testa-corpo fra circa 0,67 e 1,018 volte la formula, con la formula al bordo alto: **coerente**. Ne servono altre per dirla esatta.

### 7.2 Morte sul muro — [S], stessa fine di una collisione

```
morte se  √(hx² + hy²) + spessore · 0,95 > R
```

Morire sul muro ha la **stessa fine** di una collisione: stesso bottino d'oro, ceil(anelli/4) orb per il 100 % del saldo, corpo vuoto e `alive: false`. Cambiano solo i messaggi: nel `kill` il killer è `"WALL"` e `you_died.reason` vale `"border"`. Oggi non è stata osservata nessuna morte sul muro. A settembre l'intervallo misurato per k era [0,91; 1,45], compatibile con 0,95, e il bottino era il 100 % del saldo.

### 7.3 Ordine dei controlli in un tick — [S✓]

Prima il movimento di tutti i serpenti, poi le collisioni: prima testa-testa, poi testa-corpo. Un serpente morto in questo tick non può più uccidere nessun altro nello stesso tick. L'ordine completo è al §12.

### 7.4 Cosa succede alla morte — [M]

1. Il server manda `{"t":"kill","ts","killer","victim","streak"}` a tutti e `{"t":"you_died","reason":"hit"|"border","killer","balance"}` alla vittima.
2. Nello snapshot il serpente **resta nella lista** con `alive: false` e `segs: []` (corpo vuoto). Ci resta finché il giocatore non esce.
3. Compare il bottino (§8).
4. Il client della vittima manda poi `{"t":"spectate"}` (1,6–4,2 s dopo, quando premi il pulsante) e più tardi `{"t":"leave"}`. A quel punto la connessione viene riaperta e arriva un nuovo `init` con un nuovo `id`.
5. Il rientro in partita (`respawn`) non è stato osservato oggi [?].

**L'uccisore non riceve nulla di diretto** [M]: solo ciò che raccoglie del bottino.

---

## 8. Il bottino

### 8.1 Quanto e dove — [M]

```
numero di orb d'oro = ceil(anelli / 4)
valore di ciascuno  = saldo della vittima / numero di orb        → totale = 100 % del saldo, in parti uguali
posizione           = lungo il corpo del cadavere, circa uno ogni 4 anelli a partire dalla testa,
                      con una dispersione casuale di qualche unità (mediana 2 u, massimo 6,6 u dalla linea del corpo)
massa rilasciata    = nessuna: solo oro, nessun orb normale
```

| vittima | anelli | orb | valore per orb | totale |
|---|---:|---:|---:|---:|
| taglia 79, saldo 1 $ | 20 | **5** = ceil(20/4) | 0,2 | **1,000** |
| taglia 170, saldo 1 $ | 32 | **8** = ceil(32/4) | 0,125 | **1,000** |
| taglia 83, saldo 1 $ (5 ottobre, ucciso da te) | 21 | **6** = ceil(21/4) | 0,1667 | **1,000** |

[✗S] Il client dice uno ogni 2 anelli, con divisore `floor`, che porterebbe a distribuire fino al 104 % del saldo. Il server fa `ceil(anelli/4)` con il valore esatto.

### 8.2 Bottino mangiato prima di esistere — [M], dettaglio importante

Nella prima morte, 2 dei 5 orb sono nati **dentro il raggio di raccolta della testa dell'uccisore**, a 31 e 56 unità con raggio ~57. Sono stati mangiati **nello stesso tick** e non sono mai comparsi in uno snapshot: l'uccisore è passato da 1,0 a 1,4 $ nell'istante stesso della morte.

Il simulatore deve quindi creare il bottino e **poi** eseguire la raccolta, nello stesso tick.

### 8.3 Durata — [U] 5–7 s (regola indicata dall'utente)

Secondo l'utente il bottino non raccolto sparisce dopo un tempo **casuale fra 5 e 7 secondi**, e il simulatore usa questa regola (`loot_lifetime_ms`). Nelle sessioni di ottobre nessun bottino è rimasto a terra abbastanza a lungo da misurarlo: ogni orb d'oro è sparito con una testa entro il raggio di raccolta. Un caso è sopravvissuto 7,47 s prima di essere mangiato, al limite della regola. A settembre spariva tutto insieme dopo 120 s: se la regola è cambiata, è cambiata da allora.

---

## 9. Il cashout

È la meccanica centrale: il saldo diventa denaro reale solo uscendo con un cashout. Durante la carica il serpente è **lento, bloccato in direzione e vulnerabile**.

### 9.1 Sequenza — [M]

1. Il client manda `input` con `cashingOut: true` a 60 Hz, finché il tasto è tenuto premuto.
2. Il server alza `cashingOut` e calcola `cashoutProgress = (ora − inizio) / 3000 ms`. È **a tempo d'orologio**, non a tick: Δprogresso/Δts vale esattamente 1/3000 per ms in tutti i 429 intervalli osservati. La carica dura **3000 ms = 180 tick** [M]. Anche il rallentamento segue il tempo trascorso.
3. Dopo **3000 ms del suo orologio** il client manda `{"t":"cashout"}`. Il timer è del **client**: il server incassa solo quando arriva questo messaggio [M].
4. Il server risponde dopo 36 ms con `cashout_result`:
   `{"balance":1,"payoutLamports":7425743,"payoutUsd":"0.90","rakeLamports":825082,"rakeUsd":"0.10","solPrice":121.2,"pending":true}`
5. 34 ms dopo il serpente passa ad `alive: false` e **resta nella lista**, come un morto. Lo si distingue perché nell'ultimo snapshot da vivo aveva `cashoutProgress` ≥ 0,99 [M].
6. **Nessun orb a terra** (verificato su 3 cashout completati) [M].

Se il tasto viene rilasciato prima della fine, **il progresso torna a 0** (20 casi su 20). La carica successiva riparte da zero [M].

### 9.2 Movimento durante la carica — [M], il client è smentito

| | valore | fonte |
|---|---|---|
| sterzata | **bloccata**: rotazione 0 rad/tick (p99, 429 intervalli) | [M] |
| boost | disattivato: `boostAmount` resta 0 | [M] |
| velocità | **passo = 4,8 · (1 − 0,935 · t^2,44)**, con t = tempo trascorso / 3000 ms | [M] 409 intervalli |
| a fine carica | **quasi fermo**: 0,073 della velocità base | [M~] 3 intervalli |

| progresso | 0 | 0,2 | 0,4 | 0,5 | 0,6 | 0,7 | 0,8 | 0,9 | 1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| velocità relativa misurata | 1,000 | 0,985 | 0,911 | 0,846 | 0,745 | 0,626 | 0,484 | 0,278 | 0,113 |

[✗S] Il client dice `1 − 0,6 · t^2,6`, cioè un minimo al 40 % della velocità. Sul server il serpente **si ferma quasi del tutto** nell'ultimo decimo: per circa mezzo secondo resta immobile e indifeso.

### 9.3 Economia del cashout — [M]

**Commissione del 10,000 %**: 825 082 / (7 425 743 + 825 082). Su un saldo di 1 $ si incassano 0,90 $. Per andare in pari bisogna incassare almeno 1/0,9 = **1,111 volte la posta**.

Il pagamento è segnato `"pending": true`: alla sessione successiva non risultava ancora nel saldo, a quella dopo sì (3,58 → 4,50 $). Viene accreditato in differita.

---

## 10. Economia e lobby — [M]

| grandezza | valore |
|---|---|
| lobby (poste) | 1, 10, 100 $ (`init.lobbies`); oggi solo la lobby da 1 |
| ingresso | la posta viene addebitata sul conto al `join` (5,58 → 4,58 → 3,58 $ fra tre partite) |
| saldo in partita alla nascita | **= la posta** (saldo/posta = 1,000) |
| come cambia il saldo in partita | **solo** raccogliendo orb d'oro (+ valore pieno). Non cambia per le uccisioni, per il cibo normale o per il boost |
| alla morte | il saldo va interamente nel bottino (§8) |
| al cashout | si incassa il 90 % del saldo |
| saldi pubblici | `balance` e `buyIn` di **tutti** i giocatori sono nello snapshot |
| `lc` | numero di serpenti vivi per lobby `[lobby 1, lobby 10, lobby 100]` |
| `bounty` | sempre `false` oggi [?] |

In sintesi, il gioco è una ridistribuzione a somma negativa: il denaro passa dai morti a chi raccoglie il loro bottino, e la casa trattiene il 10 % all'uscita.

---

## 11. Eventi rari

- **Money rain**: il client gestisce `rain_started` e `rain_ended` (`estratto/sorgente/sezioni/…MONEY_RAIN…`), ma oggi non è stato osservato [?].
- **Respawn** (`respawn` → `respawn_ok` / `respawn_err`): non osservato [?].
- **`join_err`**: `{"reason":"Already in a game. Leave first."}` se si prova a entrare due volte [M].

---

## 12. L'ordine delle operazioni in un tick

Questa è la ricostruzione da usare nel simulatore. L'ordine viene dal port del server nel client (`simTick`, `stepMovement`, `checkCollisions`); i numeri sono quelli misurati oggi.

```
PER OGNI TICK (16,67 ms, 60 Hz):
  1. leggi l'ultimo input di ogni giocatore arrivato al server (arriva ~40 ms dopo che è partito)
  per ogni serpente vivo (stepMovement):
  2.   sterzata: angle verso targetDir di al massimo 0,135 rad   (nessuna sterzata se in cashout)
  3.   rampa del boost: ±0,075                                     (0 se in cashout)
  4.   passo = 4,8 + 5,7·boostAmount;   in cashout: passo = 4,8·(1 − 0,935·t^2,44)
  5.   avanza la testa di `passo` lungo angle
  6.   campiona il percorso: un punto ogni 1,6 u
  7.   applica la crescita in coda (max 15 + 0,03·taglia)
  8.   morte sul muro se dist + 0,95·spessore > R
  9.   costo del boost: taglia −= (0,1425 + 0,00039·taglia)·boostAmount;  ricalcola anelli e spessore
  10.  raccolta: orb entro spessore + 29 (oro: + 42) → crescita in coda: 6,03·(taglia/100)^0,151 (oro: +23); oro → saldo += valore
  11.  cashout: progress = (ora − inizio)/3000 ms (si azzera se rilasciato)
  collisioni (checkCollisions):
  12.  testa-testa (frontale con soglia e cono di 75°) → muore il più piccolo
  13.  testa-corpo → muore chi ha colpito
  14.  ogni morto: alive=false, segs=[], bottino ceil(anelli/4) orb d'oro, e subito la raccolta di chi è sopra
  15.  rimpiazza il cibo: finché gli orb dentro il muro sono meno di 86, nasce un orb uniforme per area entro ~0,98·R
  16.  muro: bersaglio = 2000 + 100·(vivi − 1);  R += (bersaglio − R)·0,02
  17.  ogni 1–4 tick (0,9 % / 45,8 % / 52,9 % / 0,4 %): manda lo snapshot completo, con `ts` = ora d'invio
  incasso: quando arriva {"t":"cashout"} da un giocatore in carica → alive=false, nessun bottino, paga il 90 % del saldo
```

Dati certi sull'ordine: la sterzata precede il passo [M]. Il resto dell'ordine viene dal client [S]. Un'inversione fra i passi 8 e 9, o fra 13 e 14, cambia l'istante esatto di una morte di un tick.

---

## 13. Cosa è cambiato rispetto a settembre 2026

| | settembre | **oggi** |
|---|---|---|
| orb dentro il muro | 430 | **86** |
| orb totali | 830 | **169** |
| snapshot | 31 KB | **9 KB** |
| frequenza vera | 60,0 Hz (le misure di allora dicevano 61,25: stesso artefatto del `ts`) | **60,0 Hz** |
| guadagno per orb | 5,8 · (taglia/100)^0,20 | **6,03 · (taglia/100)^0,151** |
| costo del boost | 9,3 + 0,029·taglia /s | **8,55 + 0,0234·taglia /s** (simile) |
| movimento, corpo, arena, cashout, bottino, commissione | — | **invariati** |

Quindi **il server può cambiare senza preavviso**. Per un agente che deve funzionare sul server vero:
- **randomizza** nel simulatore le grandezze che sono cambiate o sono incerte;
- **riesegui** `analizer` ogni tanto e confronta: l'estratto lo dice subito («smentito», o un valore diverso).

---

## 14. Cosa riprodurre per l'agente: osservazione e azione

### Azione (l'unica cosa che il client manda durante il gioco)

```json
{"t":"input","targetDir":1.7577755967138078,"boost":false,"cashingOut":false}
```

`targetDir` è un **angolo assoluto** in radianti, e il client lo manda a 60 Hz. Il server applica l'ultimo ricevuto. **Non si manda mai la propria posizione**: il server è autoritativo. Per incassare si tiene `cashingOut: true` per 3000 ms e poi si manda `{"t":"cashout"}`.

### Osservazione (cosa arriva, ogni 1–4 tick, quasi sempre 2 o 3)

```json
{"t":"state","ts":1791146963487,"world":{"cx":0,"cy":0,"r":2100},"lobby":1,
 "foods":[[x, y, "normal"|"gold", "#rrggbb", valoreInDollari], …],
 "players":[{"id","name","alive","spectator","boosting","boostAmount","cashingOut","cashoutProgress",
             "size","balance","buyIn","color","skinImage","boostColor","eyeColor","eyeStyle","chainImage",
             "level","thickness","hx","hy","angle","bubble","emote","bounty",
             "segs":[[x,y], …]}, …],
 "lc":[n1, n10, n100]}
```

**Precisione serializzata**, da replicare se l'agente deve vedere gli stessi numeri [M]:

| campo | precisione |
|---|---|
| `angle` | 3 decimali |
| `size` | intero |
| `foods[x, y]` | 1 decimale |
| `hx`, `hy`, `thickness`, `segs` | piena |
| `boostAmount` | piena; multipli di 0,075 tranne vicino a 1 |
| `world.r` | piena mentre si muove |

Gli orb non hanno identificatore: l'identità è la coordinata.

**Cosa NON arriva come evento** e va dedotto dagli snapshot: chi ha mangiato cosa, la nascita del cibo e del bottino, l'uscita di un altro giocatore con cashout. Lo stesso vale per la tua morte e per il tuo cashout, salvo i messaggi `you_died` e `cashout_result`.

### Altri messaggi del protocollo (per completezza)

| direzione | messaggio | quando |
|---|---|---|
| ← | `init {id, tickRate, world, lobbies, maintenance, voiceEnabled}` | all'apertura del socket |
| → | `auth {sessionToken, reclaim}` / ← `auth_ok {balanceLamports, balanceUsd, solPrice, canWithdraw, suspended…}` | autenticazione |
| → | `join {name, lobby, skin, …ItemId}` / ← `join_ok {lobby, reconnectToken}` / `join_err {reason}` | ingresso |
| ← | `user_flags {isRenderTester, renderSettings}` | impostazioni grafiche (oggi nessun `gameSettings`) |
| ← | `tutorial_status {available}` | menu |
| → / ← | `ping {ts}` / `pong {ts}` | 1 Hz |
| ← | `kill`, `you_died`, `cashout_result`, `xp_update {xpGained, totalXp, level, …}` | eventi |
| → | `spectate`, `leave`, `cashout`, `respawn`, `chat`, `emote` | azioni fuori dal movimento |

---

## 15. Cosa manca ancora, e come ottenerlo

| | stato | come chiuderlo giocando con `analizer` acceso |
|---|---|---|
| raggio di raccolta dell'oro | **chiuso il 5 ottobre**: 41,0 misurato, 42 dal client | — |
| crescita data da un orb d'oro | **chiuso il 5 ottobre**: 23 fissi, il client è smentito | — |
| limite della coda di crescita (15 + 0,03·taglia?) | [S] | raccogli molto oro tutto insieme senza boost |
| durata del bottino (120 s?) | [?] | lascia un bottino a terra e resta lontano 2+ minuti |
| morte sul muro (0,95·spessore?) | [S] | tocca il bordo |
| frontale: soglia, cono di 75°, chi muore | [S] | scontri testa contro testa |
| soglia testa-corpo esatta | [S✓] | più uccisioni e quasi-contatti |
| velocità finale del cashout (0,07?) | [M~] | più cashout completati |
| crescita oltre taglia 263 | [?] | cresci di più |
| tetto di taglia legato al saldo | [?] | supera taglia 300 con posta 1 |
| respawn, money rain, bounty | [?] | rientra dopo una morte; attendi un evento |
| lobby da 10 e 100 $ | [?] | stesse regole? solo osservando |

Il comando `c` dell'analizzatore mostra questa lista aggiornata mentre giochi.

---

## 16. Riepilogo per l'implementazione

```text
TICK           60 Hz; simulare in tick; `ts` dello snapshot = ora d'invio, NON del tick (mai contare i tick col ts)
RETE           snapshot completo ogni 1/2/3/4 tick (0,9/45,8/52,9/0,4 %); comando applicato 40 ms dopo (2–3 tick)
STERZATA       ±0,135 rad/tick verso targetDir, costante; prima ruota poi avanza; bloccata in cashout
BOOST          boostAmount ±0,075/tick in [0,1]; passo = 4,8 + 5,7·boostAmount u/tick
COSTO BOOST    taglia −= (0,1425 + 0,00039·taglia)·boostAmount per tick
CORPO          punto di percorso ogni 1,6 u; anello i = punto 4i (6,4 u); segmentsForSize/thicknessForSegments del client (esatte)
TAGLIA         nascita 100; minimo 40; reale sul server, intera nello snapshot
CIBO           86 orb dentro il muro, rimpiazzati subito, uniformi per area entro ~0,98·R; 83 fuori, fissi; niente oro spontaneo
RACCOLTA       dist ≤ spessore + 29 (oro + 42); crescita 6,03·(taglia/100)^0,151 per orb normale, +23 fissi per orb d'oro; oro → saldo += valore
ARENA          bersaglio 2000 + 100·(vivi − 1); R += (bersaglio − R)·0,02 per tick
MURO           morte se dist + 0,95·spessore > R
COLLISIONI     testa-corpo: d ≤ 1,19947·tA + 1,01650·tB contro i punti 4k, k ≥ 2
               testa-testa: d ≤ (1,19947·tA + 1,19947·tB)·1,07 e cono di 75° → muore il più piccolo
MORTE          alive=false, segs=[], resta in lista; nessun premio all'uccisore
BOTTINO        ceil(anelli/4) orb d'oro lungo il corpo, saldo/orb ciascuno (100 %); raccoglibili nello stesso tick;
               spariscono dopo 5–7 s se nessuno li prende (anche per la morte sul muro: stessa fine)
CASHOUT        3000 ms a orologio = 180 tick (client: 3000 ms poi {"t":"cashout"}); passo 4,8·(1 − 0,935·t^2,44); sterzo e boost bloccati;
               rilascio → progresso 0; completato → alive=false, nessun bottino, paga il 90 %
ECONOMIA       saldo iniziale = posta (1/10/100); cambia solo con l'oro; commissione 10 % all'uscita
```
