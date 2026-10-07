"""Caricare un agente addestrato e farlo giocare (per guardarlo o valutarlo)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from .azioni import ActionCodec
from .rete import Layout, NetConfig, Policy


def load_policy(path: str | Path, lay: Layout, device, learner: str | None = None) -> tuple[Policy, str]:
    """Accetta una cartella di corsa (migliore.pt, altrimenti stato.pt), stato.pt,
    migliore.pt, un'istantanea della lega o il checkpoint di partenza. `learner` resta per
    compatibilita' con la riga di comando («migliore» = migliore.pt della corsa).
    Il modello porta con se' la fase in cui e' stato addestrato (`m.fase`): un agente
    della fase 1 non ha mai imparato il cashout e gioca col cashout bloccato."""
    path = Path(path)
    if path.is_dir():
        best = path / "migliore.pt"
        path = best if (best.exists() and learner in (None, "migliore")) or not (path / "stato.pt").exists() else path / "stato.pt"
    st = torch.load(path, map_location=device, weights_only=False)
    nc = NetConfig()
    if isinstance(st, dict) and "learner" in st:                       # stato.pt
        sd, label = st["learner"]["model"], f"{path.parent.name}/allievo@{st['iter']}"
    elif isinstance(st, dict) and "learners" in st:
        raise ValueError(f"{path}: e' lo stato di una corsa del vecchio addestramento a fasi (non piu' supportato)")
    elif isinstance(st, dict) and "model" in st:                       # migliore.pt, istantanea, partenza
        sd, label = st["model"], f"{path.parent.name}/{st.get('allievo', '?')}@{st.get('iter', '?')}"
        if "net" in st:
            nc = NetConfig(**st["net"])
        if "layout" in st and st["layout"] != lay.to_dict():
            raise ValueError("l'agente e' stato addestrato con un'osservazione diversa da quella del simulatore attuale")
    else:
        sd, label = st, path.stem
    m = Policy(lay, nc).to(device)
    m.load_state_dict({k: v.float() for k, v in sd.items()})
    m.eval()
    m.fase = int(st.get("fase", 2)) if isinstance(st, dict) else 2
    return m, label


class Driver:
    """Guida un insieme di posti con una rete: memoria GRU e interruttore del cashout."""

    def __init__(self, model: Policy, slots: list[int], device, greedy: bool = False):
        self.m, self.slots, self.dev, self.greedy = model, np.asarray(slots), device, greedy
        self.codec = ActionCodec(device)
        self.h = model.initial_state(len(slots), device)
        self.charging = torch.zeros(len(slots), dtype=torch.bool, device=device)

    def reset(self, mask: np.ndarray | None = None):
        if mask is None:
            self.h.zero_()
            self.charging.zero_()
        else:
            t = torch.as_tensor(mask, device=self.dev)
            self.h[t] = 0
            self.charging[t] = False

    @torch.no_grad()
    def act(self, obs: np.ndarray, actions: np.ndarray):
        o = torch.from_numpy(obs[self.slots]).to(self.dev)
        out, self.h = self.m.step(o, self.h)
        turn, boost, cash, _ = self.codec.sample(out, self.charging, self.greedy, cash_lock=getattr(self.m, "fase", 2) == 1)
        self.charging = self.charging ^ cash
        actions[self.slots] = self.codec.to_sim(turn, boost, self.charging).cpu().numpy()


class RunSource:
    """Il modello di una corsa IN CORSO: ricaricato ogni volta che l'addestramento
    salva (stato.pt o migliore.pt cambiano), senza disturbarla."""

    def __init__(self, path: str | Path, lay: Layout, device, learner: str | None = None):
        self.path, self.lay, self.dev = Path(path), lay, device
        self.learner = learner
        self.model: Policy | None = None
        self.label = ""
        self._stamp = None

    def _file(self) -> Path:
        if not self.path.is_dir():
            return self.path
        if self.learner == "migliore" or (self.learner is None and not (self.path / "stato.pt").exists()):
            return self.path / "migliore.pt"
        return self.path / "stato.pt"

    def get(self) -> tuple[Policy, str, bool]:
        """→ (modello, etichetta, appena aggiornato)."""
        f = self._file()
        stamp = f.stat().st_mtime if f.exists() else None
        if stamp is None and self.model is None:
            raise FileNotFoundError(f"{f} non esiste ancora: l'addestramento salva ogni `salva_ogni` iterazioni")
        if stamp is not None and stamp != self._stamp:
            try:
                learner = None if self.learner == "migliore" else self.learner
                self.model, self.label = load_policy(f, self.lay, self.dev, learner)
                self._stamp = stamp
                return self.model, self.label, True
            except Exception:                    # file a meta' scrittura: si riprova dopo
                if self.model is None:
                    raise
        return self.model, self.label, False


class SlotPlayers:
    """Piu' reti su piu' posti dello stesso VecEnv: memoria e cashout per posto,
    un passaggio per rete a ogni passo."""

    def __init__(self, n_slots: int, memory: int, device):
        self.dev = device
        self.codec = ActionCodec(device)
        self.h = torch.zeros(n_slots, memory, device=device)
        self.charging = torch.zeros(n_slots, dtype=torch.bool, device=device)
        self.model_of: list[Policy | None] = [None] * n_slots

    def assign(self, slots, model: Policy | None):
        for s in slots:
            self.model_of[s] = model
        t = torch.as_tensor(list(slots), dtype=torch.long, device=self.dev)
        self.h[t] = 0
        self.charging[t] = False

    @torch.no_grad()
    def act(self, obs: np.ndarray, actions: np.ndarray):
        groups: dict[int, list[int]] = {}
        for s, m in enumerate(self.model_of):
            if m is not None:
                groups.setdefault(id(m), []).append(s)
        for idx in groups.values():
            m = self.model_of[idx[0]]
            t = torch.as_tensor(idx, dtype=torch.long, device=self.dev)
            out, self.h[t] = m.step(torch.from_numpy(obs[idx]).to(self.dev), self.h[t])
            turn, boost, cash, _ = self.codec.sample(out, self.charging[t], cash_lock=getattr(m, "fase", 2) == 1)
            self.charging[t] = self.charging[t] ^ cash
            actions[idx] = self.codec.to_sim(turn, boost, self.charging[t]).cpu().numpy()
