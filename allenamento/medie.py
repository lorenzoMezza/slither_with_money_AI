"""Le medie della corsa a blocchi di iterazioni (pesate per episodi), per seguirla a colpo d'occhio.

    python3 medie.py corse/affinamento            # blocchi da 100 iterazioni
    python3 medie.py corse/runpod 50 --da 3000    # blocchi da 50, dall'iterazione 3000

Colonne: punti, uccisioni, morte, cashout (fase 2), boost, taglia, cibo, e le situazioni
(attesa, svantaggio, duello) pesate per i loro episodi; in fondo la fitness del banco e il
banco per scenario all'ultima valutazione.
"""
from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

COLS = [("punti", "ep_punti"), ("ucc", "ep_uccisioni"), ("morte", "ep_morte"), ("cash", "ep_incasso"),
        ("pulita", "ep_uscita_pulita"), ("vuota", "ep_uscita_vuota"), ("pen", "ep_uscita_penale"), ("prof", "ep_profitto"),
        ("boost", "ep_boost"), ("taglia", "ep_taglia"), ("cibo", "ep_cibo"),
        ("cibo_att", "ep_cibo_attesa"), ("m_att", "ep_morte_attesa"), ("m_sva", "ep_morte_svantaggio"),
        ("cibo_du", "ep_cibo_duello"), ("bst_du", "ep_boost_duello"), ("m_du", "ep_morte_duello")]


def f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("corsa")
    ap.add_argument("blocco", type=int, nargs="?", default=100)
    ap.add_argument("--da", type=int, default=0)
    args = ap.parse_args()
    d = Path(args.corsa)
    rows = [r for r in csv.DictReader(open(d / "registro.csv")) if int(r["iter"]) >= args.da]
    cols = [(n, c) for n, c in COLS if rows and c in rows[0]]
    print("iterazioni  " + " ".join(f"{n:>8s}" for n, _ in cols))
    for i in range(0, len(rows), args.blocco):
        blk = rows[i:i + args.blocco]
        out = []
        for _, c in cols:
            sit = next((s for s in ("attesa", "svantaggio", "duello") if c.endswith(s)), None)
            wk = f"ep_n_{sit}" if sit else "ep_episodi"
            num = den = 0.0
            for r in blk:
                v, w = f(r.get(c)), f(r.get(wk))
                if v is None or not w:
                    continue
                num += v * w
                den += w
            out.append(f"{num / den:8.3f}" if den else "       -")
        print(f"{blk[0]['iter']:>5s}-{blk[-1]['iter']:<5s} " + " ".join(out))
    val = d / "valutazione.csv"
    if val.exists():
        v = list(csv.DictReader(open(val)))
        if v:
            print("fitness", [(r["iter"], round(float(r["fitness"]), 2)) for r in v[-120::20] if f(r.get("fitness")) is not None])
            r = v[-1]
            print("banco: " + ", ".join(f"{k[:-10]} {float(r[k]):.2f}" for k in r if k.endswith("_punteggio") and f(r[k]) is not None))


if __name__ == "__main__":
    main()
