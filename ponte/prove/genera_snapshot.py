"""Snapshot nel formato del server (generati dal simulatore) per il gioco finto.
    genera_snapshot.py uscita.ndjson [n]   → prima riga {"id": …}, poi un `state` per riga."""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "simulatore" / "python"))
from slither_sim import SlitherVecEnv  # noqa: E402

n = int(sys.argv[2]) if len(sys.argv) > 2 else 400
env = SlitherVecEnv(num_envs=1, agents_per_env=1, seed=11)
env.reset()
s = env.snapshot(0, 0)
mio = next(p["id"] for p in s["players"] if p["alive"])
act = np.zeros((1, 3), np.float32)
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"id": mio}) + "\n")
    for i in range(n):
        s = env.snapshot(0, 0)
        if not any(p["id"] == mio and p["alive"] for p in s["players"]):
            break
        f.write(json.dumps(s) + "\n")
        act[0] = [0.02 * np.sin(i / 20), 0, 0]
        for _ in range(2):
            env.step(act)
