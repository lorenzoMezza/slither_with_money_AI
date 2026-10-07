# allenamento

L'agente di moneyslither, addestrato nel simulatore (`../simulatore`) con PPO
ricorrente, una lega a torneo e una finale fra i migliori. È scritto in Python +
PyTorch e gira su CUDA, MPS (Mac) o CPU.

**Architettura, ricompensa e ricetta completa**, per rifare lo stesso addestramento:
**[`../PIANO_ADDESTRAMENTO.md`](../PIANO_ADDESTRAMENTO.md)**. Questo file dice solo come
si usano gli strumenti.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
(cd ../simulatore && cargo build --release)
```

## Il pannello (tutto dal browser)

Doppio clic su **`Allenamento.command`** nel Finder, oppure
`.venv/bin/python pannello.py`. Si apre http://127.0.0.1:8080.

| | |
|---|---|
| **Avvia** | nuova corsa (scrivi il nome) o ripresa della corsa selezionata dall'ultimo salvataggio |
| **Pausa / Riprendi** | il processo viene congelato e scongelato all'istante |
| **Ferma** | finisce l'iterazione in corso, salva tutto ed esce |
| **Progressi** | indicatori, grafici, banco di prova, stili dei bot, eventi |
| **Osserva l'allenamento** | da 1 a 3 partite dal vivo a tempo reale (contro i bot, contro sé stesso, contro la lega) |
| **Gioca contro l'IA** | giochi tu nel browser contro l'agente, con 1–3 IA e 0–3 bot |
| **Console** | l'uscita dell'addestramento dal vivo |

L'addestramento è un processo separato:
- chiudere il pannello o il browser non lo ferma;
- osservazione e sfida girano sulla CPU;
- porte: pannello 8080, osservazione 8081–8083, sfida 8084.

## Da terminale

```bash
.venv/bin/python allena.py --nome corsa --imposta fase=1    # addestra (riprende se esiste); Ctrl+C salva ed esce
.venv/bin/python allena.py --nome _fumo --piccola --iterazioni 2   # prova di fumo a scala ridotta
.venv/bin/python medie.py corse/corsa 100                   # medie a blocchi, fitness, banco
.venv/bin/python finale.py --corsa corse/affinamento --da 500 --uscita finale   # la finale: i 10 migliori
.venv/bin/python guarda.py corse/corsa                      # 3 partite dal vivo (porte 8081–8083); anche un file .pt
.venv/bin/python sfida.py corse/corsa                       # giochi tu contro l'IA (porta 8084)
.venv/bin/python valuta.py corse/corsa                      # banco di prova del migliore
.venv/bin/python replay_reale.py corse/corsa                # l'agente sulle partite vere registrate, offline
```

`--imposta sezione.chiave=valore` cambia qualunque parametro di `ia/config.py`. Ogni
corsa salva la sua `config.json` e la ricarica quando riparte.

`guarda`, `sfida` e `valuta` girano sul simulatore di riferimento: oro 23, bottino
5–7 s. L'addestramento e la finale usano le condizioni d'addestramento: oro 11,5,
bottino 30–60 s.

## Il codice

| file | cosa |
|---|---|
| `allena.py` | il ciclo: raccolta → PPO → lega/torneo → banco → registri; cambio di fase; campioni iniziali |
| `ia/config.py` | tutti i parametri (sezioni `env`, `ppo`, `ricompensa`, `lega`) e i preset delle fasi |
| `ia/punti.py` | la ricompensa a punti, uguale per passo e dal resoconto di fine partita |
| `ia/raccolta.py` | il Collector: lobby parallele, inferenza a pile vmap, ricompense, episodi |
| `ia/rete.py`, `ia/azioni.py` | la rete e la codifica delle azioni |
| `ia/ppo.py` | Learner e aggiornamento PPO ricorrente con PopArt |
| `ia/lega.py`, `ia/diversita.py` | campioni, torneo, archivio, protetti, PFSP, Elo; cloni, nicchie, mutanti |
| `ia/partite.py` | Matchmaker (lobby, situazioni, gironi, banco) e Benchmark |
| `ia/carica.py` | caricare e far giocare un modello |
| `ia/diario.py`, `ia/registro.py` | diario della corsa, CSV ed eventi |
| `ia/sessioni.py` | lettura delle sessioni registrate (per `replay_reale.py`) |
| `finale.py`, `medie.py` | la finale fra i candidati; le medie a blocchi del registro |
| `pannello.py`, `pannello/` | l'interfaccia nel browser |

## Cartella di una corsa: `corse/<nome>/` (ignorata da git)

| file | |
|---|---|
| `config.json` | parametri effettivi |
| `stato.pt` | tutto: allievo, ottimizzatore, lega e torneo, Elo, banco, fase. Si riprende rilanciando lo stesso `--nome` |
| `migliore.pt` | l'allievo con la fitness più alta del banco. NON è il più forte: si sceglie con la finale |
| `lega/` | campioni del torneo, archivio, protetti (`top_*`), `partenza.pt`, `sonda.pt` |
| `registro.csv` | una riga per iterazione: tutte le misure |
| `valutazione.csv` | il banco di prova per scenario |
| `eventi.log` | istantanee, gironi, cloni e mutanti, cambi di fase, regressioni, nuovi migliori, salvataggi |
| `diario.txt` | il racconto compatto della corsa, da incollare per una diagnosi. Prima le righe «!!», poi le condizioni «NO» |
| `uscita.log` | l'uscita del processo |
| `vivo.json`, `processo.json` | stato dell'ultima iterazione e processo in corso, per il pannello |

## Limiti onesti

- Il simulatore riproduce le misure del server, non il server. Ogni differenza residua
  è qualcosa che l'agente potrebbe imparare a sfruttare: per esempio la scadenza del
  bottino, che la GRU può contare anche senza vederla.
- «Batte un professionista» va misurato contro persone. I bot e la lega sono
  l'approssimazione migliore disponibile in simulazione, non una prova.
