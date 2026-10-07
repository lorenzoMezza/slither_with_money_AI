"""La lega: contro chi gioca l'allievo, e quali checkpoint sopravvivono.

In ogni lobby di addestramento:

- l'ALLIEVO (la rete che impara);
- gli AVVERSARI NEURALI: ognuno e' l'allievo stesso dal vivo (self-play: anche le sue
  righe diventano dati) oppure un CAMPIONE, un checkpoint congelato sopravvissuto al
  torneo (scelto con PFSP: piu' spesso quelli che l'allievo batte meno). Ogni tanto UNO
  di loro e' una versione VECCHIA, piu' debole, dall'archivio: prede vere, senza le
  quali contro copie tutte forti l'allievo impara solo a scappare;
- i BOT al massimo livello, di stili scelti dove l'allievo va peggio.

SELEZIONE A TORNEO (richiesta dell'utente). Ogni `istantanea_ogni` iterazioni una copia
dell'allievo entra fra i campioni. Poi, a gironi: si sorteggiano a caso `torneo_n`
campioni, giocano `torneo_partite` partite tutti nella stessa lobby (con i bot), sulle
lobby riservate al torneo; vince chi fa piu' punti in media (la ricompensa della fase).
Si tengono i vincitori (la meta' migliore; solo il primo se i campioni sono troppi), si
scartano gli altri (cancellati dal disco, salvo che servano all'archivio). Un girone
interrotto da un riavvio riprende le partite mancanti.

L'ARCHIVIO (un'istantanea ogni `archivio_ogni` iterazioni, fino ad `archivio_max`) non
passa dal torneo: e' la storia, da cui escono le versioni deboli. I PROTETTI (es. il
campione finale della fase 1) non vengono mai scartati.

STILI (diversita', soglie dell'utente in LeagueCfg). Per ogni checkpoint si sommano, nelle
partite in cui e' entrato con la posta: uccisioni, bottino proprio e altrui, tempo col
boost, distanza media dalla testa nemica piu' vicina. Dopo `stile_partite` partite gli si
attribuiscono le NICCHIE (anche piu' d'una): cacciatore, sciacallo, corridore, prudente;
nessuna = generico. Il torneo non scarta mai l'ultimo campione di una nicchia. Cloni e
mutanti: ia/diversita.py.

Elo su tutti, bot compresi; vittoria fra due partecipanti = chi fa piu' punti.
"""
from __future__ import annotations

import random
from collections import defaultdict
from pathlib import Path

import torch

STYLES = ("raccoglitore", "cacciatore", "avvoltoio", "ariete", "esca", "codardo", "spingitore",
          "accerchiatore", "affiancatore", "imprevedibile", "misto")
ALLIEVO = "allievo"
PARTENZA = "partenza"
NICCHIE = ("cacciatore", "sciacallo", "corridore", "prudente")


def pair_score(pa: float, pb: float, eps: float = 0.01) -> float:
    if pa > pb + eps:
        return 1.0
    if pa < pb - eps:
        return 0.0
    return 0.5


def bot_id(style: str) -> str:
    return f"bot:{style}"


class Elo:
    def __init__(self):
        self.r: dict[str, float] = {}
        self.games: dict[str, int] = defaultdict(int)

    def get(self, k: str) -> float:
        return self.r.get(k, 1000.0)

    def update(self, results: list[tuple[str, float]]):
        """Una partita a piu' giocatori come tutte le sue coppie (K diviso per gli avversari).
        Le copie dell'allievo dal vivo sono lo stesso giocatore: fra loro non si conta."""
        n = len(results)
        if n < 2:
            return
        k_factor = 24.0 / (n - 1)
        delta = defaultdict(float)
        for i in range(n):
            for j in range(i + 1, n):
                (a, pa), (b, pb) = results[i], results[j]
                if a == b:
                    continue
                s = pair_score(pa, pb)
                e = 1.0 / (1.0 + 10 ** ((self.get(b) - self.get(a)) / 400.0))
                delta[a] += k_factor * (s - e)
                delta[b] -= k_factor * (s - e)
        for k, d in delta.items():
            self.r[k] = self.get(k) + d
        for k in {k for k, _ in results}:
            self.games[k] += 1

    def state(self):
        return {"r": self.r, "games": dict(self.games)}

    def load(self, s):
        self.r = dict(s["r"])
        self.games = defaultdict(int, s["games"])


class Payoff:
    """Vittorie dell'allievo contro ogni avversario (medie che sfumano: conta l'ultimo periodo)."""

    def __init__(self, decay: float = 0.995):
        self.decay = decay
        self.w: dict[str, float] = {}
        self.n: dict[str, float] = {}

    def add(self, opp: str, score: float):
        self.w[opp] = self.w.get(opp, 0.0) * self.decay + score
        self.n[opp] = self.n.get(opp, 0.0) * self.decay + 1.0

    def winrate(self, opp: str) -> float:
        return (self.w.get(opp, 0.0) + 0.5) / (self.n.get(opp, 0.0) + 1.0)

    def forget(self, opp: str):
        self.w.pop(opp, None)
        self.n.pop(opp, None)

    def state(self):
        return {"w": self.w, "n": self.n}

    def load(self, s):
        self.w, self.n = dict(s["w"]), dict(s["n"])


class BotStyles:
    """Quale stile di bot mettere in lobby: piu' spesso quelli contro cui l'allievo perde.

    `beat[s]` = quante volte l'allievo chiude meglio del bot di stile `s` (media che
    sfuma). Peso = (1 − beat)² + `minimo`: uno stile battuto sempre esce ancora, di rado."""

    def __init__(self, minimo: float = 0.05):
        self.minimo = minimo
        self.beat = {s: 0.5 for s in STYLES}
        self.n = {s: 0 for s in STYLES}

    def record(self, style: str, score: float):
        if style in self.beat:
            self.beat[style] = self.beat[style] * 0.98 + 0.02 * score
            self.n[style] += 1

    def weights(self) -> list[float]:
        return [(1.0 - self.beat[s]) ** 2 + self.minimo for s in STYLES]

    def sample(self, rng: random.Random) -> str:
        return rng.choices(STYLES, weights=self.weights())[0]

    def state(self):
        return {"beat": self.beat, "n": self.n}

    def load(self, s):
        self.beat.update(s.get("beat", {}))
        self.n.update(s.get("n", {}))


class League:
    def __init__(self, root: Path, cfg):
        self.root = root
        self.cfg = cfg
        self.dir = root / "lega"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.snapshots: dict[str, dict] = {}     # id → {path, iter, fase}
        self.campioni: list[str] = []            # il pool del torneo (sopravvissuti e nuovi entrati)
        self.protetti: list[str] = []            # mai scartati (es. il campione finale della fase 1)
        self.roster: list[str] = []              # campioni in campo adesso
        self.deboli: list[str] = []              # versioni vecchie in campo adesso
        self.torneo: dict | None = None          # il girone in corso
        self.gironi = 0                          # gironi conclusi
        self.messaggi: list[str] = []            # per gli eventi della corsa (li scrive allena.py)
        self.stili: dict[str, dict] = {}         # id → somme delle misure di stile (registra_stile)
        self.diversita: float | None = None      # distanza media fra i campioni (ia/diversita.py)
        self.payoff = Payoff()
        self.elo = Elo()
        self.bots = BotStyles()

    # --- istantanee ----------------------------------------------------------------------
    def add_snapshot(self, iteration: int, state_dict: dict, fid: str | None = None, path: Path | None = None,
                     fase: int = 1, campione: bool = True, meta: dict | None = None) -> str:
        """Una copia congelata dell'allievo (in fp16: la meta' del disco, nessuna differenza
        di gioco: l'inferenza gira comunque in bf16/fp16). Entra fra i campioni del torneo."""
        fid = fid or f"{ALLIEVO}@{iteration}"
        if path is None:
            path = self.dir / f"{fid.replace('@', '_')}.pt"
            torch.save({"model": {k: (v.detach().to("cpu").half() if v.is_floating_point() else v.detach().to("cpu"))
                                  for k, v in state_dict.items()},
                        "allievo": ALLIEVO, "iter": iteration, "fase": fase}, path)
        rel = str(path.relative_to(self.root)) if path.is_relative_to(self.root) else str(path)
        self.snapshots[fid] = {"path": rel, "iter": iteration, "fase": fase, **(meta or {})}
        if campione and fid != PARTENZA and fid not in self.campioni:
            self.campioni.append(fid)
        # Parte con l'Elo dell'allievo: e' lo stesso giocatore in quel momento.
        self.elo.r.setdefault(fid, self.elo.get(ALLIEVO))
        return fid

    def path_of(self, fid: str) -> Path:
        p = Path(self.snapshots[fid]["path"])
        return p if p.is_absolute() else self.root / p

    def fase_of(self, fid: str) -> int:
        return int(self.snapshots.get(fid, {}).get("fase", 1))

    def mutante(self, fid: str) -> bool:
        return "padre" in self.snapshots.get(fid, {})

    def recent(self) -> list[str]:
        """Le istantanee, dalla piu' nuova (l'ancora di partenza esclusa)."""
        own = sorted(((v["iter"], k) for k, v in self.snapshots.items() if k != PARTENZA), reverse=True)
        return [k for _, k in own]

    def archivio(self) -> list[str]:
        """Le istantanee della storia (iterazioni multiple di `archivio_ogni`), dalla piu' vecchia."""
        a = [k for k in reversed(self.recent()) if self.snapshots[k]["iter"] % self.cfg.archivio_ogni == 0
             and self.snapshots[k]["iter"] > 0 and not self.mutante(k)]
        return a[-self.cfg.archivio_max:]

    def prune(self, in_use: set[str]):
        """Cancella dal disco cio' che non serve piu': ne' campione, ne' archivio, ne' in campo."""
        keep = (set(self.campioni) | set(self.archivio()) | {PARTENZA} | set(self.protetti)
                | set(self.roster) | set(self.deboli) | in_use | set((self.torneo or {}).get("membri", [])))
        for fid in list(self.snapshots):
            if fid in keep:
                continue
            p = self.path_of(fid)
            if p.is_relative_to(self.dir):
                p.unlink(missing_ok=True)
            del self.snapshots[fid]
            self.payoff.forget(fid)
            self.stili.pop(fid, None)

    def pfsp(self, candidates: list[str], rng: random.Random) -> str | None:
        """Preferisce gli avversari contro cui l'allievo vince meno (PFSP «difficili»)."""
        if not candidates:
            return None
        ws = [(1.0 - self.payoff.winrate(c)) ** 2 + 0.05 for c in candidates]
        return rng.choices(candidates, weights=ws)[0]

    def refresh_roster(self, rng: random.Random):
        """Quali campioni stanno in campo: sempre il piu' nuovo, gli altri con PFSP, rotazione
        graduale (`rosa_cambio` per volta). E quali versioni deboli: dall'archivio (fuori dai
        campioni), con l'ancora di partenza fra le candidate; una cambia a ogni rinnovo."""
        camp = [c for c in self.campioni if c in self.snapshots]
        if camp:
            newest = max(camp, key=lambda k: (not self.mutante(k), self.snapshots[k]["iter"]))
            stay = [r for r in self.roster if r in camp and r != newest]
            rng.shuffle(stay)
            stay = stay[:max(0, min(len(stay), self.cfg.rosa - 1) - self.cfg.rosa_cambio)]
            pool = [k for k in camp if k != newest and k not in stay]
            while 1 + len(stay) < self.cfg.rosa and pool:
                pick = self.pfsp(pool, rng)
                stay.append(pick)
                pool.remove(pick)
            self.roster = [newest] + stay
        else:
            self.roster = []
        old = [k for k in self.archivio() if k not in self.campioni] + [PARTENZA]
        old = [k for k in old if k in self.snapshots]
        keep = [d for d in self.deboli if d in old]
        if keep:
            keep.pop(rng.randrange(len(keep)))
        pool = [k for k in old if k not in keep]
        rng.shuffle(pool)
        self.deboli = (keep + pool)[:self.cfg.deboli]

    # --- stili -----------------------------------------------------------------------------
    def registra_stile(self, cid: str, row: dict, punti: float, torneo: bool):
        """Le misure di stile di un checkpoint in una partita (riga del resoconto). Solo le
        partite in cui e' entrato con la posta: chi parte grosso e ricco gioca un'altra partita."""
        if cid not in self.snapshots or float(row.get("saldo_iniziale", 1.0)) > 1.0 + 1e-6:
            return
        d = self.stili.setdefault(cid, {"n": 0, "ucc": 0.0, "bm": 0.0, "ba": 0.0, "boost": 0.0,
                                        "dist_s": 0.0, "dist_n": 0, "tp": 0.0, "tn": 0})
        d["n"] += 1
        d["ucc"] += float(row.get("uccisioni", 0))
        d["bm"] += float(row.get("bottino_mio", 0.0))
        d["ba"] += float(row.get("bottino_altrui", 0.0))
        d["boost"] += float(row.get("boost_frazione", 0.0))
        dist = float(row.get("distanza_nemico", -1.0))
        if dist >= 0:
            d["dist_s"] += dist
            d["dist_n"] += 1
        if torneo:
            d["tp"] += punti
            d["tn"] += 1

    def misure(self, cid: str) -> dict | None:
        """Medie per partita delle misure di stile (None se le partite sono troppo poche)."""
        d = self.stili.get(cid)
        if not d or d["n"] < self.cfg.stile_partite:
            return None
        n = d["n"]
        return {"partite": n, "uccisioni": d["ucc"] / n, "bottino_mio": d["bm"] / n, "bottino_altrui": d["ba"] / n,
                "boost": d["boost"] / n, "distanza": d["dist_s"] / d["dist_n"] if d["dist_n"] else 0.0}

    def nicchie(self, cid: str) -> set[str] | None:
        """Le nicchie del checkpoint con le soglie dell'utente; insieme vuoto = generico,
        None = non ancora classificato."""
        m = self.misure(cid)
        if m is None:
            return None
        c, out = self.cfg, set()
        if m["uccisioni"] >= c.nicchia_cacciatore:
            out.add("cacciatore")
        if m["bottino_altrui"] > 0 and m["bottino_altrui"] >= m["bottino_mio"] and m["uccisioni"] < c.nicchia_cacciatore:
            out.add("sciacallo")
        if m["boost"] >= c.nicchia_corridore:
            out.add("corridore")
        if m["distanza"] >= c.nicchia_prudente:
            out.add("prudente")
        return out

    def stile(self, cid: str) -> str:
        n = self.nicchie(cid)
        return "?" if n is None else ("+".join(x for x in NICCHIE if x in n) or "generico")

    def punti_torneo(self, cid: str) -> float | None:
        d = self.stili.get(cid)
        return d["tp"] / d["tn"] if d and d["tn"] else None

    def ultimo_di_nicchia(self, cid: str, restano: list[str]) -> list[str]:
        """Le nicchie di cui `cid` e' l'unico rappresentante fra i campioni `restano`."""
        mie = self.nicchie(cid) or set()
        altre = set()
        for c in restano:
            if c != cid:
                altre |= self.nicchie(c) or set()
        return [n for n in NICCHIE if n in mie and n not in altre]

    def scartabile(self, cid: str, restano: list[str]) -> bool:
        """Si puo' togliere dai campioni? Non i protetti, non l'ultimo di una nicchia, non chi
        sta giocando un girone."""
        if cid in self.protetti or cid in (self.torneo or {}).get("membri", []):
            return False
        return not self.ultimo_di_nicchia(cid, restano)

    def scarta(self, cid: str):
        self.campioni = [c for c in self.campioni if c != cid]
        self.roster = [r for r in self.roster if r != cid]

    # --- torneo --------------------------------------------------------------------------
    def nuovo_girone(self, rng: random.Random, posti: int) -> dict | None:
        """Sorteggia i membri di un girone, se ci sono abbastanza campioni."""
        camp = [c for c in self.campioni if c in self.snapshots]
        n = min(self.cfg.torneo_n, posti)
        if len(camp) < max(self.cfg.campioni_min, n, 2):
            return None
        self.torneo = {"id": self.gironi + 1, "membri": rng.sample(camp, n), "punti": {},
                       "programmate": 0, "finite": 0}
        return self.torneo

    def risultato_girone(self, gid: int, punti: dict[str, float]):
        """I punti di ogni membro in una partita del girone `gid`; chiude il girone quando
        tutte le partite sono finite."""
        t = self.torneo
        if t is None or t["id"] != gid:
            return
        for c, p in punti.items():
            s = t["punti"].setdefault(c, [0.0, 0])
            s[0] += p
            s[1] += 1
        t["finite"] += 1
        if t["finite"] >= self.cfg.torneo_partite:
            self._chiudi_girone()

    def _chiudi_girone(self):
        t, self.torneo = self.torneo, None
        self.gironi += 1
        media = {c: (t["punti"][c][0] / t["punti"][c][1]) if c in t["punti"] else -1e9 for c in t["membri"]}
        ordine = sorted(t["membri"], key=lambda c: (media[c], self.elo.get(c)), reverse=True)
        tieni = 1 if len(self.campioni) > self.cfg.campioni_max else -(-len(ordine) // 2)
        vincitori, vinti = ordine[:tieni], ordine[tieni:]
        scartati, salvati = [], []
        for c in reversed(vinti):                      # dal peggiore
            restano = [x for x in self.campioni if x not in scartati]
            if c in self.protetti:
                continue
            nic = self.ultimo_di_nicchia(c, restano)
            if nic:
                salvati.append(f"{c} (ultimo {'/'.join(nic)})")
                continue
            scartati.append(c)
        for c in scartati:
            self.scarta(c)
        fmt = lambda cs: ", ".join(f"{c} {media[c]:+.2f} {self.stile(c)}" for c in cs) or "-"   # noqa: E731
        self.messaggi.append(f"girone {t['id']} ({t['finite']} partite): restano {fmt(vincitori)}; scartati {fmt(scartati)}"
                             + (f"; tenuti per la nicchia {', '.join(salvati)}" if salvati else "") + f"; campioni {len(self.campioni)}")

    # --- risultati ---------------------------------------------------------------------------
    def record(self, results: list[tuple[str, float, str | None]], train: bool = True):
        """results: (id, punti, stile del bot o None) per ogni partecipante. Ogni posto
        dell'allievo dal vivo e' un campione: contro ogni avversario DIVERSO da se'."""
        self.elo.update([(k, p) for k, p, _ in results])
        if not train:
            return
        for a, pa, _ in results:
            if a != ALLIEVO:
                continue
            for b, pb, style in results:
                if b == ALLIEVO:
                    continue
                s = pair_score(pa, pb)
                if style is not None:
                    self.bots.record(style, s)
                else:
                    self.payoff.add(b, s)

    def state(self):
        return {"snapshots": self.snapshots, "campioni": self.campioni, "protetti": self.protetti, "roster": self.roster,
                "deboli": self.deboli, "torneo": self.torneo, "gironi": self.gironi, "stili": self.stili, "payoff": self.payoff.state(),
                "elo": self.elo.state(), "bots": self.bots.state()}

    def load(self, s):
        self.snapshots = dict(s["snapshots"])
        self.campioni = [c for c in s.get("campioni", []) if c in self.snapshots]
        self.protetti = [c for c in s.get("protetti", []) if c in self.snapshots]
        self.roster = [r for r in s["roster"] if r in self.snapshots]
        self.deboli = [r for r in s.get("deboli", []) if r in self.snapshots]
        self.torneo = s.get("torneo")
        if self.torneo is not None:
            # Le partite in volo al momento del salvataggio sono perse: si rifanno.
            self.torneo["membri"] = [c for c in self.torneo["membri"] if c in self.snapshots]
            self.torneo["programmate"] = self.torneo["finite"]
            if len(self.torneo["membri"]) < 2:
                self.torneo = None
        self.gironi = s.get("gironi", 0)
        self.stili = {k: v for k, v in s.get("stili", {}).items() if k in self.snapshots}
        self.payoff.load(s["payoff"])
        self.elo.load(s["elo"])
        self.bots.load(s["bots"])
