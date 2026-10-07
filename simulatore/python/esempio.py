"""Esempio: una policy semplice su molti mondi, con le statistiche degli episodi.

    python esempio.py                 # 64 mondi a tutta velocita'
    python esempio.py --guarda        # un mondo nel browser, a tempo reale

La policy e' volutamente banale (va verso il settore con piu' cibo, scarta quando i
raggi davanti vedono un corpo, incassa quando ha guadagnato il 25 %): serve a vedere
l'interfaccia, non a giocare bene.
"""
import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from slither_sim import MOTIVI, SlitherVecEnv  # noqa: E402


def policy(obs: np.ndarray, layout: dict) -> np.ndarray:
    """Verso il settore di cibo piu' ricco, evitando cio' che i raggi vedono davanti."""
    n = obs.shape[0]
    act = np.zeros((n, 3), np.float32)
    # Cibo per settori: 16 settori attorno alla testa (il primo e' davanti), 2 numeri ciascuno
    # (densita', vicinanza del piu' vicino). L'angolo del settore k e' k/16 di giro.
    c0, secs, sn = layout["cibo"]["inizio"], layout["cibo"]["settori"], layout["cibo"]["n"]
    density = obs[:, c0:c0 + secs * sn].reshape(n, secs, sn)[:, :, 0]
    best = density.argmax(1)
    turn = (best / secs) * 2.0                                # in giri: 0 = dritto, 1 = dietro
    turn = np.where(turn > 1.0, turn - 2.0, turn)             # in [-1, 1], come vuole il simulatore
    # Raggi: 32 direzioni × (muro, corpo, testa piu' grande, testa piu' piccola), 1 = addosso.
    r0, rays, ch = layout["raggi"]["inizio"], layout["raggi"]["raggi"], layout["raggi"]["canali"]
    ray = obs[:, r0:r0 + rays * ch].reshape(n, rays, ch)
    front = np.maximum(ray[:, [0, 1, rays - 1], 0:2].max(2).max(1), 0.0)   # davanti e ai lati: muro o corpo
    danger = front > 0.75
    turn = np.where(danger, np.where(ray[:, rays // 4, 1] < ray[:, 3 * rays // 4, 1], 0.5, -0.5), turn)
    act[:, 0] = np.clip(turn, -1.0, 1.0)
    # Incassa quando il profitto supera il 25 % (x[8] = (saldo − posta) / posta).
    s0 = layout["se_stesso"]["inizio"]
    act[:, 2] = (obs[:, s0 + 8] > 0.25).astype(np.float32)
    return act


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mondi", type=int, default=64)
    ap.add_argument("--secondi", type=int, default=20)
    ap.add_argument("--guarda", action="store_true")
    args = ap.parse_args()
    env = SlitherVecEnv(num_envs=1 if args.guarda else args.mondi, seed=1, randomize=True)
    layout = env.layout()
    obs, info = env.reset()
    if args.guarda:
        print("apri", env.viewer(0, 8080))
    t0 = time.time()
    ep: dict[str, list] = {"morte": [], "cashout": [], "troncato": [], "cashout a fine partita": []}
    steps = 0
    while time.time() - t0 < args.secondi:
        obs, rew, done, info = env.step(policy(obs, layout))
        steps += 1
        for k in np.nonzero(done)[0]:
            ep[MOTIVI[int(info["motivo"][k])]].append(float(info["profitto_episodio"][k]))
    n = sum(len(v) for v in ep.values())
    print(f"{steps * env.n} passi agente in {time.time() - t0:.1f} s · {n} episodi")
    for k, v in ep.items():
        if v:
            print(f"  {k:24s} {len(v):4d}  profitto medio {np.mean(v):+.3f} poste")


if __name__ == "__main__":
    main()
