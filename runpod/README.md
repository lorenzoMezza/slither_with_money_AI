# Addestramento su RunPod, headless, con `make`

Tutto l'addestramento gira in un pod Linux con CUDA, senza browser né terminale
interattivo: si clona il repository, si lancia `make`, si segue il log.

La ricetta completa (le quattro tappe, i comandi esatti, i numeri attesi, come scalare)
è in **[`PIANO_ADDESTRAMENTO.md`](../PIANO_ADDESTRAMENTO.md)**. Qui c'è solo come si
usa il pod.

## Il pod

Quello usato il 6 ottobre 2026:
- **RTX 5090, 32 GB**;
- 112 core, 503 GB di RAM;
- immagine PyTorch di RunPod con CUDA.

Va bene qualunque GPU CUDA: le lobby si adeguano alla memoria.

Metti il disco del pod (o un volume di rete) su `/workspace`: è l'unica cartella che
sopravvive allo spegnimento.

```bash
cd /workspace
git clone https://github.com/lorenzoMezza/slither_with_money_AI.git
cd slither_with_money_AI
make setup        # Rust, dipendenze, cargo build --release, controllo della GPU
make verifica     # cargo test --release + prova di fumo dell'addestramento
```

## Lanciare una tappa

Ogni tappa si lancia con lo script di riavvio, **sempre staccato dal terminale**:

```bash
NOME=corsa IMPOSTA="fase=1 env.mondi=448" setsid nohup runpod/riavvia.sh > /workspace/riavvia.log 2>&1 < /dev/null &
```

`runpod/riavvia.sh`:
1. ferma la corsa `NOME` in modo pulito, se gira;
2. aspetta che esca;
3. fa `git pull` e ricompila il simulatore;
4. avvia o riprende la corsa con `IMPOSTA`.

I valori di `IMPOSTA` per ogni tappa sono in `PIANO_ADDESTRAMENTO.md`, §4.

Un comando lungo lanciato da un kernel Jupyter senza `setsid nohup … < /dev/null &`
blocca il kernel. Se succede, il kernel va cancellato e ricreato.

## I bersagli

| bersaglio | cosa |
|---|---|
| `make setup` | Rust con rustup (profilo minimo), `build-essential` se manca un compilatore C, `numpy` se manca, `cargo build --release`, controllo della GPU |
| `make verifica` | `cargo test --release` e `allena.py --piccola --iterazioni 2` |
| `make addestra` | avvia o riprende la corsa `NOME` in background, attraverso il regolatore; log in `allenamento/corse/NOME/uscita.log` |
| `make ferma` | fermata pulita: finisce l'iterazione, salva, esce |
| `make log` / `make stato` | il log dal vivo / l'ultima iterazione in chiaro |
| `make diario` | il diario della corsa (`diario.txt`), da passare per una diagnosi |
| `make valuta` | banco di prova del migliore (`valuta.py`) |
| `make pacchetto` | `NOME.tar.gz` con `migliore.pt`, configurazione, registri e diario |
| `make pannello` | il pannello web su `0.0.0.0:8080`: dal proxy del pod (`https://<pod>-8080.proxy.runpod.net`) si vedono grafici, banco, situazioni ed eventi |
| `make` | `setup` + `verifica` + `addestra` |

Variabili:
- `NOME=…`: la corsa, di default «runpod»;
- `IMPOSTA="sezione.chiave=valore …"`: altri parametri, separati da spazi.

**Lobby.** `make addestra` passa dal regolatore (`strumenti.py regola`):
- parte con un numero di lobby proporzionato alla memoria della GPU;
- ogni 10 minuti misura l'uso della GPU e, se è sottoutilizzata, riavvia con più lobby;
- se la corsa muore per un errore la riavvia dal salvataggio.

Un `env.mondi=N` dentro `IMPOSTA` ha la precedenza. La ricetta lo fissa:
- 448 lobby in fase 1 (4 posti);
- 352 in fase 2 e nell'affinamento (5 posti; a 448 la VRAM era al 97 %).

## Seguire una corsa

```bash
python3 allenamento/medie.py allenamento/corse/corsa 100     # medie a blocchi, fitness, banco
grep -E 'girone|mutante|migliore' allenamento/corse/corsa/eventi.log | tail
nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader
```

## La finale e i modelli finali

`allenamento/finale.py` mette alla pari i candidati e salva `model_1.pt` (il più forte)
… `model_10.pt` (vedi `PIANO_ADDESTRAMENTO.md`, tappa 4). Quelli del 6 ottobre sono sul
pod in `/workspace/finalissimallanemento/`.

Per scaricarli (porta e indirizzo SSH sono nella pagina del pod):

```bash
scp -P <porta> root@<ip-del-pod>:/workspace/finalissimallanemento/* .
```

Sul Mac si caricano come qualunque checkpoint con `guarda.py`, `sfida.py` e
`valuta.py`.

## Cosa serve e cosa no

- **Serve**:
  - Linux con CUDA e PyTorch già installato (le immagini RunPod lo hanno);
  - rete per rustup e `apt` la prima volta;
  - ~6 GB di spazio per Rust e la build.
- **Non serve**: Node (l'analizzatore non gira qui; il simulatore usa la fisica vera
  del server e i parametri misurati scritti nei default) e un browser.
- **Costo**: il pod costa finché è acceso. Fai `make ferma`, poi spegnilo. Con il
  repository in `/workspace` la corsa riprende al prossimo lancio.
