"""Le partite: chi c'e' in ogni lobby, il torneo e il banco di prova.

Addestramento (la fase fissa i numeri, vedi config.FASI):
  fase 1  allievo + 2–3 avversari neurali (3–4 agenti) + 1–2 bot al massimo livello,
          durata massima uniforme 60–300 s
  fase 2  allievo + 0–4 avversari neurali (1–5 agenti) + 1–2 bot al massimo livello,
          durata massima uniforme 80–320 s; in parte delle lobby le situazioni «attesa»,
          «svantaggio» e (affinamento) «duello»
Ogni avversario neurale e' l'allievo dal vivo o un campione del torneo; in una parte
delle lobby (`lega.p_debole`) uno di loro e' una versione vecchia, piu' debole.
L'allievo entra sempre con la posta normale, come online; avversari e bot a volte
entrano gia' grossi e ricchi (chi arriva in una lobby avviata li trova cosi').

Torneo: lobby riservate in cui i membri di un girone giocano fra loro (con i bot).
Banco di prova: lobby riservate, scenari fissi, nessun dato di addestramento. Serve a
scegliere il migliore e a vedere se l'allievo batte anche chi NON e' lui:
  bot:<stile>  l'allievo da solo contro 2 bot di quello stile al massimo livello
  campioni     contro 3 campioni del torneo (o meno, se i posti sono meno) e un bot misto
  deboli       contro 2 versioni vecchie e un bot misto
Punteggio di uno scenario = punti medi della fase per partita. Fitness = ½ media + ½
peggiore: un agente che batte tutti tranne uno stile non e' il migliore.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from .lega import ALLIEVO, PARTENZA, STYLES, League, bot_id
from .punti import punti_resoconto

SCENARIOS = tuple(f"bot:{s}" for s in STYLES) + ("campioni", "deboli")


@dataclass
class Match:
    env: int
    slots: list                      # controllore di ogni posto: ALLIEVO, id di un'istantanea o None
    spec: dict
    kind: str = "allena"             # "allena" | "banco" | "torneo"
    scenario: str | None = None
    meta: dict = field(default_factory=dict)

    @property
    def eval(self) -> bool:
        """Nessun dato di addestramento (banco o torneo)."""
        return self.kind != "allena"


def rich_start(rng: random.Random, p: float) -> dict:
    """Chi entra in una lobby avviata trova avversari gia' cresciuti: a volte si parte cosi'."""
    if rng.random() >= p:
        return {}
    return {"start_size": round(rng.uniform(150, 900), 1), "start_balance": round(rng.uniform(1.3, 4.0), 3)}


class Matchmaker:
    def __init__(self, cfg, league: League, rng: random.Random):
        self.cfg = cfg
        self.league = league
        self.rng = rng
        self._eval_turn = 0

    def duration(self) -> float:
        """Durata massima della partita, uniforme fra minimo e massimo (`env.durata_s`)."""
        d = self.cfg.env.durata_s
        return self.rng.uniform(d[0], d[-1])

    def opponent(self) -> str:
        """Un avversario neurale: l'allievo dal vivo, o un campione del torneo (PFSP)."""
        if self.rng.random() < self.cfg.lega.p_vivo or not self.league.roster:
            return ALLIEVO
        return self.league.pfsp(self.league.roster, self.rng) or ALLIEVO

    def bot(self, style: str | None = None, skill: float | None = None, rich: float | None = None) -> dict:
        ec = self.cfg.env
        style = style or self.league.bots.sample(self.rng)
        skill = skill if skill is not None else self.rng.uniform(*ec.bot_abilita)
        return {"style": style, "skill": round(skill, 3), **rich_start(self.rng, ec.ricco if rich is None else rich)}

    def _spec(self, agents: list, bots: list, max_s: float) -> dict:
        ec = self.cfg.env
        return {"agents": agents, "bots": bots, "max_s": max_s, "end_when_alone_s": ec.solo_s, "fine_quota": ec.fine_quota}

    def training_match(self, env: int) -> Match:
        ec, lc = self.cfg.env, self.cfg.lega
        if self.cfg.fase == 2:
            x = self.rng.random()
            if x < ec.p_attesa:
                return self._match_attesa(env)
            if x < ec.p_attesa + ec.p_svantaggio:
                return self._match_svantaggio(env)
            if x < ec.p_attesa + ec.p_svantaggio + ec.p_duello:
                return self._match_duello(env)
        k = max(0, min(self.rng.randint(*ec.copie), ec.posti - 1))
        opp = [self.opponent() for _ in range(k)]
        if k and self.league.deboli and self.rng.random() < lc.p_debole:
            opp[self.rng.randrange(k)] = self.rng.choice(self.league.deboli)
        slots = [ALLIEVO] + opp
        # L'allievo (posto 0) entra con la posta, come online; gli avversari a volte gia' ricchi.
        agents = [{}] + [rich_start(self.rng, ec.ricco) for _ in range(k)]
        bots = [self.bot() for _ in range(self.rng.randint(*ec.bot_n))]
        return Match(env, slots + [None] * (ec.posti - len(slots)), self._spec(agents, bots, self.duration()))

    def _match_attesa(self, env: int) -> Match:
        """Fase 2: l'allievo entra da solo, senza bot; dopo `attesa_s` secondi entra un
        avversario neurale con la taglia d'ingresso. Chi ha mangiato nel frattempo e' piu'
        grosso (nel frontale vince il piu' grande, e c'e' piu' corpo per chiudere)."""
        ec = self.cfg.env
        dopo = round(self.rng.uniform(*ec.attesa_s), 2)
        slots = [ALLIEVO, self.opponent()]
        spec = self._spec([{}, {"join_after_s": dopo}], [], self.duration())
        return Match(env, slots + [None] * (ec.posti - len(slots)), spec, meta={"situazione": "attesa", "ritardi": {1: dopo}})

    def _match_svantaggio(self, env: int) -> Match:
        """Fase 2: l'allievo entra piccolo, col boost quasi finito, e trova un avversario
        neurale gia' grosso perche' ha mangiato (saldo normale: e' cibo, non soldi). Il resto
        della lobby come al solito."""
        ec = self.cfg.env
        k = max(1, min(self.rng.randint(*ec.copie), ec.posti - 1))
        slots = [ALLIEVO] + [self.opponent() for _ in range(k)]
        agents = [{"start_size": round(self.rng.uniform(*ec.taglia_piccolo), 1)},
                  {"start_size": round(self.rng.uniform(*ec.taglia_grosso), 1)}]
        agents += [rich_start(self.rng, ec.ricco) for _ in range(k - 1)]
        bots = [self.bot() for _ in range(self.rng.randint(*ec.bot_n))]
        return Match(env, slots + [None] * (ec.posti - len(slots)), self._spec(agents, bots, self.duration()),
                     meta={"situazione": "svantaggio"})

    def _match_duello(self, env: int) -> Match:
        """Fase 2 (affinamento): duello lungo, l'allievo contro un solo avversario neurale,
        senza bot, per `duello_s` secondi. Negli inseguimenti il boost finisce e ne ha di
        piu' chi e' piu' grosso: il cibo mangiato prima e durante conta."""
        ec = self.cfg.env
        slots = [ALLIEVO, self.opponent()]
        spec = self._spec([{}, {}], [], self.rng.uniform(*ec.duello_s))
        return Match(env, slots + [None] * (ec.posti - len(slots)), spec, meta={"situazione": "duello"})

    def tournament_match(self, env: int) -> Match:
        """Una partita del girone in corso (o di uno nuovo); se non ce n'e' bisogno, una
        partita di addestramento normale."""
        ec, lc = self.cfg.env, self.cfg.lega
        t = self.league.torneo or self.league.nuovo_girone(self.rng, ec.posti)
        if t is None or t["programmate"] >= lc.torneo_partite:
            return self.training_match(env)
        t["programmate"] += 1
        slots = list(t["membri"])
        # Alla pari: tutti con la posta, bot al massimo livello senza partenze da ricchi.
        bots = [self.bot(skill=1.0, rich=0.0) for _ in range(self.rng.randint(*ec.bot_n))]
        spec = self._spec([{} for _ in slots], bots, self.duration())
        return Match(env, slots + [None] * (ec.posti - len(slots)), spec, kind="torneo", meta={"girone": t["id"]})

    def eval_match(self, env: int) -> Match:
        ec = self.cfg.env
        scenario = SCENARIOS[self._eval_turn % len(SCENARIOS)]
        self._eval_turn += 1
        slots = [ALLIEVO]
        if scenario.startswith("bot:"):
            bots = [self.bot(scenario[4:], 1.0, 0.3) for _ in range(2)]
        elif scenario == "campioni":
            pool = self.league.roster or [PARTENZA]
            slots += [self.rng.choice(pool) for _ in range(min(3, ec.posti - 1))]
            bots = [self.bot("misto", 1.0, 0.0)]
        else:  # deboli
            pool = self.league.deboli or [PARTENZA]
            slots += [self.rng.choice(pool) for _ in range(min(2, ec.posti - 1))]
            bots = [self.bot("misto", 1.0, 0.0)]
        d = ec.durata_s
        spec = self._spec([{} for _ in slots], bots, 0.5 * (d[0] + d[-1]))
        return Match(env, slots + [None] * (ec.posti - len(slots)), spec, kind="banco", scenario=scenario)


class Benchmark:
    """Risultati del banco di prova per scenario (medie che sfumano). Punteggio = punti
    medi della fase per partita: lo stesso numero che l'allievo cerca di massimizzare."""

    KEYS = ("punti", "morte", "uccisioni", "incasso", "premio")

    def __init__(self, decay: float = 0.93):
        self.decay = decay
        self.s: dict[str, dict] = {}
        self.best: dict[str, float] = {}

    def reset(self):
        self.s, self.best = {}, {}

    def record(self, scenario: str, r: dict):
        """`r`: l'episodio del posto dell'allievo (vedi raccolta.py)."""
        d = self.s.setdefault(scenario, {"n": 0.0, "partite": 0, **{k: 0.0 for k in self.KEYS}})
        a = self.decay
        vals = {"punti": r["punti"], "morte": float(r["motivo"] == 1), "uccisioni": float(r["uccisioni"]),
                "incasso": float(r["motivo"] == 2), "premio": float(r.get("uscita") not in (None, "nessuna", "penale"))}
        for k, v in vals.items():
            d[k] = d[k] * a + v
        d["n"] = d["n"] * a + 1.0
        d["partite"] += 1

    def mean(self, scenario: str, key: str = "punti") -> float | None:
        d = self.s.get(scenario)
        if not d or d["partite"] < 3:
            return None
        return d[key] / d["n"]

    def score(self, scenario: str) -> float | None:
        return self.mean(scenario)

    def fitness(self) -> float | None:
        vals = [v for v in (self.score(sc) for sc in SCENARIOS) if v is not None]
        if len(vals) < len(SCENARIOS) // 2:
            return None
        return 0.5 * sum(vals) / len(vals) + 0.5 * min(vals)

    def regressions(self, margin: float = 0.5) -> list[str]:
        """Scenari in cui l'allievo e' tornato indietro rispetto al suo meglio."""
        out = []
        for sc in SCENARIOS:
            v = self.score(sc)
            if v is None:
                continue
            if v > self.best.get(sc, -1e9):
                self.best[sc] = v
            elif v < self.best[sc] - margin:
                out.append(sc)
        return out

    def summary(self) -> dict:
        out = {}
        for sc in SCENARIOS:
            if self.mean(sc) is None:
                continue
            out[sc] = {k: round(self.mean(sc, k), 3) for k in self.KEYS}
            out[sc]["punteggio"] = round(self.score(sc), 3)
        return out

    def state(self):
        return {"s": self.s, "best": self.best}

    def load(self, st):
        self.s, self.best = st["s"], st["best"]


def participants(match: Match, report: list[dict], rc, fase: int) -> list[tuple[str, float, str | None, dict]]:
    """Righe del resoconto del simulatore → (id, punti della fase, stile del bot, riga)."""
    out = []
    for row in report:
        if row.get("posto") is not None:
            k = row["posto"]
            cid = match.slots[k] if k < len(match.slots) else None
            if cid is None:
                continue
            out.append((cid, punti_resoconto(row, rc, fase), None, row))
        elif row.get("stile"):
            out.append((bot_id(row["stile"]), punti_resoconto(row, rc, fase), row["stile"], row))
    return out
