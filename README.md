# slither_with_money_AI

Studio di **moneyslither.com** e ambiente per addestrare un'AI a giocarci:
prima si osserva il gioco vero, poi lo si riproduce fedelmente.

| cartella | cosa c'è |
|---|---|
| [`analizer/`](analizer) | registra il gioco dal browser mentre giochi (traffico, sorgente del client, stato) e ne ricava le regole e la fisica del server. Node.js |
| [`simulatore/`](simulatore) | il server riprodotto tick per tick, con rete, latenze e avversari, per l'addestramento. Rust, con interfaccia Python e visualizzatore nel browser |
| [`allenamento/`](allenamento) | l'agente: rete (transformer + CNN + GRU), PPO ricorrente, lega a torneo, finale fra i migliori, pannello nel browser. Python + PyTorch |
| [`PIANO_ADDESTRAMENTO.md`](PIANO_ADDESTRAMENTO.md) | **l'architettura dell'IA e la ricetta completa** per rifare l'addestramento: le quattro tappe (fase 1 predatore, fase 2 giocatore completo, affinamento, finale), i comandi, i numeri attesi, l'esperienza fatta |
| [`analizer/RESOCONTO-GIOCO.md`](analizer/RESOCONTO-GIOCO.md) | come funziona il gioco sul server: ogni regola con la sua fonte e il suo grado di certezza |
| [`PONTE.md`](PONTE.md) | a quali condizioni l'agente potrà collegarsi a un server vero, cosa riceve e cosa produce, come verificarlo offline prima |
| [`runpod/`](runpod) | l'addestramento headless su un pod Linux con CUDA (usato: RTX 5090): `make`, `runpod/riavvia.sh` |

## Come si incastrano

```text
gioco vero ──► analizer ──► analizer/estratto/simulatore.json ──► simulatore ──► allenamento
                  ▲                                                    │
                  └──── simulatore registra + confronta.mjs ◄──────────┘
                        (lo stesso analizzatore misura anche il simulatore)
```

La fisica del server (movimento, corpo, taglia, boost, crescita, cibo, collisioni,
cashout con il 10 % di commissione) è la verità data dall'utente il 2026-10-07 ed è
fissa nel simulatore (`simulatore/src/config.rs`, campi `[V]`). L'analizzatore misura
il resto (tick, arena, rete), e il simulatore legge solo quello. Le partite simulate
vengono poi rimisurate dallo stesso analizzatore e confrontate con quelle vere.

## Iniziare

```bash
# analizzatore (Node ≥ 20)
cd analizer && npm install
node analizer.js login        # una volta: login con Google in un Chrome normale
node analizer.js              # gioca: registra e analizza dal vivo
node analizer.js analizza     # rigenera analizer/estratto/ dalle sessioni registrate

# simulatore (Rust stabile)
cd simulatore && cargo build --release
./target/release/simulatore vedi      # il gioco nel browser
./target/release/simulatore valida    # la fisica rigiocata sulle sessioni vere
cargo test --release                  # le regole verificate da test
```

Da Python (serve numpy): `simulatore/python/slither_sim` e l'esempio
`simulatore/python/esempio.py`.

```bash
# addestramento (Python ≥ 3.10, PyTorch)
cd allenamento && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pannello.py                # pannello nel browser: avvia, pausa, ferma, osserva, gioca contro l'IA
```
Oppure doppio clic su `allenamento/Allenamento.command`. Su un pod Linux con CUDA:
[`runpod/README.md`](runpod/README.md). La ricetta, tappa per tappa:
[`PIANO_ADDESTRAMENTO.md`](PIANO_ADDESTRAMENTO.md).

## Dati

Non sono nel repository: restano sul tuo disco, esclusi da `.gitignore`.

- `analizer/chrome-profile/`: il profilo Chrome con il login.
- `analizer/sessioni/` e `analizer/archivio/`: le partite registrate.

Tutto ciò che è ignorato e non è un dato personale si rigenera:
- `analizer/estratto/` con `node analizer.js analizza`;
- `node_modules/` con `npm install`;
- `target/` con `cargo build`;
- `allenamento/corse/` sono le corse di addestramento (pesi e registri): pesanti, si rifanno;

Senza sessioni registrate il simulatore usa i default di `simulatore/src/config.rs`:
la fisica vera del server e, per tick, arena e rete, i valori misurati il 4–5 ottobre 2026.
