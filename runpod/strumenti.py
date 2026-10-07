"""Piccoli attrezzi per il Makefile di RunPod (senza heredoc dentro make).

    python strumenti.py cuda                 # la GPU vista da PyTorch
    python strumenti.py pid  <cartella>      # il pid della corsa, se e' viva (altrimenti esce 1)
    python strumenti.py stato <cartella>     # l'ultima iterazione di vivo.json, in chiaro
    python strumenti.py scala                # le lobby iniziali adatte alla GPU (come --imposta)
    python strumenti.py regola <cartella> <radice> <nome> [altri --imposta]
                                             # avvia la corsa e la RISCALA da sola finche' la GPU
                                             # non e' sfruttata: piu' lobby a ogni riavvio pulito

Riscalatura automatica (`regola`): le lobby iniziali vengono dalla memoria della GPU
(circa 25 MB per lobby misurati, meta' della memoria come partenza prudente). Poi ogni
10 minuti si misura l'uso medio della GPU: se sta sotto il 60 % e la memoria sotto il
55 %, la corsa viene fermata in modo pulito (finisce l'iterazione, salva), e riparte
con il 50 % di lobby in piu' (minibatch e lobby del banco in proporzione). Si smette
di salire quando la GPU supera il 75 % o la memoria il 70 %, o a 4096 lobby. Ogni
passo e' scritto in scala.log della corsa. Se la corsa muore per un errore, viene
riavviata dal salvataggio (al massimo 5 volte di fila).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path


def cuda():
    import torch
    if torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        print(f"GPU: {p.name}, {p.total_memory / 2**30:.0f} GB, CUDA {torch.version.cuda}")
    else:
        print("ATTENZIONE: CUDA non disponibile, l'addestramento andrebbe sulla CPU (lentissimo). Controlla l'immagine del pod.")


def pid(run: Path, file: str = "processo.json") -> int:
    f = run / file
    if not f.exists():
        return 1
    try:
        p = int(json.loads(f.read_text())["pid"])
        os.kill(p, 0)
    except (ValueError, KeyError, OSError):
        return 1
    print(p)
    return 0


def stato(run: Path) -> int:
    f = run / "vivo.json"
    if not f.exists():
        print("nessuna iterazione completata ancora (la prima arriva in un paio di minuti)")
        return 0
    v = json.loads(f.read_text())
    print(f"iterazione {v['iter']} · {v['campioni'] / 1e6:.1f} M campioni · {v['velocita']:.0f} campioni/s · "
          f"{v['secondi'] / 3600:.1f} h · aggiornato {time.time() - v['ora']:.0f} s fa" + (" · solo critico" if v.get("riscaldamento") else ""))
    mig = v.get("migliore")
    print(f"fase {v.get('fase', 1)} · partite {v['partite']} · torneo {len(v.get('campioni_torneo', []))} campioni, "
          f"{v.get('gironi', 0)} gironi · {len(v.get('rosa', []))} in campo · fitness {v.get('fitness')} · "
          f"migliore {f'{mig:+.3f}' if mig is not None else '-'}")
    e = v.get("episodi") or {}
    if e.get("episodi"):
        print(f"  ultima iterazione: {e['episodi']} ep · punti {e['punti']:.2f} · uccisioni {e['uccisioni']:.2f} · "
              f"bottino {e['bottino_mio']:.2f} proprio + {e['bottino_altrui']:.2f} altrui · cibo {e['cibo']:.0f} · "
              f"morte {e['morte']:.0%} · fine partita {e['forzati']:.0%} · durata {e['durata']:.0f} s")
        if v.get("fase", 1) == 2:
            print(f"  cashout {e['incasso']:.0%}: senza oro {e['uscita_pulita']:.0%} · con oro {e['uscita_oro']:.0%} · "
                  f"lobby vuota {e['uscita_vuota']:.0%} · senza premio {e['uscita_sotto']:.0%} · profitto {e['profitto']:+.2f}")
    return 0


def gpu_mem_gb() -> float:
    try:
        import torch
        return torch.cuda.get_device_properties(0).total_memory / 2**30 if torch.cuda.is_available() else 0.0
    except Exception:
        return 0.0


def nvidia(query: str) -> list[float]:
    import subprocess
    try:
        out = subprocess.run(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
        return [float(x) for x in out.strip().split("\n")[0].split(",")]
    except Exception:
        return []


MB_PER_LOBBY = 36.0        # 7 posti: ~44 MB; fase 1 a 4 posti, fase 2 a 5 (doppio buffer, raccolta e aggiornamento sovrapposti)
LOBBY_MAX = 4096


def imposta_per(mondi: int) -> list[str]:
    mondi = max(256, min(LOBBY_MAX, (mondi // 128) * 128))
    minibatch = max(192, min(1024, (192 * mondi // 512) // 64 * 64))
    return [f"env.mondi={mondi}", "env.mondi_valutazione=16", "env.mondi_torneo=16", f"ppo.minibatch={minibatch}"]


def scala_iniziale() -> int:
    gb = gpu_mem_gb()
    if gb <= 0:
        return 512
    return int(gb * 1024 * 0.5 / MB_PER_LOBBY)


def scala():
    print(" ".join(f"--imposta {kv}" for kv in imposta_per(scala_iniziale())))


def regola(run: Path, radice: Path, nome: str, extra: list[str]):
    """Avvia allena.py e lo riscala finche' la GPU non e' sfruttata."""
    import signal
    import subprocess
    log = run / "scala.log"

    def nota(msg):
        with log.open("a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}\n")

    cfg_path = run / "config.json"
    mondi = None
    if cfg_path.exists():
        try:
            mondi = int(json.loads(cfg_path.read_text())["env"]["mondi"])
        except Exception:
            mondi = None
    if mondi is None:
        mondi = scala_iniziale()
    (run / "regolatore.json").write_text(json.dumps({"pid": os.getpid()}))
    fallimenti = 0
    while True:
        args = [sys.executable, "-u", str(radice / "allenamento" / "allena.py"), "--nome", nome, "--config", str(radice / "runpod" / "config.json")]
        mondi = int(imposta_per(mondi)[0].split("=")[1])        # arrotondato a multipli di 128
        for kv in imposta_per(mondi) + extra:
            args += ["--imposta", kv]
        nota(f"avvio con {mondi} lobby: {' '.join(a for a in args[3:])}")
        with (run / "uscita.log").open("a") as out:
            p = subprocess.Popen(args, cwd=radice / "allenamento", stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        t_avvio = time.time()
        util, mem = [], []
        chiesto_stop = False
        while p.poll() is None:
            time.sleep(30)
            q = nvidia("utilization.gpu,memory.used,memory.total")
            if len(q) == 3:
                util.append(q[0]); mem.append(q[1] / q[2])
            if chiesto_stop or time.time() - t_avvio < 600 or len(util) < 10:
                continue
            u, m = sum(util[-20:]) / len(util[-20:]), max(mem[-20:])
            v = run / "vivo.json"
            try:
                vel = json.loads(v.read_text())["velocita"]
            except Exception:
                vel = float("nan")
            if u < 60 and m < 0.55 and mondi < LOBBY_MAX:
                nuovo = min(LOBBY_MAX, int(mondi * 1.5))
                nota(f"GPU al {u:.0f} %, memoria al {m:.0%}, {vel:.0f} campioni/s con {mondi} lobby → riavvio con {nuovo}")
                mondi = nuovo
                p.send_signal(signal.SIGTERM)       # fermata pulita: finisce l'iterazione e salva
                chiesto_stop = True
            else:
                nota(f"GPU al {u:.0f} %, memoria al {m:.0%}, {vel:.0f} campioni/s con {mondi} lobby: si resta cosi'")
                util.clear(); mem.clear()
                t_avvio = time.time()               # prossima misura fra 10 minuti
        rc = p.returncode
        if chiesto_stop:
            fallimenti = 0
            continue
        if rc == 0:
            nota("la corsa e' finita da sola (iterazioni chieste o fermata)")
            break
        fallimenti += 1
        nota(f"la corsa e' uscita con codice {rc} ({fallimenti}/5): la riavvio dal salvataggio fra 30 s")
        if fallimenti >= 5:
            nota("troppi fallimenti di fila: mi fermo (vedi uscita.log e diario.txt)")
            break
        time.sleep(30)
    (run / "regolatore.json").unlink(missing_ok=True)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "cuda":
        cuda()
    elif cmd == "pid":
        sys.exit(pid(Path(sys.argv[2]), *sys.argv[3:4]))
    elif cmd == "stato":
        sys.exit(stato(Path(sys.argv[2])))
    elif cmd == "scala":
        scala()
    elif cmd == "regola":
        regola(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
