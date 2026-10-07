"""Diversita' della popolazione di checkpoint (richiesta dell'utente, 2026-10-06).

Il timore: che i campioni del torneo finiscano per giocare tutti allo stesso modo, e che
l'allievo impari a battere solo quello stile. Tre difese, con le soglie e le nicchie
decise dall'utente (LeagueCfg):

1. IMPRONTA di comportamento. Una SONDA fissa: `sonda_sequenze` spezzoni di gioco vero da
   `sonda_passi` passi, presi una volta (per fase) dalle partite dell'allievo. Ogni
   checkpoint li gioca partendo con la memoria vuota; si registrano la sterzata media
   (u, ritagliata a −1…1) e la probabilita' di boost a ogni passo. Due checkpoint si
   confrontano sugli STESSI stati.
2. CLONI: se la differenza media della sterzata e' sotto `clone_sterzata` E quella del
   boost sotto `clone_boost`, il peggiore dei due (punti medi nel torneo, poi Elo) esce
   dai campioni. Mai un protetto, mai l'ultimo campione di una nicchia (lega.py), mai
   chi sta giocando un girone.
3. DIVERSITA' FORZATA: se la distanza media fra i campioni (media di Δsterzata e Δboost)
   scende sotto `diversita_min`, o i campioni classificati hanno tutti lo stesso stile,
   si creano `mutanti` copie dei campioni migliori con rumore gaussiano sui pesi pari a
   `mutazione` × la deviazione di ogni strato. Se il mutante risulta comunque un clone,
   il rumore raddoppia, fino a `mutazione_max`: misurato sui checkpoint veri, l'1 % sposta
   la sterzata di 0,001–0,003 (la rete assorbe il rumore), per superare la soglia clone
   serve il 16–32 %. I mutanti entrano nel torneo come gli altri: restano solo se reggono.

Gira a ogni girone concluso, fra un'iterazione e l'altra (la GPU in quel momento e'
libera): pochi secondi.
"""
from __future__ import annotations

import itertools
from collections import Counter
from pathlib import Path

import numpy as np
import torch

from .lega import League
from .rete import Policy


class Diversita:
    def __init__(self, cfg, league: League, lay, nc, device, root: Path):
        self.cfg, self.lc, self.league, self.device = cfg, cfg.lega, league, device
        self.path = root / "lega" / "sonda.pt"
        self.net = Policy(lay, nc).to(device).eval()
        self.sonda: torch.Tensor | None = None       # (S, L, D) fp16
        self.fase_sonda: int | None = None
        self.impronte: dict[str, tuple[torch.Tensor, torch.Tensor]] = {}
        self.ult_gironi = league.gironi
        if self.path.exists():
            st = torch.load(self.path, map_location="cpu", weights_only=False)
            self.sonda, self.fase_sonda = st["obs"].to(device), st["fase"]

    # --- sonda e impronte ---------------------------------------------------------------
    def prendi_sonda(self, batch, fase: int, rng) -> bool:
        """Spezzoni dell'allievo dal lotto appena raccolto: righe sue per `sonda_passi`
        passi di fila, senza inizi di episodio in mezzo."""
        L, S = self.lc.sonda_passi, self.lc.sonda_sequenze
        own, first = batch.owner >= 0, batch.first
        T = own.shape[0]
        cand = []
        for t0 in range(0, T - L + 1, 8):
            ok = own[t0:t0 + L].all(0) & ~first[t0 + 1:t0 + L].any(0)
            cand += [(t0, int(n)) for n in np.nonzero(ok)[0]]
        if len(cand) < S:
            return False
        pick = rng.sample(cand, S)
        t0 = torch.as_tensor([p[0] for p in pick], device=batch.obs.device)
        n = torch.as_tensor([p[1] for p in pick], device=batch.obs.device)
        steps = t0[:, None] + torch.arange(L, device=batch.obs.device)[None, :]
        self.sonda = batch.obs[steps, n[:, None]].clone().to(self.device)          # (S, L, D)
        self.fase_sonda = fase
        self.impronte.clear()
        torch.save({"obs": self.sonda.cpu(), "fase": fase}, self.path)
        return True

    @torch.no_grad()
    def _impronta_sd(self, sd: dict) -> tuple[torch.Tensor, torch.Tensor]:
        self.net.load_state_dict({k: v.float() for k, v in sd.items()})
        S, L = self.sonda.shape[:2]
        h = self.net.initial_state(S, self.device)
        turn, boost = [], []
        for t in range(L):
            out, h = self.net.step(self.sonda[:, t], h)
            turn.append(out["turn_mu"].float().clamp(-1.0, 1.0))
            boost.append(torch.sigmoid(out["boost"].float()))
        return torch.stack(turn, 1).cpu(), torch.stack(boost, 1).cpu()

    def _carica(self, cid: str) -> dict:
        st = torch.load(self.league.path_of(cid), map_location="cpu", weights_only=False)
        return st.get("model", st)

    def impronta(self, cid: str) -> tuple[torch.Tensor, torch.Tensor]:
        if cid not in self.impronte:
            self.impronte[cid] = self._impronta_sd(self._carica(cid))
        return self.impronte[cid]

    @staticmethod
    def distanze(a, b) -> tuple[float, float]:
        """(Δsterzata, Δboost) medi sugli stessi stati."""
        return float((a[0] - b[0]).abs().mean()), float((a[1] - b[1]).abs().mean())

    def clone(self, a, b) -> bool:
        dt, db = self.distanze(a, b)
        return dt < self.lc.clone_sterzata and db < self.lc.clone_boost

    def _merito(self, cid: str):
        p = self.league.punti_torneo(cid)
        return (p if p is not None else -1e9, self.league.elo.get(cid))

    # --- il controllo, a ogni girone concluso ---------------------------------------------
    def dopo_iterazione(self, stato, batch, rng, log_event):
        lg = self.league
        if lg.gironi == self.ult_gironi:
            return
        self.ult_gironi = lg.gironi
        if self.sonda is None or self.fase_sonda != stato.fase:
            if not self.prendi_sonda(batch, stato.fase, rng):
                return
            log_event(f"diversita': sonda presa ({self.lc.sonda_sequenze} spezzoni da {self.lc.sonda_passi} passi, fase {stato.fase})")
        camp = [c for c in lg.campioni if c in lg.snapshots]
        for c in list(self.impronte):
            if c not in lg.snapshots:
                del self.impronte[c]
        for c in camp:
            self.impronta(c)
        cloni = self._via_i_cloni(log_event)
        mutanti = self._diversita_forzata(stato, rng, log_event)
        camp = [c for c in lg.campioni if c in lg.snapshots]
        stili = Counter(lg.stile(c) for c in camp)
        log_event(f"diversita' dopo il girone {lg.gironi}: distanza media {self._fmt(lg.diversita)}, "
                  f"stili {dict(stili)}" + (f", cloni scartati {cloni}" if cloni else "")
                  + (f", mutanti {mutanti}" if mutanti else ""))

    @staticmethod
    def _fmt(x):
        return "-" if x is None else f"{x:.3f}"

    def _via_i_cloni(self, log_event) -> int:
        lg, n = self.league, 0
        while True:
            camp = [c for c in lg.campioni if c in lg.snapshots]
            coppia = None
            for a, b in itertools.combinations(camp, 2):
                if not self.clone(self.impronta(a), self.impronta(b)):
                    continue
                # Esce il peggiore, se si puo'; altrimenti l'altro.
                for via, resta in sorted([(a, b), (b, a)], key=lambda x: self._merito(x[0])):
                    if lg.scartabile(via, camp):
                        coppia = (via, resta)
                        break
                if coppia:
                    break
            if coppia is None:
                return n
            via, resta = coppia
            dt, db = self.distanze(self.impronta(via), self.impronta(resta))
            lg.scarta(via)
            n += 1
            log_event(f"clone scartato: {via} come {resta} (Δsterzata {dt:.3f}, Δboost {db:.3f})")

    def _diversita_forzata(self, stato, rng, log_event) -> int:
        lg, lc = self.league, self.lc
        camp = [c for c in lg.campioni if c in lg.snapshots]
        if len(camp) < 2:
            lg.diversita = None
            return 0
        ds = [sum(self.distanze(self.impronta(a), self.impronta(b))) / 2 for a, b in itertools.combinations(camp, 2)]
        lg.diversita = float(np.mean(ds))
        classificati = [lg.stile(c) for c in camp if lg.nicchie(c) is not None]
        un_solo_stile = len(classificati) >= 2 and len(set(classificati)) == 1
        if lg.diversita >= lc.diversita_min and not un_solo_stile:
            return 0
        da_provare = sum(1 for c in camp if lg.mutante(c) and lg.punti_torneo(c) is None)
        k = lc.mutanti - da_provare
        if k <= 0:
            return 0
        perche = f"distanza media {lg.diversita:.3f} < {lc.diversita_min}" if lg.diversita < lc.diversita_min \
            else f"un solo stile ({classificati[0]})"
        padri = sorted(camp, key=self._merito, reverse=True)
        fatti = 0
        for j in range(k):
            padre = padri[j % len(padri)]
            fid = self._muta(padre, stato.it, j, rng, log_event)
            if fid:
                fatti += 1
                log_event(f"mutante {fid} da {padre} ({perche})")
        return fatti

    def _muta(self, padre: str, it: int, j: int, rng, log_event) -> str | None:
        lg = self.league
        sd = {k: v.float() for k, v in self._carica(padre).items()}
        sigma = self.lc.mutazione
        camp = [c for c in lg.campioni if c in lg.snapshots]
        while True:
            g = torch.Generator().manual_seed(rng.randrange(2 ** 31))
            nuovo = {}
            for k, v in sd.items():
                if v.is_floating_point() and v.numel() > 1 and not k.startswith("ret_"):
                    nuovo[k] = v + torch.randn(v.shape, generator=g) * (v.std() * sigma)
                else:
                    nuovo[k] = v
            imp = self._impronta_sd(nuovo)
            simile = next((c for c in camp if self.clone(imp, self.impronta(c))), None)
            if simile is None:
                break
            if sigma * 2 > self.lc.mutazione_max + 1e-9:
                log_event(f"mutazione di {padre} rinunciata: anche con rumore {sigma:.2f} resta un clone di {simile}")
                return None
            sigma *= 2
        fid = f"mutante@{it}_{j}"
        lg.add_snapshot(it, nuovo, fid=fid, fase=lg.fase_of(padre), meta={"padre": padre, "sigma": sigma})
        self.impronte[fid] = imp
        return fid
