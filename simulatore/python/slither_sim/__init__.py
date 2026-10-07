"""Simulatore di moneyslither.com per l'addestramento: l'interfaccia Python.

Carica la libreria Rust (``target/release/libsimulatore.*``) con ctypes: nessuna
compilazione lato Python. Richiede numpy.

    from slither_sim import SlitherVecEnv
    env = SlitherVecEnv(num_envs=64, seed=1)
    obs, info = env.reset()
    obs, rew, done, info = env.step(actions)   # actions: (N, 3) = [svolta, boost, cashout]

Un passo = uno snapshot del server: l'agente decide sullo snapshot appena
arrivato (in ritardo, come online), il suo input viaggia verso il server e il mondo
avanza fino allo snapshot successivo (1-4 tick, come il server vero).

Azione (float32, per agente):
  [0] svolta in [-1, 1]: la direzione desiderata e' quella osservata + svolta·π
      (con ``action_mode="assoluto"`` e' invece il targetDir in radianti)
  [1] boost     > 0.5 = premuto
  [2] cashout   > 0.5 = tenuto premuto (dopo 3000 ms il client manda il cashout;
      rilasciare prima azzera la carica)

Ricompensa: variazione dell'equity / posta, dove l'equity e' il VALORE D'INCASSO del
saldo (saldo × 0,9): 0 alla morte, il pagato al cashout (che quindi vale 0 come
passo). La somma su un episodio e' il profitto a meno di una costante, la commissione
sulla posta iniziale: −0,9 se muori, 0,9·saldo/posta − 0,9 se incassi. Cosi' la
commissione e' gia' pagata in ogni istante e rimandare l'uscita non la rimanda.
`info["profitto_episodio"]` e' invece il profitto vero (incassato − posta) / posta.
In modalita' partita, allo scadere del tempo chi e' in campo incassa con la stessa
commissione (motivo 4): la sessione finisce sempre o con la morte o con un cashout.
"""
from __future__ import annotations

import ctypes
import json
import os
import platform
from pathlib import Path

import numpy as np

INFO_NAMES = (
    "motivo", "saldo", "taglia", "pagato", "durata_s", "valido", "vivi",
    "progresso_cashout", "profitto_episodio", "uccisioni", "muro", "tick",
    "fine_partita", "attivo", "uccisioni_passo", "oro_passo", "x", "y", "boost",
    "bottino_mio", "bottino_altrui", "cibo_passo", "oro_uscita", "nemici_uscita", "frontale",
    "uccisioni_frontali_passo",
)
MOTIVI = {0: "in corso", 1: "morte", 2: "cashout", 3: "troncato", 4: "cashout a fine partita"}

_ROOT = Path(__file__).resolve().parents[2]


def _find_library(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    if os.environ.get("SLITHER_SIM_LIB"):
        return os.environ["SLITHER_SIM_LIB"]
    ext = {"Darwin": "dylib", "Windows": "dll"}.get(platform.system(), "so")
    prefix = "" if ext == "dll" else "lib"
    for build in ("release", "debug"):
        p = _ROOT / "target" / build / f"{prefix}simulatore.{ext}"
        if p.exists():
            return str(p)
    raise FileNotFoundError("libreria non trovata: esegui `cargo build --release` nella cartella simulatore/")


class _Lib:
    _cache: dict[str, ctypes.CDLL] = {}

    @classmethod
    def load(cls, path: str) -> ctypes.CDLL:
        if path in cls._cache:
            return cls._cache[path]
        lib = ctypes.CDLL(path)
        f32p = ctypes.POINTER(ctypes.c_float)
        u8p = ctypes.POINTER(ctypes.c_uint8)
        vp = ctypes.c_void_p
        sz = ctypes.c_size_t
        cp = ctypes.c_char_p
        sigs = {
            "sim_obs_size": ([], sz), "sim_action_size": ([], sz), "sim_info_size": ([], sz),
            "sim_layout_json": ([cp, sz], sz), "sim_last_error": ([cp, sz], sz),
            "sim_new": ([cp], vp), "sim_free": ([vp], None),
            "sim_num_envs": ([vp], sz), "sim_agents_per_env": ([vp], sz),
            "sim_params_json": ([vp, sz, cp, sz], sz), "sim_set_action_mode": ([vp, ctypes.c_int], None),
            "sim_reset": ([vp, f32p, f32p], None), "sim_step": ([vp, f32p, f32p, f32p, u8p, f32p], None),
            "sim_snapshot_json": ([vp, sz, sz, cp, sz], sz), "sim_agent_id": ([vp, sz, sz, cp, sz], sz),
            "sim_viewer_start": ([vp, sz, ctypes.c_uint16], ctypes.c_uint16), "sim_set_realtime": ([vp, ctypes.c_double], None),
            "sim_record_start": ([vp, sz, cp], ctypes.c_int), "sim_record_stop": ([vp, sz], None),
            "sim_reset_matches": ([vp, cp, f32p, f32p], ctypes.c_int),
            "sim_match_report": ([vp, sz, cp, sz], sz),
            "sim_set_human": ([vp, sz, ctypes.c_int64], None),
            "sim_featurizer_new": ([], vp), "sim_featurizer_free": ([vp], None),
            "sim_featurizer_push": ([vp, cp, cp, f32p, f32p], ctypes.c_int),
        }
        for name, (args, res) in sigs.items():
            fn = getattr(lib, name)
            fn.argtypes = args
            fn.restype = res
        cls._cache[path] = lib
        return lib


def _string(fn, *args) -> str:
    n = fn(*args, None, 0)
    buf = ctypes.create_string_buffer(n + 1)
    fn(*args, buf, n + 1)
    return buf.value.decode("utf-8", "replace")


def _ptr(a: np.ndarray, ctype):
    return a.ctypes.data_as(ctypes.POINTER(ctype))


class SlitherVecEnv:
    """Molti mondi (lobby) in parallelo; `agents_per_env` agenti in ciascuno.

    Gli array hanno una riga per agente: N = num_envs · agents_per_env.
    Ogni mondo randomizza i parametri incerti se ``randomize=True``.
    """

    def __init__(self, num_envs: int = 16, agents_per_env: int = 1, seed: int = 1, *,
                 randomize: bool = False, analizer: str | None = "auto", action_mode: str = "relativo",
                 lobby: dict | None = None, reward: dict | None = None, params: dict | None = None,
                 max_episode_s: float = 600.0, rejoin_delay_s: float = 1.0, decision_ms: float = 0.0,
                 match_mode: bool = False, lib_path: str | None = None):
        self._lib = _Lib.load(_find_library(lib_path))
        if analizer == "auto":
            cand = _ROOT.parent / "analizer" / "estratto" / "simulatore.json"
            analizer = str(cand) if cand.exists() else None
        cfg: dict = {
            "num_envs": num_envs, "agents_per_env": agents_per_env, "seed": seed,
            "max_episode_s": max_episode_s, "rejoin_delay_s": rejoin_delay_s, "decision_ms": decision_ms,
            "randomize": {"enabled": bool(randomize)},
            "match_mode": bool(match_mode),
        }
        if analizer:
            cfg["analizer"] = analizer
        if lobby:
            cfg["lobby"] = lobby
        if reward:
            cfg["reward"] = reward
        if params:
            cfg["params"] = params
        self._h = self._lib.sim_new(json.dumps(cfg).encode())
        if not self._h:
            raise ValueError(_string(self._lib.sim_last_error))
        self._lib.sim_set_action_mode(self._h, 1 if action_mode == "assoluto" else 0)
        self.num_envs = self._lib.sim_num_envs(self._h)
        self.agents_per_env = self._lib.sim_agents_per_env(self._h)
        self.n = self.num_envs * self.agents_per_env
        self.obs_size = self._lib.sim_obs_size()
        self.action_size = self._lib.sim_action_size()
        self.info_size = self._lib.sim_info_size()
        n = max(self.n, 1)
        self._obs = np.zeros((n, self.obs_size), np.float32)
        self._rew = np.zeros(n, np.float32)
        self._done = np.zeros(n, np.uint8)
        self._info = np.zeros((n, self.info_size), np.float32)

    # --- ciclo ------------------------------------------------------------------------
    def reset(self):
        self._lib.sim_reset(self._h, _ptr(self._obs, ctypes.c_float), _ptr(self._info, ctypes.c_float))
        return self._obs.copy(), self._info_dict()

    def step(self, actions):
        a = np.ascontiguousarray(actions, dtype=np.float32).reshape(max(self.n, 1), self.action_size)
        self._lib.sim_step(self._h, _ptr(a, ctypes.c_float), _ptr(self._obs, ctypes.c_float),
                           _ptr(self._rew, ctypes.c_float), _ptr(self._done, ctypes.c_uint8), _ptr(self._info, ctypes.c_float))
        return self._obs.copy(), self._rew.copy(), self._done.astype(bool), self._info_dict()

    def reset_matches(self, specs: dict[int, dict]):
        """Nuove partite (modalita' partita) nei mondi indicati: {indice: MatchSpec}.

        Le osservazioni e le info di quei mondi vengono riscritte nei buffer interni;
        `obs_view()` / `info_view()` le restituiscono senza copie.
        """
        if not specs:
            return
        ok = self._lib.sim_reset_matches(self._h, json.dumps({str(k): v for k, v in specs.items()}).encode(),
                                         _ptr(self._obs, ctypes.c_float), _ptr(self._info, ctypes.c_float))
        if not ok:
            raise ValueError(_string(self._lib.sim_last_error))

    def match_report(self, env: int) -> list[dict]:
        """Risultato di tutti i partecipanti (bot compresi) della partita del mondo `env`."""
        return json.loads(_string(self._lib.sim_match_report, self._h, env))

    def step_into(self, actions):
        """Come `step`, ma senza copie: restituisce i buffer interni (validi fino al passo dopo)."""
        a = np.ascontiguousarray(actions, dtype=np.float32).reshape(max(self.n, 1), self.action_size)
        self._lib.sim_step(self._h, _ptr(a, ctypes.c_float), _ptr(self._obs, ctypes.c_float),
                           _ptr(self._rew, ctypes.c_float), _ptr(self._done, ctypes.c_uint8), _ptr(self._info, ctypes.c_float))
        return self._obs, self._rew, self._done, self._info

    def obs_view(self):
        return self._obs

    def info_view(self):
        return self._info

    def rew_view(self):
        return self._rew

    def done_view(self):
        return self._done

    def _info_dict(self):
        return {name: self._info[:, i].copy() for i, name in enumerate(INFO_NAMES)}

    # --- strumenti --------------------------------------------------------------------
    def layout(self) -> dict:
        """Blocchi del vettore di osservazione."""
        return json.loads(_string(self._lib.sim_layout_json))

    def params(self, env: int = 0) -> dict:
        """Parametri effettivi del mondo `env` (dopo l'eventuale randomizzazione)."""
        return json.loads(_string(self._lib.sim_params_json, self._h, env))

    def snapshot(self, env: int = 0, agent: int = 0) -> dict:
        """L'ultimo snapshot ricevuto dall'agente, nel JSON del server vero."""
        s = _string(self._lib.sim_snapshot_json, self._h, env, agent)
        return json.loads(s) if s else {}

    def agent_id(self, env: int = 0, agent: int = 0) -> str:
        return _string(self._lib.sim_agent_id, self._h, env, agent)

    def viewer(self, env: int = 0, port: int = 8080, realtime: float | None = 1.0) -> str:
        """Mostra il mondo `env` nel browser; con `realtime` i passi vanno a tempo reale."""
        p = self._lib.sim_viewer_start(self._h, env, port)
        if not p:
            raise OSError(_string(self._lib.sim_last_error))
        if realtime:
            self._lib.sim_set_realtime(self._h, float(realtime))
        return f"http://127.0.0.1:{p}"

    def set_human(self, env: int, slot: int | None):
        """Il posto `slot` del mondo `env` lo comanda chi gioca nel browser del viewer
        (mouse = direzione, clic/spazio = boost, C tenuto = cashout). None = nessuno."""
        self._lib.sim_set_human(self._h, env, -1 if slot is None else slot)

    def realtime(self, factor: float):
        self._lib.sim_set_realtime(self._h, float(factor))

    def record(self, directory: str, env: int = 0):
        """Registra la partita dell'agente 0 del mondo `env` come sessione di analizer."""
        if not self._lib.sim_record_start(self._h, env, str(directory).encode()):
            raise OSError(_string(self._lib.sim_last_error))

    def stop_recording(self, env: int = 0):
        self._lib.sim_record_stop(self._h, env)

    def close(self):
        if getattr(self, "_h", None):
            self._lib.sim_free(self._h)
            self._h = None

    def __del__(self):
        self.close()


class Featurizer:
    """Le STESSE osservazioni del simulatore, calcolate da snapshot del server vero.

    Serve a usare l'agente sui dati reali (o a confrontare le osservazioni simulate
    con quelle registrate): ``obs = f.push(state_json, my_id, last_action)``.
    """

    def __init__(self, lib_path: str | None = None):
        self._lib = _Lib.load(_find_library(lib_path))
        self._f = self._lib.sim_featurizer_new()
        self.obs_size = self._lib.sim_obs_size()

    def push(self, state_json: str | bytes, my_id: str, last_action=None) -> np.ndarray | None:
        out = np.zeros(self.obs_size, np.float32)
        la = None if last_action is None else np.ascontiguousarray(last_action, dtype=np.float32)
        ok = self._lib.sim_featurizer_push(
            self._f, state_json if isinstance(state_json, bytes) else state_json.encode(), my_id.encode(),
            None if la is None else _ptr(la, ctypes.c_float), _ptr(out, ctypes.c_float))
        return out if ok else None

    def __del__(self):
        if getattr(self, "_f", None):
            self._lib.sim_featurizer_free(self._f)
            self._f = None


class SlitherVecEnvMeta:
    """Le lobby divise in due meta', ognuna un simulatore a se', con i buffer CONTIGUI e
    condivisi (le righe di una meta' seguono quelle dell'altra): mentre una meta' viene
    simulata (`step_half` in un thread: ctypes lascia il GIL durante la chiamata in Rust)
    l'altra puo' passare dalla rete. Stessa interfaccia di `SlitherVecEnv` per cio' che
    serve alla raccolta: `obs_view`, `info_view`, `reset_matches`, `match_report`,
    `step_into`, `layout`."""

    def __init__(self, num_envs: int, agents_per_env: int = 1, seed: int = 1, pin: bool = True, **kw):
        n_a = max(1, num_envs // 2)
        n_b = max(0, num_envs - n_a)
        sizes = [n_a, n_b] if n_b else [n_a]
        self.parts = [SlitherVecEnv(sz, agents_per_env, seed + 100003 * k, **kw) for k, sz in enumerate(sizes)]
        self.num_envs, self.agents_per_env = sum(sizes), agents_per_env
        self.n = self.num_envs * agents_per_env
        p0 = self.parts[0]
        self.obs_size, self.action_size, self.info_size = p0.obs_size, p0.action_size, p0.info_size
        # Osservazioni in memoria BLOCCATA (se c'e' CUDA): la GPU le copia con un DMA
        # asincrono direttamente dal buffer in cui scrive Rust, senza copie sulla CPU.
        self.obs_tensor = None
        if pin:
            try:
                import torch
                if torch.cuda.is_available():
                    self.obs_tensor = torch.zeros((self.n, self.obs_size), dtype=torch.float32).pin_memory()
            except Exception:  # noqa: BLE001
                self.obs_tensor = None
        self._obs = self.obs_tensor.numpy() if self.obs_tensor is not None else np.zeros((self.n, self.obs_size), np.float32)
        self._rew = np.zeros(self.n, np.float32)
        self._done = np.zeros(self.n, np.uint8)
        self._info = np.zeros((self.n, self.info_size), np.float32)
        self.env_ranges, self.row_ranges = [], []
        e0 = 0
        for part, sz in zip(self.parts, sizes):
            lo, hi = e0 * agents_per_env, (e0 + sz) * agents_per_env
            part._obs, part._rew, part._done, part._info = self._obs[lo:hi], self._rew[lo:hi], self._done[lo:hi], self._info[lo:hi]
            self.env_ranges.append((e0, e0 + sz))
            self.row_ranges.append((lo, hi))
            e0 += sz

    def _part_of(self, env: int):
        for k, (e0, e1) in enumerate(self.env_ranges):
            if e0 <= env < e1:
                return k, env - e0
        raise IndexError(env)

    def layout(self) -> dict:
        return self.parts[0].layout()

    def obs_view(self):
        return self._obs

    def info_view(self):
        return self._info

    def rew_view(self):
        return self._rew

    def done_view(self):
        return self._done

    def reset_matches(self, specs: dict):
        per = [{} for _ in self.parts]
        for e, spec in specs.items():
            k, loc = self._part_of(int(e))
            per[k][loc] = spec
        for part, sp in zip(self.parts, per):
            part.reset_matches(sp)

    def match_report(self, env: int) -> list:
        k, loc = self._part_of(env)
        return self.parts[k].match_report(loc)

    def step_half(self, k: int, actions_rows):
        """Avanza la sola meta' `k` con le azioni delle sue righe (senza copie dei buffer)."""
        self.parts[k].step_into(actions_rows)

    def step_into(self, actions):
        a = np.ascontiguousarray(actions, dtype=np.float32).reshape(self.n, self.action_size)
        for k, (lo, hi) in enumerate(self.row_ranges):
            self.parts[k].step_into(a[lo:hi])
        return self._obs, self._rew, self._done, self._info

    def set_human(self, env: int, slot):
        k, loc = self._part_of(env)
        self.parts[k].set_human(loc, slot)

    def close(self):
        for p in self.parts:
            p.close()
