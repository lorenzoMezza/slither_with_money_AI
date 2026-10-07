"""La finale: mette alla pari i modelli candidati e salva i migliori, in ordine di forza.

Ogni candidato gioca le STESSE partite (PIANO_ADDESTRAMENTO.md, tappa 4):
  banco   `--per-stile` partite per stile (11 stili) da solo contro 2 bot al massimo livello
  torneo  `--giri` sorteggi in gironi da 4 candidati + 1 bot misto, 16 partite per girone
Punteggio = ½ punti medi contro i bot + ½ punti medi nel torneo (punti della fase 2 con la
ricompensa ufficiale, cibo 0,02), nelle condizioni dell'addestramento (oro 11,5, bottino 30–60 s).

    python3 finale.py --corsa corse/affinamento --da 500 \\
        --extra corse/runpod/lega/allievo_7160.pt corse/runpod/migliore.pt \\
        --uscita /workspace/finalissimallanemento

Candidati: con `--corsa` tutte le istantanee `lega/allievo_*.pt` e `lega/mutante_*.pt` della
corsa con iterazione ≥ `--da`, piu' `stato.pt` (l'ultimo allievo) e `migliore.pt`; con
`--extra` qualunque altro checkpoint (`nome=percorso` per dargli un nome). Escono
`model_1.pt` (il piu' forte) … `model_N.pt`, `CLASSIFICA.txt`, `classifica_completa.json`.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "simulatore" / "python"))
sys.path.insert(0, str(HERE))
from slither_sim import INFO_NAMES, SlitherVecEnv  # noqa: E402
from ia.carica import SlotPlayers, load_policy  # noqa: E402
from ia.config import EnvCfg, RewardCfg  # noqa: E402
from ia.lega import STYLES  # noqa: E402
from ia.punti import punti_resoconto  # noqa: E402
from ia.rete import Layout  # noqa: E402

I = {n: i for i, n in enumerate(INFO_NAMES)}
P = 4


def _path(p: str) -> Path:
    q = Path(p)
    return q if q.is_absolute() else (Path.cwd() / q if (Path.cwd() / q).exists() else HERE / q)


def candidati(args) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for corsa in args.corsa:
        d = _path(corsa)
        tag = d.name
        for f in sorted((d / "lega").glob("*.pt")):
            m = re.fullmatch(r"(allievo|mutante)_(\d+)(?:_\d+)?", f.stem)
            if m and int(m.group(2)) >= args.da:
                out[f"{tag}@{m.group(2)}" if m.group(1) == "allievo" else f"{tag} mutante@{m.group(2)}"] = f
        if (d / "stato.pt").exists():
            it = torch.load(d / "stato.pt", map_location="cpu", weights_only=False).get("iter", "?")
            out[f"{tag}@{it} (ultimo)"] = d / "stato.pt"
        if (d / "migliore.pt").exists():
            it = torch.load(d / "migliore.pt", map_location="cpu", weights_only=False).get("iter", "?")
            out[f"{tag} migliore@{it}"] = d / "migliore.pt"
    for e in args.extra:
        nome, _, p = e.rpartition("=") if "=" in e else ("", "", e)
        f = _path(p)
        out[nome or f"{f.parent.parent.name if f.parent.name == 'lega' else f.parent.name}/{f.stem}"] = f
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corsa", nargs="*", default=[], help="cartelle di corsa da cui prendere i candidati")
    ap.add_argument("--da", type=int, default=0, help="solo istantanee con iterazione ≥ questa")
    ap.add_argument("--extra", nargs="*", default=[], help="altri checkpoint (nome=percorso o percorso)")
    ap.add_argument("--uscita", default="finale", help="cartella dove salvare model_N.pt e la classifica")
    ap.add_argument("--primi", type=int, default=10)
    ap.add_argument("--per-stile", type=int, default=2, help="partite contro i bot per stile")
    ap.add_argument("--giri", type=int, default=3, help="sorteggi dei gironi del torneo")
    ap.add_argument("--mondi", type=int, default=128)
    ap.add_argument("--seme", type=int, default=2026)
    args = ap.parse_args()

    cand = candidati(args)
    if len(cand) < 2:
        sys.exit("servono almeno 2 candidati")
    rng = random.Random(args.seme)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    ec = EnvCfg()
    E = args.mondi
    env = SlitherVecEnv(num_envs=E, agents_per_env=P, seed=args.seme, randomize=True, match_mode=True,
                        params={"gold_gain": ec.crescita_oro})
    lay = Layout.from_sim(env.layout())
    models, labels = {}, {}
    for name, path in cand.items():
        m, label = load_policy(path, lay, dev)
        models[name], labels[name] = m, label
        print(f"{name}: {label} (fase {m.fase})", flush=True)
    names = list(models)
    players = SlotPlayers(env.n, next(iter(models.values())).memory, dev)
    rc = RewardCfg()

    def bot(style, rich=0.0):
        b = {"style": style, "skill": 1.0}
        if rng.random() < rich:
            b.update(start_size=round(rng.uniform(150, 900), 1), start_balance=round(rng.uniform(1.3, 4.0), 3))
        return b

    jobs = []
    for m in names:
        for s in STYLES:
            for _ in range(args.per_stile):
                jobs.append(("banco", [m], {"agents": [{}], "bots": [bot(s, 0.3), bot(s, 0.3)], "max_s": 200.0, "end_when_alone_s": 12.0}))
    for _ in range(args.giri):
        order = names[:]
        rng.shuffle(order)
        for k in range(0, len(order), 4):
            group = order[k:k + 4]
            if len(group) < 2:
                continue
            for _ in range(16):
                seat = group[:]
                rng.shuffle(seat)
                jobs.append(("torneo", seat, {"agents": [{} for _ in seat], "bots": [bot("misto")],
                                              "max_s": rng.uniform(80, 240), "end_when_alone_s": 12.0}))
    rng.shuffle(jobs)
    total = len(jobs)
    print(f"{len(names)} candidati, {total} partite", flush=True)

    res = defaultdict(lambda: defaultdict(list))
    running = {}

    def start(e):
        kind, ctrl, spec = jobs.pop()
        players.assign(range(e * P, (e + 1) * P), None)
        for k, m in enumerate(ctrl):
            players.assign([e * P + k], models[m])
        running[e] = (kind, ctrl)
        return spec

    env.reset_matches({e: start(e) for e in range(min(E, len(jobs)))})
    actions = np.zeros((env.n, 3), np.float32)
    t0, last = time.time(), 0
    while running:
        actions[:] = 0
        players.act(env.obs_view(), actions)
        _, _, _, info = env.step_into(actions)
        ended = [e for e in running if info[e * P, I["fine_partita"]] > 0]
        if not ended:
            continue
        specs = {}
        for e in ended:
            kind, ctrl = running.pop(e)
            for r in env.match_report(e):
                k = r.get("posto")
                if k is None or k >= len(ctrl):
                    continue
                res[ctrl[k]][kind].append({"punti": punti_resoconto(r, rc, 2), "profitto": r["profitto"], "morte": bool(r["morto"]),
                                           "cashout": bool(r["incassato"] and not r.get("forzato")), "uccisioni": r["uccisioni"],
                                           "cibo": r.get("cibo", 0)})
            if jobs:
                specs[e] = start(e)
        if specs:
            env.reset_matches(specs)
        done_n = total - len(jobs) - len(running)
        if done_n - last >= 20 or not running:
            last = done_n
            print(f"{done_n}/{total} partite ({time.time() - t0:.0f} s)", flush=True)

    rows = []
    for m in names:
        d = {"nome": m, "origine": str(cand[m]), "etichetta": labels[m]}
        for kind in ("banco", "torneo"):
            rs = res[m][kind]
            d[kind] = {k: float(np.mean([r[k] for r in rs])) if rs else float("nan")
                       for k in ("punti", "profitto", "morte", "cashout", "uccisioni", "cibo")}
            d[kind]["partite"] = len(rs)
        d["punteggio"] = 0.5 * d["banco"]["punti"] + 0.5 * d["torneo"]["punti"]
        rows.append(d)
    rows.sort(key=lambda d: -d["punteggio"])

    out_dir = _path(args.uscita) if Path(args.uscita).is_absolute() else Path.cwd() / args.uscita
    out_dir.mkdir(parents=True, exist_ok=True)
    lines = ["Classifica finale (punteggio = ½ punti medi contro i bot + ½ punti medi nel torneo fra candidati)", ""]
    lines.append(f"{'pos':>3s}  {'modello':28s} {'punteggio':>9s} | {'bot: punti':>10s} {'morte':>6s} {'cash':>5s} {'ucc':>5s} {'prof':>6s} | "
                 f"{'torneo: punti':>13s} {'morte':>6s} {'cash':>5s} {'ucc':>5s} {'prof':>6s}")
    for i, d in enumerate(rows, 1):
        b, t = d["banco"], d["torneo"]
        lines.append(f"{i:3d}  {d['nome']:28s} {d['punteggio']:9.3f} | {b['punti']:10.2f} {b['morte']:6.0%} {b['cashout']:5.0%} {b['uccisioni']:5.2f} {b['profitto']:+6.2f} | "
                     f"{t['punti']:13.2f} {t['morte']:6.0%} {t['cashout']:5.0%} {t['uccisioni']:5.2f} {t['profitto']:+6.2f}")
    print("\n".join(lines), flush=True)

    for i, d in enumerate(rows[:args.primi], 1):
        st = torch.load(d["origine"], map_location="cpu", weights_only=False)
        if "learner" in st:
            sd, it, fase = st["learner"]["model"], st["iter"], st.get("fase", 2)
        else:
            sd, it, fase = st["model"], st.get("iter"), st.get("fase", 2)
        out = {"model": sd, "allievo": f"model_{i}", "iter": it, "fase": fase, "layout": lay.to_dict(),
               "classifica": i, "nome": d["nome"], "origine": d["origine"], "punteggio": d["punteggio"],
               "banco": d["banco"], "torneo": d["torneo"]}
        if isinstance(st, dict) and "net" in st:
            out["net"] = st["net"]
        torch.save(out, out_dir / f"model_{i}.pt")
    (out_dir / "CLASSIFICA.txt").write_text("\n".join(lines) + f"\n\nmodel_N.pt = posizione N (salvati i primi {args.primi}).\n")
    json.dump(rows, open(out_dir / "classifica_completa.json", "w"), indent=1)
    print(f"salvati i {args.primi} migliori in {out_dir}", flush=True)


if __name__ == "__main__":
    main()
