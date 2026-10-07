"""Tutti i parametri dell'addestramento, in un posto solo.

Si sovrascrivono da riga di comando (`--imposta ppo.lr=1e-4`) o con un JSON
(`--config mio.json`); la configurazione effettiva viene salvata nella cartella
della corsa e ricaricata quando si riprende (le chiavi sconosciute vengono ignorate:
una corsa vecchia riparte con i default nuovi per cio' che manca).
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from pathlib import Path


@dataclass
class EnvCfg:
    """La lobby. I valori di `posti`, `copie`, `durata_s`, `bot_n` li fissa la fase (FASI qui sotto)."""
    mondi: int = 384                 # lobby simulate in parallelo (su RunPod le sceglie il regolatore)
    posti: int = 4                   # agenti neurali per lobby (fase 1: 3–4 in campo; fase 2: 1–5)
    mondi_valutazione: int = 16      # di cui riservate al banco di prova (nessun dato di addestramento)
    mondi_torneo: int = 16           # ...e ai gironi del torneo fra checkpoint (nessun dato di addestramento)
    randomizza: bool = True          # rete e tick randomizzati per lobby (la fisica vera del server e' fissa)
    copie: tuple = (2, 3)            # avversari neurali dell'allievo (minimo, massimo)
    bot_n: tuple = (1, 2)            # bot per lobby (minimo, massimo), stili scelti dalla lega
    bot_abilita: tuple = (1.0, 1.0)  # abilita' dei bot: al massimo
    ricco: float = 0.3               # copie e bot che entrano gia' grossi e ricchi (lobby avviate)
    # Due situazioni della FASE 2 (chieste dall'utente il 2026-10-06) per far capire che il cibo conta:
    p_attesa: float = 0.1            # l'allievo entra DA SOLO (niente bot) e un avversario neurale arriva
    attesa_s: tuple = (10.0, 60.0)   # dopo tanti secondi: chi ha mangiato nel frattempo e' piu' grosso
    p_svantaggio: float = 0.1        # l'allievo entra piccolo (taglia_piccolo, boost quasi finito) in una lobby
    taglia_piccolo: tuple = (45.0, 60.0)    # dove un avversario neurale e' gia' grosso perche' ha mangiato
    taglia_grosso: tuple = (200.0, 300.0)   # saldo normale (1): il tetto della taglia e' 300, e' cibo, non soldi
    p_duello: float = 0.0            # duello lungo (affinamento, 2026-10-06): l'allievo contro UN avversario
    duello_s: tuple = (200.0, 320.0)  # neurale, senza bot, per tanti secondi: negli inseguimenti il boost
                                     # finisce, e ne ha di piu' chi e' piu' grosso (chi ha mangiato)
    durata_s: tuple = (60.0, 300.0)  # durata massima della partita, UNIFORME fra minimo e massimo (secondi)
    fine_quota: float = 1.0          # a fine partita chi e' in campo incassa questa parte (la ricompensa
                                     # a punti non da' nulla alla fine forzata: conta solo per le statistiche)
    solo_s: float = 12.0             # rimasto solo senza oro: la partita chiude (cashout forzato)
    crescita_oro: float = 12.0       # taglia da un orb d'oro: +12 (verita' del server, 2026-10-07)
    inferenza_unica: str = "auto"    # raccolta: tutti i controllori in un passaggio (vmap) e CUDA
                                     # graph; "auto" = su CUDA, "si"/"no" per forzare
    decisione_ms: float = 12.0       # tempo di calcolo dell'agente fra snapshot e input (online la
                                     # rete non e' istantanea; per partita viene randomizzato 5–30 ms)


@dataclass
class PPOCfg:
    passi: int = 128                 # passi per raccolta
    sequenza: int = 64               # lunghezza delle sequenze per la GRU (BPTT): ~2,7 s di gioco
    gamma: float = 0.9995            # ~80 s di orizzonte a ~24 passi/s
    lam: float = 0.95
    epoche: int = 2
    minibatch: int = 128             # sequenze per minibatch
    lr: float = 3e-4                 # la fissa la fase (3e-4 da pesi casuali, 2e-4 in fase 2)
    clip: float = 0.15
    vf_coef: float = 0.5
    ent_svolta: float = 0.004
    ent_boost: float = 0.002
    ent_cashout: float = 0.0005
    aux_coef: float = 0.2
    max_grad: float = 1.0
    kl_max: float = 0.03             # stop anticipato delle epoche
    popart_beta: float = 0.05
    riscaldamento_critico: int = 20  # al cambio di fase: iterazioni in cui si allena solo la testa del valore
    compila: bool = True             # su CUDA: torch.compile dei codificatori nella raccolta (pile vmap)
    compila_agg: bool = False        # ...e nell'aggiornamento (spento: sospetto di regressione, 2026-10-06)
    sovrapponi: bool = True          # la raccolta del blocco successivo gira mentre l'allievo
                                     # impara dal blocco appena raccolto (dati con 1 aggiornamento di ritardo)


@dataclass
class RewardCfg:
    """La ricompensa a punti delle due fasi (ia/punti.py, PIANO_ADDESTRAMENTO.md §3). Per passo, nessun
    modellamento: solo cio' che l'utente ha chiesto."""
    uccisione: float = 0.5           # ogni uccisione...
    quota_frontale: float = 0.75     # ...ma vinta testa contro testa vale solo questa parte (0,375): non e' una
                                     # vera uccisione (chiesto dall'utente il 2026-10-06). Il bottino non cambia
    bottino_mio: float = 1.0         # bottino delle PROPRIE uccisioni: per caduta intera, diviso per orb
    bottino_altrui: float = 0.6      # bottino delle uccisioni ALTRUI (o del muro): per caduta intera, diviso per orb
    cibo: float = 0.02               # ogni orb di cibo normale (raddoppiato il 2026-10-06: mangiare per ingrassare)
    morte_frontale: float = 0.5      # tolti a chi muore in uno scontro testa contro testa (muore il piu' piccolo,
                                     # chiesto dall'utente il 2026-10-06; le altre morti non hanno penalita')
    peso_fase2: float = 0.7          # in fase 2 i punti qui sopra valgono il 30 % in meno
    # Fase 2: cashout fatto da se' (la fine partita forzata e la morte non danno nulla).
    obiettivo: float = 0.8           # profitto netto (incassato − saldo d'ingresso, poste)
    bonus_pulito: float = 5.0        # profitto ≥ obiettivo e nessun orb d'oro a terra
    bonus_oro: float = 2.6           # profitto ≥ obiettivo ma ancora oro raccoglibile (circa la meta')
    soglia_vuoto: float = 0.2        # profitto > soglia...
    bonus_vuoto: float = 7.0         # ...nessun avversario in campo e niente oro: non resta nulla da fare
    pena_sotto: float = 5.0          # cashout fatto da se' con profitto sotto `soglia_vuoto` (+20 %): tolti tanti punti.
                                     # Da evitare assolutamente (chiesto dall'utente il 2026-10-06): peggio che morire


@dataclass
class LeagueCfg:
    partenza: str = ""               # checkpoint da cui parte una corsa nuova; vuoto = pesi casuali
    iniziali: str = ""               # corsa nuova: checkpoint (separati da virgole) che entrano fra i campioni
                                     # come PROTETTI (l'affinamento dei migliori: restano sempre in campo)
    p_vivo: float = 0.3              # ogni avversario: l'allievo dal vivo (self-play: anche le sue righe
                                     # sono dati), altrimenti un campione del torneo (PFSP)
    p_debole: float = 0.3            # per lobby: probabilita' che UNO degli avversari sia una versione
                                     # vecchia e piu' debole (dall'archivio)
    istantanea_ogni: int = 20        # iterazioni fra un'istantanea dell'allievo e l'altra (entra nel torneo)
    torneo_n: int = 4                # checkpoint sorteggiati per girone (giocano tutti nella stessa lobby)
    torneo_partite: int = 16         # partite per girone (in parallelo sulle lobby del torneo)
    campioni_min: int = 5            # sotto questo numero di campioni non si fanno gironi (si accumula)
    campioni_max: int = 16           # sopra, il girone tiene solo il vincitore (invece della meta')
    archivio_ogni: int = 100         # le istantanee a multipli di `archivio_ogni` restano nell'archivio...
    archivio_max: int = 40           # ...fino a tante: la storia, da cui escono le versioni deboli
    deboli: int = 4                  # versioni vecchie disponibili in campo contemporaneamente
    rosa: int = 6                    # campioni in campo contemporaneamente (ognuno costa un passaggio)
    rosa_ogni: int = 24              # iterazioni fra un rinnovo della rosa e l'altro
    rosa_cambio: int = 2             # campioni che escono a ogni rinnovo (oltre al piu' nuovo)
    fase_da_migliore: bool = False   # al cambio di fase si riparte da migliore.pt invece che dall'allievo attuale
    # Diversita' della popolazione (ia/diversita.py): soglie e nicchie decise dall'utente (2026-10-06).
    clone_sterzata: float = 0.05     # cloni: differenza media della sterzata (u, scala −1…1) sotto questa...
    clone_boost: float = 0.05        # ...E differenza media della probabilita' di boost sotto questa
    nicchia_cacciatore: float = 1.0  # cacciatore: uccisioni per partita ≥
                                     # sciacallo: bottino altrui ≥ proprio (e > 0) e uccisioni < nicchia_cacciatore
    nicchia_corridore: float = 0.20  # corridore: frazione del tempo col boost ≥
    nicchia_prudente: float = 600.0  # prudente: distanza media dalla testa nemica piu' vicina ≥ (u)
    stile_partite: int = 10          # partite (entrato con la posta) prima di attribuire uno stile
    diversita_min: float = 0.10      # popolazione troppo simile: distanza media fra campioni sotto questa,
                                     # o un solo stile fra i campioni classificati
    mutazione: float = 0.01          # rumore dei mutanti: frazione della deviazione dei pesi di ogni strato...
    mutazione_max: float = 0.32      # ...raddoppiato finche' il mutante non e' piu' un clone, fino a qui (misurato
                                     # sul pod il 2026-10-06: l'1 % sposta il comportamento di 0,001–0,003, ne serve 16–32 %)
    mutanti: int = 2                 # mutanti creati per volta (al massimo cosi' tanti ancora da provare)
    sonda_sequenze: int = 96         # impronta: spezzoni di gioco vero...
    sonda_passi: int = 48            # ...da tanti passi (~2 s), giocati da ogni checkpoint con memoria vuota


# Le due fasi (PIANO_ADDESTRAMENTO.md §4). Applicate quando la corsa nasce o quando cambia `fase`; i parametri
# dati esplicitamente con --imposta restano i padroni.
FASI = {
    1: {"env.posti": 4, "env.copie": [2, 3], "env.bot_n": [1, 2], "env.bot_abilita": [1.0, 1.0],
        "env.durata_s": [60.0, 300.0], "ppo.lr": 3e-4},
    2: {"env.posti": 5, "env.copie": [0, 4], "env.bot_n": [1, 2], "env.bot_abilita": [1.0, 1.0],
        "env.durata_s": [80.0, 320.0], "ppo.lr": 2e-4},
}


@dataclass
class Config:
    nome: str = "corsa"
    fase: int = 1                    # 1 = predatore (niente cashout), 2 = giocatore completo
    seme: int = 1
    dispositivo: str = "auto"
    salva_ogni: int = 10
    iterazioni: int = 0              # 0 = senza fine
    env: EnvCfg = field(default_factory=EnvCfg)
    ppo: PPOCfg = field(default_factory=PPOCfg)
    ricompensa: RewardCfg = field(default_factory=RewardCfg)
    lega: LeagueCfg = field(default_factory=LeagueCfg)

    def to_dict(self) -> dict:
        return asdict(self)

    def save(self, path: Path):
        path.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False))

    @staticmethod
    def from_dict(d: dict) -> "Config":
        cfg = Config()
        _merge(cfg, d)
        return cfg

    def applica_fase(self):
        """I parametri della fase corrente (FASI)."""
        for k, v in FASI[self.fase].items():
            self.set(k, json.dumps(v))

    def set(self, dotted: str, raw: str):
        """`ppo.lr=1e-4`, `env.durata_s=[60,120,300]`."""
        obj = self
        parts = dotted.split(".")
        for p in parts[:-1]:
            obj = getattr(obj, p)
        key = parts[-1]
        if not hasattr(obj, key):
            raise KeyError(f"parametro sconosciuto: {dotted}")
        cur = getattr(obj, key)
        val = json.loads(raw) if not isinstance(cur, str) else raw
        if isinstance(cur, tuple):
            val = tuple(val)
        elif isinstance(cur, bool):
            val = bool(val)
        elif isinstance(cur, float):
            val = float(val)
        elif isinstance(cur, int):
            val = int(val)
        setattr(obj, key, val)


def _merge(obj, d: dict):
    for f in fields(obj):
        if f.name not in d:
            continue
        cur = getattr(obj, f.name)
        if is_dataclass(cur):
            _merge(cur, d[f.name])
        elif isinstance(cur, tuple):
            setattr(obj, f.name, tuple(d[f.name]))
        else:
            setattr(obj, f.name, d[f.name])
