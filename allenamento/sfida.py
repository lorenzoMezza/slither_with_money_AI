"""Gioca tu contro l'agente, nel browser, mentre l'addestramento continua.

    .venv/bin/python sfida.py corse/prima                         # contro l'agente attuale
    .venv/bin/python sfida.py corse/prima --allievo migliore --avversari 2 --bot 1
    .venv/bin/python sfida.py corse/prima/lega/allievo_100.pt

Apri http://127.0.0.1:8084 e clicca nel gioco: mouse = direzione, clic o spazio =
boost, C tenuto = cashout. Quando la partita finisce ne parte un'altra. Di solito
lo avvia il pannello (pulsante «Gioca contro l'IA»).
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

from ia.carica import RunSource, SlotPlayers  # noqa: E402
from ia.lega import STYLES  # noqa: E402
from ia.rete import Layout  # noqa: E402

I = {n: i for i, n in enumerate(INFO_NAMES)}
P = 5


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("agente", help="cartella della corsa o file .pt")
    ap.add_argument("--allievo", help="«migliore» (migliore.pt) oppure «attuale» (lo stato della corsa)")
    ap.add_argument("--avversari", type=int, default=1, help="agenti IA in partita (1–4)")
    ap.add_argument("--bot", type=int, default=0, help="bot scriptati in partita (0–3)")
    ap.add_argument("--abilita", type=float, default=0.8, help="abilita' dei bot")
    ap.add_argument("--porta", type=int, default=8084)
    ap.add_argument("--durata", type=float, default=900.0)
    args = ap.parse_args()

    torch.set_num_threads(2)
    dev = torch.device("cpu")
    rng = random.Random()
    env = SlitherVecEnv(num_envs=1, agents_per_env=P, seed=rng.randrange(1 << 30), randomize=True, match_mode=True)
    lay = Layout.from_sim(env.layout())
    src = RunSource(args.agente, lay, dev, args.allievo)
    model, label, _ = src.get()
    players = SlotPlayers(P, model.memory, dev)
    n_ai = max(1, min(P - 1, args.avversari))
    env.set_human(0, 0)
    url = env.viewer(0, args.porta, realtime=1.0)
    print(f"PRONTO {args.porta} — {label}: apri {url} e clicca nel gioco", flush=True)

    match = 0
    wins = 0
    actions = np.zeros((P, 3), np.float32)
    try:
        while True:
            match += 1
            model, label, fresh = src.get()
            if fresh and match > 1:
                print(f"modello aggiornato: {label}", flush=True)
            names = ["tu"] + [f"IA {k}" for k in range(1, n_ai + 1)]
            bots = [{"style": rng.choice(STYLES), "skill": args.abilita} for _ in range(max(0, min(3, args.bot)))]
            env.reset_matches({0: {"agents": [{"name": n} for n in names], "bots": bots,
                                   "max_s": args.durata, "end_when_alone_s": 30.0}})
            players.assign(range(P), None)
            players.assign(range(1, 1 + n_ai), model)
            print(f"partita {match}: tu contro {n_ai} IA ({label})" + (f" e {len(bots)} bot" if bots else ""), flush=True)
            after = None                     # passi da quando sei uscito tu
            while True:
                actions[:] = 0
                players.act(env.obs_view(), actions)
                _, _, done, info = env.step_into(actions)
                if done[0] and after is None:
                    after = 0
                if after is not None:
                    after += 1
                # Finita per tutti, o 5 s dopo che sei uscito: chi e' ancora in campo
                # vale come se incassasse in quel momento.
                if info[0, I["fine_partita"]] > 0 or (after or 0) > 125:
                    break
            rows = sorted(env.match_report(0), key=lambda r: -r["profitto"])
            me = next(r for r in rows if r.get("posto") == 0)
            best_ai = max((r["profitto"] for r in rows if r.get("posto") not in (None, 0)), default=-9)
            wins += me["profitto"] > best_ai
            for r in rows:
                who = r["nome"] if r.get("posto") is not None else f"bot {r['stile']}"
                esito = ("fine partita" if r.get("forzato") else "incassa") if r["incassato"] else ("muore" if r["morto"] else "in campo")
                print(f"   {who:10s} {esito:8s} profitto {r['profitto']:+.2f}  taglia {r['taglia']:.0f}  uccisioni {r['uccisioni']}", flush=True)
            print(f"   → {'hai vinto tu' if me['profitto'] > best_ai else 'ha vinto l IA'}  (tu {wins} su {match})", flush=True)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
