"""L'allievo e il suo aggiornamento: PPO ricorrente.

- Vantaggi con GAE sull'orizzonte della raccolta; una partita troncata NON e' una fine
  (si stima il seguito col valore). In modalita' partita non succede: la fine di una
  partita e' un cashout vero.
- Sequenze di `sequenza` passi con lo stato GRU salvato durante la raccolta.
- Valore normalizzato con PopArt: i ritorni cambiano scala man mano che l'agente migliora.
- Teste ausiliarie (morte imminente, oro in arrivo) con perdita supervisionata.
- Stop anticipato delle epoche se la politica si allontana troppo (KL).
- Riscaldamento del critico (`solo_critico`): partendo da un checkpoint addestrato con
  un'altra ricompensa, per le prime iterazioni si allena solo la testa del valore. Con
  un critico starato i vantaggi sarebbero rumore e i primi aggiornamenti rovinerebbero
  una politica che gia' sa giocare.
"""
from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as F

from .azioni import ActionCodec
from .rete import Layout, NetConfig, Policy

AUX_DEATH_STEPS = 50       # ~2 s
AUX_GOLD_STEPS = 125       # ~5 s
PAD = 512                  # lotti dell'aggiornamento arrotondati a multipli di questo (poche
                           # forme diverse per MPS, al massimo 511 righe fittizie per lotto)
CRITICO = ("value.",)      # parametri allenati durante il riscaldamento del critico


class Learner:
    def __init__(self, name: str, lay: Layout, nc: NetConfig, pc, device):
        self.name = name
        self.model = Policy(lay, nc).to(device)
        self.hp = {"lr": pc.lr, "clip": pc.clip, "ent_svolta": pc.ent_svolta,
                   "ent_boost": pc.ent_boost, "ent_cashout": pc.ent_cashout}
        self.opt = torch.optim.Adam(self.model.parameters(), lr=pc.lr, eps=1e-5)
        self.ret_nu = 1.0          # secondo momento dei ritorni (PopArt)
        self.updates = 0
        self.samples = 0

    def state(self):
        return {"name": self.name, "model": self.model.state_dict(), "opt": self.opt.state_dict(),
                "hp": self.hp, "ret_nu": self.ret_nu, "updates": self.updates, "samples": self.samples}

    def load(self, s):
        self.model.load_state_dict(s["model"])
        self.opt.load_state_dict(s["opt"])
        self.hp.update(s["hp"])
        self.ret_nu, self.updates, self.samples = s["ret_nu"], s["updates"], s["samples"]


def gae(rew, values, last_value, term, trunc, gamma, lam):
    """Vantaggi e ritorni (T, N). Troncamento: il seguito vale quanto lo stato attuale."""
    T = rew.shape[0]
    adv = np.zeros_like(rew)
    last = np.zeros(rew.shape[1], np.float32)
    for t in reversed(range(T)):
        nextv = last_value if t == T - 1 else values[t + 1]
        nextv = np.where(trunc[t], values[t], nextv)
        nextv = np.where(term[t], 0.0, nextv)
        cont = ~(term[t] | trunc[t])
        delta = rew[t] + gamma * nextv - values[t]
        last = delta + gamma * lam * cont * last
        adv[t] = last
    return adv, adv + values


def aux_targets(death, gold, term, trunc):
    """Bersagli ausiliari: muore entro ~2 s? raccoglie oro entro ~5 s? (con maschera
    dove il futuro non e' ancora noto alla fine della raccolta)."""
    T, N = death.shape
    td = np.zeros((T, N), np.float32)
    md = np.zeros((T, N), np.float32)
    tg = np.zeros((T, N), np.float32)
    mg = np.zeros((T, N), np.float32)
    until_death = np.full(N, 1e9)
    gold_left = np.zeros(N)              # oro entro l'orizzonte (somma scontata)
    known = np.zeros(N, bool)
    g = 1.0 - 1.0 / AUX_GOLD_STEPS
    for t in reversed(range(T)):
        ended = term[t] | trunc[t]
        until_death = np.where(death[t], 0, np.where(ended, 1e9, until_death + 1))
        gold_left = gold[t] + np.where(ended, 0.0, g * gold_left)
        known = known | ended
        td[t] = until_death < AUX_DEATH_STEPS
        md[t] = known | (T - t >= AUX_DEATH_STEPS)
        tg[t] = gold_left > 0.02
        mg[t] = known | (T - t >= AUX_GOLD_STEPS)
    return td, md, tg, mg


def update(learner: Learner, idx: int, batch, pc, codec: ActionCodec, device, solo_critico: bool = False) -> dict:
    """Un aggiornamento PPO sui dati dell'allievo `idx` (righe con owner == idx). Con
    `solo_critico` si allena solo la testa del valore (riscaldamento dopo un cambio di
    ricompensa): la politica resta esattamente quella del checkpoint."""
    own = batch.owner == idx                                       # (T, N)
    n_own = int(own.sum())
    if n_own < pc.sequenza * 4:
        return {}
    model = learner.model
    if pc.compila_agg and device.type == "cuda" and not getattr(learner, "_compilato", False):
        # La parte costosa (codificatori) compilata anche in addestramento; la GRU resta fuori.
        # dynamic=True: il numero di righe cambia a ogni lotto (con forme fisse ricompilava sempre).
        model.encode = torch.compile(model.encode, dynamic=True)
        learner._compilato = True
    T, N = own.shape
    L = pc.sequenza
    adv, ret = gae(batch.rew, batch.value, batch.last_value, batch.term, batch.trunc, pc.gamma, pc.lam)

    # PopArt: nuove statistiche dei ritorni, uscite del valore preservate.
    r = ret[own]
    beta = pc.popart_beta
    mu = float(model.ret_mu) * (1 - beta) + beta * float(r.mean())
    learner.ret_nu = learner.ret_nu * (1 - beta) + beta * float((r ** 2).mean())
    sigma = math.sqrt(max(learner.ret_nu - mu * mu, 1e-4))
    model.popart_update(mu, sigma)
    ret_n = (ret - mu) / sigma

    a = adv[own]
    adv = (adv - a.mean()) / (a.std() + 1e-8)
    td, md, tg, mg = aux_targets(batch.death, batch.gold, batch.term, batch.trunc)

    # Sequenze (blocco, posto) che contengono dati di questo allievo.
    C = T // L
    own_c = own.reshape(C, L, N).any(1)                             # (C, N)
    cs, ns = np.nonzero(own_c)
    order = np.arange(len(cs))

    def dev(x, dtype=torch.float32):
        return torch.as_tensor(x, dtype=dtype, device=device).reshape(C, L, N)

    t_adv, t_ret = dev(adv), dev(ret_n)
    t_td, t_md, t_tg, t_mg = dev(td), dev(md), dev(tg), dev(mg)
    t_first = dev(batch.first, torch.bool)
    first_cln = batch.first.reshape(C, L, N)
    obs = batch.obs.view(C, L, N, -1)
    turn, boost, cash, charging = (x.view(C, L, N) for x in (batch.turn, batch.boost, batch.cash, batch.charging))
    old_logp = batch.logp.view(C, L, N)
    h0 = batch.h0                                                    # (C, N, H)

    for g in learner.opt.param_groups:
        g["lr"] = learner.hp["lr"]
    clip = learner.hp["clip"]
    keys = ("perdita_pol", "perdita_val", "entropia_svolta", "entropia_cash", "kl", "clipfrac", "aux_morte", "aux_oro")
    # Somme sulla GPU: un solo trasferimento alla fine (ogni float() ferma la GPU).
    stats = {k: torch.zeros((), device=device) for k in keys}
    own_cln = own.reshape(C, L, N)
    nb = 0
    mb = pc.minibatch
    stop = False
    for epoch in range(pc.epoche):
        np.random.shuffle(order)
        kl_sum, kl_n = torch.zeros((), device=device), 0
        for s in range(0, len(order), mb):
            sel = order[s:s + mb]
            ci = torch.as_tensor(cs[sel], device=device)
            ni = torch.as_tensor(ns[sel], device=device)
            # Solo i passi di questo allievo (calcolati sulla CPU: nessuna attesa della GPU).
            # Gli altri (partite finite, posti vuoti, avversari) non entrano ne' nella
            # perdita ne' nella memoria: i codificatori non li calcolano nemmeno.
            pos_np = np.flatnonzero(own_cln[cs[sel], :, ns[sel]])
            K = len(pos_np)
            if K == 0:
                continue
            # Lotto arrotondato a un multiplo di PAD con righe fittizie di peso 0: poche
            # forme sempre uguali, che MPS compila una volta sola e non frammentano la memoria.
            B = len(sel)
            Kp = -(-K // PAD) * PAD
            pos_np = np.concatenate([pos_np, np.full(Kp - K, B * L)])
            pos = torch.as_tensor(pos_np, device=device)
            real = torch.as_tensor(np.arange(Kp) < K, device=device)
            w = real.float()
            bi = torch.as_tensor(np.minimum(pos_np // L, B - 1), device=device)
            li = torch.as_tensor(pos_np % L, device=device)
            o = obs[ci[bi], li, ni[bi]]
            # Inizi di episodio nel lotto? Deciso qui sulla CPU: la GPU non si ferma a rispondere.
            reset_any = bool(first_cln[cs[sel], :, ns[sel]].any())
            out = model.unroll(o, h0[ci, ni], t_first[ci, :, ni], pos, reset_any=reset_any)

            def pick(x):
                flat = x[ci, :, ni].reshape(-1)
                return torch.cat([flat, flat.new_zeros(1)])[pos]

            ch = pick(charging)
            logp, e_turn, e_boost, e_cash = codec.log_prob(out, pick(turn), pick(boost), pick(cash), ch, batch.cash_lock)
            old = pick(old_logp)
            ratio = torch.exp(logp - old)
            A = pick(t_adv)
            pg = -torch.min(ratio * A, ratio.clamp(1 - clip, 1 + clip) * A)
            pol_loss = (pg * w).sum() / K
            v = out["value"].float()
            val_loss = 0.5 * (((v - pick(t_ret)) ** 2) * w).sum() / K
            ent = ((learner.hp["ent_svolta"] * e_turn + learner.hp["ent_boost"] * e_boost
                    + learner.hp["ent_cashout"] * e_cash) * w).sum() / K
            aux = out["aux"].float()
            mdx, mgx = pick(t_md) * w, pick(t_mg) * w
            aux_d = (F.binary_cross_entropy_with_logits(aux[:, 0], pick(t_td), reduction="none") * mdx).sum() / mdx.sum().clamp(min=1.0)
            aux_g = (F.binary_cross_entropy_with_logits(aux[:, 1], pick(t_tg), reduction="none") * mgx).sum() / mgx.sum().clamp(min=1.0)
            if solo_critico:
                loss = pc.vf_coef * val_loss
            else:
                loss = pol_loss + pc.vf_coef * val_loss - ent + pc.aux_coef * (aux_d + aux_g)
            learner.opt.zero_grad(set_to_none=True)
            loss.backward()
            if solo_critico:
                # Solo la testa del valore: il resto della rete (politica compresa) non si muove.
                for name, p in model.named_parameters():
                    if not name.startswith(CRITICO):
                        p.grad = None
            torch.nn.utils.clip_grad_norm_(model.parameters(), pc.max_grad)
            learner.opt.step()
            with torch.no_grad():
                lr_ = logp - old
                kl = (((torch.exp(lr_) - 1) - lr_) * w).sum() / K
                kl_sum += kl
                kl_n += 1
                for k, x in (("perdita_pol", pol_loss), ("perdita_val", val_loss), ("kl", kl), ("aux_morte", aux_d), ("aux_oro", aux_g),
                             ("clipfrac", ((((ratio - 1).abs() > clip).float()) * w).sum() / K), ("entropia_cash", (e_cash * w).sum() / K),
                             ("entropia_svolta", (e_turn * w).sum() / ((~ch).float() * w).sum().clamp(min=1.0))):
                    stats[k] += x.detach().float()
                nb += 1
        if not solo_critico and kl_n and float(kl_sum) / kl_n > pc.kl_max:
            stop = True
            break
    out = {k: float(v) / max(nb, 1) for k, v in stats.items()}
    if device.type == "mps":
        torch.mps.empty_cache()            # fra un allievo e l'altro: niente memoria frammentata
    # Varianza spiegata: quanto il valore prevede davvero i ritorni.
    vals, rets = batch.value[own], ret[own]
    out["var_spiegata"] = float(1 - np.var(rets - vals) / (np.var(rets) + 1e-8))
    out["campioni_allievo"] = n_own
    out["epoche"] = epoch + 1
    out["stop_kl"] = int(stop)
    out["solo_critico"] = int(solo_critico)
    learner.updates += 1
    learner.samples += n_own
    return out
