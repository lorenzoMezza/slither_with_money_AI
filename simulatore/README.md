# simulatore

Simulatore di **moneyslither.com** per addestrare un'AI: la fisica e le regole del
server riprodotte tick per tick, la rete come la vede un client vero, avversari
che giocano come persone. È scritto in **Rust**: un mondo da solo va a circa 3000
volte il tempo reale, e in parallelo a oltre 6000. Si usa da **Python**
(ctypes + numpy) e si guarda nel **browser**.

## In tre comandi

```bash
cargo build --release
./target/release/simulatore vedi           # il gioco nel browser: ci giochi tu (mouse, clic/spazio = boost, C tenuto = cashout)
./target/release/simulatore valida         # la fisica rigiocata sulle tue sessioni registrate dal server vero
```

| comando | cosa fa |
|---|---|
| `vedi [--bot 1-4] [--velocita 1] [--porta 8080]` | lobby a tempo reale nel browser, con te come giocatore |
| `vedi --spettatore` | solo bot, da guardare (F = cambia serpente seguito) |
| `valida [--sessioni DIR…]` | rigioca il tuo serpente dai tuoi input reali e misura l'errore |
| `registra --secondi 600 --cartella DIR` | partita simulata scritta come sessione di `analizer` |
| `bench [--mondi 64]` | velocità di simulazione |
| `parametri` | i parametri in uso |

La fisica del server è la **verità data dall'utente il 2026-10-07** (tabella più
sotto), scritta in `src/config.rs` (campi `[V]`): è fissa e nessun estratto la
sovrascrive. Le grandezze che la verità non copre (frequenza dei tick, arena, RTT, orb
di bottino per anello) sono i valori misurati, scritti anch'essi nei default. Nessun
estratto viene letto da solo, quindi il mondo è identico su ogni macchina (Mac o
RunPod); solo per esperimenti, `--analizer FILE` (o `analizer="auto"` da Python) prende
quelle quattro grandezze da un estratto.

## Da Python

```python
import sys; sys.path.insert(0, "simulatore/python")
from slither_sim import SlitherVecEnv

env = SlitherVecEnv(num_envs=64, seed=1, randomize=True)
obs, info = env.reset()                      # obs: (64, 10128) float32
for _ in range(10_000):
    actions = policy(obs)                    # (64, 3): [svolta ∈ [−1,1], boost, cashout]
    obs, rew, done, info = env.step(actions)
    # info["motivo"] 1 = morte, 2 = cashout; info["profitto_episodio"] in poste
env.viewer(env=0, port=8080)                 # guardi il mondo 0 nel browser, a tempo reale
```

`python/esempio.py` è un esempio completo, anche con `--guarda`. La libreria va
compilata prima (`cargo build --release`); serve numpy.

**Un passo è uno snapshot**, non un tick. L'agente decide sull'ultimo snapshot
arrivato, quindi vede il mondo in ritardo. Il suo input viaggia verso il server e
viene applicato al primo tick utile. Il mondo avanza fino allo snapshot successivo
(1–4 tick, con la distribuzione del server vero), che poi viaggia verso il client.
È esattamente il ciclo di un client online.

**Azione.**
- `[0]` svolta in [−1, 1]: la direzione desiderata è quella osservata + svolta·π (oppure `action_mode="assoluto"`: il `targetDir` in radianti, come il messaggio `input`).
- `[1]` boost.
- `[2]` cashout tenuto premuto: dopo 3000 ms d'orologio del client parte `{"t":"cashout"}`, esattamente come nel client vero; rilasciarlo prima azzera la carica.

**Osservazione** (10128 float, `env.layout()` dice dove sta ogni blocco):

| blocco | contenuto |
|---|---|
| se stesso | 40 valori: stato proprio, velocità e sterzata, budget e costo del boost, muro che sta per stringersi, minacce più vicine, economia della lobby |
| raggi | 32 direzioni × (muro, corpo nemico, testa più grande, testa più piccola), fino a 1000 u |
| avversari | gli 8 più vicini × 36 valori: posizione (anche prevista fra 0,5 s con la cinematica esatta del server: sterzata costante, poi passo; forma chiusa della somma dei 12 passi), rotta, velocità, sterzata, taglia, saldo, minacce reciproche, e il dossier delle abitudini su ~20 s (boost, mira verso di me, inseguimenti, guadagni, uccisioni, cashout finti, sterzate, vicinanza) |
| oro | gli 8 più vicini × 5: presenza, posizione, distanza, valore (un bottino è un mucchio: la massa d'oro per zona è nella griglia e nella mappa). **Nessun timer**: il bottino non scade mai |
| cibo | 16 settori × (densità, distanza del più vicino) |
| griglia | 6 canali × 32 × 32 celle da 20 u: corpi, teste, cibo, oro, fuori dal muro, il proprio corpo |
| mappa | gli stessi 6 canali × 24 × 24 celle da 200 u: ±2400 u, praticamente tutta l'arena |

È egocentrica e costruita **solo dallo snapshot ricevuto**, mai dallo stato interno.
`Featurizer` calcola le stesse identiche osservazioni da un JSON `state` del server
vero (verificato: coincidono). Chi preferisce costruirsi le proprie ha
`env.snapshot()`, lo stesso JSON del server.

**Ricompensa.** Variazione dell'equity divisa per la posta. L'equity è il **valore
d'incasso** del saldo in gioco (saldo × 0,9, cioè quanto si porterebbe a casa
incassando adesso); vale 0 alla morte e il pagato al cashout, che quindi come passo
vale 0. La somma su un episodio è il profitto a meno di una costante (la commissione
sulla posta iniziale): −0,9 se muori, 0,9·saldo/posta − 0,9 se incassi. Con la
commissione «già pagata» in ogni istante, rimandare l'uscita non rimanda nessun
costo: l'agente non ha motivo di restare in campo solo per via dello sconto γ.
`info["profitto_episodio"]` è il profitto vero. Lo shaping (`reward={"size": …,
"alive": …}`) è spento per default.

**Episodi.** Finiscono con la morte, il cashout o il limite `max_episode_s`; poi
l'agente rientra (leave + join, come il client) e il mondo continua. Con
`agents_per_env > 1` più agenti condividono la stessa lobby (self-play):
`info["valido"] = 0` segnala i passi in cui un agente è fuori partita.

**Modalità partita** (`match_mode=True`, usata da `../allenamento`). Ogni mondo è
una partita a sé: `env.reset_matches({indice: spec})` la avvia con chi c'è dentro.

```python
spec = {"agents": [{}, {"start_size": 400, "start_balance": 3.0}],   # 1–4 agenti esterni
        "bots": [{"style": "cacciatore", "skill": 0.9}],             # stili: raccoglitore, cacciatore,
        "max_s": 240, "end_when_alone_s": 12}                         # avvoltoio, ariete, esca, codardo,
                                                                      # spingitore, misto
```

Chi muore o incassa resta fuori fino alla partita successiva. Allo scadere di
`max_s` chi è ancora in campo viene incassato d'ufficio, con la stessa commissione
del cashout volontario (`motivo` 4; `match_report` lo marca con `forzato`): una
sessione finisce sempre o con la morte o con un cashout che paga il 10 %, come
online. Il troncamento con bootstrap (`motivo` 3) esiste solo fuori dalla modalità
partita (`max_episode_s`).
`info["fine_partita"]` segnala la fine, e `env.match_report(i)` dà il profitto di
ogni partecipante, bot compresi.

**Randomizzazione** (`randomize=True`). La fisica del server è certa e non si
randomizza. Varia per mondo solo ciò che dipende dalla connessione:
- frequenza dei tick (59,85–60,15 Hz);
- latenza (12–35 ms per verso), jitter (2–10 ms), singhiozzi di rete (0–1 % dei
  messaggi in ritardo di 40–250 ms) e tempo di calcolo dell'agente (5–25 ms): il
  server vero è stato misurato con una buona connessione, l'agente deve reggere
  anche una linea peggiore.

## La fisica del server (verità, 2026-10-07)

| fenomeno | regola |
|---|---|
| sterzata | 8,1 rad/s = 0,135 rad/tick, costante, verso la mira |
| passo | 4,8 + 5,7·boostAmount u/tick (288 u/s base, 630 u/s in boost); raggio di curvatura 35,6 u (77,8 u in boost) |
| rampa del boost | 0,075/tick in salita e in discesa; boost solo con taglia > 40 |
| corpo | percorso ogni 1,6 u; anello i = punto 4·i (6,4 u); al massimo 1200 anelli; buffer max(800, anelli·4 + 200) |
| anelli dalla taglia | fino a 100: 8 + (taglia − 40)·18/60; oltre: 26 + (taglia − 100)·0,08; arrotondati, minimo 8 |
| spessore | (7,5 + 0,55·√n + [n > 26]·0,17·(n − 26)^0,7)·1,43, minimo 10, uguale lungo il corpo |
| taglia | nascita 100 (saldo 1, posta 1), minimo 40, tetto max(100, floor(saldo/posta·300)) a ogni tick |
| costo del boost | 10,8 % della taglia al secondo (taglia·0,108/60 per tick) mentre è premuto, anche sulla rampa, non × boostAmount; sotto 40 si spegne |
| crescita | orb normale 3·(taglia/100)^0,6; orb d'oro +12; coda ≤ 15 + 0,03·taglia per tick, sempre entro il tetto |
| cibo | 86 orb in campo, bottino compreso; rabbocco solo sotto 86; nascita uniforme entro 0,95·R; orb fuori dal muro tolti |
| raccolta | spessore + 29 (oro: spessore + 42); l'oro aggiunge il suo valore al saldo |
| bottino | non scade mai |
| hitbox | testa spessore·1,1995, corpo spessore·1,0165 |
| frontale | distanza ≤ (testa A + testa B)·1,07 ed entrambi puntati entro 75°: muore il più piccolo, a parità il caso (`smallest_wins` = `biggest_wins`) |
| testa-corpo | anelli 2..min(anelli, 1200) − 1, senza arco frontale, mai col proprio corpo |
| muro | si muore se distanza dal centro + 0,95·spessore > R |
| cashout | 3000 ms d'orologio del client, controllato ogni 30 ms; direzione bloccata, boost spento, passo 4,8·(1 − 0,6·t^2,6) (fino al 40 %); rilascio = carica azzerata; si incassa il saldo meno il 10 % |

Misurati il 4–5 ottobre (non coperti dalla verità): 60 Hz, snapshot ogni 1–4 tick,
RTT 35 ms, arena 2000 + 100·(vivi − 1) con rilassamento 0,02, bottino ceil(anelli/4)
orb che valgono il 100 % del saldo.

## Quanto è fedele

Due verifiche indipendenti, entrambe rilanciabili:

**1. Il tuo serpente rigiocato** (`simulatore valida`). Prende le sessioni
registrate con `analizer` sul server vero, parte dalla posizione reale e applica i
tuoi input reali con la latenza del modello di rete. Risultato sulle sessioni del
4 ottobre (2319 intervalli):

| | |
|---|---|
| dopo uno snapshot | errore **zero** (entro 0,01 unità) nell'85 % dei casi, entro 1 unità nel 99,1 % |
| `boostAmount` | identico al server nel 99,9 % |
| catene da 10 snapshot (0,45 s) senza mai riallinearsi | errore mediano 0,1 unità (un serpente è largo 30) |
| ritardo comando → server che spiega meglio i dati | 40 ms, lo stesso del modello di rete |

**2. Il simulatore misurato come il server** (`registra` + `analizer` +
`strumenti/confronta.mjs`). Una partita simulata viene scritta come sessione e
misurata dallo **stesso** analizzatore che misura il server vero; i due estratti
si confrontano grandezza per grandezza:

```bash
./target/release/simulatore registra --secondi 900 --cartella /tmp/sim/s1
cd ../analizer && SESSIONS_DIR=/tmp/sim EXTRACT_DIR=/tmp/sim-estratto node analizer.js analizza
node ../simulatore/strumenti/confronta.mjs estratto/simulatore.json /tmp/sim-estratto/simulatore.json
```

Questa verifica ha anche **corretto l'analizzatore**. I tick contati col `ts`
dello snapshot davano 61,7 Hz e un cashout di 183,7 tick. Il `ts` però è l'ora
d'invio, presa da un timer diverso da quello del tick: contati dallo spostamento,
i tick sono 60 al secondo, e il cashout dura 3000 ms d'orologio.

## Cosa è certo e cosa no

| | |
|---|---|
| **verità del server (data dall'utente)** | movimento, corpo, taglia e tetto, costo del boost, crescita, cibo, raccolta, bottino che non scade, collisioni, muro, cashout e commissione del 10 %. Verificati da `cargo test` |
| **misurato e riprodotto** | frequenza dei tick, snapshot, arena, bottino (ceil(anelli/4) orb, 100 % del saldo), tempi di rete |
| **stimato** | posizione di nascita (0,35–0,72 del raggio, direzione casuale), tolleranza del server sul messaggio di cashout |
| **comportamento** | gli avversari sono bot calibrati sulle sessioni vere: lobby con 0–2 avversari vivi (default, `lobby.bots_max` per allenarsi a lobby piene), boost acceso il 33 % del tempo come i giocatori veri, morti che diventano spettatori, chi incassa che resta in lista con `cashingOut: true`, percezione in ritardo come un umano (rete + 45 ms di buffer), riflessi 110–270 ms, tattiche, partite di 40–240 s. Restano i meno verificabili: crescono un po' piu' dei giocatori veri (taglia mediana ~180 contro 118, su un campione reale di soli 3 avversari) |

Ogni costante sta in `src/config.rs` con la sua fonte (`[V]` verità, `[M]`, `[S]`, `[P]`).
Il resoconto completo del gioco è in `../analizer/RESOCONTO-GIOCO.md`.

## Struttura

```text
src/
  world.rs      il server: tick, collisioni, cibo, bottino, cashout, arena
  snake.rs      percorso campionato, segmentsForSize / thicknessForSegments del client
  snapshot.rs   il JSON `state` con la stessa quantizzazione (angoli a 3 decimali, taglia intera…)
  env.rs        lobby con client emulati: latenze, snapshot ogni 1–4 tick, ts d'invio, timer del cashout
  bots.rs       avversari, con 11 stili di gioco e le tecniche dei bot open source più forti
  features.rs   osservazioni (uguali sui dati veri)
  vecenv.rs     mondi in parallelo (rayon)        ffi.rs   interfaccia C per Python
  viewer.rs     server HTTP + SSE per il browser  record.rs  sessioni nel formato di analizer
  validate.rs   rigioco delle sessioni vere
viewer/index.html   il client nel browser (interpola a −45 ms come il client vero)
python/slither_sim  il pacchetto Python
strumenti/confronta.mjs   confronto fra estratti
```
