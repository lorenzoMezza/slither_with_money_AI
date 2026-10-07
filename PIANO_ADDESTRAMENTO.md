# Piano di addestramento: architettura dell'IA e ricetta completa

Questo file basta da solo per rifare da capo, anche più in fretta, l'addestramento del
6 ottobre 2026. Quel giorno l'agente è partito da pesi casuali ed è arrivato ai 10
modelli finali in `/workspace/finalissimallanemento` sul pod.

Contiene:

- l'architettura (simulatore, osservazione, rete, PPO, lega, selezione);
- la ricompensa esatta;
- il piano in quattro tappe, con i comandi e i numeri attesi;
- come scalarlo su più calcolo;
- tutto ciò che si è imparato strada facendo: le cose che hanno funzionato, quelle che
  non hanno funzionato e quelle che l'utente ha scartato.

I dettagli di contorno restano negli altri file:
- `analizer/RESOCONTO-GIOCO.md`: le regole del gioco, ognuna con la sua fonte;
- `allenamento/README.md`: come si usano gli strumenti;
- `runpod/README.md`: il pod;
- `CLAUDE.md`: il contesto per riprendere il lavoro.

Dove questo documento e quelli dicono cose diverse, vale questo.

---

## 0. In una pagina

| tappa | cosa | da dove | campioni | iterazioni (RTX 5090) | tempo (RTX 5090) |
|---|---|---|---|---|---|
| 1. Fase 1, predatore | uccidere e raccogliere, cashout bloccato | pesi casuali | ~250 M | 0 → 3141 | 2 h 08 min |
| 2. Fase 2, giocatore completo | cashout con premi, situazioni attesa e svantaggio | fine fase 1 | ~245 M | 3141 → 7477 | 2 h 25 min |
| 3. Affinamento | boost e cibo, duelli lunghi, 4 migliori protetti | miglior campione della fase 2 | ~106 M | 0 → 2059 (corsa nuova) | 1 h 04 min |
| 4. Finale | 22 candidati alla pari, si tengono i 10 migliori | checkpoint delle tappe 2–3 | 772 partite | — | 8,5 min |

Totale: ~600 M campioni, circa 5 h 45 min su una RTX 5090 (32 GB), 112 core e 503 GB di RAM.

Il risultato: `model_1.pt` … `model_10.pt`, tutti dell'affinamento. I migliori della
fase 2 sono finiti dal 16° al 21° posto.
- **Contro i bot**: il primo muore nello 0 % delle partite e incassa nel 100 %.
- **Nel torneo fra modelli**: il primo muore nel 33 % e incassa nel 62 %; il quarto
  muore nel 15 % e incassa nell'81 %.

Il ciclo, a ogni iterazione:

1. **raccolta**: centinaia di lobby simulate in parallelo, ~50–80 mila passi dell'allievo;
2. **PPO ricorrente**: l'aggiornamento della rete;
3. **lega a torneo**: ogni 20 iterazioni l'allievo entra fra i campioni;
4. **banco di prova**: le misure per scegliere il migliore;
5. **registri**: registro, diario, eventi.

---

## 1. Il gioco e il simulatore

**moneyslither.com** è uno slither.io a soldi:
- si entra con una posta;
- si guadagna mangiando il bottino d'oro di chi muore (le sue monete);
- si esce col **cashout**: 3 s fermi, con il 10 % di commissione;
- chi muore perde tutto il saldo.

Le unità di misura:
- 1 «posta» è l'unità di tutti i conti;
- si entra con una posta e taglia 100.

Il simulatore (`simulatore/`, Rust) riproduce il server misurato dall'analizzatore
(`analizer/`, registrazioni CDP del gioco vero). I fatti principali:

- 60 Hz. Uno snapshot ogni 1/2/3/4 tick (0,8/45,8/53,1/0,3 %), quindi ~24 decisioni
  al secondo.
- Movimento:
  - sterzata 0,135 rad/tick;
  - passo 4,8 + 5,7·boostAmount, rampa del boost 0,075/tick;
  - costo del boost (0,1425 + 0,00039·taglia)·boostAmount di taglia per tick;
  - anelli ogni 6,4.
- 86 orb di cibo dentro il muro.
  - Si raccoglie entro spessore + 29 (l'oro entro + 42).
  - Un orb di cibo fa crescere di 6,03·(taglia/100)^0,151, cioè 6–7.
- L'arena ha raggio 2000 + 100·(vivi − 1).
- Bottino: alla morte, ceil(anelli/4) orb d'oro che valgono in tutto il 100 % del
  saldo. Il muro conta come una collisione. Testa contro testa vince il più grande.
- Cashout: 3000 ms tenuti, velocità 4,8·(1 − 0,935·t^2,44), direzione bloccata.
- Fedeltà: `simulatore valida` dà l'85 % dei passi esatti e il 99,1 % entro 1 u.

**Condizioni d'addestramento** (diverse dal simulatore di riferimento, per scelta
dell'utente):

| grandezza | server / riferimento | addestramento | parametro |
|---|---|---|---|
| taglia da un orb d'oro | 23 | **11,5** | `env.crescita_oro` (→ `gold_gain`) |
| bottino non raccolto sparisce dopo | 5–7 s (regola indicata, mai misurata) | **30–60 s** | `env.durata_bottino_s` (→ `loot_lifetime_ms`) |
| rete: andata | 17,6 ms (RTT 35) | 12–35 ms per partita | `Randomization` in `config.rs` |
| jitter | p95 5 ms | 2–10 ms | |
| singhiozzi (40–250 ms) | non misurabili | 0–1 % dei messaggi | |
| tempo di decisione dell'agente | — | 5–25 ms | |
| tick | 59,94–60,01 Hz | 59,85–60,15 Hz | |

`guarda.py`, `valuta.py` e `sfida.py` girano sul simulatore di riferimento (oro 23,
bottino 5–7 s). La finale (`finale.py`) gira nelle condizioni d'addestramento.

**Modalità partita** (`match_mode`), quella usata in addestramento:
- La lobby è fissa: chi muore diventa spettatore.
- La partita finisce quando non resta nessun agente in campo.
- Durata massima uniforme fra due valori (`env.durata_s`). Allo scadere chi è in campo
  incassa per forza (`fine_quota` 1,0, nessun premio).
- Chi resta solo, senza oro a terra, per 12 s (`env.solo_s`) chiude la partita allo
  stesso modo. L'attesa di un agente in arrivo (situazione «attesa») non conta come
  «solo».
- Gli agenti possono entrare in ritardo (`SlotSpec.join_after_s`).

**Bot** (`bots.rs`):
- 11 stili: raccoglitore, cacciatore, avvoltoio, ariete, esca, codardo, spingitore,
  accerchiatore, affiancatore, imprevedibile, misto.
- Le tattiche stanno sopra uno strato di sicurezza che simula le rotte candidate.
- Abilità 1,0 in addestramento.
- **Tengono il loro tempo di reazione** (110–270 ms): è quello di una persona, non va
  tolto.

---

## 2. L'architettura dell'IA

### 2.1 Osservazione (10128 float)

L'osservazione è egocentrica (x = dove guarda la testa). Si calcola **solo dallo
snapshot che il client riceve**: lo stesso `Featurizer` gira sugli snapshot veri.
Niente timer del bottino, niente orologio di partita.

| blocco | forma | contenuto |
|---|---|---|
| sé stesso | 40 | stato, velocità e sterzata con segno, budget e costo del boost, muro che si stringe, minacce più vicine, quanti sono più grandi, profitto se incassassi ora (x[38]), tempo minimo alla collisione, economia della lobby |
| cibo per settori | 16 × 2 | |
| raggi | 32 × 4 | muro, corpi, teste più grandi, teste più piccole |
| avversari | 8 × 36 | posizione attuale e prevista a 0,5 s (cinematica esatta del server), rotta, velocità, sterzata, taglia, saldo, minacce, e un **dossier** delle abitudini su ~20 s |
| oro | 8 × 5 | posizione, distanza, valore |
| griglia | 6 × 32 × 32, celle da 20 u | corpi, teste, cibo, oro, fuori dal muro, il proprio corpo |
| mappa | 6 × 24 × 24, celle da 200 u | gli stessi canali su tutta l'arena |

Il dossier contiene: boost, mira verso di me, inseguimenti, guadagni, uccisioni,
cashout finti, sterzate, vicinanza.

### 2.2 Rete (`allenamento/ia/rete.py`, 5,02 M parametri)

```text
sé stesso + cibo ─► MLP ──────────────────────────────┐
raggi 32×4 ─► Conv1d CIRCOLARE ────────────────────────┤
io + 8 avversari + 8 ori ─► transformer 3 strati ──────┼─► tronco 512 ─► GRU 512 ─► teste
griglia 6×32×32 ─► CNN a toppe 4×4, poi 3×3 ───────────┤
mappa 6×24×24 ─► CNN a toppe 3×3, poi 3×3 ─────────────┘
```

`NetConfig`:
- token del transformer: `d_ent` 128, `ent_layers` 3, `ent_heads` 4;
- raggi: `rays_ch` 32;
- griglia e mappa: `grid_patch` 4, `grid_ch` 64, `map_patch` 3;
- uscita di ogni codificatore: `block` 256;
- `torso` 512, `memory` (GRU) 512.

Precisione e normalizzazione:
- I codificatori girano in bf16, memoria e teste in fp32.
- Nessuna normalizzazione appresa sugli ingressi, così una copia congelata resta
  valida per sempre (serve alla lega).

Teste:
- **svolta continua**: gaussiana su u ∈ [−1, 1], con deviazione imparata (parte da
  0,25). L'angolo è π·u·|u|: fine vicino a zero, piena fino a ±π.
- **boost**: Bernoulli.
- **cashout**: un interruttore con due teste, «inizia» quando non si carica e
  «interrompi» mentre si carica.
  - Il tasto va tenuto 3 s.
  - Mentre carica, svolta e boost restano fuori dal gradiente.
- **valore**: con PopArt (`popart_beta` 0,05).
- **ausiliarie**: «morirò entro ~2 s» (50 passi) e «raccoglierò oro entro ~5 s» (125
  passi), con `aux_coef` 0,2.

### 2.3 PPO ricorrente (`allenamento/ia/ppo.py`)

| parametro | valore | note |
|---|---|---|
| `ppo.passi` | 128 | passi per raccolta |
| `ppo.sequenza` | 64 | BPTT, ~2,7 s; stato GRU salvato in raccolta |
| `ppo.gamma` / `lam` | 0,9995 / 0,95 | ~80 s di orizzonte |
| `ppo.epoche` | 2 | stop anticipato se KL > `kl_max` 0,03 |
| `ppo.minibatch` | 192 sul pod (128 di default) | sequenze per minibatch |
| `ppo.lr` | 3e-4 fase 1, 2e-4 fase 2, **1e-4 affinamento** | Adam, eps 1e-5 |
| `ppo.clip` | 0,15 | |
| `vf_coef`, `max_grad` | 0,5, 1,0 | |
| entropie | svolta 0,004, boost 0,002, cashout 0,0005 | |
| `riscaldamento_critico` | 20 iterazioni | al cambio di fase si allena solo il valore |
| `compila` / `compila_agg` | sì / **no** | torch.compile solo in raccolta (nell'aggiornamento sospetto di regressione) |
| `sovrapponi` | sì | la raccolta del blocco i+1 gira mentre si impara dal blocco i |

### 2.4 Raccolta veloce (`allenamento/ia/raccolta.py`)

- Tutti i controllori in un passaggio:
  - i pesi sono impilati con `vmap` (`StackedPolicies`), in due pile: allievi e copie;
  - su CUDA ogni forma è un CUDA graph.
- Le lobby sono divise in due metà: mentre una viene simulata in un thread (ctypes
  rilascia il GIL a Rust), l'altra passa dalla rete.
- Verso la GPU vanno solo le righe vive, da memoria bloccata, con copie asincrone.
- I thread di rayon e di torch sono limitati (`allena.py`).
- Allocatore CUDA a segmenti espandibili: senza, con la sovrapposizione la memoria si
  frammentava (OOM a 500 lobby).
- Le ricompense si calcolano per passo in `Collector._after_sim`.
- Le righe dell'allievo (fuori dal banco) sono i dati; anche le copie dal vivo
  imparano (self-play).

### 2.5 Lega a torneo (`allenamento/ia/lega.py`, `ia/partite.py`)

- **In ogni lobby di addestramento**:
  - l'allievo;
  - gli avversari neurali: ognuno è l'allievo dal vivo (30 %, `p_vivo`) o un
    **campione** scelto con PFSP (più spesso quelli che l'allievo batte meno);
  - nel 30 % delle lobby (`p_debole`) uno degli avversari è una **versione vecchia**
    dall'archivio, una preda vera;
  - 1–2 bot al massimo livello. Lo stile si sceglie dove l'allievo va peggio, con peso
    (1 − battuto)² + 0,05.
- **Torneo**:
  1. ogni 20 iterazioni (`istantanea_ogni`) l'allievo entra fra i campioni;
  2. un girone sorteggia 4 campioni (`torneo_n`), che giocano 16 partite fra loro più
     i bot (`torneo_partite`), sulle 16 lobby `env.mondi_torneo`;
  3. restano i 2 con più punti medi; sopra 16 campioni (`campioni_max`) resta solo il
     primo;
  4. i gironi partono da 5 campioni (`campioni_min`).
- **Archivio**: un'istantanea ogni 100 iterazioni, fino a 40; ne escono le versioni
  deboli (`deboli` 4 in campo).
- **Rosa**: 6 campioni in campo, rinnovati ogni 24 iterazioni, 2 alla volta.
- **Protetti**: mai scartati. Sono il campione finale della fase 1 e, nell'affinamento,
  i 4 migliori (`lega.iniziali`, nomi `top:<nome>`).
- **Elo** su tutti, bot compresi: vince chi fa più punti nella stessa partita.

### 2.6 Diversità (`allenamento/ia/diversita.py`)

Soglie e nicchie le ha decise l'utente: non cambiarle da soli.

- **Impronta**: una sonda fissa di 96 spezzoni da 48 passi veri, giocati da ogni
  checkpoint con la memoria vuota. Si misurano sterzata e probabilità di boost passo
  per passo.
- **Clone**: Δsterzata < 0,05 **e** Δboost < 0,05; esce il peggiore.
- **Nicchie**:
  - cacciatore: ≥ 1 uccisione per partita;
  - sciacallo: bottino altrui ≥ proprio, < 1 uccisione;
  - corridore: boost ≥ 20 % del tempo;
  - prudente: distanza dal nemico ≥ 600 u.

  Si attribuiscono dopo 10 partite. L'ultimo di una nicchia non si scarta.
- **Popolazione troppo simile** (distanza media < 0,10, o un solo stile):
  - si creano 2 mutanti, con rumore pari all'1 % della deviazione di ogni strato;
  - il rumore raddoppia fino al 32 % finché il mutante non è più un clone (l'1 % da
    solo non cambia nulla: misurato).

### 2.7 Banco di prova (`ia/partite.py`, `Benchmark`)

- Sono 16 lobby riservate, che non danno dati di addestramento.
- **Scenari**:
  - `bot:<stile>`: l'allievo da solo contro 2 bot di quello stile, al massimo livello;
  - `campioni`: contro 3 campioni e un bot misto;
  - `deboli`: contro 2 versioni vecchie e un bot misto.
- **Punteggio di uno scenario**: i punti medi, in una media che sfuma (0,93).
- **Fitness**: ½ media + ½ scenario peggiore. La migliore va in `migliore.pt`.

**Attenzione**: la fitness è rumorosa (±1 punto da un controllo all'altro) e
`migliore.pt` NON è il modello migliore. Alla finale il `migliore.pt` dell'affinamento
è arrivato 15°, quello della fase 2 19°. Si sceglie con la finale (tappa 4).

### 2.8 Situazioni (fase 2 e affinamento, `ia/partite.py`)

| situazione | cosa succede | parametri |
|---|---|---|
| **attesa** | l'allievo entra da solo, senza bot; un avversario neurale entra dopo un po' alla taglia d'ingresso | `env.p_attesa`, `env.attesa_s` |
| **svantaggio** | l'allievo entra piccolo (taglia 45–60, boost quasi finito) e trova un avversario neurale già a 300–600 (saldo normale) | `env.p_svantaggio`, `env.taglia_piccolo`, `env.taglia_grosso` |
| **duello** | l'allievo contro UN avversario neurale, senza bot, per 200–320 s | `env.p_duello`, `env.duello_s` |

Le misure di ogni situazione finiscono nel registro: `ep_*_attesa`, `ep_*_svantaggio`,
`ep_*_duello`.

### 2.9 Strumenti

| strumento | a cosa serve |
|---|---|
| `allenamento/allena.py` | il ciclo di addestramento (`--nome`, `--imposta sezione.chiave=valore`, `--piccola` per la prova di fumo) |
| `corse/<nome>/registro.csv` | una riga per iterazione, tutte le misure |
| `corse/<nome>/diario.txt` | il racconto compatto della corsa, con anomalie «!!»; su RunPod `make diario` |
| `corse/<nome>/eventi.log` | gironi, mutanti, cloni, migliori, salvataggi |
| `allenamento/medie.py` | medie a blocchi del registro, per i controlli ogni 10 minuti |
| `allenamento/finale.py` | la finale: candidati alla pari, salva `model_1.pt` … `model_N.pt` |
| `allenamento/pannello.py` | l'interfaccia nel browser (sul pod `make pannello`, porta 8080) |
| `runpod/Makefile` | `setup`, `verifica`, `addestra`, `ferma`, `log`, `stato`, `diario`, `valuta`, `pacchetto`, `pannello`; variabili `NOME`, `IMPOSTA` |

---

## 3. La ricompensa (a punti, `allenamento/ia/punti.py`)

Si assegna passo per passo. La somma coincide con `punti_resoconto` calcolato sul
resoconto di fine partita: verificato su ~3.000 agenti, premi e penalità compresi.

**Non esiste nessun altro termine**: niente costo del tempo, niente modellamento,
niente valore della taglia. Non aggiungerne senza che l'utente lo chieda.

### Fase 1, predatore

Il cashout è bloccato per tutte le reti.

| evento | punti | parametro |
|---|---|---|
| uccisione (contatore `kills` del server) | 0,5 | `ricompensa.uccisione` |
| … vinta testa contro testa | il 75 %: 0,375 | `ricompensa.quota_frontale` |
| bottino delle PROPRIE uccisioni | 1 per caduta intera, diviso per orb | `ricompensa.bottino_mio` |
| bottino delle uccisioni ALTRUI (o del muro) | 0,6 per caduta intera, diviso per orb | `ricompensa.bottino_altrui` |
| orb di cibo | 0,02 | `ricompensa.cibo` |
| morte testa contro testa | −0,5 | `ricompensa.morte_frontale` |
| altre morti, fine partita forzata | 0 | |

Ogni orb d'oro porta scritto chi ha ucciso (`killer`) e quale parte della caduta vale
(`share` = 1/orb della caduta).

### Fase 2, giocatore completo

Tutti i punti della fase 1 valgono × 0,7 (`peso_fase2`). Fa eccezione la penalità del
frontale, che resta −0,5.

In più, al cashout fatto da sé, misurato nel momento in cui il cashout si completa:

| condizione | punti |
|---|---|
| profitto ≥ +80 % e nessun orb d'oro dentro il muro | **5,0** (`bonus_pulito`) |
| profitto ≥ +80 % con oro ancora raccoglibile | **2,6** (`bonus_oro`) |
| profitto > +20 %, nessun avversario vivo e niente oro | **7,0** (`bonus_vuoto`; con +80 % a lobby vuota vale 7,0) |
| profitto **sotto +20 %** (anche in perdita) | **−5,0** (`pena_sotto`: peggio che morire) |
| fra +20 % e +80 % con avversari o oro | 0 |

Il profitto è quello vero dell'episodio: incassato − saldo d'ingresso, in poste.

L'obiettivo minimo dell'utente è uscire con almeno +80 % e niente oro a terra. La
regola della lobby vuota (7,0 già da +21 %) è sua e resta così.

### Come si leggono le regole (interpretazioni fissate il 6 ottobre)

- **Profitto**: incassato − saldo d'ingresso, in poste. Nell'osservazione c'è il
  profitto se si incassasse adesso, P = 0,9·saldo − posta, in x[38].
- **«Oro a terra»**: solo gli orb d'oro **dentro il muro**. Quelli oltre il muro non si
  possono prendere. Basta un solo orb per passare da 5,0 a 2,6. L'agente vede l'oro a
  terra in x[25] (valore) e x[26] (numero di orb).
- **«Avversari in campo»**: chiunque altro sia ancora vivo, neurale o bot (x[16]).
- **+80 % a lobby vuota**: valgono entrambe le condizioni e si prende la migliore,
  7,0. Altrimenti avere più soldi farebbe prendere meno punti.
- **Divisione del bottino**: per numero di orb. Gli orb di una caduta valgono tutti
  uguale.
- **Uccisione**: quella che il server attribuisce, cioè il contatore `kills`. Un
  frontale in cui muoiono entrambi non conta.
- **Bottino dei ricchi**: vale 1 (o 0,6) per caduta, qualunque sia il saldo della
  vittima. I soldi veri entrano in gioco in fase 2 attraverso la soglia di profitto.
- **Perché si continua a cacciare in fase 2**: i punti di caccia restano (× 0,7) e il
  premio più alto (7,0) chiede una lobby senza avversari, quindi uccidere tutti resta la
  strada migliore.

### Dove si modifica

| cosa | dove |
|---|---|
| punti e premi | `allenamento/ia/punti.py` (`punti_caccia`, `bonus_uscita`, `punti_resoconto`) |
| valori della ricompensa, lobby, PPO, lega | `allenamento/ia/config.py` (`RewardCfg`, `EnvCfg`, `PPOCfg`, `LeagueCfg`, preset `FASI`) |
| applicazione per passo, statistiche degli episodi | `allenamento/ia/raccolta.py`, `Collector._after_sim` |
| cashout bloccato | `Collector.lock_of`: in fase 1 per tutti; in fase 2 solo per i checkpoint della fase 1 |
| provenienza del bottino, contatori del giocatore, oro e nemici al cashout | `simulatore/src/world.rs` (`kill`, `step_movement`, `request_cashout`) |
| info per passo verso Python (INFO_SIZE 26) | `simulatore/src/env.rs`, `collect` |
| lobby, situazioni, torneo, banco | `allenamento/ia/partite.py` (`Matchmaker`, `Benchmark`) |
| selezione a torneo, protetti, nicchie | `allenamento/ia/lega.py` |
| cambio di fase, campioni iniziali | `allenamento/allena.py` (`build_config`, `cambia_fase`, `load_iniziali`) |

Le lobby di ogni fase sono nel preset `config.FASI` e si applicano quando la corsa
nasce o quando `fase` cambia. Quello che si passa con `--imposta` vince sempre. Con
`lega.fase_da_migliore=true` la fase 2 parte da `migliore.pt` invece che dall'ultimo
allievo: serve solo se a fine fase 1 l'allievo stava regredendo.

### Affinamento

È la ricompensa della fase 2. Il cibo vale **0,04** dall'iterazione 1152 (prima 0,02),
su scelta dell'utente. La finale e tutte le altre corse usano 0,02.

---

## 4. Il piano ideale, tappa per tappa

Rispetto a com'è andata davvero, il piano ideale:
- applica **tutte le regole finali fin dall'inizio** (nella corsa vera sono arrivate a
  metà strada, vedi la cronologia al §7);
- **salta le deviazioni scartate** (il bot fuggitivo e il valore della taglia).

I default del codice (`allenamento/ia/config.py`) sono già quelli finali:
- crescita dall'oro 11,5;
- bottino 30–60 s;
- frontale −0,5 e uccisione frontale al 75 %;
- cibo 0,02;
- penalità sotto +20 %;
- rete del server ristretta;
- attesa e svantaggio al 10 %.

Da tenere presente:
- **Tutto si misura in campioni**, non in iterazioni o ore. I campioni sono la colonna
  `campioni` del registro e la riga «FINE» del diario. I campioni per iterazione
  dipendono dalle lobby: ~79 k in fase 1 (448–512 lobby × 4 posti), ~56 k in fase 2 e
  ~52 k nell'affinamento (352 lobby × 5 posti).
- **L'RL non è riproducibile bit per bit**: thread, GPU e riavvii cambiano i numeri. La
  stessa ricetta dà risultati simili, non pesi identici. Per questo la tappa 4 sceglie
  fra molti candidati.

### Tappa 0: preparazione del pod

Hardware usato:
- RunPod con una **RTX 5090, 32 GB**;
- 112 core, 503 GB di RAM;
- immagine PyTorch con CUDA;
- disco su `/workspace`, l'unico che sopravvive allo spegnimento.

```bash
cd /workspace
git clone https://github.com/lorenzoMezza/slither_with_money_AI.git
cd slither_with_money_AI
make setup        # Rust, dipendenze, cargo build --release, controllo della GPU
make verifica     # cargo test --release (9 test) + prova di fumo allena.py --piccola
```

Per lanciare qualunque cosa di lungo sul pod:
- usa sempre `setsid nohup … > log 2>&1 < /dev/null &`;
- se lanci dal kernel Jupyter senza staccare il processo, il kernel resta appeso; in
  quel caso va cancellato dall'API e ricreato.

Lo script di riavvio è nel repository, `runpod/riavvia.sh`:
1. ferma la corsa `$NOME` in modo pulito;
2. aspetta che esca;
3. fa `git pull` e ricompila il simulatore;
4. riprende la corsa (o la avvia) con `$IMPOSTA`.

Ogni tappa qui sotto si lancia così, dalla cartella del repository:

```bash
NOME=corsa IMPOSTA='…' setsid nohup runpod/riavvia.sh > /workspace/riavvia.log 2>&1 < /dev/null &
```

`make addestra` lancia il regolatore (`runpod/strumenti.py regola`), che sceglie le
lobby in base alla GPU. Un `env.mondi=` dentro `IMPOSTA` ha la precedenza.

### Tappa 1: Fase 1, il predatore (da pesi casuali)

```bash
NOME=corsa IMPOSTA="fase=1 env.mondi=448" setsid nohup runpod/riavvia.sh > /workspace/riavvia.log 2>&1 < /dev/null &
```

- **Lobby** (preset di fase 1):
  - allievo + 2–3 avversari neurali (`env.posti` 4) + 1–2 bot al massimo livello;
  - durata massima uniforme 60–300 s;
  - lr 3e-4.
- **Numero di lobby**: con 4 posti la RTX 5090 regge 448–512 lobby (nella corsa vera
  384 → 512 → 448).
- **Avvio da pesi casuali**: `lega.partenza` vuoto, che è il default. Ripartire da un
  checkpoint vecchio ha portato con sé abitudini sbagliate (arrotolarsi).

Curva attesa (corsa vera; fino a 1631 cibo 0,01 e senza penalità frontale, quindi
i punti di inizio fase sono un po' diversi):

| campioni | iterazioni | punti | uccisioni | bottino proprio | morte | boost | taglia | fitness |
|---|---|---|---|---|---|---|---|---|
| 0–8 M | 1–100 | 0,08 | 0,09 | 0,01 | 96 % | 15 % | 111 | 0,06 |
| ~45 M | 500–600 | 1,43 | 0,97 | 0,87 | 75 % | 34 % | 250 | 0,67 |
| ~85 M | 1000–1100 | 1,49 | 0,99 | 0,91 | 65 % | 18 % | 265 | 1,19 |
| ~165 M | 2000–2100 | 1,31 | 0,90 | 0,77 | 63 % | 13 % | 300 | 1,44 |
| ~245 M | 3040–3141 | 1,52 | 1,02 | 0,90 | 72 % | **72 %** | **69** | 1,58–1,87 |

**Quando chiudere**. La fase 1 è matura quando:
- uccide con regolarità e mangia le prede (bottino proprio ≈ uccisioni);
- batte la maggior parte degli stili di bot;
- nei gironi vincono le versioni recenti.

Si chiude per stallo (punti e fitness non salgono di più del 5 % in ~2 ore, cioè
~200 M campioni a questa velocità) o per regressione (più del 10 % sotto il massimo,
senza recupero). Nella corsa vera l'utente l'ha chiusa a ~250 M campioni, con la
fitness ancora in salita (+1,87).

**Segnale da guardare**: fra 2100 e 2600 iterazioni (~170–210 M campioni) è nata
l'abitudine del **boost sempre acceso**. Il boost è passato dal 13 al 63–72 % del tempo
e la taglia è scesa da 300 a ~70.
- Nello stesso intervallo erano entrate la crescita dall'oro dimezzata e il bottino a
  30–60 s; la causa precisa non è nota.
- L'abitudine è rimasta per tutta la fase 2 (boost 62–77 %, taglia ~90).
- Solo l'affinamento l'ha ridotta.

Nella corsa nuova, con le regole finali dall'inizio, controllare `ep_boost` e
`ep_taglia`. Se il boost supera il 40 % con la taglia sotto 100, l'abitudine si sta
formando: annotarlo e dirlo all'utente, senza inventare rimedi da soli.

### Tappa 2: Fase 2, il giocatore completo

```bash
NOME=corsa IMPOSTA="fase=2 env.mondi=352" setsid nohup runpod/riavvia.sh > /workspace/riavvia.log 2>&1 < /dev/null &
```

`fase=2` sulla stessa corsa fa il passaggio (`cambia_fase` in `allena.py`):
- l'allievo di fine fase 1 entra fra i campioni come **protetto** (`fase1_finale`) e
  gioca col cashout bloccato: in fase 2 resta in campo un predatore puro;
- anche gli altri checkpoint della fase 1 giocano senza cashout;
- banco azzerato; il migliore della fase 1 va in `migliore_fase1.pt`;
- 20 iterazioni di solo critico;
- preset di fase 2:
  - allievo + 0–4 avversari neurali (`env.posti` 5) + 1–2 bot;
  - durata 80–320 s;
  - lr 2e-4;
  - attesa 10 % (10–60 s) e svantaggio 10 %;
  - penalità sotto +20 %.
- Con 5 posti la RTX 5090 regge **352 lobby**; a 448 la VRAM era al 97 %.

Curva attesa (corsa vera; attesa e svantaggio entrati a 5004, penalità sotto +20 % a
5698):

| campioni | iterazioni | punti | uccisioni | morte | cashout | +80 % senza oro | lobby vuota | profitto |
|---|---|---|---|---|---|---|---|---|
| ~250 M | 3161–3300 | 2,20 | 0,68 | 57 % | 37 % | 10 % | 14 % | +0,14 |
| ~300 M | 4000–4100 | 3,45 | 0,78 | 53 % | 47 % | 18 % | 25 % | +0,34 |
| ~380 M | 5300–5400 | 4,22 | 0,75 | 36 % | 59 % | 26 % | 30 % | +0,55 |
| ~430 M | 6000–6100 | 4,05 | 0,71 | 37 % | 56 % | 26 % | 29 % | +0,50 |
| ~490 M | 7000–7477 | 4,23 | 0,72 | 37 % | 59 % | 26 % | 31 % | +0,51 |

Altri riferimenti:
- uscite sotto +20 %: ~0,1 % dopo la penalità (prima ~1 %);
- fitness 4,7–5,9, il massimo 6,07 è rumore.

**Quando chiudere**: i punti sono fermi dalle ~380 M (iterazione ~5400). Nella corsa
vera l'utente l'ha fermata a ~490 M. Con le regole finali dall'inizio della fase basta
chiudere quando:
- punti e fitness non salgono di più del 5 % in ~2 ore;
- le uscite con premio non crescono più;
- le uscite senza premio non calano più.

In pratica circa 100–150 M campioni dopo il passaggio.

**Cosa portare all'affinamento**: il **campione più solido del torneo**, cioè molte
partite di torneo e punti medi alti (nella corsa vera allievo@7160: 110 partite, 4,49
di media). Più i 3 successivi per Elo o punti. NON `migliore.pt`.

Per vedere i campioni, da `corse/<nome>/stato.pt`:
- Elo: `league.elo.r`;
- punti nel torneo: `league.stili[id].tp / tn`.

### Tappa 3: Affinamento dei migliori (corsa nuova)

Perché esiste:
- a fine fase 2 aggressività e cashout erano ottimi;
- ma gli agenti non gestivano boost e cibo: boost acceso il 73 % del tempo, taglia
  finale ~92, 4 orb mangiati mentre aspettano (quanti ne prende chi gira a caso).

```bash
NOME=affinamento IMPOSTA="fase=2 env.mondi=352 ppo.lr=1e-4 ricompensa.cibo=0.02 \
  lega.partenza=corse/corsa/lega/allievo_<MIGLIORE>.pt \
  lega.iniziali=corse/corsa/migliore.pt,corse/corsa/lega/allievo_<A>.pt,corse/corsa/lega/allievo_<B>.pt,corse/corsa/lega/<C>.pt,corse/corsa/lega/fase1_finale.pt \
  env.p_attesa=0.3 env.attesa_s=[20,90] env.p_svantaggio=0.1 env.p_duello=0.2 env.duello_s=[200,320]" \
  setsid nohup runpod/riavvia.sh > /workspace/riavvia.log 2>&1 < /dev/null &
```

Valori della corsa vera:
- `allievo_<MIGLIORE>` = allievo@7160;
- `iniziali`: migliore@5784, allievo@7160, allievo@7420, mutante@7406 e `fase1_finale`.

Come funziona:
- **Partenza**: i pesi del campione scelto (anche PopArt).
- **Campioni protetti**: i 4 migliori più il predatore della fase 1
  (`lega.iniziali`), mai scartati e sempre fra gli avversari possibili. Le versioni
  nuove devono batterli nel torneo: così non si perdono aggressività e cashout.
- **Lobby**:
  - 30 % attesa, 20–90 s;
  - 10 % svantaggio;
  - 20 % duello lungo 1 contro 1, 200–320 s;
  - 40 % lobby normali di fase 2.
- **lr 1e-4**: cambiare poco alla volta.
- **Cibo**:
  - 0,02 per i primi ~60 M campioni (iterazione 1152);
  - poi `ricompensa.cibo=0.04`: riavviare con lo stesso comando e il valore cambiato.

  Per rifarla esattamente si segue questa sequenza. Il modello primo in classifica
  (@1100) viene dal tratto a 0,02; il 2°, 3° e 4° da quello a 0,04.

Curva attesa (corsa vera):

| campioni | iterazioni | boost nel duello | morte nel duello | taglia nel duello | uccisioni | cashout | morte | banco contro i bot: morte / cashout |
|---|---|---|---|---|---|---|---|---|
| 0–5 M | 1–100 | 74 % | 46 % | 65 | 0,63 | 57 % | 38 % | 9 % / 90 % |
| ~57 M | 1100 | 67 % | 43 % | 71 | 0,66 | 59 % | 36 % | |
| ~78 M | 1500 | 52 % | 39 % | 72 | 0,68 | 59 % | 38 % | 7 % / 92 % |
| ~97 M | 1870 | 44 % | 38 % | 79 | 0,66 | 59 % | 36 % | |

Altri riferimenti:
- boost totale da 68 % a 58 %;
- taglia finale da 75 a 86–88;
- fitness 5,1–6,25; nel torneo le versioni nuove battono i protetti (Elo 1.500–1.580
  contro 1.290–1.480);
- **il cibo mangiato non è salito**, nemmeno raddoppiato: 5–7 orb in attesa, 4–5 nel
  duello.

**Quando chiudere**: quando il boost nel duello smette di scendere e il cibo resta
fermo, senza perdite di uccisioni (~0,65), cashout (~59 %) e morte (~37 %). Nella
corsa vera l'utente l'ha fermata a ~106 M campioni.

### Tappa 4: La finale

```bash
cd /workspace/slither_with_money_AI/allenamento
setsid nohup python3 finale.py --corsa corse/affinamento --da 500 \
  --extra fase2@7160=corse/corsa/lega/allievo_7160.pt fase2@7300=corse/corsa/lega/allievo_7300.pt \
          fase2@7420=corse/corsa/lega/allievo_7420.pt fase2@7460=corse/corsa/lega/allievo_7460.pt \
          "fase2 migliore=corse/corsa/migliore.pt" "fase2 mutante@7406=corse/corsa/lega/mutante_7406_0.pt" \
  --uscita /workspace/finalissimallanemento > /workspace/finale.log 2>&1 < /dev/null &
```

- **Candidati**: tutte le istantanee dell'affinamento da 500 in poi, l'ultimo allievo
  (`stato.pt`), `migliore.pt`, i mutanti, più i migliori della fase 2.
  - Nella corsa vera erano 22: affinamento @500, @1000–@2000 ogni 100, @2040, @2059,
    migliore.pt, mutante@1866; fase 2 @7160, @7300, @7420, @7460, migliore@5784,
    mutante@7406.
  - Con `--da 500` lo script prende anche @600–@900, che allora non c'erano: più
    candidati, stessa regola.
- **Partite di ogni candidato**:
  - 22 contro 2 bot al massimo livello (ogni stile 2 volte);
  - 48 nel torneo, in gironi da 4 candidati più 1 bot misto (3 sorteggi da 16
    partite).
- **Punteggio**: ½ punti medi contro i bot + ½ punti medi nel torneo, ricompensa
  ufficiale.
- **Tempo**: 772 partite su 128 lobby in ~8,5 minuti.

Escono `model_1.pt` (il più forte) … `model_10.pt`, `CLASSIFICA.txt` e
`classifica_completa.json`. Si caricano con `ia.carica.load_policy`, quindi anche con
`guarda.py`, `sfida.py` e `valuta.py`.

Risultato della corsa vera:

| pos | modello | punteggio | contro i bot: morte / cashout / uccisioni | torneo: punti / morte / cashout |
|---|---|---|---|---|
| 1 | affinamento @1100 | 6,82 | 0 % / 100 % / 1,73 | 4,76 / 33 % / 62 % |
| 2 | affinamento @1800 | 6,82 | 5 % / 95 % / 1,68 | 5,12 / 33 % / 67 % |
| 3 | affinamento @2000 | 6,48 | 9 % / 91 % / 1,50 | 5,02 / 25 % / 67 % |
| 4 | affinamento @1900 | 6,37 | 18 % / 82 % / 1,45 | 5,55 / 15 % / 81 % |
| 5 | affinamento @2059 (l'ultimo) | 6,31 | 9 % / 91 % / 1,68 | 4,48 / 25 % / 62 % |
| 6–10 | @1700, @1000, @2040, @500, @1300 | 6,16–5,93 | | |
| 15 | affinamento migliore.pt | 5,39 | | |
| 16–21 | fase 2: @7460, @7420, @7160, migliore@5784, @7300, mutante@7406 | 5,12–4,50 | | torneo: morte 52–71 % |

Su 70 partite per candidato i gruppi sono separati bene, ma le posizioni vicine sono
alla pari: 1° e 2° differiscono di 0,005.

Per portare i modelli fuori dal pod: `scp -P <porta> root@<ip>:/workspace/finalissimallanemento/* .`.
`make pacchetto` non li include.

---

## 5. Come andare più veloce

Il collo di bottiglia è la GPU:
- in raccolta, l'inferenza (~20–30 % della GPU, ~1,9 s per iterazione);
- nell'aggiornamento, la GPU al 100 % (~1,8 s).

Il simulatore costa poco e usa tutti i core. Le leve, in ordine:

1. **Una GPU più grande, con più lobby.**
   - Memoria: ~50–60 MB per lobby con 5 posti, ~40 MB con 4, compresi rete e
     ottimizzatore. Sulla 5090 (32 GB) erano 352 lobby in fase 2 e 448 in fase 1.
   - Su 80 GB ~900–1.000 lobby in fase 2.
   - Il regolatore (`make addestra` senza `env.mondi`) sale da solo finché la GPU
     supera il 75 % o la memoria il 70 %.
2. **Tenere le stesse cadenze per campione, non per iterazione.** Con k volte più
   lobby, ogni iterazione porta k volte più campioni. Per avere la stessa dinamica:
   - `lega.istantanea_ogni` ≈ 20 / k (circa un'istantanea ogni 1,1 M campioni);
   - `lega.archivio_ogni` ≈ 100 / k;
   - `lega.rosa_ogni` ≈ 24 / k;
   - `ppo.riscaldamento_critico` ≈ 20 / k (minimo 1);
   - `env.mondi_torneo` e `env.mondi_valutazione` × k: torneo e banco devono giocare
     altrettante partite per campione.
3. **PPO**: lasciare `ppo.minibatch` 192 e lr uguali.
   - Così i passi di gradiente per campione restano gli stessi, come nella ricetta.
   - Un minibatch più grande accelera l'aggiornamento ma cambia la dinamica: è una
     variante da provare a parte, non la ricetta.
4. **Più pod in parallelo.** Il codice usa una GPU per corsa.
   - Il modo sicuro di usare più GPU è rifare la stessa ricetta su 2–4 pod, ognuno
     con un seme diverso (`seme=2`, `seme=3`, …).
   - Poi una **finale unica** con i candidati di tutte le corse (`--corsa` più volte,
     oppure `--extra`).
   - Più candidati diversi danno una finale più robusta.
5. **Tempi per tappa misurati in campioni**: fase 1 ~250 M, fase 2 ~245 M (ne
   bastano ~150 M con le regole finali dall'inizio), affinamento ~60–106 M. A
   velocità k volte maggiore il tempo si divide per k.

Cosa non cambiare scalando:
- la ricompensa;
- le soglie della diversità (sono dell'utente);
- la rete del server;
- le situazioni;
- le osservazioni (solo ciò che il client vede).

**Idee non ancora provate.** Vanno proposte all'utente, non applicate:
- mettere già in fase 2 le partite dell'affinamento (attesa 30 %, duello 20 %) per
  evitare l'abitudine del boost sempre acceso;
- capire perché il cibo non sale nemmeno raddoppiato. Probabilmente l'agente mangia
  solo ciò che incontra: meno boost vuol dire meno strada, quindi meno orb.

---

## 6. L'esperienza fatta: cosa funziona e cosa no

### Ricompensa e regole

- **Prima delle due fasi** si è provato altro, fra il 5 ottobre e il pomeriggio del 6
  (fino al commit b339f59):
  - un curriculum a 4 fasi con situazioni, bot immortali e avvio per imitazione dei bot;
  - poi una «fase unica».

  Ricompensa della fase unica, in poste, per passo:

  | termine | quando |
  |---|---|
  | Δ valore d'incasso (0,9·saldo) | sempre; −tutto alla morte |
  | − κ (0,3) | morte |
  | − pagato − κ | uscita con profitto < +80 % (uscire sotto l'obiettivo = morire) |
  | + 0,3 | cashout da sé con profitto ≥ +80 % |
  | − 0,4 poste/min, più 0,6 se fermo in tondo | sotto l'obiettivo |
  | γΦ' − Φ | potenziale su taglia, progresso verso +80 % e carica del cashout |
  | + 0,002 per zona nuova | esplorazione |

  Com'è andata:
  - l'agente si arrotolava e girava in tondo: escursione da 850 a 400 u;
  - bruciava massa col boost per sopravvivere: taglia da 147 a 53;
  - raggiungeva +80 % nello 0,4 % delle partite;
  - uccidere non era mai premiato direttamente: con tanti termini che si compensavano,
    la strategia più sicura era restare arrotolati e sperare che qualcuno si
    schiantasse;
  - ripartire da un checkpoint vecchio si portava dietro le stesse abitudini.

  **Abbandonata.** La ricompensa a punti in due fasi, da pesi casuali, funziona. I
  cloni dei giocatori umani (imitazione dalle sessioni registrate) sono stati provati e
  spenti già il 5 ottobre.
- **Fase 1 con il cashout bloccato per tutti**: l'agente impara prima a cacciare e
  a raccogliere. In fase 2 il predatore della fase 1 resta in campo, protetto: un
  avversario da cui non disimparare a difendersi.
- **Penalità del frontale (−0,5)**: senza, l'agente non capiva che nel frontale muore
  il più piccolo. L'uccisione vinta di frontale vale il 75 % di una vera, su scelta
  dell'utente.
- **Cibo da 0,01 a 0,02** in fase 1: chiesto dall'utente.
- **Crescita dall'oro dimezzata (11,5) e bottino a 30–60 s**: scelte dell'utente, il
  valore in soldi non cambia.
  - In un tempo vicino è nata l'abitudine del boost sempre acceso (§4, tappa 1).
- **Uscite senza premio**: in «attesa», da solo, l'agente usciva subito, perché uscire
  senza premio costava 0. Con −5 sotto +20 % sono scese dall'~1 % allo 0,1 % in poche
  iterazioni.
- **Morte a −5**: chiesta e poi interrotta dall'utente («va tutto bene così»). NON
  applicata.
- **Bot «fuggitivo» e «valore della taglia»** (costo del boost, taglia dall'oro):
  provati in fase 2 (19:52–19:59). **L'utente li ha rifiutati**: annullati (commit
  67e20a3) e corsa riportata ad allievo@4460. **Non riproporli.**
- **Cibo raddoppiato nell'affinamento**: dopo ~350 iterazioni il cibo mangiato non è
  salito. Il boost invece è diventato più dosato e i duelli sono migliorati.
  - Con la fisica misurata un orb di cibo vale ~0,5 s di boost (6–7 di taglia contro
    11–16 al secondo di costo).
  - Mangiare conta soprattutto prima dello scontro.

### Avversari, popolazione, selezione

- La popolazione dei campioni tende a un solo stile, il «corridore». Da qui la
  diversità forzata.
  - Un mutante all'1 % è un clone, quindi serve l'escalation fino al 32 %. Per
    confronto, due istantanee a 20 iterazioni di distanza differiscono di 0,04–0,14
    nella sterzata e di 0,01–0,05 nel boost.
  - Ogni tanto i mutanti vincono gironi: in finale due si sono piazzati a metà
    classifica.
- **I protetti funzionano**: nell'affinamento le versioni nuove li hanno battuti nel
  torneo (Elo +100–200) senza perdere nulla al banco.
- **La fitness del banco è rumorosa** (media che sfuma con 0,93, ~14 partite per
  scenario). Gli eventi «regressione» arrivano a raffica dopo ogni riavvio: non
  reagire a un singolo controllo.
- **`migliore.pt` non è il migliore** (15° e 19° in finale). Per scegliere servono il
  torneo diretto e la finale.
- I vecchi migliori della fase 2, messi contro le versioni affinate, muoiono nel
  52–71 % delle partite del torneo, contro il 15–40 %.

### Tecnica

- **VRAM**:
  - 4 posti: 512 lobby funzionano, 448 è prudente;
  - 5 posti: 352 lobby, perché a 448 la VRAM era al 97 %;
  - l'allocatore a segmenti espandibili è indispensabile con raccolta e aggiornamento
    sovrapposti.
- **torch.compile**: solo nella raccolta. Nell'aggiornamento c'è il sospetto di una
  regressione del gioco.
- **Pile vmap a capienza fissa** (4, 8, 12, …): un cambio della rosa ricopia i pesi
  sul posto invece di ricompilare (~20 s risparmiati ogni ~20 iterazioni).
- **Kernel Jupyter del pod**: un comando lungo o un processo non staccato lo blocca.
  Lanciare sempre con `setsid nohup … < /dev/null &`; se si blocca, cancellarlo
  dall'API.
- **Strumenti di visione** (`guarda`, `sfida`, `valuta`): usano oro 23 e bottino
  5–7 s, non le condizioni d'addestramento. La finale usa quelle d'addestramento.
- **Coerenza dei punti**: ogni volta che si tocca la ricompensa, verificare che la
  somma per passo sia uguale a `punti_resoconto` del resoconto, su qualche migliaio di
  agenti (`allena.py --piccola` più un controllo come quello del 6 ottobre).

### Come seguire una corsa (ogni 10 minuti)

```bash
python3 allenamento/medie.py allenamento/corse/<nome> 100   # medie a blocchi, fitness, banco
grep -E 'girone|mutante|migliore|PASSAGGIO' allenamento/corse/<nome>/eventi.log | tail
grep -cE 'Traceback|out of memory' allenamento/corse/<nome>/uscita.log
nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
```

Cosa guardare:
- **fase 1**: punti, uccisioni, bottino proprio, morte, boost e taglia, fitness.
- **fase 2**:
  - cashout per tipo: `uscita_pulita`, `uscita_vuota`, `uscita_sotto`, `uscita_penale`;
  - profitto;
  - uccisioni, che non devono scendere sotto l'~80 % della fine della fase 1;
  - le situazioni.
- **affinamento**:
  - boost, cibo, taglia e morte nel duello;
  - cibo in attesa;
  - uccisioni, cashout e morte nelle partite;
  - il torneo contro i `top:`.
- **diario**: prima le righe «!!», poi le condizioni «NO».

---

## 7. Cronologia della corsa vera (6 ottobre 2026, RTX 5090)

| ora | iterazione | campioni | evento | commit |
|---|---|---|---|---|
| 16:57 | — | — | due fasi a punti e selezione a torneo, da pesi casuali | 4e3910d |
| 17:00 | 0 | 0 | corsa «runpod», fase 1, 384 lobby (poi 512) | |
| 17:30 | 735 | 60 M | diversità: cloni, nicchie, mutanti | 6ebf60a |
| 17:46 | 1143 | 93 M | rete del server ristretta ai valori misurati | 016506e |
| 18:06 | 1631 | 132 M | penalità frontale −0,5, cibo 0,01 → 0,02 | 217a271 |
| 18:24 | 2022 | 166 M | 448 lobby | |
| 18:34 | 2266 | 185 M | crescita dall'oro 23 → 11,5 | 75ec348 |
| 18:40 | 2397 | 195 M | bottino 30–60 s | 5406121 |
| 18:55 | 2790 | 223 M | uccisione frontale al 75 % | 3f3c7fa |
| 19:08 | 3141 | 249 M | **passaggio alla fase 2** (fitness +1,87), 352 lobby | |
| 19:52–19:59 | 4497–4637 | 326–334 M | bot fuggitivo e valore della taglia: rifiutati, annullati, ripristino di allievo@4460 | f58fe44, 67e20a3 |
| 20:12 | 5004 | 355 M | situazioni attesa e svantaggio (10 % + 10 %) | 8c9e50b |
| 20:36 | 5698 | 394 M | cashout sotto +20 % = −5 | 5caef62 |
| 21:33 | 7477 | 493 M | fine fase 2 (punti ~4,2 fermi da ~380 M) | |
| 21:51 | 0 | 0 | **affinamento** da allievo@7160, 4 top + fase1_finale protetti | 8300356 |
| 22:26 | 1152 | 59 M | cibo 0,02 → 0,04 (solo affinamento) | d94580e |
| 22:55 | 2059 | 106 M | fine affinamento | |
| 23:00–23:08 | — | — | finale fra 22 candidati, 10 migliori in `/workspace/finalissimallanemento` | d952b50 |

---

## 8. Vincoli che valgono sempre

- **Niente ponte verso il server vero.** Nessuna API e nessun layer che faccia giocare
  l'IA su moneyslither.com: ci sono soldi veri e giocatori umani che non lo sanno. La
  sola eccezione sarebbe una lobby privata con partecipanti consapevoli. Vedi
  `PONTE.md`.
- **Dati personali mai pubblicati**: `analizer/chrome-profile/`, `analizer/sessioni/`,
  `analizer/archivio/`.
- **Osservazione = solo ciò che il client vede online.**
- **Le regole della ricompensa e le soglie della diversità sono dell'utente**: ogni
  modifica va proposta, non applicata.
- **Commit e push su `main`** per ogni modifica.
