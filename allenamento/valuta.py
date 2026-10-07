"""Banco di prova autonomo: quanto guadagna un agente contro ogni tipo di avversario.

    .venv/bin/python valuta.py corse/prova                    # il migliore della corsa
    .venv/bin/python valuta.py corse/prova/stato.pt                # lo stato attuale invece del migliore
    .venv/bin/python valuta.py corse/prova --avversario corse/vecchia --partite 40

Per ogni scenario: i punti medi delle due fasi (la ricompensa di PIANO_ADDESTRAMENTO.md), le
uccisioni, il profitto medio per partita (in poste), quante volte muore, incassa per
scelta, viene fatto incassare allo scadere del tempo, raddoppia la posta.
"""
from __future__ import annotations

import argparse
import random
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "simulatore" / "python"))
sys.path.insert(0, str(HERE))

from slither_sim import INFO_NAMES, SlitherVecEnv  # noqa: E402

from ia.carica import Driver, load_policy  # noqa: E402
from ia.config import RewardCfg  # noqa: E402
from ia.lega import STYLES  # noqa: E402
from ia.punti import punti_resoconto  # noqa: E402
from ia.rete import Layout  # noqa: E402

I = {n: i for i, n in enumerate(INFO_NAMES)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("agente")
    ap.add_argument("--allievo")
    ap.add_argument("--avversario", help="un altro agente da mettere in lobby (1–3 copie)")
    ap.add_argument("--partite", type=int, default=24, help="partite per scenario")
    ap.add_argument("--mondi", type=int, default=48)
    ap.add_argument("--abilita", type=float, default=1.0, help="abilita' dei bot")
    ap.add_argument("--durata", type=float, default=240.0)
    ap.add_argument("--seme", type=int, default=7)
    args = ap.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
    P = 4
    env = SlitherVecEnv(num_envs=args.mondi, agents_per_env=P, seed=args.seme, randomize=True, match_mode=True)
    lay = Layout.from_sim(env.layout())
    me, label = load_policy(args.agente, lay, dev, args.allievo)
    opp = load_policy(args.avversario, lay, dev)[0] if args.avversario else None
    rng = random.Random(args.seme)

    scenarios = [f"bot:{s}" for s in STYLES] + ["bot:assortiti"]
    if opp is not None:
        scenarios.append("neurale")
    todo = [sc for sc in scenarios for _ in range(args.partite)]
    rng.shuffle(todo)

    def spec_for(sc):
        agents, bots = [{}], []
        if sc == "neurale":
            agents += [{} for _ in range(rng.randint(1, 3))]
            bots = [{"style": "misto", "skill": args.abilita}]
        elif sc == "bot:assortiti":
            bots = [{"style": rng.choice(STYLES), "skill": args.abilita} for _ in range(3)]
        else:
            bots = [{"style": sc[4:], "skill": args.abilita} for _ in range(3)]
        return {"agents": agents, "bots": bots, "max_s": args.durata, "end_when_alone_s": 12.0}

    focal = Driver(me, [e * P for e in range(args.mondi)], dev)
    others = Driver(opp, [e * P + k for e in range(args.mondi) for k in range(1, P)], dev) if opp else None
    running: dict[int, str] = {}
    specs = {}
    for e in range(args.mondi):
        if todo:
            running[e] = todo.pop()
            specs[e] = spec_for(running[e])
    env.reset_matches(specs)
    results = defaultdict(list)
    total = len(scenarios) * args.partite
    actions = np.zeros((env.n, 3), np.float32)
    while running:
        actions[:] = 0
        obs = env.obs_view()
        focal.act(obs, actions)
        if others:
            others.act(obs, actions)
        _, _, done, info = env.step_into(actions)
        ended = [e for e in running if done[e * P] or info[e * P, I["fine_partita"]] > 0]
        if not ended:
            continue
        specs = {}
        for e in ended:
            row = next(r for r in env.match_report(e) if r.get("posto") == 0)
            results[running.pop(e)].append(row)
            if todo:
                running[e] = todo.pop()
                specs[e] = spec_for(running[e])
        env.reset_matches(specs)
        fmask = np.zeros(args.mondi, bool)
        fmask[list(specs)] = True
        focal.reset(fmask)
        if others:
            others.reset(np.repeat(fmask, P - 1))
        n = sum(len(v) for v in results.values())
        print(f"\r{n}/{total} partite", end="", flush=True)

    print(f"\n\n{label} — bot ad abilita' {args.abilita}\n")
    rc = RewardCfg()
    print(f"{'scenario':18s} {'partite':>7s} {'punti F1':>9s} {'punti F2':>9s} {'uccis.':>7s} {'profitto':>9s} {'morte':>7s} "
          f"{'incasso':>8s} {'scaduto':>8s} {'×2':>6s}")
    allf = {1: [], 2: []}
    for sc in scenarios:
        rows = results[sc]
        if not rows:
            continue
        p = np.array([r["profitto"] for r in rows])
        pf = {f: np.mean([punti_resoconto(r, rc, f) for r in rows]) for f in (1, 2)}
        for f in (1, 2):
            allf[f].append(pf[f])
        forced = np.array([bool(r.get("forzato")) for r in rows])
        print(f"{sc:18s} {len(rows):7d} {pf[1]:9.2f} {pf[2]:9.2f} {np.mean([r['uccisioni'] for r in rows]):7.2f} {p.mean():+9.3f} "
              f"{np.mean([r['morto'] for r in rows]):7.0%} {np.mean([r['incassato'] and not f for r, f in zip(rows, forced)]):8.0%} "
              f"{forced.mean():8.0%} {np.mean(p >= 1.0):6.0%}")
    for f in (1, 2):
        v = allf[f]
        print(f"punti fase {f}: media {np.mean(v):.2f}   peggiore {min(v):.2f}   fitness {0.5 * np.mean(v) + 0.5 * min(v):.2f}")


if __name__ == "__main__":
    main()
