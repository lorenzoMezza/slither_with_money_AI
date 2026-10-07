"""Lettura delle sessioni registrate dall'analizzatore (`analizer/sessioni/`).

Da ogni registrazione si ricostruisce, per ogni giocatore della lobby, cio' che vedeva
(lo stesso `Featurizer` dell'agente, col suo id al centro) e cio' che ha fatto, letto
dagli snapshot successivi:
  svolta    la rotta a cui la testa si e' assestata (si guarda avanti finche' smette di
            girare o inverte il verso, al massimo ~1 s), portata nel parametro continuo u;
  boost     il campo `boosting` dello snapshot successivo (e' l'input ricevuto);
  cashout   `cashingOut` dello snapshot successivo rispetto a quello corrente.

Lo usa `replay_reale.py` per la verifica offline dell'agente sulle partite vere. I dati
restano dove sono: qui si leggono soltanto (sono personali e non vanno mai pubblicati).
"""
from __future__ import annotations

import gzip
import json
import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from slither_sim import Featurizer

from .rete import angle_to_turn

LOOKAHEAD = 24          # snapshot guardati avanti per capire dove la testa si assestava (~1 s)
STOP_TURN = 0.012       # rad per snapshot sotto cui «non sta girando» (l'angolo arriva a 0,001)


def normalize(a: float) -> float:
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


def turn_target(angles: list[float], t: int) -> float:
    """L'angolo di svolta (rad) che spiega come la rotta e' cambiata da `t` in poi."""
    a0 = angles[t]
    n = len(angles)
    target = 0.0
    prev_step = 0.0
    for k in range(1, LOOKAHEAD + 1):
        if t + k >= n:
            break
        step = normalize(angles[t + k] - angles[t + k - 1])
        if abs(step) < STOP_TURN:
            break                                   # assestata
        if prev_step and (step > 0) != (prev_step > 0):
            break                                   # ha invertito: la meta era li'
        target = normalize(angles[t + k] - a0)
        prev_step = step
    return target


@dataclass
class Run:
    """La partita di una persona: osservazioni e azioni passo per passo."""
    obs: np.ndarray            # (T, D) float16
    turn: np.ndarray           # (T,) float32: u della svolta
    boost: np.ndarray          # (T,) bool
    cash: np.ndarray           # (T,) bool: cambio dell'interruttore
    charging: np.ndarray       # (T,) bool: stava caricando
    nbytes: int = 0

    def __post_init__(self):
        self.nbytes = self.obs.nbytes


@dataclass
class _Open:
    """Una partita in corso durante la lettura: cio' che serve per etichettarla alla fine."""
    feat: Featurizer
    pid: str = ""
    angles: list = field(default_factory=list)
    boosting: list = field(default_factory=list)
    cashing: list = field(default_factory=list)
    jsons: deque = field(default_factory=deque)     # snapshot non ancora spinti nel Featurizer
    obs: list = field(default_factory=list)
    last: np.ndarray = field(default_factory=lambda: np.zeros(3, np.float32))
    pushed: int = 0                                  # passi gia' osservati


def find_sessions(root: Path) -> list[Path]:
    """Le sessioni registrate (cartelle con `rete/frames.ndjson.gz`) in `root`, o `root`
    stessa se e' una sessione."""
    if (root / "rete" / "frames.ndjson.gz").exists():
        return [root]
    if not root.exists():
        return []
    return sorted(p for p in root.iterdir() if (p / "rete" / "frames.ndjson.gz").exists())


def _iter_states(path: Path):
    """Gli snapshot `state` di una sessione, in ordine, con il socket d'origine."""
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("k") != "f" or ev.get("d") != "i":
                continue
            p = ev.get("p")
            if not isinstance(p, str) or '"state"' not in p[:40]:
                continue
            try:
                msg = json.loads(p)
            except ValueError:
                continue
            if msg.get("t") != "state":
                continue
            yield int(ev.get("s", 0)), p, msg


class SessionReader:
    """Legge una sessione e produce le partite (`Run`) di ogni giocatore, una alla volta."""

    def __init__(self, min_steps: int = 48):
        self.min_steps = min_steps

    def runs(self, session_dir: Path):
        frames = session_dir / "rete" / "frames.ndjson.gz"
        if not frames.exists():
            return
        open_runs: dict[tuple[int, str], _Open] = {}
        cur_socket = None
        for sock, raw, msg in _iter_states(frames):
            if sock != cur_socket:
                # Nuova connessione: le partite della precedente finiscono.
                for key in list(open_runs):
                    r = self._close(open_runs.pop(key))
                    if r is not None:
                        yield r
                cur_socket = sock
            alive = {}
            for p in msg.get("players", []):
                if p.get("alive") and p.get("id"):
                    alive[p["id"]] = p
            for key in list(open_runs):
                if key[0] != sock or key[1] not in alive:
                    r = self._close(open_runs.pop(key))
                    if r is not None:
                        yield r
            for pid, p in alive.items():
                key = (sock, pid)
                o = open_runs.get(key)
                if o is None:
                    o = open_runs[key] = _Open(feat=Featurizer(), pid=pid)
                o.angles.append(float(p.get("angle", 0.0)))
                o.boosting.append(bool(p.get("boosting", False)))
                o.cashing.append(bool(p.get("cashingOut", False)))
                o.jsons.append(raw)
                # Il Featurizer viene spinto con LOOKAHEAD+1 snapshot di ritardo: cosi'
                # l'azione del passo precedente (che gli serve come ingresso) e' gia' nota.
                self._advance(o, final=False)
        for key in list(open_runs):
            r = self._close(open_runs.pop(key))
            if r is not None:
                yield r

    def _label(self, o: _Open, t: int):
        """Azione al passo t: (categoria di svolta, boost, cambio del cashout, caricava)."""
        n = len(o.angles)
        nxt = min(t + 1, n - 1)
        charging = o.cashing[t]
        cash = o.cashing[nxt] != charging
        boost = o.boosting[nxt] and not o.cashing[nxt]
        turn = angle_to_turn(turn_target(o.angles, t))
        return turn, boost, cash, charging

    def _advance(self, o: _Open, final: bool):
        """Spinge nel Featurizer gli snapshot per cui l'ultima azione e' gia' decidibile
        (alla chiusura, `final`, tutti: l'ultima si etichetta con quel che c'e')."""
        n = len(o.angles)
        while o.jsons:
            t = o.pushed
            # L'azione di t−1 richiede gli angoli fino a t−1+LOOKAHEAD+1.
            if not final and n < t + LOOKAHEAD + 1:
                break
            raw = o.jsons.popleft()
            if t > 0:
                turn, boost, cash, charging = self._label(o, t - 1)
                held = charging != cash                   # stato dell'interruttore dopo la decisione
                # Cio' che il client avrebbe mandato: angolo/π (= u·|u|), boost, cashout tenuto.
                o.last = np.array([turn * abs(turn), float(boost), float(held)], np.float32)
            row = o.feat.push(raw, o.pid, o.last)
            if row is None:
                row = np.zeros(o.feat.obs_size, np.float32)
            o.obs.append(row.astype(np.float16))
            o.pushed += 1

    def _close(self, o: _Open) -> Run | None:
        self._advance(o, final=True)
        T = len(o.obs)
        if T < self.min_steps:
            return None
        labels = [self._label(o, t) for t in range(T)]
        return Run(
            obs=np.stack(o.obs),
            turn=np.array([l[0] for l in labels], np.float32),
            boost=np.array([l[1] for l in labels], bool),
            cash=np.array([l[2] for l in labels], bool),
            charging=np.array([l[3] for l in labels], bool),
        )
