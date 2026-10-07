"""Dalle uscite della rete alle azioni del simulatore, e ritorno (log-probabilita').

Il cashout e' un «interruttore»: la rete decide di INIZIARE a caricarlo e poi, a ogni
passo, se INTERROMPERLO. Mentre carica la direzione e' bloccata dal server e il boost
spento: svolta e boost non contano, e non entrano nella log-probabilita' (sarebbero
solo rumore nel gradiente).

`cash_lock`: nelle prime fasi dell'addestramento il cashout non si puo' iniziare (vedi
`RewardCfg.cashout_dopo_passi`); la testa «inizio» e' allora fuori dal gradiente.
"""
from __future__ import annotations

import math

import torch
import torch.nn.functional as F

from .rete import turn_to_sim

LOCKED = -30.0
LOG_SQRT_2PI = 0.5 * math.log(2 * math.pi)
LOG_STD_MIN, LOG_STD_MAX = math.log(0.02), math.log(1.0)


def _turn_params(out: dict):
    mu = out["turn_mu"].float()
    log_std = out["turn_log_std"].float().clamp(LOG_STD_MIN, LOG_STD_MAX)
    return mu, log_std


def _cash_logits(out: dict, charging, cash_lock):
    """`cash_lock`: bool per tutto il lotto, oppure un tensore bool per riga."""
    start = out["cash_start"]
    if isinstance(cash_lock, torch.Tensor):
        start = torch.where(cash_lock, torch.full_like(start, LOCKED), start)
    elif cash_lock:
        start = torch.full_like(start, LOCKED)
    return torch.where(charging, out["cash_abort"], start).float()


class ActionCodec:
    """Svolta continua (gaussiana su u, poi ritagliata in [−1, 1]: la log-probabilita' e'
    quella del campione non ritagliato, come si usa in PPO), boost e cashout Bernoulli."""

    def __init__(self, device):
        self.device = device

    @torch.no_grad()
    def sample(self, out: dict, charging: torch.Tensor, greedy: bool = False, cash_lock: bool = False):
        """→ (svolta u [B] float, boost [B] bool, cambio del cashout [B] bool, logp [B])."""
        mu, log_std = _turn_params(out)
        if greedy:
            turn = mu
            boost = out["boost"] > 0
            cash = _cash_logits(out, charging, cash_lock) > 0
        else:
            turn = mu + torch.randn_like(mu) * log_std.exp()
            boost = torch.rand_like(out["boost"]) < torch.sigmoid(out["boost"].float())
            cash_logit = _cash_logits(out, charging, cash_lock)
            cash = torch.rand_like(cash_logit) < torch.sigmoid(cash_logit)
        logp = self.log_prob(out, turn, boost, cash, charging, cash_lock, entropy=False)[0]
        return turn, boost, cash, logp

    def log_prob(self, out: dict, turn, boost, cash, charging, cash_lock: bool = False, entropy: bool = True):
        """Log-probabilita' dell'azione e, se `entropy`, le tre entropie (svolta, boost, cashout)."""
        mu, log_std = _turn_params(out)
        turn_lp = -0.5 * ((turn.float() - mu) / log_std.exp()) ** 2 - log_std - LOG_SQRT_2PI
        bl = out["boost"].float()
        boost_lp = -F.binary_cross_entropy_with_logits(bl, boost.float(), reduction="none")
        cl = _cash_logits(out, charging, cash_lock)
        cash_lp = -F.binary_cross_entropy_with_logits(cl, cash.float(), reduction="none")
        free = (~charging).float()
        logp = cash_lp + free * (turn_lp + boost_lp)
        if not entropy:
            return logp, None, None, None
        ent_turn = (log_std + 0.5 + LOG_SQRT_2PI) * free
        pb = torch.sigmoid(bl)
        ent_boost = (F.binary_cross_entropy_with_logits(bl, pb, reduction="none")) * free
        pc = torch.sigmoid(cl)
        ent_cash = F.binary_cross_entropy_with_logits(cl, pc, reduction="none")
        return logp, ent_turn, ent_boost, ent_cash

    def to_sim(self, turn, boost, new_charging) -> torch.Tensor:
        """Il vettore (B, 3) del simulatore: [angolo/π = u·|u| ritagliato, boost, cashout tenuto]."""
        return torch.stack([turn_to_sim(turn.float().clamp(-1.0, 1.0)), boost.float(), new_charging.float()], -1)
