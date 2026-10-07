"""Il diario della corsa: `corse/<nome>/diario.txt`.

Un solo file di testo che racconta ESATTAMENTE cosa e' successo nell'addestramento,
pensato per essere incollato in una conversazione e letto tutto insieme: deve stare in
una finestra di contesto anche dopo giorni di corsa. Per questo non e' un log riga per
riga ma un riassunto a cadenza crescente (ogni iterazione all'inizio, poi ogni 5, 20,
50, 100, 250), con i numeri aggregati sull'intervallo, piu' tutti gli eventi
(istantanee, gironi del torneo, cambi di fase, migliore, regressioni, salvataggi,
fermate, errori), un «quadro» periodico piu' profondo (banco scenario per scenario,
stili dei bot, rosa, campioni del torneo, iperparametri) e un controllo automatico delle anomalie, segnalate con «!!».

Sopra `limite_kb` i riassunti piu' vecchi vengono diradati (eventi, quadri e anomalie
restano): il diario resta sempre leggibile per intero.

Lettura rapida del formato:
  [HH:MM] it N  ...          evento (lo stesso di eventi.log)
  it A–B | ...               riassunto delle iterazioni A..B
  == quadro it N             sezione profonda
  !! ...                     anomalia rilevata automaticamente
"""
from __future__ import annotations

import math
import platform
import subprocess
import sys
import time
from pathlib import Path

from .config import Config
from .lega import ALLIEVO, STYLES


def cadenza(it: int) -> int:
    """Ogni quante iterazioni si scrive un riassunto: cresce con la corsa."""
    for lim, c in ((20, 1), (100, 5), (500, 20), (2000, 50), (10000, 100)):
        if it <= lim:
            return c
    return 250


def _pct(x) -> str:
    return "-" if x is None else f"{100 * x:.0f}%"


def _f(x, d=2) -> str:
    if x is None:
        return "-"
    if isinstance(x, float) and not math.isfinite(x):
        return "nan"
    return f"{x:+.{d}f}"


def _git() -> str:
    try:
        root = Path(__file__).resolve().parents[2]
        h = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True, timeout=5).stdout.strip()
        return (h or "?") + (" (modifiche locali)" if dirty else "")
    except Exception:
        return "?"


def _differenze(cfg: Config) -> list[str]:
    """I parametri diversi dai default, come `sezione.chiave=valore`."""
    base, cur = Config().to_dict(), cfg.to_dict()
    out = []
    for sec, vals in cur.items():
        if isinstance(vals, dict):
            out += [f"{sec}.{k}={v}" for k, v in vals.items() if base[sec].get(k) != v]
        elif base.get(sec) != vals and sec != "nome":
            out.append(f"{sec}={vals}")
    return out


class Diario:
    def __init__(self, root: Path, cfg: Config, limite_kb: int = 600):
        self.path = root / "diario.txt"
        self.cfg = cfg
        self.limite = limite_kb * 1024
        self.acc: list[dict] = []           # iterazioni dall'ultimo riassunto
        self.vel: list[float] = []          # velocita' delle ultime iterazioni (per il crollo)
        self.ult_it = 0
        self.ult_quadro = 0

    # --- scrittura ----------------------------------------------------------------------
    def _scrivi(self, testo: str):
        with self.path.open("a", encoding="utf-8") as f:
            f.write(testo.rstrip("\n") + "\n")
        if self.path.stat().st_size > self.limite:
            self._compatta()

    def _compatta(self):
        """Dirada i riassunti di iterazione piu' vecchi (uno su due nella prima meta')."""
        blocchi = self.path.read_text(encoding="utf-8").split("\n\n")
        meta = len(blocchi) // 2
        tenuti, tolti, k = [], 0, 0
        for i, b in enumerate(blocchi):
            if i < meta and b.startswith("it "):
                k += 1
                if k % 2 == 0:
                    tolti += 1
                    # Gli eventi e le anomalie scritti in coda al blocco restano.
                    resto = [r for r in b.splitlines() if r.startswith("[") or r.lstrip().startswith("!!")]
                    if resto:
                        tenuti.append("\n".join(resto))
                    continue
            tenuti.append(b)
        if tolti == 0:
            self.limite = int(self.limite * 1.5)     # non c'e' piu' niente da diradare: si allarga
            return
        tenuti.append(f"[{time.strftime('%H:%M')}] diario compattato: tolti {tolti} riassunti vecchi (il file superava {self.limite // 1024} kB)")
        self.path.write_text("\n\n".join(tenuti) + "\n", encoding="utf-8")

    # --- intestazione e eventi ------------------------------------------------------------
    def apertura(self, device, lay_size: int, n_par: float, ripresa: bool, it: int, samples: int):
        import torch
        c = self.cfg
        rc, ec, lc = c.ricompensa, c.env, c.lega
        diff = _differenze(c)
        righe = [
            f"{'=' * 78}",
            f"{'RIPRESA' if ripresa else 'NUOVA CORSA'} «{c.nome}»  {time.strftime('%Y-%m-%d %H:%M:%S')}"
            + (f"  dall'iterazione {it} ({samples / 1e6:.1f} M campioni)" if ripresa else f"  da {lc.partenza}"),
            f"codice {_git()} · python {platform.python_version()} · torch {torch.__version__} · {platform.system()} {platform.machine()} · dispositivo {device}",
            f"comando: {' '.join(sys.argv)}",
            f"rete {n_par:.2f} M parametri · osservazione {lay_size} · FASE {c.fase}: allievo + {ec.copie[0]}–{ec.copie[1]} avversari neurali "
            f"(dal vivo {lc.p_vivo:.0%}, altrimenti campioni del torneo; una versione debole nel {lc.p_debole:.0%} delle lobby) + "
            f"{ec.bot_n[0]}–{ec.bot_n[1]} bot abilita' {ec.bot_abilita[0]}–{ec.bot_abilita[1]} · durata {ec.durata_s[0]:.0f}–{ec.durata_s[-1]:.0f} s · "
            f"crescita per orb d'oro {ec.crescita_oro} · bottino a terra senza scadenza",
            f"lobby {ec.mondi}×{ec.posti} posti (banco {ec.mondi_valutazione}, torneo {ec.mondi_torneo}) · passi {c.ppo.passi} · sequenza {c.ppo.sequenza} · "
            f"minibatch {c.ppo.minibatch} · lr {c.ppo.lr:g} · γ {c.ppo.gamma} · λ {c.ppo.lam} · kl_max {c.ppo.kl_max}",
            f"ricompensa a punti: uccisione {rc.uccisione} · bottino proprio {rc.bottino_mio}/caduta · altrui {rc.bottino_altrui}/caduta · "
            f"cibo {rc.cibo}/orb · morte testa contro testa −{rc.morte_frontale}" + ("" if c.fase == 1 else
                                    f" · tutto ×{rc.peso_fase2} · cashout: +{rc.obiettivo:.0%} senza oro {rc.bonus_pulito}, con oro {rc.bonus_oro}, "
                                    f">+{rc.soglia_vuoto:.0%} a lobby vuota {rc.bonus_vuoto}"),
            f"torneo: gironi da {lc.torneo_n} su {lc.torneo_partite} partite, campioni {lc.campioni_min}–{lc.campioni_max}, "
            f"istantanea ogni {lc.istantanea_ogni} it, archivio ogni {lc.archivio_ogni}",
            "parametri diversi dai default: " + (", ".join(diff) if diff else "nessuno"),
            "lettura: ep = episodi entrati con la posta; pt = punti (ricompensa) per episodio; ucc = uccisioni; bm/ba = cadute di "
            "bottino proprio/altrui raccolte; m = morti; f = fine partita; usc = cashout (pul = +80 % senza oro, oro = con oro a terra, "
            "vuota = lobby vuota, sotto = senza premio); kl/ent/clipf/vs = KL, entropia della sterzata, frazione tagliata, "
            "varianza spiegata; !! = anomalia",
        ]
        self._scrivi("\n".join(righe))

    def evento(self, msg: str, it: int | None = None):
        self._scrivi(f"[{time.strftime('%H:%M')}]{f' it {it}' if it is not None else ''}  {msg}")

    def errore(self, tb: str):
        corto = "\n".join(tb.strip().splitlines()[-12:])
        self._scrivi(f"\n!! ERRORE {time.strftime('%Y-%m-%d %H:%M:%S')}\n{corto}\n")

    def chiusura(self, motivo: str, stato, t_start: float, samples_start: int):
        dt = time.time() - t_start
        self._scrivi(f"\n[{time.strftime('%H:%M')}] FINE: {motivo} · iterazione {stato.it} · {stato.samples / 1e6:.1f} M campioni "
                     f"({(stato.samples - samples_start) / 1e6:.1f} M in questa sessione, {dt / 3600:.1f} h, {(stato.samples - samples_start) / max(dt, 1):.0f}/s) · "
                     f"fase {stato.fase} · migliore {_f(stato.best_fit, 3) if stato.best_fit > -1e8 else '-'}\n")

    # --- iterazioni -----------------------------------------------------------------------
    def iterazione(self, stato, cfg, learner, league, bench, col, summ: dict, upd: dict, fit, cst: dict, times: tuple):
        t0, t1, t2, t_start, samples_start = times
        now = time.time()
        vel = (stato.samples - samples_start) / max(now - t_start, 1e-6)
        self.acc.append({"it": stato.it, "campioni": stato.samples, "vel": vel, "racc": t1 - t0, "agg": t2 - t1,
                         "inf": cst.get("t_inferenza", 0.0), "sim": cst.get("t_simulatore", 0.0),
                         "vive": cst.get("righe_vive", 0.0) / max(getattr(col, "N", 1), 1), "scarto": cst.get("scarto_pila", 0.0),
                         "fase": stato.fase, "summ": summ, "upd": upd, "fit": fit})
        for a in self._anomalie_immediate(stato, upd, vel, cst):
            self._scrivi(f"!! it {stato.it}: {a}")
        self.vel.append(vel)
        c = cadenza(stato.it)
        if stato.it % c == 0 or stato.it - self.ult_it >= c:
            self._riassunto(stato, learner, league)
            if stato.it - self.ult_quadro >= 10 * c or self.ult_quadro == 0:
                self._quadro(stato, learner, league, bench)
                self.ult_quadro = stato.it
            self.ult_it = stato.it
            self.acc.clear()

    def _anomalie_immediate(self, stato, upd: dict, vel: float, cst: dict) -> list[str]:
        out = []
        cattivi = [k for k, v in upd.items() if isinstance(v, float) and not math.isfinite(v)]
        if cattivi:
            out.append(f"valori non finiti nell'aggiornamento ({', '.join(cattivi)}): la rete puo' essere corrotta")
        if len(self.vel) >= 10:
            rif = sorted(self.vel[-10:])[5]
            if vel < 0.5 * rif and stato.it > 20:
                out.append(f"velocita' crollata: {vel:.0f}/s contro {rif:.0f}/s delle ultime iterazioni (GPU rallentata? altro processo? memoria?)")
        if cst.get("scarto_pila", 0.0) > 0.1:
            out.append(f"la pila d'inferenza diverge dal modello (scarto {cst['scarto_pila']:.3f}): azioni di un posto a un altro?")
        return out

    def _w(self, key: str):
        """Media pesata sugli episodi dell'intervallo (0 se nessun episodio)."""
        tot = sum(x["summ"].get("episodi", 0) for x in self.acc)
        if tot == 0:
            return 0.0
        return sum(x["summ"].get(key, 0.0) * x["summ"].get("episodi", 0) for x in self.acc) / tot

    def _m(self, key: str, d: int = 3) -> str:
        v = [x["upd"][key] for x in self.acc if key in x["upd"] and isinstance(x["upd"][key], (int, float)) and math.isfinite(x["upd"][key])]
        return f"{sum(v) / len(v):.{d}f}" if v else "-"

    def _riassunto(self, stato, learner, league):
        a = self.acc
        if not a:
            return
        p, u = a[0], a[-1]
        n = len(a)
        span = f"it {p['it']}" if p is u else f"it {p['it']}–{u['it']}"
        ep = sum(x["summ"].get("episodi", 0) for x in a)
        ricchi = sum(x["summ"].get("ricchi", 0) for x in a)
        crit = sum(1 for x in a if x["upd"].get("solo_critico"))
        righe = [f"{span} | {u['campioni'] / 1e6:.2f}M camp | {sum(x['vel'] for x in a) / n:.0f}/s | "
                 f"racc {sum(x['racc'] for x in a) / n:.1f}s agg {sum(x['agg'] for x in a) / n:.1f}s "
                 f"(inf {sum(x['inf'] for x in a) / n:.1f} sim {sum(x['sim'] for x in a) / n:.1f}) | righe vive {_pct(sum(x['vive'] for x in a) / n)} | "
                 f"F{u['fase']} | rosa {len(league.roster)} campioni {len(league.campioni)} gironi {league.gironi} ist {len(league.snapshots)} | "
                 f"Elo {league.elo.get(ALLIEVO):.0f}"
                 + (f" | solo critico {crit}/{n}" if crit else "")]
        if ep:
            w = self._w
            righe.append(f"   {ep}ep (+{ricchi} ricchi) pt {w('punti'):.2f} ucc {w('uccisioni'):.2f} bm {w('bottino_mio'):.2f} "
                         f"ba {w('bottino_altrui'):.2f} cibo {w('cibo'):.0f} m{_pct(w('morte'))} (frontale {_pct(w('frontale'))}) f{_pct(w('forzati'))} "
                         f"dur {w('durata'):.0f}s muro {_pct(w('muro'))} taglia {w('taglia'):.0f} escursione {w('escursione'):.0f}u "
                         f"fermo {_pct(w('fermo'))} boost {_pct(w('boost'))}")
            if u["fase"] == 2:
                righe.append(f"   cashout {_pct(w('incasso'))} (pul {_pct(w('uscita_pulita'))} oro {_pct(w('uscita_oro'))} "
                             f"vuota {_pct(w('uscita_vuota'))} sotto {_pct(w('uscita_sotto'))}) rag{_pct(w('raggiunto'))} "
                             f"prof {_f(w('profitto'))} x2 {_pct(w('raddoppio'))}")
        else:
            righe.append("   nessun episodio «da posta» finito")
        sk = [x["upd"].get("stop_kl", 0) for x in a if x["upd"]]
        righe.append(f"   kl {self._m('kl', 4)} ent {self._m('entropia_svolta')} clipf {self._m('clipfrac')} vs {self._m('var_spiegata')} "
                     f"pol {self._m('perdita_pol')} val {self._m('perdita_val')} aux {self._m('aux_morte')}/{self._m('aux_oro')} "
                     f"stopKL {sum(sk)}/{len(sk)} lr {learner.hp.get('lr', 0):.1e} scarto pila {max(x['scarto'] for x in a):.3f} | "
                     f"fit {_f(u['fit'], 3)} migliore {_f(stato.best_fit, 3) if stato.best_fit > -1e8 else '-'}")
        for an in self._anomalie_intervallo(stato, ep):
            righe.append(f"   !! {an}")
        self._scrivi("\n" + "\n".join(righe))

    def _anomalie_intervallo(self, stato, ep: int) -> list[str]:
        out = []
        a = self.acc
        rc = self.cfg.ricompensa
        w = self._w
        ent = self._m("entropia_svolta")
        if ent != "-" and float(ent) < -1.5:
            out.append(f"sterzata quasi deterministica (entropia {ent}): niente esplorazione")
        vs = self._m("var_spiegata")
        crit = all(x["upd"].get("solo_critico") for x in a if x["upd"])
        if vs != "-" and float(vs) < 0.0 and stato.samples > 5e6 and not crit:
            out.append(f"il valore non spiega i ritorni (varianza spiegata {vs}): critico o ricompensa troppo rumorosi")
        kl = self._m("kl", 4)
        if kl != "-" and float(kl) > 2 * self.cfg.ppo.kl_max:
            out.append(f"KL medio {kl} oltre il doppio di kl_max {self.cfg.ppo.kl_max}: passi troppo grandi (lr, clip)")
        sk = [x["upd"].get("stop_kl", 0) for x in a if x["upd"]]
        if len(sk) >= 5 and sum(sk) == len(sk):
            out.append(f"stop sul KL in TUTTE le {len(sk)} iterazioni: una sola epoca utile, lr forse alto")
        if ep >= 30:
            if w("durata") < 8.0 and w("incasso") > 0.6:
                out.append(f"TRAPPOLA dell'uscita immediata: episodi di {w('durata'):.0f} s e {_pct(w('incasso'))} di cashout")
            if w("morte") >= 0.6 and stato.samples > 3e7:
                out.append(f"muore nel {_pct(w('morte'))} degli episodi dopo {stato.samples / 1e6:.0f} M campioni")
            if w("fermo") > 0.5 and stato.samples > 3e7:
                out.append(f"fermo in tondo il {_pct(w('fermo'))} del tempo: non caccia")
            if a[-1]["fase"] == 2 and w("raggiunto") > 0.1 and w("incasso") < 0.3 * w("raggiunto"):
                out.append(f"raggiunge +{rc.obiettivo:.0%} nel {_pct(w('raggiunto'))} degli episodi ma incassa solo nel {_pct(w('incasso'))}")
        elif stato.it > 30 and ep < 5 * len(a):
            out.append(f"solo {ep} episodi «da posta» finiti in {len(a)} iterazioni: partite troppo lunghe o lobby senza l'allievo?")
        vive = sum(x["vive"] for x in a) / len(a)
        if vive < 0.12:
            out.append(f"solo {_pct(vive)} delle righe del lotto sono vive: lobby vuote o episodi brevissimi")
        return out

    def _quadro(self, stato, learner, league, bench):
        righe = [f"== quadro it {stato.it} ({stato.samples / 1e6:.1f} M) {time.strftime('%Y-%m-%d %H:%M')}"]
        s = bench.summary()
        if not s:
            righe.append("   banco: ancora nessuno scenario con ≥ 3 partite")
        else:
            peggio = sorted(s.items(), key=lambda kv: kv[1]["punteggio"])
            righe.append(f"   banco fitness {_f(bench.fitness(), 3)} · " + " ".join(
                f"{sc.replace('bot:', 'b:')} {v['punteggio']:+.2f}(m{v['morte'] * 100:.0f} u{v['uccisioni']:.1f})" for sc, v in peggio))
        righe.append("   bot (battuti%/partite): " + " ".join(f"{st[:5]} {league.bots.beat[st] * 100:.0f}/{league.bots.n[st]}" for st in STYLES))
        righe.append("   rosa: " + (", ".join(f"{r} (vinte {league.payoff.winrate(r) * 100:.0f}%)" for r in league.roster) or "-"))
        righe.append("   deboli: " + (", ".join(f"{r} (vinte {league.payoff.winrate(r) * 100:.0f}%)" for r in league.deboli) or "-"))
        righe.append(f"   torneo: {league.gironi} gironi conclusi · distanza media "
                     f"{'-' if league.diversita is None else f'{league.diversita:.3f}'} · campioni ({len(league.campioni)}): "
                     + (", ".join(f"{c} [{league.stile(c)}] Elo {league.elo.get(c):.0f}" for c in league.campioni) or "-")
                     + (f" · protetti: {', '.join(league.protetti)}" if league.protetti else ""))
        righe.append("   iperparametri: " + " ".join(f"{k}={v:.2e}" if isinstance(v, float) and v < 0.01 else f"{k}={v:.3g}" for k, v in learner.hp.items()))
        self._scrivi("\n" + "\n".join(righe))
