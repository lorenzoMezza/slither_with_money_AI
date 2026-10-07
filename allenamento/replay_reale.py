"""Verifica OFFLINE dell'agente sulle partite vere registrate con `analizer`.

    .venv/bin/python replay_reale.py corse/prima                       # il migliore della corsa
    .venv/bin/python replay_reale.py corse/prima/stato.pt
    .venv/bin/python replay_reale.py corse/prima --sessioni ../analizer/sessioni --max_sessioni 3

Nessuna connessione al gioco: si rileggono gli snapshot gia' registrati e si mette
l'agente nei panni di ogni giocatore che c'era in lobby. Serve a rispondere a tre
domande prima di qualunque uso fuori dal simulatore:

  1. l'agente CAPISCE il traffico vero? (osservazioni costruite dallo stesso
     `Featurizer` del simulatore, dagli snapshot reali: quante sono valide, con che
     cadenza arrivano, quanto sono lontane dalla distribuzione dell'addestramento)
  2. cosa AVREBBE FATTO in quelle situazioni? (svolte, boost, cashout, e quanto
     coincidono con quello che la persona ha fatto davvero)
  3. VEDE il pericolo? (la testa ausiliaria «muoio entro 2 s» negli ultimi secondi
     delle partite finite con una morte, contro il resto del tempo)

Le sessioni restano dove sono (`analizer/sessioni/`): qui si leggono soltanto.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "simulatore" / "python"))
sys.path.insert(0, str(HERE))

from slither_sim import SlitherVecEnv  # noqa: E402

from ia.carica import load_policy  # noqa: E402
from ia.sessioni import SessionReader, find_sessions  # noqa: E402
from ia.rete import Layout  # noqa: E402


@torch.no_grad()
def replay_run(model, run, device, seq: int = 64):
    """L'agente passo per passo nei panni di quel giocatore: azioni greedy e teste."""
    T = len(run.turn)
    h = model.initial_state(1, device)
    turns, boosts, starts, aborts, pdeath, values = [], [], [], [], [], []
    for c in range(0, T, seq):
        o = torch.as_tensor(run.obs[c:c + seq], device=device)
        x = model.encode(o)
        hs = []
        for k in range(o.shape[0]):
            h = model.gru(x[k:k + 1], h)
            hs.append(h)
        out = model.heads(torch.cat(hs, 0), x)
        turns.append(out["turn_mu"].float().cpu().numpy())
        boosts.append((out["boost"] > 0).cpu().numpy())
        starts.append(torch.sigmoid(out["cash_start"]).cpu().numpy())
        aborts.append(torch.sigmoid(out["cash_abort"]).cpu().numpy())
        pdeath.append(torch.sigmoid(out["aux"][:, 0]).cpu().numpy())
        values.append(model.value_denorm(out["value"]).cpu().numpy())
    return (np.concatenate(turns), np.concatenate(boosts), np.concatenate(starts), np.concatenate(aborts),
            np.concatenate(pdeath), np.concatenate(values))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("agente")
    ap.add_argument("--allievo")
    ap.add_argument("--sessioni", default=str(HERE.parent / "analizer" / "sessioni"))
    ap.add_argument("--max_sessioni", type=int, default=0)
    ap.add_argument("--dispositivo", default="cpu")
    args = ap.parse_args()

    sessions = find_sessions(Path(args.sessioni))
    if args.max_sessioni > 0:
        sessions = sessions[:args.max_sessioni]
    if not sessions:
        sys.exit(f"nessuna sessione registrata in {args.sessioni}")
    dev = torch.device(args.dispositivo)
    env = SlitherVecEnv(num_envs=1, agents_per_env=1, seed=1)
    lay = Layout.from_sim(env.layout())
    env.close()
    model, label = load_policy(args.agente, lay, dev, args.allievo)
    reader = SessionReader(min_steps=24)

    tot = {"partite": 0, "passi": 0, "validi": 0, "svolta_uguale": 0, "verso_uguale": 0, "liberi": 0,
           "boost_ia": 0, "boost_umano": 0, "cash_start_ia": 0.0, "cash_start_umano": 0,
           "morti": 0, "pdeath_fine": [], "pdeath_resto": [], "valore": [], "dt": []}
    for s in sessions:
        for run in reader.runs(s):
            T = len(run.turn)
            turns, boosts, starts, aborts, pdeath, values = replay_run(model, run, dev)
            obs = run.obs.astype(np.float32)
            valid = obs[:, lay.self_off] > 0.5                    # x[0] = 1 se il giocatore era vivo nello snapshot
            free = ~run.charging
            tot["partite"] += 1
            tot["passi"] += T
            tot["validi"] += int(valid.sum())
            tot["liberi"] += int(free.sum())
            ang_ia, ang_umano = turns * np.abs(turns) * np.pi, run.turn * np.abs(run.turn) * np.pi
            tot["svolta_uguale"] += float((np.abs(ang_ia - ang_umano) * free).sum())            # errore sull'angolo, rad
            sign = (np.sign(np.round(ang_ia, 2)) == np.sign(np.round(ang_umano, 2)))
            tot["verso_uguale"] += int((sign & free).sum())
            tot["boost_ia"] += int((boosts & free).sum())
            tot["boost_umano"] += int((run.boost & free).sum())
            tot["cash_start_ia"] += float((starts * free).sum())
            tot["cash_start_umano"] += int((run.cash & free).sum())
            tot["dt"].extend((obs[valid, lay.self_off + 17] * 50.0).tolist())
            tot["valore"].extend(values[valid].tolist())
            died = not bool(run.charging[-1]) and T >= 50
            if died:
                tot["morti"] += 1
                tot["pdeath_fine"].extend(pdeath[-50:].tolist())
                tot["pdeath_resto"].extend(pdeath[:-50].tolist())
            else:
                tot["pdeath_resto"].extend(pdeath.tolist())
        print(f"  {s.name}: {tot['partite']} partite finora", flush=True)

    n, nf = max(tot["passi"], 1), max(tot["liberi"], 1)
    dt = np.array(tot["dt"]) if tot["dt"] else np.array([np.nan])
    print(f"\n{label} sulle partite vere ({len(sessions)} sessioni, {tot['partite']} giocatori-partita, {tot['passi'] / 24 / 60:.1f} min di gioco)\n")
    print(f"  osservazioni valide            {tot['validi'] / n:6.1%}   (snapshot in cui il giocatore era vivo e riconosciuto)")
    print(f"  cadenza degli snapshot         {np.nanmedian(dt):6.0f} ms mediana · p95 {np.nanpercentile(dt, 95):.0f} ms")
    print(f"  svolta: errore medio sull'angolo ±{tot['svolta_uguale'] / nf:.2f} rad · stesso verso della persona {tot['verso_uguale'] / nf:.1%}")
    print(f"  boost: IA {tot['boost_ia'] / nf:.1%} del tempo, persona {tot['boost_umano'] / nf:.1%}")
    print(f"  inizi di cashout: IA {tot['cash_start_ia']:.1f} attesi, persona {tot['cash_start_umano']}")
    if tot["pdeath_fine"]:
        print(f"  «muoio entro 2 s»: {np.mean(tot['pdeath_fine']):.2f} negli ultimi 2 s delle {tot['morti']} partite finite senza cashout, {np.mean(tot['pdeath_resto']):.2f} nel resto")
    if tot["valore"]:
        print(f"  valore stimato: media {np.mean(tot['valore']):+.2f} poste, p10 {np.percentile(tot['valore'], 10):+.2f}, p90 {np.percentile(tot['valore'], 90):+.2f}")
    print("\nNessuna connessione al gioco: e' una verifica a tavolino, sui dati gia' registrati.")


if __name__ == "__main__":
    main()
