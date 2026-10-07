#!/usr/bin/env python3
"""Il ponte fra l'agente e moneyslither.com.

    allenamento/.venv/bin/python ponte/ponte.py abc.pt          # (o: ponte/avvia.sh abc.pt)

Carica il modello e si mette in ascolto per l'estensione `ponte/estensione/` caricata nel TUO
Chrome (col tuo profilo e il tuo login: niente finestra speciale). Poi:

  · ogni snapshot `state` del server arriva qui così com'è, diventa l'osservazione
    dell'agente (lo stesso `Featurizer` dell'addestramento) e la decisione torna alla
    pagina, dove l'estensione la applica come il controller del sito: puntatore, boost,
    tasto Q. È il client del gioco a mandare gli input, a disegnare e a chiudere il cashout;
  · entri tu in partita come sempre (scegli la lobby e la posta, clicca Gioca): da quel
    momento guida l'IA;
  · il tasto X (nella finestra del gioco) passa il controllo alla persona e di nuovo
    all'IA, quando vuoi.

La rete gira sulla CPU con un thread (≈1 ms a decisione): la GPU resta tutta al gioco.
Soldi veri: il ponte NON entra mai in partita da solo e non sceglie la posta.
Dettagli e prove in ponte/README.md.
"""
from __future__ import annotations

import argparse
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

QUI = Path(__file__).resolve().parent
sys.path.insert(0, str(QUI))

CADENZA_ETICHETTA = 1.0     # s fra due aggiornamenti dell'etichetta nella pagina
CADENZA_CONSOLE = 5.0


def ora() -> str:
    return time.strftime("%H:%M:%S")


REGISTRO = QUI / "registro.txt"      # le stesse righe della console (si azzera a ogni avvio)


def dire(testo: str):
    riga = f"[{ora()}] {testo}"
    print(riga, flush=True)
    try:
        with REGISTRO.open("a", encoding="utf-8") as f:
            f.write(riga + "\n")
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("modello", nargs="?", help="il modello: file .pt (migliore.pt, stato.pt, un'istantanea) o cartella di una corsa")
    ap.add_argument("--url", default="https://moneyslither.com/", help="pagina del gioco")
    ap.add_argument("--porta-ws", type=int, default=8765, help="porta locale a cui si collega l'estensione")
    ap.add_argument("--non-aprire", action="store_true", help="non aprire la pagina del gioco in Chrome (c'è già)")
    ap.add_argument("--parti-umano", action="store_true", help="all'avvio guidi tu; X passa il controllo all'IA")
    ap.add_argument("--greedy", action="store_true", help="azioni deterministiche (media) invece di campionate come in addestramento")
    ap.add_argument("--dispositivo", default="cpu", help="cpu (predefinito: la GPU resta al gioco) | mps | cuda | auto")
    ap.add_argument("--thread", type=int, default=1, help="thread della CPU per la rete (1 è il più veloce a lotti da 1)")
    args = ap.parse_args()

    if not args.modello:
        ap.error("serve il modello (es. ponte.py abc.pt)")
    if not (QUI / "node_modules").exists():
        sys.exit("manca `ws`: esegui una volta  cd ponte && npm install")

    import torch                        # dopo gli errori di sintassi dei parametri: è lento da caricare
    torch.set_num_threads(max(1, args.thread))
    torch.set_num_interop_threads(1)
    from cervello import Cervello

    REGISTRO.write_text(f"ponte avviato {time.strftime('%Y-%m-%d %H:%M:%S')} · {' '.join(sys.argv[1:])}\n", encoding="utf-8")
    dire(f"carico {args.modello} …")
    cerv = Cervello(args.modello, args.dispositivo, args.greedy)
    cerv.riscalda(8)
    dire(f"modello {cerv.etichetta} · fase {cerv.fase}{' (cashout bloccato: fase 1)' if cerv.fase == 1 else ''} · "
         f"{cerv.dev} · {torch.get_num_threads()} thread · azioni {'deterministiche' if args.greedy else 'campionate'}")

    modo_iniziale = "umano" if args.parti_umano else "ai"
    node = subprocess.Popen(["node", str(QUI / "browser.mjs"), json.dumps({"portaWs": args.porta_ws})],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    coda: queue.Queue = queue.Queue()

    def leggi():
        # Snapshot e messaggi del server arrivano come «testa JSON» TAB «testo del server»:
        # qui si legge solo la testa, il testo va intatto al Featurizer.
        for riga in node.stdout:
            riga = riga.rstrip("\n")
            testa, tab, corpo = riga.partition("\t")
            try:
                e = json.loads(testa)
            except ValueError:
                print(f"[browser] {riga}", flush=True)
                continue
            if tab:
                e["m"] = corpo
            e["_t"] = time.perf_counter()
            coda.put(e)
        coda.put({"k": "fine"})

    threading.Thread(target=leggi, daemon=True).start()
    if not args.non_aprire and sys.platform == "darwin":
        subprocess.Popen(["open", "-a", "Google Chrome", args.url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def invia(**c):
        try:
            node.stdin.write(json.dumps(c, separators=(",", ":")) + "\n")
            node.stdin.flush()
        except (BrokenPipeError, ValueError):
            pass

    S = {"init_id": None, "modo": modo_iniziale, "vivo": False, "ultimo_et": 0.0, "ultima_cons": 0.0,
         "ultimo_avviso": 0.0, "passi": 0, "boost": 0, "saldo_max": 0.0, "t_inizio": 0.0, "lobby": None,
         "lat": None, "fps": None, "costo": None, "persi": 0, "py_ms": 0.0, "diag": []}

    def finisci_partita(motivo: str):
        dire(f"fuori dalla partita ({motivo}) · durata {time.time() - S['t_inizio']:.0f} s · saldo massimo {S['saldo_max']:.2f}")
        S["vivo"] = False

    def misure() -> str:
        p = [f"rete {cerv.ms_ema:.1f} ms", f"python {S['py_ms']:.1f} ms"]
        if S["lat"] is not None:
            p.append(f"risposta {S['lat']:.0f} ms")
        if S["fps"] is not None:
            p.append(f"gioco {S['fps']} FPS")
        return " · ".join(p)

    def diagnosi(st: list[dict]):
        """Ogni 5 s: da dove viene un eventuale ritardo (pagina, rete, Python, trasporto, server)."""
        num = lambda k: [x[k] for x in st if isinstance(x.get(k), (int, float))]          # noqa: E731
        l50, lmax, fps = num("lat50"), num("latMax"), num("fps")
        chi = ("IA" if st[-1].get("modo") == "ai" else "TU") + (" (pratica)" if sum(num("pratica")) else "")
        risposta = f"{sorted(l50)[len(l50) // 2]:.0f}/{max(lmax):.0f} ms" if l50 else "–"
        dire(f"diagnosi {chi} · risposta {risposta} (mediana/peggiore; python {S['py_ms']:.1f}, rete {cerv.ms_ema:.1f}) · "
             f"gioco {min(fps) if fps else '–'}–{max(fps) if fps else '–'} FPS · fotogrammi persi {sum(num('persi'))} "
             f"(peggiore {max(num('dtMax') or [0]):.0f} ms) · snapshot {sum(num('snap')) / len(st):.0f}/s, "
             f"buco max {max(num('gapMax') or [0]):.0f} ms ({sum(num('buchi'))} > 100 ms) · "
             f"ponte nella pagina {sum(num('costo')) / len(st):.2f} ms/s")

    def gestisci(e: dict, decide: bool):
        k = e.get("k")
        if k == "rx":
            ty = e.get("ty")
            if ty == "state":
                S["modo"] = e.get("modo", S["modo"])
                mio = e.get("id") or S["init_id"]
                v = cerv.osserva(e["m"], mio, e.get("hum") if S["modo"] == "umano" else None)
                if v.vivo and not S["vivo"]:
                    S.update(vivo=True, passi=0, boost=0, saldo_max=v.saldo, t_inizio=time.time())
                    dire(f"in partita · posta {v.posta:g} · taglia {v.size:.0f} · {v.nemici} avversari · guida: {'IA' if S['modo'] == 'ai' else 'persona'}")
                elif not v.vivo and S["vivo"]:
                    finisci_partita("morto o uscito")
                if not v.vivo:
                    return
                S["saldo_max"] = max(S["saldo_max"], v.saldo)
                if not decide:
                    S["persi"] += 1
                    return
                if S["modo"] == "ai":
                    d = cerv.decidi()
                    if d is not None:
                        invia(c="cmd", dir=round(d.dir, 6), boost=d.boost, cash=d.cash, n=e.get("n", 0))
                        py = (time.perf_counter() - e.get("_t", time.perf_counter())) * 1000      # dall'arrivo della riga al comando scritto
                        S["py_ms"] = py if not S["py_ms"] else 0.95 * S["py_ms"] + 0.05 * py
                        S["passi"] += 1
                        S["boost"] += int(d.boost)
                else:
                    cerv.segui()
                t = time.time()
                if t - S["ultimo_et"] >= CADENZA_ETICHETTA:
                    S["ultimo_et"] = t
                    pct = (v.saldo / v.posta - 1) * 100 if v.posta > 0 else 0.0
                    carica = f" · cashout {v.cash_progresso:.0%}" if v.cash_progresso > 0 else ""
                    invia(c="testo", t=f"taglia {v.size:.0f} · saldo {v.saldo:.2f} ({pct:+.0f} %) · {v.nemici} avversari{carica}\n{misure()}")
                if t - S["ultima_cons"] >= CADENZA_CONSOLE and S["passi"]:
                    S["ultima_cons"] = t
                    pct = (v.saldo / v.posta - 1) * 100 if v.posta > 0 else 0.0
                    dire(f"{'IA' if S['modo'] == 'ai' else 'tu'} · taglia {v.size:.0f} · saldo {v.saldo:.2f} ({pct:+.0f} %) · "
                         f"{v.nemici} avversari · boost {S['boost'] / S['passi']:.0%} · {misure()}")
                if (S["lat"] or 0) > 40 and t - S["ultimo_avviso"] > 15:
                    S["ultimo_avviso"] = t
                    dire(f"ATTENZIONE: {S['lat']:.0f} ms dallo snapshot al comando (in addestramento 5–25 ms): "
                         f"rete {cerv.ms_ema:.1f} ms, il resto è il trasporto o un Mac sotto carico")
            else:
                try:
                    m = json.loads(e.get("m") or "{}")
                except ValueError:
                    return
                if ty == "init":
                    S["init_id"] = m.get("id") or S["init_id"]
                    dire(f"connesso al server (tick {m.get('tickRate')} Hz) · id {S['init_id']}")
                elif ty == "join_ok":
                    S["lobby"] = m.get("lobby")
                    dire(f"entrato nella lobby {S['lobby']}")
                elif ty == "join_err":
                    dire(f"ingresso rifiutato: {m.get('reason')}")
                elif ty == "you_died":
                    dire(f"MORTO · causa {m.get('reason', '?')} · da {m.get('killer', '–')}")
                elif ty == "cashout_result":
                    dire(f"CASHOUT completato · incassati {m.get('payoutUsd', '?')} $ (commissione {m.get('rakeUsd', '?')} $)")
        elif k == "stat":
            S["lat"], S["fps"], S["costo"] = e.get("lat"), e.get("fps"), e.get("costo")
            S["diag"].append(e)
            if len(S["diag"]) >= 5:
                diagnosi(S["diag"])
                S["diag"] = []
        elif k == "modo":
            S["modo"] = e["modo"]
            dire(f"controllo → {'IA' if e['modo'] == 'ai' else 'PERSONA'} ({e.get('perche', '')})")
        elif k == "ws":
            dire({"agganciato": "socket del gioco agganciato"}.get(e.get("ev"), f"{e.get('ev')}"))
        elif k == "pagina":
            dire(f"pagina del gioco collegata ({e.get('href')})")
            invia(c="cfg", modo=S["modo"] if S["modo"] in ("ai", "umano") else modo_iniziale)
        elif k == "in_ascolto":
            dire(f"in ascolto per l'estensione (127.0.0.1:{e.get('porta')}) · apri moneyslither.com nel tuo Chrome e ricarica la pagina")
        elif k == "errore":
            dire(f"ERRORE: {e.get('m')}")
        elif k == "fine":
            raise SystemExit(0)

    try:
        while True:
            try:
                primo = coda.get(timeout=1.0)
            except queue.Empty:
                if node.poll() is not None:
                    break
                continue
            lotto = [primo]
            while True:
                try:
                    lotto.append(coda.get_nowait())
                except queue.Empty:
                    break
            # Se il calcolo è più lento degli snapshot si decide sull'ultimo: gli altri vanno comunque
            # osservati (il Featurizer li vuole tutti, in ordine) ma non fanno girare la rete.
            ultimo = max((i for i, e in enumerate(lotto) if e.get("k") == "rx" and e.get("ty") == "state"), default=-1)
            for i, e in enumerate(lotto):
                gestisci(e, decide=(i == ultimo))
    except KeyboardInterrupt:
        dire("interrotto: dopo 2,5 s di silenzio la pagina rende il controllo a te")
    finally:
        try:
            node.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)
        if node.poll() is None:
            node.terminate()


if __name__ == "__main__":
    main()
