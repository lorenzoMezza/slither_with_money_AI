"""La rete: un codificatore per ogni blocco dell'osservazione, una memoria
ricorrente e le teste di decisione.

    se stesso + cibo per settori ─► MLP ─────────────────────────┐
    raggi 32×4 ─► convoluzione CIRCOLARE (il cerchio non ha bordi) ┤
    io + 8 avversari + 8 ori ─► transformer a 3 strati (insieme,  ├─► tronco ─► GRU ─► teste
        ordine irrilevante: chi arriva prima su quale oro, chi    │      512      512
        chiude chi — ragionamenti a piu' passaggi)               │
    griglia 6×32×32 (±320 u) ─► CNN (corpi, varchi, chiusure) ────┤
    mappa 6×24×24 (±2400 u) ─► CNN (tutta l'arena: dove sono    ──┘
        gli altri, dove si combatte, dove c'e' spazio)

Ogni blocco arriva gia' egocentrico (x = dove guarda la testa) e normalizzato dal
simulatore, quindi la rete non usa statistiche di normalizzazione: una copia
congelata resta valida per sempre, cosa indispensabile per la lega.

La GRU e' la percezione del tempo: lo snapshot dice dove sono le cose ADESSO (con le
velocita' gia' calcolate), la memoria tiene cio' che non si vede in un fotogramma —
le intenzioni di un avversario, da quanto un oro e' in campo, se qualcuno ha appena
caricato il cashout, come si sta muovendo la partita.

Teste:
  svolta    CONTINUA: una gaussiana su u ∈ [−1, 1] (media dalla rete, deviazione imparata),
            mappata all'angolo con una curva quadratica, angolo = π·u·|u|: precisione fine
            vicino a zero, dove conta la mira, e portata piena fino a ±π
  boost     Bernoulli
  cashout   due Bernoulli in alternativa: «inizio» quando non si sta caricando,
            «interrompi» mentre si carica (il tasto va tenuto 3 s: un'unica moneta
            lanciata a ogni passo non arriverebbe mai in fondo)
  valore    in scala normalizzata (PopArt)
  ausiliarie morte entro ~2 s, oro raccolto entro ~5 s: insegnano alla rete a vedere
            pericoli e occasioni prima che arrivi la ricompensa
"""
from __future__ import annotations

import copy
import math
import threading
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.func import functional_call, stack_module_state, vmap

# La svolta: u ∈ [−1, 1] → angolo relativo = π·u·|u| (quadratica: a u = 0,1 corrispondono
# 0,03 rad, a u = 0,5 0,8 rad, a u = 1 il dietrofront). Il simulatore vuole angolo/π.
TURN_LOG_STD_INIT = math.log(0.25)


def turn_to_sim(u: torch.Tensor) -> torch.Tensor:
    """u → angolo/π, come lo vuole il simulatore (`turn` in [−1, 1])."""
    return u * u.abs()


def angle_to_turn(angle: float) -> float:
    """Angolo relativo (rad) → u (per leggere le azioni dalle sessioni registrate)."""
    a = max(-math.pi, min(math.pi, angle)) / math.pi
    return math.copysign(math.sqrt(abs(a)), a)


@dataclass(frozen=True)
class Layout:
    """Dove sta ogni blocco nel vettore di osservazione (da `SlitherVecEnv.layout()`)."""
    size: int
    self_off: int
    self_n: int
    rays_off: int
    rays: int
    ray_ch: int
    ent_off: int
    ents: int
    ent_n: int
    gold_off: int
    golds: int
    gold_n: int
    sec_off: int
    secs: int
    sec_n: int
    grid_off: int
    grid_ch: int
    grid: int
    map_off: int
    map_ch: int
    map: int

    @staticmethod
    def from_sim(lay: dict) -> "Layout":
        return Layout(
            size=lay["dimensione"],
            self_off=lay["se_stesso"]["inizio"], self_n=lay["se_stesso"]["n"],
            rays_off=lay["raggi"]["inizio"], rays=lay["raggi"]["raggi"], ray_ch=lay["raggi"]["canali"],
            ent_off=lay["avversari"]["inizio"], ents=lay["avversari"]["entita"], ent_n=lay["avversari"]["n"],
            gold_off=lay["oro"]["inizio"], golds=lay["oro"]["entita"], gold_n=lay["oro"]["n"],
            sec_off=lay["cibo"]["inizio"], secs=lay["cibo"]["settori"], sec_n=lay["cibo"]["n"],
            grid_off=lay["griglia"]["inizio"], grid_ch=lay["griglia"]["canali"], grid=lay["griglia"]["lato"],
            map_off=lay["mappa"]["inizio"], map_ch=lay["mappa"]["canali"], map=lay["mappa"]["lato"],
        )

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class NetConfig:
    # Dimensionata sulla GPU dell'M5 (~1 TFLOPS effettivo): la capacita' sta dove serve
    # il ragionamento (le relazioni fra entita' e la memoria), il resto resta snello.
    d_ent: int = 128        # larghezza dei token del transformer
    ent_layers: int = 3     # piu' strati = ragionamenti a piu' passaggi («lui va li', l'altro lo chiude»)
    ent_heads: int = 4
    rays_ch: int = 32
    grid_patch: int = 4     # la griglia 32×32 diventa 8×8 «toppe» da 4×4 celle (80 u)
    grid_ch: int = 64
    map_patch: int = 3      # la mappa 24×24 diventa 8×8 toppe da 3×3 celle (600 u)
    block: int = 256        # uscita di ogni codificatore
    torso: int = 512
    memory: int = 512       # stato della GRU


def _mlp(i: int, h: int, o: int) -> nn.Sequential:
    return nn.Sequential(nn.Linear(i, h), nn.GELU(), nn.Linear(h, o))


class AttentionBlock(nn.Module):
    """Blocco transformer pre-norm, scritto a mano: su MPS e' piu' rapido di quello di torch."""

    def __init__(self, d: int, heads: int):
        super().__init__()
        self.h = heads
        self.n1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.o = nn.Linear(d, d)
        self.n2 = nn.LayerNorm(d)
        self.ff = _mlp(d, 2 * d, d)

    def forward(self, x, bias):                    # bias: (B, 1, 1, N), −1e4 sui token assenti
        b, n, d = x.shape
        q, k, v = self.qkv(self.n1(x)).reshape(b, n, 3, self.h, d // self.h).permute(2, 0, 3, 1, 4)
        w = (q @ k.transpose(-1, -2)) * (d // self.h) ** -0.5 + bias
        a = w.softmax(-1) @ v
        x = x + self.o(a.transpose(1, 2).reshape(b, n, d))
        return x + self.ff(self.n2(x))


class EntityEncoder(nn.Module):
    """Io, gli avversari e gli ori come insieme di token: l'attenzione confronta ogni
    coppia (quale avversario arriva prima su quell'oro, chi mi sta tagliando la strada)."""

    def __init__(self, lay: Layout, nc: NetConfig, self_in: int):
        super().__init__()
        d = nc.d_ent
        self.lay = lay
        self.self_tok = _mlp(self_in, d, d)
        self.ent_tok = _mlp(lay.ent_n, d, d)
        self.gold_tok = _mlp(lay.gold_n, d, d)
        self.type_emb = nn.Parameter(torch.zeros(3, d))
        nn.init.normal_(self.type_emb, std=0.02)
        self.blocks = nn.ModuleList([AttentionBlock(d, nc.ent_heads) for _ in range(nc.ent_layers)])
        self.norm = nn.LayerNorm(d)
        self.out = nn.Linear(4 * d, nc.block)

    def forward(self, self_x, ents, golds):
        b = self_x.shape[0]
        ent_mask = ents[..., 0] > 0.5                      # presenti
        gold_mask = golds[..., 0] > 0.5
        tok = torch.cat([
            self.self_tok(self_x).unsqueeze(1) + self.type_emb[0],
            self.ent_tok(ents) + self.type_emb[1],
            self.gold_tok(golds) + self.type_emb[2],
        ], 1)
        valid = torch.cat([torch.ones(b, 1, dtype=torch.bool, device=tok.device), ent_mask, gold_mask], 1)
        # Il token «io» c'e' sempre: nessuna riga e' tutta mascherata.
        bias = ((~valid).to(tok.dtype) * -1e4).reshape(b, 1, 1, -1)
        h = tok
        for blk in self.blocks:
            h = blk(h, bias)
        h = self.norm(h)
        ne = self.lay.ents
        e_h, g_h = h[:, 1:1 + ne], h[:, 1 + ne:]
        em, gm = ent_mask.unsqueeze(-1).float(), gold_mask.unsqueeze(-1).float()
        e_mean = (e_h * em).sum(1) / em.sum(1).clamp(min=1.0)
        e_max = (e_h + (em - 1.0) * 1e4).amax(1) * em.amax(1)     # 0 se nessun avversario
        g_mean = (g_h * gm).sum(1) / gm.sum(1).clamp(min=1.0)
        return F.gelu(self.out(torch.cat([h[:, 0], e_mean, e_max, g_mean], -1)))


class RayEncoder(nn.Module):
    """32 raggi attorno alla testa: convoluzione circolare (il raggio 31 confina col 0),
    poi appiattita perche' la direzione conta (davanti non e' come dietro)."""

    def __init__(self, lay: Layout, nc: NetConfig):
        super().__init__()
        c = nc.rays_ch
        self.lay = lay
        self.c1 = nn.Conv1d(lay.ray_ch, c, 5, padding=2, padding_mode="circular")
        self.c2 = nn.Conv1d(c, c, 5, padding=2, padding_mode="circular")
        self.out = nn.Linear(c * lay.rays + lay.rays * lay.ray_ch, nc.block)

    def forward(self, rays):                       # (B, raggi, canali)
        x = rays.transpose(1, 2)
        y = F.gelu(self.c2(F.gelu(self.c1(x))))
        # Anche i valori grezzi: la distanza esatta del muro davanti non va sfocata.
        return F.gelu(self.out(torch.cat([y.flatten(1), rays.flatten(1)], -1)))


class GridEncoder(nn.Module):
    """Una griglia egocentrica: le FORME — un corpo che si chiude a cerchio, un varco,
    dove finisce lo spazio sicuro (griglia fine), o dove sono gli altri e dove si
    combatte in tutta l'arena (mappa larga).

    Prima «toppe» proiettate linearmente (nessuna cella si perde: la proiezione vede
    ognuna delle celle di ogni canale), poi convoluzioni 3×3 sulla mappa 8×8 delle
    toppe per i rapporti fra toppe vicine. `log_ch`: canali che sono conteggi o somme,
    in scala logaritmica perche' restino confrontabili."""

    def __init__(self, in_ch: int, side: int, patch: int, width: int, out: int, log_ch: tuple):
        super().__init__()
        log = torch.zeros(in_ch, dtype=torch.bool)
        log[list(log_ch)] = True
        self.register_buffer("log", log, persistent=False)
        self.net = nn.Sequential(
            nn.Conv2d(in_ch, width, patch, stride=patch), nn.GELU(),       # 8×8
            nn.Conv2d(width, 48, 3, padding=1), nn.GELU(),
            nn.Conv2d(48, 32, 3, padding=1), nn.GELU(),
        )
        n = side // patch
        self.out = nn.Linear(32 * n * n, out)

    def forward(self, g):
        m = self.log.reshape(1, -1, 1, 1)
        g = torch.where(m, torch.log1p(g.clamp(min=0)), g)
        return F.gelu(self.out(self.net(g).flatten(1)))


class Policy(nn.Module):
    def __init__(self, lay: Layout, nc: NetConfig | None = None):
        super().__init__()
        nc = nc or NetConfig()
        self.lay, self.nc = lay, nc
        self.mixed = True
        self_in = lay.self_n + lay.secs * lay.sec_n
        self.self_enc = nn.Sequential(nn.Linear(self_in, 128), nn.GELU(), nn.Linear(128, 128), nn.GELU())
        self.ent_enc = EntityEncoder(lay, nc, self_in)
        self.ray_enc = RayEncoder(lay, nc)
        self.grid_enc = GridEncoder(lay.grid_ch, lay.grid, nc.grid_patch, nc.grid_ch, nc.block, log_ch=(2, 3))
        self.map_enc = GridEncoder(lay.map_ch, lay.map, nc.map_patch, nc.grid_ch, nc.block, log_ch=(0, 2, 3, 5))
        self.torso = nn.Sequential(nn.Linear(128 + 4 * nc.block, nc.torso), nn.LayerNorm(nc.torso), nn.GELU())
        self.gru = nn.GRUCell(nc.torso, nc.memory)
        self.mem_norm = nn.LayerNorm(nc.memory)
        w = nc.torso
        self.post = nn.Sequential(nn.Linear(nc.memory + nc.torso, w), nn.GELU(), nn.Linear(w, w), nn.GELU())
        self.turn = nn.Linear(w, 1)                # media di u
        self.turn_log_std = nn.Parameter(torch.full((1,), TURN_LOG_STD_INIT))
        self.boost = nn.Linear(w, 1)
        self.cash = nn.Linear(w, 2)                # [inizio, interrompi]
        self.value = nn.Linear(w, 1)
        self.aux = nn.Linear(w, 2)                 # [morte entro ~2 s (logit), oro entro ~5 s]
        for head in (self.turn, self.boost, self.cash):
            nn.init.orthogonal_(head.weight, 0.01)
            nn.init.zeros_(head.bias)
        # Priori iniziali, poi li decide la ricompensa: boost raro (costa massa), cashout
        # raro da iniziare (~1 volta ogni 45 s) e raro da interrompere una volta iniziato.
        with torch.no_grad():
            self.boost.bias.fill_(-1.5)
            self.cash.bias.copy_(torch.tensor([-7.0, -5.0]))
        nn.init.orthogonal_(self.value.weight, 1.0)
        nn.init.zeros_(self.value.bias)
        # PopArt: il valore esce normalizzato; media e scala dei ritorni stanno qui.
        self.register_buffer("ret_mu", torch.zeros(1))
        self.register_buffer("ret_sigma", torch.ones(1))

    @property
    def memory(self) -> int:
        return self.nc.memory

    def initial_state(self, n: int, device) -> torch.Tensor:
        return torch.zeros(n, self.nc.memory, device=device)

    def encode(self, obs: torch.Tensor) -> torch.Tensor:
        """(B, D) → (B, torso): tutto cio' che non dipende dal tempo, in un colpo solo."""
        L = self.lay
        o = obs.float()
        selfv = torch.cat([o[:, L.self_off:L.self_off + L.self_n], o[:, L.sec_off:L.sec_off + L.secs * L.sec_n]], -1)
        rays = o[:, L.rays_off:L.rays_off + L.rays * L.ray_ch].reshape(-1, L.rays, L.ray_ch)
        ents = o[:, L.ent_off:L.ent_off + L.ents * L.ent_n].reshape(-1, L.ents, L.ent_n)
        golds = o[:, L.gold_off:L.gold_off + L.golds * L.gold_n].reshape(-1, L.golds, L.gold_n)
        grid = o[:, L.grid_off:L.grid_off + L.grid_ch * L.grid * L.grid].reshape(-1, L.grid_ch, L.grid, L.grid)
        mp = o[:, L.map_off:L.map_off + L.map_ch * L.map * L.map].reshape(-1, L.map_ch, L.map, L.map)
        # I codificatori (la parte costosa) in bfloat16 sulla GPU; memoria e teste in fp32.
        with torch.autocast(o.device.type, dtype=torch.bfloat16, enabled=self.mixed and o.device.type in ("mps", "cuda"), cache_enabled=False):
            z = torch.cat([self.self_enc(selfv), self.ray_enc(rays), self.ent_enc(selfv, ents, golds),
                           self.grid_enc(grid), self.map_enc(mp)], -1)
            x = self.torso(z)
        return x.float()

    def heads(self, mem: torch.Tensor, x: torch.Tensor) -> dict:
        y = self.post(torch.cat([self.mem_norm(mem), x], -1))
        cash = self.cash(y)
        return {
            "turn_mu": self.turn(y).squeeze(-1),
            "turn_log_std": self.turn_log_std.expand(y.shape[0]),
            "boost": self.boost(y).squeeze(-1),
            "cash_start": cash[..., 0],
            "cash_abort": cash[..., 1],
            "value": self.value(y).squeeze(-1),
            "aux": self.aux(y),
        }

    def step(self, obs: torch.Tensor, h: torch.Tensor):
        """Un passo (raccolta): obs (B, D), memoria (B, H) → uscite, nuova memoria."""
        x = self.encode(obs)
        h = self.gru(x, h)
        return self.heads(h, x), h

    forward = step          # per `functional_call` (StackedPolicies)

    def unroll(self, obs: torch.Tensor, h0: torch.Tensor, first: torch.Tensor, pos: torch.Tensor | None = None,
               reset_any: bool = True):
        """Una sequenza (addestramento): h0 (B, H), first (B, T) = inizio di episodio (la
        memoria si azzera prima di quel passo; `reset_any=False` dice che non ce n'e'
        nessuno nel lotto, deciso sulla CPU senza interrogare la GPU).

        Senza `pos`: obs (B, T, D), uscite per tutti i B·T passi. Con `pos` (K,) =
        indici piatti in B·T dei soli passi che servono (B·T = riga fittizia di
        riempimento): obs (K, D), uscite (K, …). I
        codificatori, la parte costosa, girano solo su quei passi; gli altri entrano
        nella GRU come zeri. E' esatto se ogni tratto utile comincia con l'inizio della
        sequenza o con un `first` (in raccolta: una partita nuova azzera la memoria)."""
        b, t = first.shape
        if pos is None:
            x = self.encode(obs.reshape(b * t, -1))
        else:
            # `pos` puo' contenere l'indice b·t: una riga fittizia per riempire il lotto
            # fino a una dimensione fissa (su MPS ogni forma nuova si ricompila).
            xk = self.encode(obs)
            x = xk.new_zeros(b * t + 1, xk.shape[-1]).index_copy(0, pos, xk)[:b * t]
        x = x.view(b, t, -1)
        h, hs = h0, []
        if reset_any:
            keep = (1.0 - first.float()).unsqueeze(-1)
            for k in range(t):
                h = self.gru(x[:, k], h * keep[:, k])
                hs.append(h)
        else:
            # Nessun inizio di episodio nel lotto: niente maschera (un kernel in meno per passo).
            for k in range(t):
                h = self.gru(x[:, k], h)
                hs.append(h)
        mem = torch.stack(hs, 1).reshape(b * t, -1)
        if pos is None:
            return self.heads(mem, x.reshape(b * t, -1))
        mem = torch.cat([mem, mem.new_zeros(1, mem.shape[1])])
        return self.heads(mem[pos], xk)

    # --- PopArt ---------------------------------------------------------------------------
    def value_denorm(self, v: torch.Tensor) -> torch.Tensor:
        return v * self.ret_sigma + self.ret_mu

    @torch.no_grad()
    def popart_update(self, mu: float, sigma: float):
        """Nuove statistiche dei ritorni, preservando le uscite gia' imparate."""
        old_mu, old_sigma = self.ret_mu.clone(), self.ret_sigma.clone()
        new_mu = torch.tensor([mu], device=old_mu.device)
        new_sigma = torch.tensor([max(sigma, 1e-3)], device=old_mu.device)
        self.value.weight.mul_(old_sigma / new_sigma)
        self.value.bias.mul_(old_sigma).add_(old_mu - new_mu).div_(new_sigma)
        self.ret_mu.copy_(new_mu)
        self.ret_sigma.copy_(new_sigma)


def count_params(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters())


GRADINI_K = (1, 4, 8, 12, 16, 24, 32)

# torch.compile (dynamo) non e' thread-safe: aggiornamento dell'allievo (thread suo) e
# catture delle pile di raccolta non devono compilare insieme. Chi puo' compilare lo prende.
COMPILE_LOCK = threading.RLock()


class StackedPolicies:
    """K politiche con la stessa architettura in UN solo passaggio: i pesi sono impilati
    (K, …) e la rete gira con `vmap` su obs (K, M, D) e memoria (K, M, H). Serve in
    raccolta: con 8–12 controllori diversi in campo, 8–12 passaggi da poche righe
    tenevano la GPU a lanciare kernel invece che a calcolare. Su CUDA il passaggio e'
    anche registrato come CUDA graph per ogni forma (K, M) vista: un solo lancio.

    I pesi degli allievi cambiano a ogni aggiornamento: `refresh` li ricopia NEI
    tensori impilati (stesso indirizzo, cosi' i graph restano validi); se cambia
    l'insieme dei controllori si rifa' la pila e i graph vengono buttati."""

    def __init__(self, base: Policy, device, cuda_graph: bool = True, compila: bool = False):
        self.base = copy.deepcopy(base).to("meta")
        # torch.compile (inductor) fonde i tanti piccoli kernel del transformer: ~1,5–2× righe/s
        # misurato su RTX 5090. Una compilazione (~13 s) per forma (K, M): le M sono a gradini.
        self._run_c = None
        if compila and device.type == "cuda":
            import torch._dynamo
            torch._dynamo.config.cache_size_limit = max(torch._dynamo.config.cache_size_limit, 256)
            self._run_c = torch.compile(self._run, dynamic=False)
        self.device = device
        self.cuda_graph = cuda_graph and device.type == "cuda"
        self.names: list[str] = []
        self.params: dict = {}
        self.buffers: dict = {}
        self.graphs: dict = {}
        self.graph_ok = True
        self.cap = 0

    def refresh(self, models: dict):
        """Mette in pila i controllori dati. La pila ha una CAPIENZA a gradini (4, 8, 12, …):
        se cambiano i nomi ma la capienza basta, i pesi si ricopiano sul posto e i CUDA graph
        (e le compilazioni) restano validi; i posti in avanzo ripetono il primo controllore e
        ricevono solo righe fittizie. Prima ogni cambio della rosa costava ~20 s di
        ricompilazione."""
        names = list(models)
        cap = next(c for c in GRADINI_K + (len(names),) if c >= len(names))
        mods = list(models.values())
        if cap != self.cap or not self.params:
            # stack_module_state vuole lo stesso modo per tutti (allievi in train, copie in eval;
            # la rete non ha dropout ne' batchnorm, quindi il modo non cambia nulla).
            modes = [m.training for m in mods]
            for m in mods:
                m.eval()
            with torch.no_grad():
                p, b = stack_module_state(mods + [mods[0]] * (cap - len(mods)))
            for m, tr in zip(mods, modes):
                m.train(tr)
            self.params = {k: v.detach().clone() for k, v in p.items()}
            self.buffers = {k: v.detach().clone() for k, v in b.items()}
            self.names, self.cap = names, cap
            self.graphs.clear()
            return
        with torch.no_grad():
            for i, m in enumerate(mods):
                for k, v in m.named_parameters():
                    self.params[k][i].copy_(v.detach())
                for k, v in m.named_buffers():
                    self.buffers[k][i].copy_(v.detach())
        self.names = names

    @property
    def K(self) -> int:
        """Posti della pila (la capienza): le osservazioni vanno date come (K, M, D)."""
        return self.cap

    def _run(self, obs: torch.Tensor, h: torch.Tensor):
        def one(p, b, o, hh):
            return functional_call(self.base, (p, b), (o, hh))
        out, hn = vmap(one)(self.params, self.buffers, obs, h)
        out["value"] = out["value"] * self.buffers["ret_sigma"].view(-1, 1) + self.buffers["ret_mu"].view(-1, 1)
        return out, hn

    @torch.no_grad()
    def step(self, obs: torch.Tensor, h: torch.Tensor):
        """obs (K, M, D) in fp16/fp32, h (K, M, H) → uscite (K, M, …) con il valore gia'
        denormalizzato, nuova memoria (K, M, H)."""
        if not (self.cuda_graph and self.graph_ok):
            return self._run(obs, h)
        key = tuple(obs.shape)
        g = self.graphs.get(key)
        if g is None:
            if len(self.graphs) >= 64:
                self.graphs.clear()
            try:
                COMPILE_LOCK.acquire()
                st_obs, st_h = obs.clone(), h.clone()
                s = torch.cuda.Stream()
                s.wait_stream(torch.cuda.current_stream())
                with torch.cuda.stream(s):
                    for _ in range(2):
                        (self._run_c or self._run)(st_obs, st_h)
                torch.cuda.current_stream().wait_stream(s)
                graph = torch.cuda.CUDAGraph()
                # thread_local: l'aggiornamento dell'allievo puo' girare in un altro thread
                # mentre si cattura (raccolta e aggiornamento sovrapposti).
                with torch.cuda.graph(graph, capture_error_mode="thread_local"):
                    st_out, st_hn = (self._run_c or self._run)(st_obs, st_h)
                g = self.graphs[key] = (graph, st_obs, st_h, st_out, st_hn)
                COMPILE_LOCK.release()
            except Exception as e:  # noqa: BLE001
                COMPILE_LOCK.release()
                print(f"  · CUDA graph non disponibile ({type(e).__name__}: {str(e)[:80]}): inferenza vettoriale senza graph", flush=True)
                self.graph_ok = False
                self.graphs.clear()
                return self._run(obs, h)
        graph, st_obs, st_h, st_out, st_hn = g
        st_obs.copy_(obs)
        st_h.copy_(h)
        graph.replay()
        return st_out, st_hn
