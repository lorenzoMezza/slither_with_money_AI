"""La raccolta: centinaia di lobby simulate in parallelo, ogni posto guidato dal suo
controllore (l'allievo o un'istantanea congelata), e le ricompense.

A ogni passo:
  1. le osservazioni dei posti in gioco vanno sulla GPU (solo le righe vive, da memoria
     bloccata);
  2. UN passaggio della rete per pila di controllori (allievo; istantanee impilate con
     `vmap`, su CUDA registrato come CUDA graph);
  3. le azioni tornano al simulatore (Rust, tutti i core), che avanza ogni lobby fino al
     prossimo snapshot con le latenze di rete del server vero. Le lobby sono divise in
     due meta': mentre una viene simulata in un thread, l'altra passa dalla rete;
  4. ricompense, fini d'episodio, partite chiuse → nuove partite dal matchmaker.

Le righe dei posti guidati dall'allievo (fuori dal banco di prova) sono i dati di
addestramento: in self-play anche le copie dal vivo imparano.

RICOMPENSA per passo, a PUNTI (ia/punti.py, PIANO_ADDESTRAMENTO.md §3), uguale per tutti i posti:

  fase 1 (predatore)   0,5 per uccisione + 1 per caduta intera del bottino delle proprie
                       uccisioni + 0,6 per caduta intera del bottino altrui (divisi per
                       orb raccolti; un'uccisione vinta testa contro testa vale il 75 %)
                       + 0,02 per orb di cibo − 0,5 se muore in uno scontro
                       testa contro testa (muore il piu' piccolo). Il cashout e' bloccato.
  fase 2 (completo)    gli stessi punti × 0,7, piu' al cashout fatto da se': 5,0 con
                       profitto ≥ +80 % e niente oro a terra, 2,6 con oro ancora a terra,
                       7,0 con profitto > +20 % quando non restano ne' avversari ne' oro.

Nessun modellamento; fra le morti solo il frontale ha una penalita' (uguale nelle due
fasi): le altre, e la fine forzata della partita, tolgono solo cio' che si sarebbe
potuto ancora guadagnare.
"""
from __future__ import annotations

import copy
import threading
import time
from collections import OrderedDict, defaultdict
from dataclasses import dataclass

import numpy as np
import torch

from slither_sim import INFO_NAMES

from .azioni import ActionCodec
from .lega import ALLIEVO
from .partite import Match, participants
from .punti import bonus_uscita, penalita_frontale, punti_caccia, tipo_uscita
from .rete import Policy, StackedPolicies

I = {n: i for i, n in enumerate(INFO_NAMES)}
TICK_HZ = 60.0


@dataclass
class Batch:
    obs: torch.Tensor          # (T, N, D) fp16
    turn: torch.Tensor         # (T, N) float: u della svolta (prima del ritaglio)
    boost: torch.Tensor        # (T, N) bool
    cash: torch.Tensor         # (T, N) bool: cambio dell'interruttore
    charging: torch.Tensor     # (T, N) bool: stava caricando il cashout prima di decidere
    logp: torch.Tensor         # (T, N)
    h0: torch.Tensor           # (C, N, H) memoria all'inizio di ogni sequenza
    value: np.ndarray          # (T, N) in scala reale
    last_value: np.ndarray     # (N,)
    rew: np.ndarray
    term: np.ndarray
    trunc: np.ndarray
    first: np.ndarray
    death: np.ndarray
    gold: np.ndarray
    owner: np.ndarray          # (T, N) 0 = dato dell'allievo, −1 = non e' un dato di addestramento
    cash_lock: bool = False


FERMO_PASSO = 2.0                         # s fra una tappa e l'altra (misura «fermo in tondo»)
FERMO_TAPPE = 5                           # la piu' vecchia e' di ~8–10 s fa
FERMO_U = 500.0                           # spostamento sotto cui si e' «fermi in tondo»
GRADINI_M = (64, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096)


class Collector:
    def __init__(self, cfg, env, learner, league, matchmaker, bench, lay, nc, device, root):
        self.cfg, self.env, self.learner, self.league = cfg, env, learner, league
        self.mm, self.bench, self.lay, self.nc, self.device, self.root = matchmaker, bench, lay, nc, device, root
        self.E, self.P, self.N = env.num_envs, env.agents_per_env, env.n
        # Le ultime lobby: banco di prova; prima di quelle, i gironi del torneo.
        nv, nt = cfg.env.mondi_valutazione, cfg.env.mondi_torneo
        self.eval_envs = set(range(self.E - nv, self.E))
        self.torneo_envs = set(range(self.E - nv - nt, self.E - nv))
        self.fase = cfg.fase
        self.codec = ActionCodec(device)
        N = self.N
        self.h = torch.zeros(N, nc.memory, device=device)
        self.charging = torch.zeros(N, dtype=torch.bool, device=device)
        self.alive = np.zeros(N, bool)
        self.first = np.ones(N, bool)
        self.ctrl: list[str | None] = [None] * N
        self.owner = np.full(N, -1, np.int64)         # 0 = riga dell'allievo fuori dal banco
        self.matches: list[Match | None] = [None] * self.E
        self.cache: OrderedDict[str, Policy] = OrderedDict()
        # Per posto, l'episodio in corso.
        self.ricco = np.zeros(N, bool)            # entrato gia' ricco (copie): fuori dalle statistiche «da posta»
        self.p_now = np.zeros(N, np.float32)      # profitto netto se incassasse adesso
        self.tick_prev = np.full(N, -1.0)
        self.t_ep = np.zeros(N, np.float32)       # secondi di gioco dall'ingresso
        self.p_max = np.zeros(N, np.float32)
        self.punti = np.zeros(N, np.float32)      # punti dell'episodio (la somma delle ricompense)
        self.b_mio = np.zeros(N, np.float32)      # parti di bottino delle proprie uccisioni
        self.b_altrui = np.zeros(N, np.float32)   # parti di bottino altrui
        self.cibo = np.zeros(N, np.float32)       # orb di cibo
        self.pos0 = np.zeros((N, 2), np.float32)  # dove e' entrato (prima posizione vista)
        self.pos_ok = np.zeros(N, bool)
        self.tappe = np.zeros((N, FERMO_TAPPE, 2), np.float32)  # posizioni ogni FERMO_PASSO s (anello)
        self.n_tappe = np.zeros(N, np.int64)
        self.prossima = np.zeros(N, np.float32)   # t_ep della prossima tappa
        self.fermo_s = np.zeros(N, np.float32)    # secondi passati «fermo in tondo»
        self.in_arrivo = np.zeros(N, bool)        # posto con ingresso ritardato, non ancora entrato
        self.escursione = np.zeros(N, np.float32) # quanto si e' allontanato da li', al massimo
        self.boost_s = np.zeros(N, np.float32)    # secondi col boost
        self.episodes: list[dict] = []            # episodi finiti dell'allievo (addestramento)
        self.eval_done: list[dict] = []
        self.matches_done = 0
        self.steps = 0
        self._buf = None
        self._sim_error = None
        self._lock = threading.Lock()             # le due meta' chiudono partite in thread diversi
        # La politica che raccoglie e' una COPIA congelata dell'allievo, aggiornata solo da
        # `sync_allievo()`: cosi' la raccolta puo' girare mentre l'allievo si aggiorna (allena.py
        # sovrappone le due fasi; i dati hanno al piu' un aggiornamento di ritardo, come in
        # PPO asincrono: il rapporto d'importanza usa il logp della politica che ha giocato).
        self._behav = copy.deepcopy(learner.model).eval()
        self._buf_i = 0
        # Inferenza in un solo passaggio per pila (vmap + CUDA graph).
        iu = cfg.env.inferenza_unica
        self.unica = (device.type == "cuda") if iu == "auto" else iu in ("si", "sì", "true", "1")
        base = learner.model
        comp = cfg.ppo.compila
        self.stacks = {"allievo": StackedPolicies(base, device, compila=comp), "copie": StackedPolicies(base, device, compila=comp)} if self.unica else None
        self._stack_names: dict[str, list[str]] = {"allievo": [], "copie": []}
        # Osservazioni verso la GPU. Se il simulatore scrive gia' in memoria bloccata
        # (`obs_tensor`), ogni meta' viene copiata con un DMA asincrono su uno stream a parte,
        # lanciato dal thread del simulatore appena finisce: il trasferimento si sovrappone al
        # calcolo dell'altra meta' e la CPU non copia piu' niente (prima: index_select delle
        # righe vive, ~0,7 s per raccolta). Altrimenti: righe vive raccolte in memoria bloccata.
        self._obs_pin = getattr(env, "obs_tensor", None) if device.type == "cuda" else None
        if self._obs_pin is not None:
            self._stage = torch.empty((N, lay.size), dtype=torch.float32, device=device)
            self._copy_stream = torch.cuda.Stream(device=device)
            self._copy_ev: dict[int, object] = {}
        self._pin = torch.empty((N, lay.size), dtype=torch.float32).pin_memory() if device.type == "cuda" and self._obs_pin is None else None
        self._obs_x = torch.zeros(N + 1, lay.size, dtype=torch.float16, device=device)   # riga N = fittizia, zero
        pin = (lambda n, dt: torch.empty(n, dtype=dt).pin_memory()) if device.type == "cuda" else (lambda n, dt: torch.empty(n, dtype=dt))
        self._prow = pin(N, torch.int64)
        # Un gioco di buffer PER PILA: le copie verso la GPU sono asincrone, e la pila
        # successiva non deve riscrivere un buffer che la precedente sta ancora copiando.
        self._pinbuf = {q: (pin(32 * (N + 64), torch.int64), pin(N, torch.int64), pin(N, torch.int64)) for q in ("allievo", "copie")}
        self._lock_cache: dict = {}
        self._scarto_pila = 0.0           # controllo di coerenza pila ↔ passaggio semplice (max |Δ| su turn_mu)
        self._controlli = 0

    # --- controllori ------------------------------------------------------------------------
    def model_for(self, cid: str) -> Policy:
        if cid == ALLIEVO:
            return self._behav
        m = self.cache.get(cid)
        if m is None:
            m = Policy(self.lay, self.nc).to(self.device)
            sd = torch.load(self.league.path_of(cid), map_location=self.device, weights_only=False)
            sd = sd.get("model", sd)
            m.load_state_dict({k: v.float() for k, v in sd.items()})
            m.eval()
            self.cache[cid] = m
        self.cache.move_to_end(cid)
        return m

    def in_use(self) -> set[str]:
        return {c for c in self.ctrl if c is not None and c != ALLIEVO}

    def prune_cache(self):
        """Toglie dalla memoria le istantanee che nessuna partita usa piu'."""
        used = self.in_use() | set(self.league.roster) | set(self.league.deboli)
        for cid in list(self.cache):
            if cid not in used:
                del self.cache[cid]

    # --- partite ---------------------------------------------------------------------------
    def _new_match(self, e: int) -> Match:
        if e in self.eval_envs:
            return self.mm.eval_match(e)
        if e in self.torneo_envs:
            return self.mm.tournament_match(e)
        return self.mm.training_match(e)

    def start(self):
        specs = {}
        for e in range(self.E):
            m = self._new_match(e)
            self.matches[e] = m
            specs[e] = m.spec
        self.env.reset_matches(specs)
        for e in range(self.E):
            self._assign(self.matches[e])

    def _assign(self, m: Match):
        info = self.env.info_view()
        base = m.env * self.P
        for k in range(self.P):
            n = base + k
            cid = m.slots[k] if k < len(m.slots) else None
            active = cid is not None and info[n, I["attivo"]] > 0
            self.ctrl[n] = cid if active else None
            self.alive[n] = active
            self.owner[n] = 0 if (active and not m.eval and cid == ALLIEVO) else -1
            # Ingresso ritardato (fase 2, situazione «attesa»): il posto non gioca finche' non entra.
            self.in_arrivo[n] = active and k in m.meta.get("ritardi", {})
            if self.in_arrivo[n]:
                self.alive[n] = False
            self.first[n] = True
            agents = m.spec.get("agents", [])
            self.ricco[n] = k < len(agents) and float(agents[k].get("start_balance", 0.0) or 0.0) > 1.0
            self.p_now[n] = 0.9 * max(float(agents[k].get("start_balance", 0.0) or 0.0), 1.0) - 1.0 if k < len(agents) else -0.1
            self.tick_prev[n] = -1.0
            self.t_ep[n] = 0.0
            self.p_max[n] = self.p_now[n]
            self.punti[n] = 0.0
            self.b_mio[n] = 0.0
            self.b_altrui[n] = 0.0
            self.cibo[n] = 0.0
            self.escursione[n] = 0.0
            self.pos_ok[n] = False
            self.n_tappe[n] = 0
            self.prossima[n] = 0.0
            self.fermo_s[n] = 0.0
            self.boost_s[n] = 0.0
        self.h[base:base + self.P] = 0
        self.charging[base:base + self.P] = False

    def _finish(self, envs: list[int]):
        """Chiude le partite indicate: risultati alla lega, poi partite nuove."""
        specs = {}
        for e in envs:
            m = self.matches[e]
            rows = participants(m, self.env.match_report(e), self.cfg.ricompensa, self.fase)
            self.league.record([(c, p, s) for c, p, s, _ in rows], train=not m.eval)
            for c, p, s, row in rows:
                if s is None and c != ALLIEVO:
                    self.league.registra_stile(c, row, p, torneo=m.kind == "torneo")
            if m.kind == "torneo":
                membri = set(m.slots) - {None}
                self.league.risultato_girone(m.meta["girone"], {c: p for c, p, s, _ in rows if c in membri})
            nm = self._new_match(e)
            self.matches[e] = nm
            specs[e] = nm.spec
            self.matches_done += 1
        if specs:
            self.env.reset_matches(specs)
            for e in envs:
                self._assign(self.matches[e])

    def lock_of(self, cid: str) -> bool:
        """Cashout bloccato: in fase 1 per tutti; in fase 2 per i checkpoint della fase 1
        (non l'hanno mai imparato: restano predatori che non escono)."""
        if self.fase == 1:
            return True
        return cid != ALLIEVO and self.league.fase_of(cid) == 1

    def _lock_rows(self, groups: dict):
        """Il blocco del cashout per le righe di `groups` (nell'ordine delle chiavi): un bool se
        e' uguale per tutte, altrimenti un tensore per riga."""
        locks = {c: self.lock_of(c) for c in groups}
        vals = set(locks.values())
        if len(vals) == 1:
            return vals.pop()
        return torch.as_tensor(np.concatenate([np.full(len(r), locks[c]) for c, r in groups.items()]), device=self.device)

    # --- inferenza in un passaggio -----------------------------------------------------------
    @torch.no_grad()
    def sync_allievo(self):
        """Copia i pesi attuali dell'allievo nella politica di raccolta (e nella sua pila)."""
        for d, s in zip(self._behav.parameters(), self.learner.model.parameters()):
            d.copy_(s.detach())
        for d, s in zip(self._behav.buffers(), self.learner.model.buffers()):
            d.copy_(s.detach())
        if self.unica:
            self._refresh_stacks({}, force_allievo=True)

    def _refresh_stacks(self, groups: dict, force_allievo: bool = False):
        """La pila «allievo» ha i pesi dell'allievo (ricopiati dopo ogni aggiornamento);
        la pila «copie» le istantanee in campo e chiunque sia in una partita."""
        copie = list(self.league.roster) + [d for d in self.league.deboli if d not in self.league.roster]
        copie += [c for c in groups if c not in copie and c != ALLIEVO]
        copie += [c for c in self.in_use() if c not in copie]
        voluti = {"allievo": [ALLIEVO], "copie": copie}
        for quale, names in voluti.items():
            if names and (names != self._stack_names[quale] or (quale == "allievo" and force_allievo)):
                self.stacks[quale].refresh({c: self.model_for(c) for c in names})
                self._stack_names[quale] = names

    def _step_stacked(self, groups: dict, act: torch.Tensor, b: dict, t: int):
        noti = set(self._stack_names["allievo"]) | set(self._stack_names["copie"])
        if any(c not in noti for c in groups):
            self._refresh_stacks(groups)
        for quale, stack in self.stacks.items():
            names = self._stack_names[quale]
            sub = {c: r for c, r in groups.items() if c in names}
            if sub:
                self._step_one_stack(quale, stack, names, sub, act, b, t)

    def _step_one_stack(self, quale: str, stack, names: list, groups: dict, act: torch.Tensor, b: dict, t: int):
        K, N = stack.K, self.N            # la capienza della pila (posti in avanzo: righe fittizie)
        M = max(len(v) for v in groups.values())
        M = next(g for g in GRADINI_M + (((M + 1023) // 1024) * 1024,) if g >= M)   # poche forme: poche compilazioni
        pidx, pflat, pit = self._pinbuf[quale]
        if K * M > pidx.numel():
            pidx = torch.empty(K * M * 2, dtype=torch.int64)
            pidx = pidx.pin_memory() if self.device.type == "cuda" else pidx
            self._pinbuf[quale] = (pidx, pflat, pit)
        # Indici (K, M): le righe vuote puntano alla riga fittizia N (osservazione zero).
        # Posizioni valide e righe calcolate sulla CPU: nessuna attesa della GPU.
        idx = pidx[:K * M].numpy().reshape(K, M)
        idx.fill(N)
        pos = {c: i for i, c in enumerate(names)}
        flats, its = [], []
        for c, rows in groups.items():
            i, n = pos[c], len(rows)
            idx[i, :n] = rows
            flats.append(np.arange(i * M, i * M + n))
            its.append(rows)
        flat_np, it_np = np.concatenate(flats), np.concatenate(its)
        n = len(it_np)
        pflat[:n].numpy()[:] = flat_np
        pit[:n].numpy()[:] = it_np
        dev = self.device
        idx_t = pidx[:K * M].to(dev, non_blocking=True).view(K, M)
        flat = pflat[:n].to(dev, non_blocking=True)
        it = pit[:n].to(dev, non_blocking=True)
        obs_x = self._obs_x[idx_t]
        h_x = torch.cat([self.h, self.h.new_zeros(1, self.h.shape[1])], 0)[idx_t]
        out, hn = stack.step(obs_x, h_x)
        self._controlli += 1
        if self._controlli % 200 == 0:
            # Coerenza: la pila deve dare lo stesso risultato del passaggio semplice del
            # modello vero (pesi freschi, indici giusti). Lo scarto finisce nel registro.
            c0 = next(iter(groups))
            i0, n0 = pos[c0], len(groups[c0])
            ref, _ = self.model_for(c0).step(obs_x[i0, :n0], h_x[i0, :n0])
            self._scarto_pila = max(self._scarto_pila, float((ref["turn_mu"] - out["turn_mu"][i0, :n0]).abs().max()))
        o = {k: x.reshape(K * M, *x.shape[2:])[flat] for k, x in out.items()}
        self.h[it] = hn.reshape(K * M, -1)[flat]
        ch = self.charging[it]
        turn, boost, cash, logp = self.codec.sample(o, ch, cash_lock=self._lock_rows(groups))
        newch = ch ^ cash
        act[it] = self.codec.to_sim(turn, boost, newch)
        self.charging[it] = newch
        b["turn"][t, it] = turn
        b["boost"][t, it] = boost
        b["cash"][t, it] = cash
        b["charging"][t, it] = ch
        b["logp"][t, it] = logp
        b["value"][t, it] = o["value"]

    # --- raccolta a meta' ----------------------------------------------------------------
    def _sim_half(self, k: int, act_np, t: int, rows: tuple, envs: tuple):
        """Nel thread: il passo di Rust (senza GIL), poi ricompense, episodi e partite nuove
        di questa meta'."""
        try:
            if hasattr(self.env, "step_half"):
                self.env.step_half(k, act_np)
            else:
                self.env.step_into(act_np)
            self._after_sim(t, rows, envs)
            if self._obs_pin is not None:
                # Le osservazioni nuove di questa meta' (anche delle partite appena
                # ricominciate) partono subito verso la GPU, in parallelo al resto.
                lo, hi = rows
                with torch.cuda.stream(self._copy_stream):
                    self._stage[lo:hi].copy_(self._obs_pin[lo:hi], non_blocking=True)
                    ev = torch.cuda.Event()
                    ev.record(self._copy_stream)
                self._copy_ev[k] = ev
        except BaseException as e:  # noqa: BLE001
            self._sim_error = e

    def _wait_half(self, k: int, pending: list):
        if pending[k] is None:
            return
        t0 = time.perf_counter()
        pending[k].join()
        self._t_sim += time.perf_counter() - t0        # solo il tempo NON coperto dall'inferenza
        pending[k] = None
        if self._sim_error is not None:
            err, self._sim_error = self._sim_error, None
            raise err

    def _infer_half(self, t: int, lo: int, hi: int, k: int = 0):
        """Le righe vive in [lo, hi) passano dalla rete; restituisce le azioni (numpy) di quelle righe."""
        b, N = self._buf, self.N
        rows = np.nonzero(self.alive[lo:hi])[0] + lo
        obs_np = self.env.obs_view()
        if self._obs_pin is not None:
            ev = self._copy_ev.pop(k, None)
            if ev is None:            # prima raccolta: nessuna copia in volo per questa meta'
                self._stage[lo:hi].copy_(self._obs_pin[lo:hi], non_blocking=True)
            else:
                torch.cuda.current_stream().wait_event(ev)
            self._obs_x[lo:hi] = self._stage[lo:hi].half()
        elif self._pin is not None:
            k = len(rows)
            if k:
                rows_c = torch.from_numpy(rows)
                torch.index_select(torch.from_numpy(obs_np), 0, rows_c, out=self._pin[:k])
                self._prow[:k].copy_(rows_c)
                rows_t = self._prow[:k].to(self.device, non_blocking=True)
                self._obs_x[rows_t] = self._pin[:k].to(self.device, non_blocking=True).half()
        else:
            self._obs_x[lo:hi] = torch.from_numpy(obs_np[lo:hi]).to(self.device).half()
        obs = self._obs_x[:N]
        b["obs"][t, lo:hi] = obs[lo:hi]
        self._raw["first"][t, lo:hi] = self.first[lo:hi]
        self.first[lo:hi] = False
        self._raw["owner"][t, lo:hi] = np.where(self.alive[lo:hi], self.owner[lo:hi], -1)
        act = self._act
        act[lo:hi] = 0.0
        groups: dict[str, list[int]] = defaultdict(list)
        for n in rows:
            groups[self.ctrl[n]].append(n)
        self._alive_rows += len(rows)
        if self.unica and groups:
            self._step_stacked(groups, act, b, t)
            groups = {}
        for cid, idx in groups.items():
            it = torch.as_tensor(idx, device=self.device)
            model = self.model_for(cid)
            out, hn = model.step(obs[it], self.h[it])
            self.h[it] = hn
            ch = self.charging[it]
            turn, boost, cash, logp = self.codec.sample(out, ch, cash_lock=self.lock_of(cid))
            newch = ch ^ cash
            act[it] = self.codec.to_sim(turn, boost, newch)
            self.charging[it] = newch
            b["turn"][t, it] = turn
            b["boost"][t, it] = boost
            b["cash"][t, it] = cash
            b["charging"][t, it] = ch
            b["logp"][t, it] = logp
            b["value"][t, it] = model.value_denorm(out["value"])
        return act[lo:hi].cpu().numpy()

    def _after_sim(self, t: int, rows: tuple, envs: tuple):
        """Ricompense, episodi finiti e partite finite per le righe [lo, hi) dopo il passo t."""
        rc, fase = self.cfg.ricompensa, self.fase
        lo, hi = rows
        elo, ehi = envs
        sl = slice(lo, hi)
        done = self.env.done_view()[sl]
        info = self.env.info_view()[sl]
        # Chi entra in ritardo comincia a giocare al primo snapshot valido (dal passo dopo).
        arrivati = self.in_arrivo[sl] & (info[:, I["valido"]] > 0)
        if arrivati.any():
            idx = np.nonzero(arrivati)[0] + lo
            self.in_arrivo[idx] = False
            self.alive[idx] = True
            self.first[idx] = True
        alive = self.alive[sl] & ~arrivati
        d = done.astype(bool) & alive
        motivo = info[:, I["motivo"]]
        dead = d & (motivo == 1)
        tr = d & (motivo == 3)
        valido = info[:, I["valido"]] > 0

        # Tempo di gioco di questo passo (tick del server fra due snapshot).
        tick = info[:, I["tick"]].astype(np.float64)
        prev = self.tick_prev[sl]
        dt = np.where(valido & (prev >= 0), np.clip((tick - prev) / TICK_HZ, 0.0, 0.25), 1.0 / 24.0).astype(np.float32)
        self.tick_prev[sl] = np.where(valido, tick, prev)
        # Profitto netto se incassasse adesso (come x[38]): solo per le statistiche.
        p_old = self.p_now[sl]
        p_new = np.where(valido, 0.9 * info[:, I["saldo"]] - 1.0, p_old).astype(np.float32)

        # I punti (ia/punti.py): caccia e raccolta di questo passo, e il premio del cashout
        # fatto da se' (fase 2; in fase 1 il cashout e' bloccato e il premio e' 0).
        mio, altrui, cibo = info[:, I["bottino_mio"]], info[:, I["bottino_altrui"]], info[:, I["cibo_passo"]]
        r = punti_caccia(rc, fase, info[:, I["uccisioni_passo"]], mio, altrui, cibo,
                         info[:, I["uccisioni_frontali_passo"]]).astype(np.float32)
        uscita = d & (motivo == 2)
        bonus = bonus_uscita(rc, fase, info[:, I["profitto_episodio"]], info[:, I["oro_uscita"]], info[:, I["nemici_uscita"]])
        r += np.where(uscita, bonus, 0.0).astype(np.float32)
        frontale = dead & (info[:, I["frontale"]] > 0.5)
        r -= np.where(frontale, penalita_frontale(rc, 1.0), 0.0).astype(np.float32)
        r[~alive] = 0.0
        self.punti[sl] += r
        self.b_mio[sl] += np.where(alive, mio, 0.0)
        self.b_altrui[sl] += np.where(alive, altrui, 0.0)
        self.cibo[sl] += np.where(alive, cibo, 0.0)

        # Contatori dell'episodio.
        in_campo = alive & ~d
        self.t_ep[sl] += np.where(alive, dt, 0.0)
        self.p_max[sl] = np.where(in_campo, np.maximum(self.p_max[sl], p_new), self.p_max[sl])
        self.p_now[sl] = np.where(in_campo, p_new, p_old)
        # Uso della mappa: distanza massima dal punto d'ingresso, e tempo col boost.
        xy = info[:, [I["x"], I["y"]]]
        nuovo = valido & alive & ~self.pos_ok[sl]
        self.pos0[sl] = np.where(nuovo[:, None], xy, self.pos0[sl])
        self.pos_ok[sl] |= nuovo
        dist = np.hypot(xy[:, 0] - self.pos0[sl][:, 0], xy[:, 1] - self.pos0[sl][:, 1])
        self.escursione[sl] = np.where(valido & alive, np.maximum(self.escursione[sl], dist), self.escursione[sl])
        self.boost_s[sl] += np.where(alive & valido & (info[:, I["boost"]] > 0.5), dt, 0.0).astype(np.float32)
        # Fermo in tondo (solo misura): posizione ogni FERMO_PASSO s; fermo se negli ultimi
        # ~8–10 s la testa si e' spostata meno di FERMO_U u.
        ri = np.arange(lo, hi)
        vivo = valido & alive & ~d
        tappa = vivo & (self.t_ep[sl] >= self.prossima[sl])
        if tappa.any():
            rt = ri[tappa]
            self.tappe[rt] = np.roll(self.tappe[rt], -1, axis=1)
            self.tappe[rt, -1] = xy[tappa]
            self.n_tappe[rt] += 1
            self.prossima[rt] += FERMO_PASSO
        pieno = self.n_tappe[sl] >= FERMO_TAPPE
        spost = np.hypot(xy[:, 0] - self.tappe[sl, 0, 0], xy[:, 1] - self.tappe[sl, 0, 1])
        self.fermo_s[sl] += np.where(vivo & pieno & (spost < FERMO_U), dt, 0.0).astype(np.float32)

        raw = self._raw
        raw["rew"][t, sl] = r
        raw["term"][t, sl] = d & ~tr
        raw["trunc"][t, sl] = tr
        raw["death"][t, sl] = dead
        raw["gold"][t, sl] = np.where(alive, info[:, I["oro_passo"]], 0.0)

        ended = np.nonzero(d)[0]
        if len(ended):
            with self._lock:
                for j in ended:
                    n = lo + j
                    m = self.matches[n // self.P]
                    if self.ctrl[n] != ALLIEVO or m is None or m.kind == "torneo":
                        continue
                    if m.kind == "allena" and self.owner[n] < 0:
                        continue
                    if m.kind == "banco" and n % self.P != 0:
                        continue
                    prof = float(info[j, I["profitto_episodio"]])
                    oro_u, nem_u = float(info[j, I["oro_uscita"]]), float(info[j, I["nemici_uscita"]])
                    ep = {
                        "motivo": int(motivo[j]), "profitto": prof,
                        "pagato": float(info[j, I["pagato"]]), "durata": float(info[j, I["durata_s"]]),
                        "uccisioni": int(info[j, I["uccisioni"]]), "muro": bool(info[j, I["muro"]]),
                        "frontale": bool(frontale[j]),
                        "taglia": float(info[j, I["taglia"]]), "ricco": bool(self.ricco[n]),
                        "punti": float(self.punti[n]), "bottino_mio": float(self.b_mio[n]),
                        "bottino_altrui": float(self.b_altrui[n]), "cibo": float(self.cibo[n]),
                        "uscita": tipo_uscita(rc, prof, oro_u, nem_u) if motivo[j] == 2 else None,
                        "oro_uscita": oro_u, "nemici_uscita": nem_u,
                        "p_max": float(self.p_max[n]), "raggiunto": bool(self.p_max[n] >= rc.obiettivo - 1e-4),
                        "escursione": float(self.escursione[n]),
                        "boost": float(self.boost_s[n] / max(self.t_ep[n], 1e-3)),
                        "fermo": float(self.fermo_s[n] / max(self.t_ep[n], 1e-3)),
                        "situazione": m.meta.get("situazione"),
                    }
                    if m.kind == "banco":
                        self.bench.record(m.scenario, ep)
                        self.eval_done.append({"scenario": m.scenario, **ep})
                    else:
                        self.episodes.append(ep)
            self.alive[lo + ended] = False
            self.charging[torch.as_tensor(lo + ended, device=self.device)] = False

        # --- partite finite ---------------------------------------------------------------
        ne = ehi - elo
        alive_e = self.alive[sl].reshape(ne, self.P)
        owned_e = (self.alive[sl] & (self.owner[sl] >= 0)).reshape(ne, self.P).any(1)
        fin = info.reshape(ne, self.P, -1)[:, 0, I["fine_partita"]] > 0
        to_close = []
        for j in range(ne):
            e = elo + j
            m = self.matches[e]
            if fin[j] or (m.kind == "torneo" and not alive_e[j].any()):
                to_close.append(e)
            elif m.kind == "banco":
                if not alive_e[j, 0]:
                    to_close.append(e)
            elif m.kind == "allena" and not owned_e[j]:
                # Nessun posto dell'allievo ancora in gioco: la partita non da' piu' dati.
                to_close.append(e)
        if to_close:
            with self._lock:
                self._finish(to_close)

    # --- raccolta --------------------------------------------------------------------------
    def _alloc(self, T):
        # Due buffer alternati: mentre l'allievo impara dal blocco precedente si scrive l'altro.
        if self._buf is None:
            self._bufs = [self._new_buf(T), self._new_buf(T)]
        self._buf_i ^= 1
        self._buf = self._bufs[self._buf_i]

    def _new_buf(self, T):
        N, D, dev = self.N, self.lay.size, self.device
        C = T // self.cfg.ppo.sequenza
        return dict(
            obs=torch.zeros(T, N, D, dtype=torch.float16, device=dev),
            turn=torch.zeros(T, N, device=dev),
            boost=torch.zeros(T, N, dtype=torch.bool, device=dev),
            cash=torch.zeros(T, N, dtype=torch.bool, device=dev),
            charging=torch.zeros(T, N, dtype=torch.bool, device=dev),
            logp=torch.zeros(T, N, device=dev),
            value=torch.zeros(T, N, device=dev),
            h0=torch.zeros(C, N, self.nc.memory, device=dev),
        )

    @torch.no_grad()
    def collect(self, sync: bool = True) -> tuple[Batch, dict]:
        """T passi su tutte le lobby, a META' ALTERNATE: mentre la meta' A viene simulata in
        un thread (Rust, senza GIL) la meta' B passa dalla rete sulla GPU, e viceversa."""
        pc = self.cfg.ppo
        T, L, N = pc.passi, pc.sequenza, self.N
        self._alloc(T)
        b = self._buf
        self._raw = dict(rew=np.zeros((T, N), np.float32), term=np.zeros((T, N), bool), trunc=np.zeros((T, N), bool),
                         first=np.zeros((T, N), bool), death=np.zeros((T, N), bool), gold=np.zeros((T, N), np.float32),
                         owner=np.full((T, N), -1, np.int64))
        rows_h = getattr(self.env, "row_ranges", [(0, N)])
        envs_h = getattr(self.env, "env_ranges", [(0, self.E)])
        self._act = torch.zeros(N, 3, device=self.device)
        self._t_inf = self._t_sim = 0.0
        self._alive_rows = 0
        if sync:
            # L'allievo e' appena stato aggiornato: la raccolta prende i pesi nuovi.
            self.sync_allievo()
        pending: list = [None] * len(rows_h)
        for t in range(T):
            if t % L == 0:
                b["h0"][t // L] = self.h
            for k, (lo, hi) in enumerate(rows_h):
                self._wait_half(k, pending)
                t0 = time.perf_counter()
                act_np = self._infer_half(t, lo, hi, k)
                self._t_inf += time.perf_counter() - t0
                th = threading.Thread(target=self._sim_half, args=(k, act_np, t, rows_h[k], envs_h[k]), daemon=True)
                th.start()
                pending[k] = th
                self.steps += 1
        for k in range(len(rows_h)):
            self._wait_half(k, pending)
        raw = self._raw

        # Valore dell'ultimo stato per chi e' ancora in gioco (la memoria non avanza: il
        # passo verra' rifatto, identico, all'inizio della prossima raccolta).
        last_value = torch.zeros(N, device=self.device)
        idx = np.nonzero(self.alive & (self.owner >= 0))[0]
        if len(idx):
            obs = torch.from_numpy(self.env.obs_view()[idx]).to(self.device).half()
            it = torch.as_tensor(idx, device=self.device)
            h = self.h[it] * torch.as_tensor(~self.first[idx], device=self.device).unsqueeze(-1).float()
            out, _ = self._behav.step(obs, h)
            last_value[it] = self._behav.value_denorm(out["value"])
        batch = Batch(obs=b["obs"], turn=b["turn"], boost=b["boost"], cash=b["cash"], charging=b["charging"],
                      logp=b["logp"], h0=b["h0"], value=b["value"].cpu().numpy(), last_value=last_value.cpu().numpy(),
                      rew=raw["rew"], term=raw["term"], trunc=raw["trunc"], first=raw["first"], death=raw["death"],
                      gold=raw["gold"], owner=raw["owner"], cash_lock=self.fase == 1)
        self.prune_cache()
        scarto, self._scarto_pila = self._scarto_pila, 0.0
        return batch, {"t_inferenza": self._t_inf, "t_simulatore": self._t_sim, "righe_vive": self._alive_rows / T,
                       "controllori": len(self.cache) + 1, "scarto_pila": scarto}
