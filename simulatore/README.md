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

Tutti i comandi leggono i parametri misurati da `../analizer/estratto/simulatore.json`,
se c'è (`--analizer FILE` per un altro estratto). Quando il server cambia: si
rigioca con `analizer` acceso, `node analizer.js analizza`, e il simulatore si
riallinea da solo.

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
| oro | gli 8 più vicini × 5: presenza, posizione, distanza, valore (un bottino è un mucchio: la massa d'oro per zona è nella griglia e nella mappa). **Nessun timer di scadenza**: online non si conosce |
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

**Randomizzazione** (`randomize=True`). Varia per mondo solo ciò che è incerto o
che il server ha già cambiato:
- frequenza dei tick, costo del boost, guadagno per orb;
- cibo in campo (il server è passato da 430 a 86 orb in un mese);
- latenza (12–35 ms per verso), jitter (2–10 ms), singhiozzi di rete (0–1 % dei
  messaggi in ritardo di 40–250 ms) e tempo di calcolo dell'agente (5–25 ms): il
  server vero è stato misurato con una buona connessione, l'agente deve reggere
  anche una linea peggiore;
- scala delle hitbox (±3 %).

Ciò che è misurato esatto (passo, sterzata, rampa, corpo) resta esatto.

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
misurata dallo **stesso** analizzatore che misura il server vero. Ecco i due
estratti a confronto:

| grandezza | server | simulatore |
|---|---|---|
| frequenza | 59,98 Hz | 59,95 Hz |
| passo | 4,8 / 10,5 | 4,8 / 10,5 |
| rampa del boost | 0,075 | 0,075 |
| sterzata | 0,1351 | 0,1355 |
| distanza fra anelli | 6,4 | 6,4 |
| cibo dentro / fuori / totale | 86 / 83 / 169 | 86 / 80 / 171 |
| raggio di raccolta (normale / oro) | 28,93 / 41,01 | 29,42 / 41,59 |
| crescita per orb d'oro | 23 fissi | 23 fissi |
| crescita per orb | 6,03·(t/100)^0,158 | 6,04·(t/100)^0,157 |
| costo del boost | 0,1444 + 0,000386·t | 0,1441 + 0,000386·t |
| arena | 2000 + 100·(n−1), rilassamento 0,02 | identico |
| cashout | 3000 ms, curva 0,935·t^2,44 | 3000 ms, 0,934·t^2,43 |
| commissione | 10 % | 10 % |
| frequenza degli snapshot, tick per snapshot, jitter, RTT, input a 60 Hz | — | coincidono |

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
| **misurato e riprodotto** | movimento, boost e costo, corpo, cibo e crescita, raccolta, arena, cashout, bottino (ceil(anelli/4), 100 % del saldo), commissione, tempi di rete |
| **dal client, coerente con i dati** | soglie delle collisioni (i sopravvissuti più vicini passano a 1,02× la soglia, i morti dentro), ordine delle operazioni nel tick |
| **regole indicate da te** | frontale: vince il più grande (a parità decide il caso); morire sul muro ha la stessa fine di una collisione (stesso bottino); il bottino non raccolto sparisce dopo 5–7 s. Verificate da `cargo test` |
| **dal client, mai osservato** | cono del frontale (75°), soglia del muro (0,95·spessore), limite della coda di crescita (15 + 0,03·taglia per tick) |
| **stimato** | posizione di nascita (0,35–0,72 del raggio, direzione casuale), tolleranza del server sul messaggio di cashout |
| **comportamento** | gli avversari sono bot calibrati sulle sessioni vere: lobby con 0–2 avversari vivi (default, `lobby.bots_max` per allenarsi a lobby piene), boost acceso il 33 % del tempo come i giocatori veri, morti che diventano spettatori, chi incassa che resta in lista con `cashingOut: true`, percezione in ritardo come un umano (rete + 45 ms di buffer), riflessi 110–270 ms, tattiche, partite di 40–240 s. Restano i meno verificabili: crescono un po' piu' dei giocatori veri (taglia mediana ~180 contro 118, su un campione reale di soli 3 avversari) |

Ogni costante sta in `src/config.rs` con la sua fonte (`[M]`, `[S]`, `[P]`).
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
