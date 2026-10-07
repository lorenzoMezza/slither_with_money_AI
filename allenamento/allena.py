"""Addestramento dell'agente di moneyslither nel simulatore: due fasi, una lega a torneo.

    .venv/bin/python allena.py --nome prova                 # nuova corsa (o la riprende)
    .venv/bin/python allena.py --nome prova --imposta fase=2 # passa alla fase 2 riprendendo
    .venv/bin/python allena.py --nome piccola --piccola      # prova veloce a bassa scala

Fase 1 (predatore): uccidere e raccogliere soldi, cashout bloccato. Fase 2 (giocatore
completo): gli stessi punti × 0,7 e il premio del cashout fatto da se'. Ricompensa,
lobby e criteri di passaggio in PIANO_ADDESTRAMENTO.md; i numeri di ogni fase in `config.FASI`. Una
corsa nuova parte da pesi casuali (o da `lega.partenza`). Latenza, jitter, singhiozzi e
tempo di decisione sono randomizzati per partita dal simulatore, come online.

Tutto finisce in corse/<nome>/: configurazione, stato completo (riprendibile),
istantanee della lega, il miglior agente, registri CSV, eventi e diario.

Un'iterazione:
  1. raccolta      (`Collector.collect`)  tutte le lobby avanzano di `ppo.passi` snapshot
                                          (addestramento, gironi del torneo, banco di prova)
  2. aggiornamento (`ppo.update`)         PPO sui dati dell'allievo (dopo un cambio di fase,
                                          per qualche iterazione solo il critico)
  3. lega          (`league_step`)        istantanee nel torneo, rosa, deboli, disco
  4. selezione     (`select_best`)        banco di prova, regressioni, migliore
  5. registri      (`write_logs`)         CSV, console, vivo.json per il pannello, diario.txt
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import signal
import threading
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Raccolta e aggiornamento su stream diversi: senza segmenti espandibili la memoria della GPU
# si frammenta (7 GB riservati e inutilizzati, poi OOM con 500 lobby).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import torch  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "simulatore" / "python"))
sys.path.insert(0, str(HERE))

from slither_sim import SlitherVecEnvMeta  # noqa: E402

from ia import ppo  # noqa: E402
from ia.azioni import ActionCodec  # noqa: E402
from ia.config import Config, _merge  # noqa: E402
from ia.diario import Diario  # noqa: E402
from ia.diversita import Diversita  # noqa: E402
from ia.lega import ALLIEVO, PARTENZA, STYLES, League  # noqa: E402
from ia.partite import Benchmark, Matchmaker  # noqa: E402
from ia.raccolta import Collector  # noqa: E402
from ia.registro import CsvLog, Events, save_atomic  # noqa: E402
from ia.rete import COMPILE_LOCK, Layout, NetConfig  # noqa: E402

PICCOLA = ("env.mondi=24", "env.mondi_valutazione=4", "env.mondi_torneo=4", "env.durata_s=[8,20]", "ppo.passi=64",
           "ppo.sequenza=32", "ppo.minibatch=16", "ppo.riscaldamento_critico=1", "lega.istantanea_ogni=2", "lega.rosa_ogni=2",
           "lega.campioni_min=2", "lega.torneo_partite=3", "lega.archivio_ogni=4", "lega.stile_partite=2",
           "lega.sonda_sequenze=8", "lega.sonda_passi=16", "salva_ogni=3")


@dataclass
class Stato:
    """Cio' che una corsa porta con se' da un'iterazione all'altra (e nel salvataggio)."""
    it: int = 0
    samples: int = 0
    best_fit: float = -1e9
    fase: int = 1
    it_fase: int = 0                   # iterazione in cui e' cominciata la fase corrente
    riscaldo_fino: int = 0             # fino a quest'iterazione solo il critico (dopo un cambio di fase)


# --- preparazione --------------------------------------------------------------------------
def build_config(args) -> tuple[Config, Path]:
    """La configurazione della corsa: quella salvata (se riprende) piu' le opzioni date."""
    root = HERE / "corse" / args.nome
    root.mkdir(parents=True, exist_ok=True)
    cfg_path = root / "config.json"
    nuova = not cfg_path.exists()
    cfg = Config() if nuova else Config.from_dict(json.loads(cfg_path.read_text()))
    cfg.nome = args.nome
    fase_prima = cfg.fase
    for kv in args.imposta:
        if kv.split("=", 1)[0] == "fase":
            cfg.set(*kv.split("=", 1))
    if nuova or cfg.fase != fase_prima:
        # I numeri della fase (lobby, durate, lr); cio' che e' dato esplicitamente vince.
        cfg.applica_fase()
    if args.piccola:
        for kv in PICCOLA:
            cfg.set(*kv.split("=", 1))
    if args.config:
        _merge(cfg, json.loads(Path(args.config).read_text()))
    for kv in args.imposta:
        cfg.set(*kv.split("=", 1))
    if args.iterazioni is not None:
        cfg.iterazioni = args.iterazioni
    if cfg.ppo.passi % cfg.ppo.sequenza:
        sys.exit(f"ppo.passi ({cfg.ppo.passi}) deve essere un multiplo di ppo.sequenza ({cfg.ppo.sequenza})")
    if cfg.fase not in (1, 2):
        sys.exit(f"fase {cfg.fase}: le fasi sono 1 (predatore) e 2 (giocatore completo)")
    if not 0 <= cfg.env.copie[0] <= cfg.env.copie[1] <= cfg.env.posti - 1:
        sys.exit(f"env.copie {cfg.env.copie}: servono 0 ≤ minimo ≤ massimo ≤ env.posti − 1 ({cfg.env.posti - 1})")
    if cfg.env.mondi_valutazione + cfg.env.mondi_torneo >= cfg.env.mondi:
        sys.exit("env.mondi_valutazione + env.mondi_torneo devono lasciare lobby per l'addestramento")
    cfg.save(cfg_path)
    return cfg, root


def pick_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def load_partenza(cfg: Config, learner, league: League, lay: Layout, root: Path, log_event):
    """Una corsa nuova parte dal checkpoint di partenza (i pesi dell'allievo, e una sua
    copia nella lega: l'ancora del banco di prova), o da pesi casuali se `lega.partenza`
    e' vuoto: allora l'ancora e' la rete casuale stessa."""
    dst = league.dir / "partenza.pt"
    if not cfg.lega.partenza:
        save_atomic({"model": learner.model.state_dict(), "allievo": "casuale", "iter": 0,
                     "layout": lay.to_dict()}, dst)
        league.add_snapshot(0, {}, fid=PARTENZA, path=dst, campione=False)
        log_event("allievo avviato da pesi casuali (lega.partenza vuoto)")
        return
    src = Path(cfg.lega.partenza)
    src = src if src.is_absolute() else HERE / src
    if not src.exists():
        sys.exit(f"checkpoint di partenza mancante: {src} (lega.partenza)")
    st = torch.load(src, map_location="cpu", weights_only=False)
    if isinstance(st, dict) and "layout" in st and st["layout"] != lay.to_dict():
        sys.exit(f"{src.name}: osservazione diversa da quella del simulatore attuale")
    sd = st.get("model", st) if isinstance(st, dict) else st
    learner.model.load_state_dict({k: v.float() for k, v in sd.items()})
    # Copia nella cartella della corsa: la corsa resta completa e spostabile (Mac ↔ RunPod).
    shutil.copyfile(src, dst)
    league.add_snapshot(0, {}, fid=PARTENZA, path=dst, campione=False)
    log_event(f"allievo avviato da {src.name} ({st.get('allievo', '?')} @ {st.get('iter', '?')}); "
              f"PopArt μ {float(learner.model.ret_mu):+.3f} σ {float(learner.model.ret_sigma):.3f}")


def load_iniziali(cfg: Config, league: League, lay: Layout, log_event):
    """Corsa nuova con `lega.iniziali`: quei checkpoint (i migliori di una corsa vecchia)
    entrano fra i campioni come PROTETTI e restano sempre in campo. Serve all'affinamento:
    l'allievo impara cose nuove senza smettere di misurarsi con chi e' gia' forte."""
    for raw in filter(None, (x.strip() for x in cfg.lega.iniziali.split(","))):
        src = Path(raw) if Path(raw).is_absolute() else HERE / raw
        if not src.exists():
            sys.exit(f"checkpoint iniziale mancante: {src} (lega.iniziali)")
        st = torch.load(src, map_location="cpu", weights_only=False)
        if isinstance(st, dict) and "layout" in st and st["layout"] != lay.to_dict():
            sys.exit(f"{src.name}: osservazione diversa da quella del simulatore attuale")
        it = st.get("iter", 0) if isinstance(st, dict) else 0
        nome = f"migliore@{it}" if src.stem == "migliore" else src.stem
        fid = f"top:{nome}"
        dst = league.dir / f"top_{nome.replace('@', '_')}.pt"
        shutil.copyfile(src, dst)
        fase = int(st.get("fase", 2)) if isinstance(st, dict) else 2
        league.add_snapshot(0, {}, fid=fid, path=dst, fase=fase, meta={"origine": str(src)})
        if fid not in league.protetti:
            league.protetti.append(fid)
        log_event(f"campione protetto {fid} da {src} (fase {fase})")


def load_or_init(root: Path, cfg: Config, learner, league, bench, rng, lay, device, log_event) -> Stato:
    """Riprende dal salvataggio se c'e', altrimenti avvia una corsa nuova dal checkpoint."""
    state_path = root / "stato.pt"
    if state_path.exists():
        st = torch.load(state_path, map_location=device, weights_only=False)
        if st.get("formato") != 3:
            sys.exit(f"{state_path}: e' di una corsa con la vecchia ricompensa; usa un --nome nuovo")
        learner.load(st["learner"])
        league.load(st["league"])
        bench.load(st["bench"])
        stato = Stato(it=st["iter"], samples=st["samples"], best_fit=st["best_fit"], fase=st["fase"],
                      it_fase=st["it_fase"], riscaldo_fino=st.get("riscaldo_fino", 0))
        rng.setstate(st["rng"])
        log_event(f"ripresa la corsa «{cfg.nome}» dall'iterazione {stato.it} ({stato.samples / 1e6:.1f} M campioni), fase {stato.fase}")
        if cfg.fase != stato.fase:
            cambia_fase(stato, cfg, learner, league, bench, root, log_event)
    else:
        stato = Stato(fase=cfg.fase)
        log_event(f"nuova corsa «{cfg.nome}» su {device}, fase {cfg.fase}: {cfg.env.mondi} lobby × {cfg.env.posti} posti")
        load_partenza(cfg, learner, league, lay, root, log_event)
        load_iniziali(cfg, league, lay, log_event)
    if not league.roster or not league.deboli:
        league.refresh_roster(rng)
    return stato


def cambia_fase(stato: Stato, cfg: Config, learner, league, bench, root: Path, log_event):
    """Passaggio di fase. L'allievo di fine fase entra fra i campioni come PROTETTO (non
    viene mai scartato: in fase 2 resta in campo un predatore puro da cui non disimparare);
    il banco riparte (i punti hanno un'altra scala) e per `riscaldamento_critico`
    iterazioni si allena solo il critico (i ritorni sono cambiati, la politica no)."""
    vecchia = stato.fase
    best = root / "migliore.pt"
    if cfg.lega.fase_da_migliore and best.exists():
        # La fase nuova parte dal migliore della fase vecchia (se l'allievo stava regredendo).
        st = torch.load(best, map_location="cpu", weights_only=False)
        learner.model.load_state_dict({k: v.float() for k, v in st["model"].items()})
        log_event(f"la fase {cfg.fase} parte da migliore.pt (iterazione {st.get('iter', '?')}, fitness {st.get('fitness', float('nan')):+.3f})")
    fid = league.add_snapshot(stato.it, learner.model.state_dict(), fid=f"fase{vecchia}_finale", fase=vecchia)
    if fid not in league.protetti:
        league.protetti.append(fid)
    bench.reset()
    stato.best_fit = -1e9
    stato.fase, stato.it_fase = cfg.fase, stato.it
    stato.riscaldo_fino = stato.it + cfg.ppo.riscaldamento_critico
    if best.exists():
        shutil.copyfile(best, root / f"migliore_fase{vecchia}.pt")
    log_event(f"PASSAGGIO ALLA FASE {cfg.fase} all'iterazione {stato.it}: «{fid}» protetto fra i campioni, "
              f"banco azzerato (migliore della fase {vecchia} in migliore_fase{vecchia}.pt), "
              f"solo critico fino all'iterazione {stato.riscaldo_fino}")


def save_state(root: Path, stato: Stato, cfg: Config, learner, league, bench, rng):
    save_atomic({"formato": 3, "iter": stato.it, "samples": stato.samples, "best_fit": stato.best_fit,
                 "fase": stato.fase, "it_fase": stato.it_fase, "riscaldo_fino": stato.riscaldo_fino,
                 "learner": learner.state(), "league": league.state(),
                 "bench": bench.state(), "rng": rng.getstate(), "cfg": cfg.to_dict()},
                root / "stato.pt")


# --- un'iterazione, a pezzi ----------------------------------------------------------------
def summarize(eps: list[dict]) -> dict:
    """Gli episodi finiti dell'allievo in un'iterazione, riassunti. Le statistiche
    principali sono sugli episodi «da posta» (entrati con la posta, come online); gli
    episodi delle copie dal vivo entrate gia' ricche contano a parte."""
    base = [e for e in eps if not e["ricco"]]
    out = {"episodi": len(base), "ricchi": len(eps) - len(base)}
    if not base:
        return out
    mot = np.array([e["motivo"] for e in base])
    m = lambda k: float(np.mean([e[k] for e in base]))           # noqa: E731
    usc = [e.get("uscita") for e in base]
    out.update({
        "punti": m("punti"),                                      # la ricompensa per episodio
        "uccisioni": m("uccisioni"),
        "bottino_mio": m("bottino_mio"),                          # cadute intere delle proprie uccisioni
        "bottino_altrui": m("bottino_altrui"),
        "cibo": m("cibo"),
        "profitto": m("profitto"),
        "morte": float((mot == 1).mean()),
        "incasso": float((mot == 2).mean()),                      # cashout fatti da se'
        "forzati": float((mot == 4).mean()),                      # in campo alla fine della partita
        "uscita_pulita": float(np.mean([u == "pulita" for u in usc])),    # +80 % e niente oro a terra (5,0)
        "uscita_oro": float(np.mean([u == "con_oro" for u in usc])),      # +80 % con oro a terra (2,6)
        "uscita_vuota": float(np.mean([u == "vuota" for u in usc])),      # +20 %, lobby vuota (7,0)
        "uscita_sotto": float(np.mean([u == "nessuna" for u in usc])),    # cashout senza premio (fra +20 e +80 %)
        "uscita_penale": float(np.mean([u == "penale" for u in usc])),    # cashout sotto +20 % (−5,0)
        "raggiunto": m("raggiunto"),                              # +80 % raggiunto almeno una volta
        "raddoppio": float(np.mean([e["profitto"] >= 1.0 for e in base])),
        "durata": m("durata"),
        "muro": m("muro"),
        "frontale": m("frontale"),                                # morti in uno scontro testa contro testa
        "taglia": m("taglia"),
        "escursione": m("escursione"),                            # u dal punto d'ingresso, al massimo
        "boost": m("boost"),                                      # frazione del tempo col boost
        "fermo": m("fermo"),                                      # frazione del tempo fermo in tondo
    })
    # Le situazioni della fase 2: quanto mangia mentre aspetta, come se la cava da piccolo,
    # come gestisce cibo e boost in un duello lungo.
    for sit, chiavi in (("attesa", ("cibo", "boost", "punti", "morte", "uccisioni")),
                        ("svantaggio", ("punti", "morte", "uccisioni")),
                        ("duello", ("cibo", "boost", "taglia", "punti", "morte", "uccisioni"))):
        es = [e for e in base if e.get("situazione") == sit]
        out[f"n_{sit}"] = len(es)
        for k in chiavi:
            v = [float(e["motivo"] == 1) if k == "morte" else e[k] for e in es]
            out[f"{k}_{sit}"] = float(np.mean(v)) if v else float("nan")
    return out


def league_step(stato: Stato, cfg: Config, learner, league: League, col: Collector, rng, log_event):
    """Istantanee nel torneo; rosa e deboli rinnovati a poco a poco; disco entro il budget;
    i risultati dei gironi negli eventi."""
    it, lc = stato.it, cfg.lega
    if it % lc.istantanea_ogni == 0:
        league.add_snapshot(it, learner.model.state_dict(), fase=stato.fase)
        league.prune(col.in_use())
        if it % (lc.istantanea_ogni * 10) == 0:
            log_event(f"iterazione {it}: istantanea nel torneo ({len(league.campioni)} campioni, "
                      f"{len(league.snapshots)} checkpoint su disco)")
    if it % lc.rosa_ogni == 0:
        league.refresh_roster(rng)
    for msg in league.messaggi:
        log_event(msg)
    league.messaggi.clear()


def select_best(stato: Stato, cfg: Config, learner, league, bench, lay, nc, root: Path, log_event) -> float | None:
    """Banco di prova: regressioni (eventi) e migliore di sempre (migliore.pt)."""
    for sc in bench.regressions():
        log_event(f"regressione nello scenario {sc}: punteggio {bench.score(sc):+.3f} contro il meglio {bench.best[sc]:+.3f}")
    fit = bench.fitness()
    if fit is not None and fit > stato.best_fit:
        stato.best_fit = fit
        save_atomic({"model": learner.model.state_dict(), "allievo": ALLIEVO, "iter": stato.it, "fitness": fit, "fase": stato.fase,
                     "layout": lay.to_dict(), "net": nc.__dict__}, root / "migliore.pt")
        log_event(f"nuovo migliore con fitness {fit:+.3f}")
    return fit


def write_logs(stato: Stato, cfg: Config, learner, league, bench, col, summ: dict, upd: dict, fit, cst: dict,
               times: tuple, logs: tuple, root: Path):
    """registro.csv (una riga per iterazione), valutazione.csv (banco), la riga in console e
    vivo.json per il pannello."""
    log_train, log_eval = logs
    t0, t1, t2, t_start, samples_start = times
    it, samples = stato.it, stato.samples
    now = time.time()
    rate_all = (samples - samples_start) / max(now - t_start, 1e-6)
    row = {"iter": it, "allievo": ALLIEVO, "campioni": samples, "secondi": round(now - t_start, 1), "fase": stato.fase,
           "partite": col.matches_done, "t_raccolta": t1 - t0, "t_aggiornamento": t2 - t1, "elo": league.elo.get(ALLIEVO),
           "rosa": len(league.roster), "istantanee": len(league.snapshots), "campioni_torneo": len(league.campioni),
           "gironi": league.gironi, "diversita": league.diversita, "fitness": fit, **cst,
           **{f"ep_{k}": v for k, v in summ.items()}, **upd, **{f"hp_{k}": v for k, v in learner.hp.items()}}
    log_train.write(row)
    if col.eval_done:
        er = {"iter": it, "allievo": ALLIEVO, "fitness": fit}
        for sc, v in bench.summary().items():
            er.update({f"{sc}_{k}": x for k, x in v.items()})
        log_eval.write(er)
        col.eval_done.clear()

    s = summ
    txt = (f"{s['episodi']:4d}ep pt {s['punti']:.2f} ucc {s['uccisioni']:.2f} bm {s['bottino_mio']:.2f} ba {s['bottino_altrui']:.2f} "
           f"cibo {s['cibo']:.0f} m{s['morte']:.0%} (front {s['frontale']:.0%}) f{s['forzati']:.0%} dur {s['durata']:.0f}s"
           + (f" | usc {s['incasso']:.0%} (pul {s['uscita_pulita']:.0%} oro {s['uscita_oro']:.0%} vuota {s['uscita_vuota']:.0%} "
              f"sotto {s['uscita_sotto']:.0%} pen {s['uscita_penale']:.0%}) prof {s['profitto']:+.2f}" if stato.fase == 2 else "")
           + f" | esc {s['escursione']:.0f} fermo {s['fermo']:.0%} b{s['boost']:.0%} t{s['taglia']:.0f}") if s.get("episodi") else "-"
    crit = " critico" if upd.get("solo_critico") else ""
    print(f"it {it:5d} F{stato.fase} | {samples / 1e6:7.2f}M | {rate_all:6.0f}/s | racc {t1 - t0:4.1f}s agg {t2 - t1:4.1f}s{crit} | {txt} | "
          f"camp {len(league.campioni)} gir {league.gironi} fit {'-' if fit is None else f'{fit:+.3f}'}", flush=True)

    # Istantanea per il pannello (scritta in modo atomico, letta ogni pochi secondi).
    dt = now - t0
    live = {"iter": it, "campioni": samples, "velocita": rate_all, "secondi": now - t_start, "t_iterazione": dt,
            "tempo_reale_x": cfg.env.mondi * cfg.ppo.passi * 0.0421 / max(dt, 1e-6),
            "fase": stato.fase, "it_fase": stato.it_fase, "obiettivo": cfg.ricompensa.obiettivo,
            "partite": col.matches_done, "fitness": fit, "campioni_torneo": list(league.campioni),
            "gironi": league.gironi, "torneo": league.torneo, "deboli": list(league.deboli), "diversita": league.diversita,
            "stili": {c: league.stile(c) for c in league.campioni},
            "migliore": stato.best_fit if stato.best_fit > -1e8 else None, "riscaldamento": bool(upd.get("solo_critico")),
            "stili_bot": dict(zip(STYLES, (round(league.bots.beat[st], 3) for st in STYLES))),
            "rosa": list(league.roster), "istantanee": len(league.snapshots), "elo": league.elo.get(ALLIEVO),
            "episodi": summ, "banco": bench.summary(), "ora": now}
    tmp = root / "vivo.json.tmp"
    tmp.write_text(json.dumps(live))
    os.replace(tmp, root / "vivo.json")


# --- il ciclo ------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nome", default="corsa")
    ap.add_argument("--config", help="JSON con parametri da sovrascrivere")
    ap.add_argument("--imposta", action="append", default=[], metavar="CHIAVE=VALORE")
    ap.add_argument("--iterazioni", type=int, default=None, help="si ferma dopo N iterazioni (0 = mai)")
    ap.add_argument("--piccola", action="store_true", help="scala ridotta per provare che tutto giri")
    args = ap.parse_args()
    cfg, root = build_config(args)
    # Il simulatore (rayon) e torch sulla CPU non devono contendersi tutti i core con il
    # thread di Python che guida la GPU: su macchine con molti core si limita il numero.
    cores = os.cpu_count() or 8
    os.environ.setdefault("RAYON_NUM_THREADS", str(max(4, min(cores - 4, 64))))
    torch.set_num_threads(max(2, min(cores // 4, 16)))

    # Il Mac non deve addormentarsi mentre si addestra: caffeinate lo tiene sveglio
    # finche' vive questo processo.
    if sys.platform == "darwin" and shutil.which("caffeinate"):
        subprocess.Popen(["caffeinate", "-i", "-s", "-w", str(os.getpid())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    random.seed(cfg.seme)
    np.random.seed(cfg.seme)
    torch.manual_seed(cfg.seme)
    rng = random.Random(cfg.seme + 1)
    device = pick_device(cfg.dispositivo)
    diario = Diario(root, cfg)
    log_event = Events(root / "eventi.log", anche=diario.evento)
    logs = (CsvLog(root / "registro.csv"), CsvLog(root / "valutazione.csv"))

    # Due meta' di lobby: una viene simulata mentre l'altra passa dalla rete (raccolta.py).
    env = SlitherVecEnvMeta(num_envs=cfg.env.mondi, agents_per_env=cfg.env.posti, seed=cfg.seme,
                            params={"gold_gain": cfg.env.crescita_oro},
                            randomize=cfg.env.randomizza, match_mode=True, decision_ms=cfg.env.decisione_ms)
    lay = Layout.from_sim(env.layout())
    nc = NetConfig()
    learner = ppo.Learner(ALLIEVO, lay, nc, cfg.ppo, device)
    league = League(root, cfg.lega)
    bench = Benchmark()
    mm = Matchmaker(cfg, league, rng)
    codec = ActionCodec(device)
    ripresa = (root / "stato.pt").exists()
    n_par = sum(p.numel() for p in learner.model.parameters()) / 1e6
    pending = []
    log_event.anche = lambda msg, it: pending.append(msg)      # gli eventi di avvio vanno dopo l'intestazione
    stato = load_or_init(root, cfg, learner, league, bench, rng, lay, device, log_event)
    diario.apertura(device, lay.size, n_par, ripresa, stato.it, stato.samples)
    for msg in pending:
        diario.evento(msg)
    log_event.anche = diario.evento

    col = Collector(cfg, env, learner, league, mm, bench, lay, nc, device, root)
    col.start()
    div = Diversita(cfg, league, lay, nc, device, root)
    print(f"rete: {n_par:.2f} M parametri; osservazione {lay.size}; dispositivo {device}", flush=True)

    # Ctrl+C o «Ferma» dal pannello: si finisce l'iterazione, si salva, si esce.
    stop = {"chiesto": False}

    def on_stop(signum, frame):
        if not stop["chiesto"]:
            stop["chiesto"] = True
            print("  · fermata richiesta: salvo alla fine di questa iterazione…", flush=True)

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)
    pid_path = root / "processo.json"
    pid_path.write_text(json.dumps({"pid": os.getpid(), "avvio": time.time()}))

    t_start, samples_start = time.time(), stato.samples
    try:
        ciclo(cfg, stato, stop, learner, league, bench, col, div, codec, device, rng, lay, nc, root, logs, log_event, diario, t_start, samples_start)
    except Exception:
        diario.errore(traceback.format_exc())
        diario.chiusura("ERRORE (traccia qui sopra)", stato, t_start, samples_start)
        pid_path.unlink(missing_ok=True)
        raise
    pid_path.unlink(missing_ok=True)
    log_event(f"addestramento fermato all'iterazione {stato.it}")
    diario.chiusura("fermata richiesta (Ferma dal pannello, Ctrl+C o segnale)" if stop["chiesto"] else f"raggiunte le {cfg.iterazioni} iterazioni chieste",
                    stato, t_start, samples_start)


def ciclo(cfg, stato, stop, learner, league, bench, col, div, codec, device, rng, lay, nc, root, logs, log_event, diario, t_start, samples_start):
    """Le iterazioni, finche' non si chiede di fermarsi.

    Con `ppo.sovrapponi` raccolta e aggiornamento si sovrappongono: l'allievo impara
    dal blocco i in un thread (su uno stream CUDA suo) mentre il simulatore e la politica
    di raccolta (copia congelata dei pesi dopo l'aggiornamento i−1) raccolgono il blocco
    i+1. GPU e CPU non restano ferme ad aspettarsi."""
    sovrapponi = cfg.ppo.sovrapponi
    pronto = None                      # (batch, cst, t_raccolta) gia' raccolto in sovrapposizione
    while (cfg.iterazioni == 0 or stato.it < cfg.iterazioni) and not stop["chiesto"]:
        stato.it += 1
        log_event.it = stato.it
        t0 = time.time()

        if pronto is None:
            batch, cst = col.collect()
            t_racc = time.time() - t0
        else:
            batch, cst, t_racc = pronto
            col.sync_allievo()
        eps, col.episodes = col.episodes, []
        t1 = time.time()
        # Dopo un cambio di fase solo il critico: i ritorni sono cambiati e i primi
        # vantaggi sarebbero rumore che rovinerebbe una politica che gia' sa giocare.
        solo_critico = stato.it <= stato.riscaldo_fino
        if sovrapponi and not stop["chiesto"]:
            res: dict = {}

            def aggiorna():
                try:
                    if device.type != "cuda":
                        res["upd"] = ppo.update(learner, 0, batch, cfg.ppo, codec, device, solo_critico=solo_critico)
                        return
                    stream = torch.cuda.Stream()
                    stream.wait_stream(torch.cuda.default_stream())
                    # COMPILE_LOCK: le catture delle pile di raccolta (che compilano) aspettano.
                    with torch.cuda.stream(stream), COMPILE_LOCK:
                        res["upd"] = ppo.update(learner, 0, batch, cfg.ppo, codec, device, solo_critico=solo_critico)
                    stream.synchronize()
                except BaseException as e:  # noqa: BLE001
                    res["err"] = e

            th = threading.Thread(target=aggiorna, daemon=True)
            th.start()
            tc = time.time()
            nb, ncst = col.collect(sync=False)
            pronto = (nb, ncst, time.time() - tc)
            th.join()
            if "err" in res:
                raise res["err"]
            upd = res["upd"]
        else:
            upd = ppo.update(learner, 0, batch, cfg.ppo, codec, device, solo_critico=solo_critico)
            pronto = None
        if solo_critico and stato.it == stato.riscaldo_fino:
            log_event(f"fine del riscaldamento del critico (varianza spiegata {upd.get('var_spiegata', float('nan')):.2f}): da qui PPO completo")
        stato.samples += int((batch.owner >= 0).sum())
        t2 = time.time()
        t0 = t1 - t_racc               # nel registro: raccolta del blocco usato, poi il resto

        summ = summarize(eps)
        league_step(stato, cfg, learner, league, col, rng, log_event)
        div.dopo_iterazione(stato, batch, rng, log_event)      # cloni e mutanti, a ogni girone concluso
        fit = select_best(stato, cfg, learner, league, bench, lay, nc, root, log_event)
        write_logs(stato, cfg, learner, league, bench, col, summ, upd, fit, cst, (t0, t1, t2, t_start, samples_start), logs, root)
        diario.iterazione(stato, cfg, learner, league, bench, col, summ, upd, fit, cst, (t0, t1, t2, t_start, samples_start))

        if stato.it % cfg.salva_ogni == 0 or (cfg.iterazioni and stato.it >= cfg.iterazioni) or stop["chiesto"]:
            save_state(root, stato, cfg, learner, league, bench, rng)
            log_event(f"salvato (iterazione {stato.it})")


if __name__ == "__main__":
    main()
