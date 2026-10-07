"""Il cervello del ponte: dagli snapshot del server vero all'input da mandare.

Non sa nulla di browser né di WebSocket: riceve il testo di ogni messaggio `state` e
restituisce una decisione. Usa le STESSE funzioni dell'addestramento:

  osservazione  `slither_sim.Featurizer` (lo stesso del simulatore), un passo per snapshot,
                nell'ordine di arrivo, con l'ultima azione REALMENTE mandata come ingresso;
  rete          `ia.carica.load_policy` + memoria GRU, azzerata a ogni ingresso in partita;
  azione        `ia.azioni.ActionCodec` (svolta continua, boost, interruttore del cashout);
  svolta        targetDir = angolo osservato + π·u·|u|, come `env.rs::act` del simulatore.

Mentre guida la PERSONA il cervello continua a osservare (il dossier degli avversari e la
memoria della rete dipendono dalla sequenza) con l'azione che la persona ha fatto davvero,
così al ritorno dell'IA il contesto è coerente.
"""
from __future__ import annotations

import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch

RADICE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RADICE / "simulatore" / "python"))
sys.path.insert(0, str(RADICE / "allenamento"))

from slither_sim import Featurizer, SlitherVecEnv  # noqa: E402

from ia.azioni import ActionCodec  # noqa: E402
from ia.carica import load_policy  # noqa: E402
from ia.rete import Layout  # noqa: E402


def normalizza(a: float) -> float:
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


def scegli_dispositivo(nome: str) -> torch.device:
    if nome != "auto":
        return torch.device(nome)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


@dataclass
class Decisione:
    dir: float            # targetDir assoluto (rad), da mandare così com'è
    boost: bool
    cash: bool            # cashout tenuto
    svolta_u: float       # u·|u| in [−1, 1] (angolo/π), per i registri
    ms: float             # tempo di calcolo


@dataclass
class Vista:
    """Cosa il cervello vede di sé nell'ultimo snapshot (per l'etichetta e il registro)."""
    vivo: bool = False
    size: float = 0.0
    saldo: float = 0.0
    posta: float = 0.0
    nemici: int = 0
    cash_progresso: float = 0.0


class Cervello:
    def __init__(self, modello: str | Path, dispositivo: str = "auto", greedy: bool = False):
        self.dev = scegli_dispositivo(dispositivo)
        env = SlitherVecEnv(num_envs=1, agents_per_env=1, seed=1)
        self.lay = Layout.from_sim(env.layout())
        env.close()
        self.m, self.etichetta = load_policy(modello, self.lay, self.dev)
        self.m.eval()
        self.fase = int(getattr(self.m, "fase", 2))
        self.greedy = greedy
        self.codec = ActionCodec(self.dev)
        self.ms_ema = 0.0
        self.nuova_partita()

    # ------------------------------------------------------------------ partita
    def nuova_partita(self):
        """Memoria, dossier e interruttore a zero: da chiamare a ogni ingresso in partita."""
        self.feat = Featurizer()
        self.h = self.m.initial_state(1, self.dev)
        self.charging = torch.zeros(1, dtype=torch.bool, device=self.dev)
        self.ultima = np.zeros(3, np.float32)       # [angolo/π, boost, cashout tenuto] realmente mandato
        self.angolo_prec = 0.0
        self.dir_prec = 0.0
        self.obs: np.ndarray | None = None
        self.vista = Vista()
        self.in_partita = False

    def riscalda(self, passi: int = 4):
        """Qualche passo a vuoto: la prima chiamata (MPS/CUDA) compila e costa decine di ms."""
        z = torch.zeros(1, self.feat.obs_size, device=self.dev)
        with torch.no_grad():
            h = self.m.initial_state(1, self.dev)
            for _ in range(passi):
                _, h = self.m.step(z, h)
            if self.dev.type == "mps":
                torch.mps.synchronize()

    # ------------------------------------------------------------------ osservare
    def osserva(self, raw: str, mio_id: str, umano: dict | None = None, nome: str | None = None) -> Vista:
        """Spinge UNO snapshot nel Featurizer (va chiamato per tutti, in ordine).
        `umano` = ultimo input della persona {dir, boost, cash}, usato come «ultima azione»
        quando non è l'IA a guidare (`None` = guidava l'IA: vale la sua ultima decisione)."""
        try:
            msg = json.loads(raw)
        except ValueError:
            return self.vista
        giocatori = msg.get("players") or []
        io = next((p for p in giocatori if p.get("id") == mio_id and p.get("alive")), None)
        if io is None and nome:
            candidati = [p for p in giocatori if p.get("name") == nome and p.get("alive")]
            if len(candidati) == 1:
                io, mio_id = candidati[0], candidati[0]["id"]
        if io is None:
            self.obs = None
            self.in_partita = False
            self.vista = Vista(vivo=False, nemici=sum(1 for p in giocatori if p.get("alive")))
            return self.vista
        if not self.in_partita:
            self.nuova_partita()                    # primo snapshot da vivo: memoria e dossier puliti
        if umano is not None and umano.get("dir") is not None:
            rel = normalizza(float(umano["dir"]) - self.angolo_prec) / math.pi
            self.ultima = np.array([max(-1.0, min(1.0, rel)), float(umano["boost"]), float(umano["cash"])], np.float32)
        self.obs = self.feat.push(raw, mio_id, self.ultima)
        self.angolo_prec = float(io.get("angle", 0.0))
        self.in_partita = self.obs is not None
        self.vista = Vista(
            vivo=self.obs is not None, size=float(io.get("size", 0)), saldo=float(io.get("balance", 0)),
            posta=float(io.get("buyIn", 0)), nemici=sum(1 for p in giocatori if p.get("alive") and p.get("id") != mio_id),
            cash_progresso=float(io.get("cashoutProgress", 0)))
        self.id_riconosciuto = mio_id
        return self.vista

    # ------------------------------------------------------------------ decidere
    @torch.no_grad()
    def decidi(self) -> Decisione | None:
        """Una decisione sull'ULTIMA osservazione (None se non si è in gioco)."""
        if self.obs is None:
            return None
        t0 = time.perf_counter()
        o = torch.from_numpy(self.obs)[None].to(self.dev)
        out, self.h = self.m.step(o, self.h)
        turn, boost, cash, _ = self.codec.sample(out, self.charging, self.greedy, cash_lock=self.fase == 1)
        self.charging = self.charging ^ cash
        a = self.codec.to_sim(turn, boost, self.charging)[0].cpu().numpy()      # [angolo/π, boost, cashout tenuto]
        ms = (time.perf_counter() - t0) * 1000
        self.ms_ema = ms if self.ms_ema == 0 else 0.95 * self.ms_ema + 0.05 * ms
        self.ultima = np.array([max(-1.0, min(1.0, float(a[0]))), float(a[1]), float(a[2])], np.float32)
        if self.charging.item():
            d = self.dir_prec               # in carica il server blocca la direzione: si ripete l'ultima
        else:
            d = normalizza(self.angolo_prec + float(self.ultima[0]) * math.pi)
        self.dir_prec = d
        return Decisione(d, bool(self.ultima[1] > 0.5) and not bool(self.ultima[2] > 0.5), bool(self.ultima[2] > 0.5),
                         float(self.ultima[0]), ms)

    @torch.no_grad()
    def segui(self):
        """Guida la persona: la rete avanza (memoria coerente) ma non decide niente."""
        if self.obs is None:
            return
        o = torch.from_numpy(self.obs)[None].to(self.dev)
        _, self.h = self.m.step(o, self.h)
        self.charging = torch.tensor([bool(self.ultima[2] > 0.5)], device=self.dev)
