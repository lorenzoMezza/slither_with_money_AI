"""Partite dal vivo dell'agente, nel browser, mentre l'addestramento continua.

    .venv/bin/python guarda.py corse/prima                    # 3 finestre: porte 8081, 8082, 8083
    .venv/bin/python guarda.py corse/prima --finestre 1 --allievo migliore
    .venv/bin/python guarda.py corse/prima/lega/allievo_100.pt

Di solito lo avvia il pannello (`pannello.py`, pulsante «Osserva»). E' un processo a
parte: legge i pesi che l'addestramento salva e gioca partite sue, quindi si apre e
si chiude senza toccare la corsa. A ogni nuova partita ricarica il modello, se nel
frattempo l'addestramento ne ha salvato uno piu' recente. Gira sulla CPU per non
rubare la GPU all'addestramento.

Le finestre mostrano tre situazioni diverse:
  1. contro i bot       l'agente con 3 bot di stili e abilita' varie
  2. contro se stesso   l'agente, 4 sue copie e un bot forte
  3. come in allenamento  l'agente, 1–4 copie (lui stesso o istantanee recenti) e un bot forte
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "simulatore" / "python"))
sys.path.insert(0, str(HERE))

from slither_sim import INFO_NAMES, SlitherVecEnv  # noqa: E402

from ia.carica import RunSource, SlotPlayers, load_policy  # noqa: E402
from ia.lega import STYLES  # noqa: E402
from ia.rete import Layout  # noqa: E402

I = {n: i for i, n in enumerate(INFO_NAMES)}
SCENARI = ("contro i bot", "contro se stesso", "come in allenamento")
P = 5


def short(label: str) -> str:
    return label.split("/")[-1]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("agente", help="cartella della corsa o file .pt")
    ap.add_argument("--allievo", help="«migliore» (migliore.pt) oppure «attuale» (lo stato della corsa)")
    ap.add_argument("--finestre", type=int, default=3)
    ap.add_argument("--porta", type=int, default=8081, help="la prima finestra; le altre seguono")
    ap.add_argument("--velocita", type=float, default=1.0, help="1 = tempo reale")
    ap.add_argument("--durata", type=float, default=300.0)
    args = ap.parse_args()

    torch.set_num_threads(2)
    dev = torch.device("cpu")
    W = max(1, min(6, args.finestre))
    rng = random.Random()
    env = SlitherVecEnv(num_envs=W, agents_per_env=P, seed=rng.randrange(1 << 30), randomize=True, match_mode=True)
    lay = Layout.from_sim(env.layout())
    src = RunSource(args.agente, lay, dev, args.allievo)
    model, label, _ = src.get()
    lega_dir = Path(args.agente) / "lega" if Path(args.agente).is_dir() else None
    frozen_cache: dict[str, object] = {}
    players = SlotPlayers(W * P, model.memory, dev)

    for w in range(W):
        env.viewer(w, args.porta + w, realtime=None)
    env.realtime(args.velocita)
    print("PRONTO " + " ".join(f"{args.porta + w}:{SCENARI[w % 3]}" for w in range(W)), flush=True)

    def frozen():
        files = sorted(lega_dir.glob("*.pt"))[-40:] if lega_dir and lega_dir.exists() else []
        if not files:
            return None, None
        f = rng.choice(files)
        if str(f) not in frozen_cache:
            frozen_cache[str(f)] = load_policy(f, lay, dev)[0]
        return frozen_cache[str(f)], f.stem

    def new_match(w: int):
        nonlocal model, label
        model, label, fresh = src.get()
        if fresh:
            print(f"modello aggiornato: {label}", flush=True)
        kind = SCENARI[w % 3]
        tag = short(label)
        names, ctrl, bots = [f"IA {tag}"], [model], []
        if kind == "contro i bot":
            bots = [{"style": rng.choice(STYLES), "skill": round(rng.uniform(0.6, 1.0), 2)} for _ in range(3)]
        elif kind == "contro se stesso":
            names += [f"IA copia {k}" for k in range(1, P)]
            ctrl += [model] * (P - 1)
            bots = [{"style": rng.choice(STYLES), "skill": round(rng.uniform(0.85, 1.0), 2)}]
        else:
            for _ in range(rng.randint(1, P - 1)):
                m, stem = frozen() if rng.random() < 0.5 else (None, None)
                if m is None:
                    m, stem = model, "copia"
                names.append(f"lega {short(stem)}")
                ctrl.append(m)
            bots = [{"style": rng.choice(STYLES), "skill": round(rng.uniform(0.85, 1.0), 2)}]
        spec = {"agents": [{"name": n} for n in names], "bots": bots, "max_s": args.durata, "end_when_alone_s": 15.0}
        players.assign(range(w * P, (w + 1) * P), None)
        for k, m in enumerate(ctrl):
            players.assign([w * P + k], m)
        return spec

    env.reset_matches({w: new_match(w) for w in range(W)})
    actions = np.zeros((env.n, 3), np.float32)
    played = 0
    try:
        while True:
            actions[:] = 0
            players.act(env.obs_view(), actions)
            _, _, _, info = env.step_into(actions)
            ended = [w for w in range(W) if info[w * P, I["fine_partita"]] > 0]
            if not ended:
                continue
            specs = {}
            for w in ended:
                played += 1
                rows = sorted(env.match_report(w), key=lambda r: -r["profitto"])
                parts = []
                for r in rows:
                    who = r["nome"] if r.get("posto") is not None else f"bot {r['stile']}"
                    esito = ("fine partita" if r.get("forzato") else "incassa") if r["incassato"] else ("muore" if r["morto"] else "in campo")
                    parts.append(f"{who} {esito} {r['profitto']:+.2f}")
                print(f"partita {played} [{SCENARI[w % 3]}]: " + " · ".join(parts), flush=True)
                specs[w] = new_match(w)
            env.reset_matches(specs)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
