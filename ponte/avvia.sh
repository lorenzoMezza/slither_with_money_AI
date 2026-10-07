#!/bin/sh
# ponte/avvia.sh abc.pt [opzioni]  — lancia il ponte con il Python dell'addestramento.
QUI="$(cd "$(dirname "$0")" && pwd)"
PY="$QUI/../allenamento/.venv/bin/python"
[ -x "$PY" ] || PY="python3"
exec "$PY" "$QUI/ponte.py" "$@"
