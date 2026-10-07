# Addestramento completo, headless, su un pod RunPod con CUDA (usato: RTX 5090 32 GB) o qualunque
# Linux con CUDA. Dalla radice del repository basta `make`; qui dentro `make <bersaglio>`.
# La ricetta completa, tappa per tappa, e' in PIANO_ADDESTRAMENTO.md (si lancia con runpod/riavvia.sh).
#
#   make              = setup + verifica + addestra (in background) + istruzioni per seguire
#   make setup        Rust, dipendenze Python, compilazione del simulatore, controllo CUDA
#   make verifica     test del simulatore e prova di fumo dell'addestramento (2 minuti)
#   make addestra     avvia (o riprende) la corsa NOME in background (setsid: un Ctrl+C o un kernel
#                     Jupyter interrotto nel terminale che l'ha lanciata non la fermano), log in corse/NOME/uscita.log
#   make log          segue il log della corsa
#   make stato        l'ultima iterazione (vivo.json), in chiaro
#   make ferma        fermata pulita: finisce l'iterazione, salva, esce
#   make diario       stampa il diario della corsa (diario.txt), il file da passare per una diagnosi
#   make valuta       banco di prova del migliore della corsa
#   make pacchetto    un .tar.gz con il migliore, la configurazione e i registri, da scaricare
#   make pannello     il pannello web sulla porta 8080 (0.0.0.0: dal proxy del pod)
#
# Variabili: NOME (corsa, default «runpod»), IMPOSTA (altri parametri, es. IMPOSTA="ppo.lr=2e-4", separati da spazi).
# Le lobby le sceglie e le riscala il regolatore (strumenti.py regola), a meno che IMPOSTA contenga
# env.mondi=N (la ricetta lo fissa: 448 in fase 1, 352 in fase 2 e nell'affinamento, su 32 GB).

SHELL := /bin/bash
.ONESHELL:
.DEFAULT_GOAL := avvia

RADICE    := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
SIM       := $(RADICE)/simulatore
ALL       := $(RADICE)/allenamento
NOME      ?= runpod
IMPOSTA   ?=
PY        ?= $(shell command -v python3 || command -v python)
CARGO     ?= $(or $(shell command -v cargo),$(HOME)/.cargo/bin/cargo)
CORSA     := $(ALL)/corse/$(NOME)

.PHONY: avvia setup rust deps compila cuda verifica addestra log stato ferma diario valuta pacchetto pannello

avvia: setup verifica addestra
	@echo
	@echo "Addestramento avviato in background. Per seguirlo:  make log   ·  make stato   ·  make ferma"

# --- preparazione ---------------------------------------------------------------------
setup: rust deps compila cuda

rust:
	@if [ ! -x "$(CARGO)" ]; then
	  echo "== installo Rust (rustup, profilo minimo)"
	  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
	fi
	@if ! command -v cc >/dev/null 2>&1; then
	  echo "== installo il compilatore C (serve al linker di Rust)"
	  apt-get update -qq && apt-get install -y -qq build-essential
	fi
	@$(CARGO) --version

deps:
	@echo "== dipendenze Python"
	@$(PY) -c "import torch" 2>/dev/null || { echo "PyTorch non trovato: usa un'immagine RunPod con PyTorch (runpod/pytorch) oppure installalo"; exit 1; }
	@$(PY) -c "import numpy" 2>/dev/null || $(PY) -m pip install -q numpy
	@$(PY) -c "import torch, numpy; print('torch', torch.__version__, '· numpy', numpy.__version__)"

compila:
	@echo "== compilo il simulatore"
	@cd $(SIM) && $(CARGO) build --release 2>&1 | tail -1

cuda:
	@$(PY) $(RADICE)/runpod/strumenti.py cuda

# --- verifica -------------------------------------------------------------------------
verifica:
	@echo "== test del simulatore"
	@cd $(SIM) && $(CARGO) test --release 2>&1 | grep -E "test result|FAILED|panicked" | head -1
	@echo "== prova di fumo dell'addestramento (2 iterazioni a scala ridotta)"
	@cd $(ALL) && rm -rf corse/_fumo && $(PY) allena.py --nome _fumo --piccola --iterazioni 2 2>&1 | grep -E "^rete|^it |Traceback|Error" ; rm -rf corse/_fumo

# --- addestramento --------------------------------------------------------------------
addestra:
	@mkdir -p $(CORSA)
	@if $(PY) $(RADICE)/runpod/strumenti.py pid $(CORSA) regolatore.json >/dev/null || $(PY) $(RADICE)/runpod/strumenti.py pid $(CORSA) >/dev/null; then
	  echo "la corsa «$(NOME)» è già in esecuzione (make log per seguirla, make ferma per fermarla)"; exit 0
	fi
	@echo "== avvio della corsa «$(NOME)»: lobby scelte dalla GPU e riscalate da sole finché non è sfruttata (scala.log)"
	@cd $(ALL) && setsid nohup $(PY) -u $(RADICE)/runpod/strumenti.py regola $(CORSA) $(RADICE) $(NOME) \
	    $(IMPOSTA) >> $(CORSA)/regolatore.log 2>&1 < /dev/null &
	@sleep 3 && cat $(CORSA)/scala.log | tail -n 2

log:
	@tail -n 40 -f $(CORSA)/uscita.log

stato:
	@$(PY) $(RADICE)/runpod/strumenti.py stato $(CORSA)

ferma:
	@R=$$($(PY) $(RADICE)/runpod/strumenti.py pid $(CORSA) regolatore.json) && kill -TERM $$R && rm -f $(CORSA)/regolatore.json || true
	@P=$$($(PY) $(RADICE)/runpod/strumenti.py pid $(CORSA)) && kill -TERM $$P && echo "fermata richiesta: finisce l'iterazione, salva ed esce (make log per vedere)" || echo "nessuna corsa «$(NOME)» in esecuzione"

diario:
	@cat $(CORSA)/diario.txt 2>/dev/null || echo "nessun diario ancora: $(CORSA)/diario.txt"

valuta:
	@cd $(ALL) && $(PY) valuta.py corse/$(NOME) --mondi 64 --partite 24

pacchetto:
	@cd $(ALL)/corse && tar czf $(RADICE)/$(NOME).tar.gz $(NOME)/migliore.pt $(NOME)/config.json $(NOME)/registro.csv $(NOME)/valutazione.csv $(NOME)/eventi.log $(NOME)/diario.txt 2>/dev/null \
	  && echo "scritto $(RADICE)/$(NOME).tar.gz" || echo "manca ancora migliore.pt (arriva dopo le prime partite del banco di prova)"

pannello:
	@cd $(ALL) && PANNELLO_HOST=0.0.0.0 PANNELLO_SENZA_BROWSER=1 $(PY) pannello.py 8080
