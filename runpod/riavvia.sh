#!/bin/bash
# Fermata pulita della corsa $NOME, attesa dell'uscita, codice aggiornato (pull + simulatore
# ricompilato), ripresa (o avvio) con i parametri $IMPOSTA. Si lancia SEMPRE staccato:
#   NOME=corsa IMPOSTA="fase=1 env.mondi=448" setsid nohup runpod/riavvia.sh > /workspace/riavvia.log 2>&1 < /dev/null &
# Le tappe e i loro IMPOSTA sono in PIANO_ADDESTRAMENTO.md, §4.
set -u
cd "$(dirname "$0")/.."
NOME="${NOME:-runpod}"
IMPOSTA="${IMPOSTA:-}"
make ferma NOME="$NOME"
for i in $(seq 1 60); do
  pgrep -f "allena[.]py --nome $NOME " >/dev/null || break
  sleep 3
done
git pull -q || true
make compila
make addestra NOME="$NOME" IMPOSTA="$IMPOSTA"
