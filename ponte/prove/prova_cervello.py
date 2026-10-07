"""Prova offline del cervello: snapshot veri nel formato del server (generati dal
simulatore con `env.snapshot`) → osservazioni → decisioni. Controlla anche che la
decisione sia quella che darebbe il Driver dell'addestramento con le stesse osservazioni.

    allenamento/.venv/bin/python ponte/prove/prova_cervello.py tutte_le_versioni/migliore.pt
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cervello import Cervello  # noqa: E402

from slither_sim import SlitherVecEnv  # noqa: E402

modello = sys.argv[1] if len(sys.argv) > 1 else "tutte_le_versioni/migliore.pt"
c = Cervello(modello, "cpu", greedy=True)
c.riscalda()
print(f"modello {c.etichetta} · fase {c.fase} · dispositivo {c.dev}")

env = SlitherVecEnv(num_envs=1, agents_per_env=4, seed=7)
env.reset()
mio = env.snapshot(0, 0)
ids = [p["id"] for p in mio["players"]]
print("giocatori nello snapshot:", len(ids))
agent_id = ids[0]
act = np.zeros((4, 3), np.float32)
dec_ms, caricando = [], 0
for passo in range(240):
    snap = env.snapshot(0, 0)
    raw = json.dumps(snap)
    v = c.osserva(raw, snap_id := agent_id)
    if not v.vivo:
        print(f"passo {passo}: non piu' vivo / non trovato")
        break
    d = c.decidi()
    dec_ms.append(d.ms)
    caricando += int(d.cash)
    act[0] = [d.svolta_u, float(d.boost), float(d.cash)]
    env.step(act)
print(f"{len(dec_ms)} decisioni · {np.mean(dec_ms):.1f} ms in media · p95 {np.percentile(dec_ms, 95):.1f} ms · "
      f"ultimo targetDir {d.dir:+.3f} rad · cashout tenuto {caricando} passi")
assert all(np.isfinite(x) for x in (d.dir, d.svolta_u)), "decisione non finita"
print("OK")
