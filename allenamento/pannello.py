"""Il pannello di controllo dell'addestramento, nel browser.

    .venv/bin/python pannello.py          (oppure doppio clic su «Allenamento.command»)

Si apre http://127.0.0.1:8080. Da li': avviare, mettere in pausa, riprendere e
fermare l'addestramento; seguire console, grafici e banco di prova; aprire e
chiudere le partite di osservazione; giocare contro l'IA.

Ogni cosa e' un processo a parte:
  addestramento   allena.py   sopravvive alla chiusura del pannello (riaprendo il
                              pannello lo si ritrova, anche in pausa)
  osservazione    guarda.py   finestre 8081–8083, si chiude con il pannello
  sfida           sfida.py    finestra 8084, si chiude con il pannello
Pausa = il processo viene congelato (SIGSTOP) e scongelato (SIGCONT): istantanea e
senza perdere nulla. Ferma = l'iterazione in corso finisce, tutto viene salvato, poi
il processo esce.
"""
from __future__ import annotations

import atexit
import csv
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
RUNS = HERE / "corse"
PY = sys.executable
PAGE = HERE / "pannello" / "index.html"
NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")
OBS_PORT, DUEL_PORT = 8081, 8084


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    try:   # uno zombie (figlio terminato ma non ancora raccolto) non conta
        st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(st) and not st.startswith("Z")
    except OSError:
        return True


def stopped(pid: int) -> bool:
    st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return st.startswith("T")


def run_dir(name: str) -> Path:
    if not NAME_RE.match(name or ""):
        raise ValueError("nome della corsa non valido: lettere, numeri, _ e -")
    return RUNS / name


class Manager:
    def __init__(self):
        self.lock = threading.Lock()
        self.train_proc: subprocess.Popen | None = None
        self.stop_at: float | None = None
        self.helpers: dict[str, dict] = {}       # «osserva» / «sfida» → {proc, corsa, log, info}

    # --- addestramento -----------------------------------------------------------------------
    def training(self) -> dict | None:
        """La corsa che si sta addestrando (avviata da qui o da terminale)."""
        if self.train_proc is not None and self.train_proc.poll() is not None:
            self.train_proc = None
        if not RUNS.exists():
            return None
        for d in RUNS.iterdir():
            f = d / "processo.json"
            if not f.exists():
                continue
            try:
                pid = json.loads(f.read_text())["pid"]
            except (ValueError, KeyError, OSError):
                continue
            if alive(pid):
                state = "in pausa" if stopped(pid) else ("in chiusura" if self.stop_at else "in corso")
                if self.stop_at and time.time() - self.stop_at > 120:
                    os.kill(pid, signal.SIGKILL)       # bloccato: chiusura forzata
                return {"corsa": d.name, "pid": pid, "stato": state}
            f.unlink(missing_ok=True)                    # processo morto senza pulire
        if self.train_proc is not None:                  # sta partendo: processo.json non c'e' ancora
            return {"corsa": getattr(self.train_proc, "corsa", "?"), "pid": self.train_proc.pid, "stato": "in avvio"}
        self.stop_at = None
        return None

    def start(self, name: str, opts: dict):
        with self.lock:
            if self.training():
                raise RuntimeError("c'e' gia' un addestramento attivo: fermalo prima")
            d = run_dir(name)
            d.mkdir(parents=True, exist_ok=True)
            cmd = [PY, "-u", str(HERE / "allena.py"), "--nome", name]
            if opts.get("piccola"):
                cmd.append("--piccola")
            if int(opts.get("iterazioni") or 0) > 0:
                cmd += ["--iterazioni", str(int(opts["iterazioni"]))]
            for k, v in (opts.get("imposta") or {}).items():
                if str(v).strip() != "":
                    cmd += ["--imposta", f"{k}={v}"]
            for line in (opts.get("altre") or "").splitlines():
                line = line.strip()
                if line and "=" in line:
                    cmd += ["--imposta", line]
            log = open(d / "uscita.log", "a")
            log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} avvio dal pannello: {' '.join(cmd[2:])}\n")
            log.flush()
            env = dict(os.environ, PYTHONUNBUFFERED="1")
            p = subprocess.Popen(cmd, cwd=HERE, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
            p.corsa = name
            self.train_proc = p
            self.stop_at = None

    def _signal(self, sig_list, note: str):
        t = self.training()
        if not t:
            raise RuntimeError("nessun addestramento attivo")
        for sig in sig_list:
            os.kill(t["pid"], sig)
        with open(RUNS / t["corsa"] / "uscita.log", "a") as f:
            f.write(f"  · [pannello] {note}\n")

    def pause(self):
        self._signal([signal.SIGSTOP], "pausa")

    def resume(self):
        self._signal([signal.SIGCONT], "ripresa")

    def stop(self):
        self.stop_at = time.time()
        self._signal([signal.SIGCONT, signal.SIGTERM], "fermata richiesta: salvataggio a fine iterazione")

    def delete(self, name: str):
        d = run_dir(name)
        t = self.training()
        if t and t["corsa"] == name:
            raise RuntimeError("la corsa si sta addestrando: fermala prima di cancellarla")
        for k in list(self.helpers):
            if self.helpers[k]["corsa"] == name:
                self.close(k)
        if d.exists():
            shutil.rmtree(d)

    # --- osservazione e sfida ------------------------------------------------------------------
    def open(self, kind: str, name: str, opts: dict):
        d = run_dir(name)
        if not ((d / "stato.pt").exists() or (d / "migliore.pt").exists()):
            raise RuntimeError("questa corsa non ha ancora salvato un modello (succede ogni 10 iterazioni)")
        self.close(kind)
        target = str(d)
        allievo = opts.get("allievo") or ""
        if allievo.startswith("lega/"):
            target, allievo = str(d / allievo), ""
        if kind == "osserva":
            cmd = [PY, "-u", str(HERE / "guarda.py"), target, "--porta", str(OBS_PORT),
                   "--finestre", str(int(opts.get("finestre") or 3))]
        else:
            cmd = [PY, "-u", str(HERE / "sfida.py"), target, "--porta", str(DUEL_PORT),
                   "--avversari", str(int(opts.get("avversari") or 1)), "--bot", str(int(opts.get("bot") or 0)),
                   "--abilita", str(float(opts.get("abilita") or 0.8))]
        if allievo:
            cmd += ["--allievo", allievo]
        logp = d / f"{kind}.log"
        log = open(logp, "w")
        p = subprocess.Popen(cmd, cwd=HERE, stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, PYTHONUNBUFFERED="1"))
        self.helpers[kind] = {"proc": p, "corsa": name, "log": logp, "allievo": allievo or "attuale"}

    def close(self, kind: str):
        h = self.helpers.pop(kind, None)
        if h and h["proc"].poll() is None:
            h["proc"].terminate()
            try:
                h["proc"].wait(5)
            except subprocess.TimeoutExpired:
                h["proc"].kill()

    def helper_state(self, kind: str) -> dict:
        h = self.helpers.get(kind)
        if not h:
            return {"attiva": False}
        txt = h["log"].read_text(errors="replace") if h["log"].exists() else ""
        running = h["proc"].poll() is None
        ready = re.search(r"^PRONTO (.*)$", txt, re.M)
        windows = []
        if ready and kind == "osserva":
            # «8081:contro i bot 8082:contro se stesso …» (i titoli contengono spazi)
            windows = [{"porta": int(m.group(1)), "titolo": m.group(2).strip()}
                       for m in re.finditer(r"(\d{4,5}):([^:]+?)(?=\s\d{4,5}:|$)", ready.group(1))]
        if ready and kind == "sfida":
            windows = [{"porta": DUEL_PORT, "titolo": "sfida"}]
        return {"attiva": running, "pronta": bool(ready) and running, "corsa": h["corsa"], "allievo": h["allievo"],
                "finestre": windows, "errore": None if running else (txt.strip().splitlines() or ["terminata"])[-1]}

    def shutdown(self):
        for k in list(self.helpers):
            self.close(k)


MGR = Manager()
atexit.register(MGR.shutdown)


# --- dati per i grafici -------------------------------------------------------------------------
def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def read_csv(p: Path) -> list[dict]:
    if not p.exists():
        return []
    try:
        with p.open(newline="") as f:
            return list(csv.DictReader(f))
    except (OSError, csv.Error):
        return []


def thin(points: list, n: int = 400) -> list:
    if len(points) <= n:
        return points
    step = len(points) / n
    return [points[int(i * step)] for i in range(n)] + [points[-1]]


def run_data(name: str) -> dict:
    d = run_dir(name)
    reg = read_csv(d / "registro.csv")
    series: dict[str, dict[str, list]] = {}
    keys = ("ep_punti", "ep_uccisioni", "ep_bottino_mio", "ep_bottino_altrui", "ep_cibo", "ep_profitto", "ep_morte", "ep_incasso",
            "ep_forzati", "ep_uscita_pulita", "ep_uscita_oro", "ep_uscita_vuota", "ep_durata", "ep_episodi",
            "elo", "entropia_svolta", "var_spiegata")
    glob = {"fase": []}
    for r in reg:
        it = _f(r.get("iter"))
        if it is None:
            continue
        s = series.setdefault(r.get("allievo", "?"), {k: [] for k in keys})
        for k in keys:
            v = _f(r.get(k))
            if v is not None:
                s[k].append([it, v])
        if True:
            for k in glob:
                v = _f(r.get(k))
                if v is not None:
                    glob[k].append([it, v])
    for s in series.values():
        for k in s:
            s[k] = thin(s[k])
    ev = read_csv(d / "valutazione.csv")
    fitness: dict[str, list] = {}
    bench: dict[str, dict] = {}
    for r in ev:
        a = r.get("allievo", "?")
        v = _f(r.get("fitness"))
        if v is not None:
            fitness.setdefault(a, []).append([_f(r["iter"]), v])
        cur = {}
        for k, x in r.items():
            if k.endswith("_punti") and _f(x) is not None:
                sc = k[:-len("_punti")]
                cur[sc] = {"punti": _f(x), "morte": _f(r.get(sc + "_morte")), "uccisioni": _f(r.get(sc + "_uccisioni"))}
        if cur:
            bench[a] = cur
    events = (d / "eventi.log").read_text(errors="replace").splitlines()[-40:] if (d / "eventi.log").exists() else []
    live = {}
    if (d / "vivo.json").exists():
        try:
            live = json.loads((d / "vivo.json").read_text())
        except ValueError:
            pass
    lega = sorted(p.name for p in (d / "lega").glob("*.pt")) if (d / "lega").exists() else []
    cfg = {}
    if (d / "config.json").exists():
        try:
            cfg = json.loads((d / "config.json").read_text())
        except ValueError:
            pass
    return {"serie": series, "globali": {k: thin(v) for k, v in glob.items()}, "fitness": {k: thin(v) for k, v in fitness.items()},
            "banco": bench, "eventi": events, "vivo": live, "lega": lega, "config": cfg,
            "ha_modello": (d / "stato.pt").exists() or (d / "migliore.pt").exists()}


def tail(p: Path, since: int) -> dict:
    """Il log da `since` in poi; `ricomincia` se il file e' stato riscritto (o e' la prima lettura)."""
    if not p.exists():
        return {"testo": "", "fine": 0, "ricomincia": since > 0}
    size = p.stat().st_size
    restart = since <= 0 or since > size
    if restart:
        since = max(0, size - 40_000)
    with p.open("rb") as f:
        f.seek(since)
        data = f.read(200_000)
    return {"testo": data.decode("utf-8", "replace"), "fine": since + len(data), "ricomincia": restart}


# --- server HTTP --------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path in ("/", "/index.html"):
                body = PAGE.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            elif u.path == "/api/stato":
                runs = sorted((p.name for p in RUNS.iterdir() if p.is_dir()), key=lambda n: -(RUNS / n).stat().st_mtime) if RUNS.exists() else []
                self._json({"corse": runs, "addestramento": MGR.training(),
                            "osserva": MGR.helper_state("osserva"), "sfida": MGR.helper_state("sfida")})
            elif u.path == "/api/dati":
                self._json(run_data(q["corsa"]))
            elif u.path == "/diario.txt":
                body = (run_dir(q["corsa"]) / "diario.txt").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="diario_{q["corsa"]}.txt"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif u.path == "/api/log":
                kind = q.get("tipo", "uscita")
                if kind not in ("uscita", "osserva", "sfida"):
                    raise ValueError("log sconosciuto")
                self._json(tail(run_dir(q["corsa"]) / f"{kind}.log", int(q.get("da", 0))))
            else:
                self._json({"errore": "non trovato"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"errore": str(e)}, 400)

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            act = u.path.removeprefix("/api/")
            if act == "avvia":
                MGR.start(body["corsa"], body)
            elif act == "pausa":
                MGR.pause()
            elif act == "riprendi":
                MGR.resume()
            elif act == "ferma":
                MGR.stop()
            elif act == "cancella":
                MGR.delete(body["corsa"])
            elif act in ("osserva", "sfida"):
                MGR.open(act, body["corsa"], body)
            elif act in ("chiudi_osserva", "chiudi_sfida"):
                MGR.close(act.removeprefix("chiudi_"))
            else:
                raise ValueError("azione sconosciuta")
            self._json({"ok": True})
        except Exception as e:  # noqa: BLE001
            self._json({"ok": False, "errore": str(e)}, 400)


def main():
    RUNS.mkdir(exist_ok=True)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    # PANNELLO_HOST=0.0.0.0 per raggiungerlo da fuori (per esempio dal proxy di un pod).
    host = os.environ.get("PANNELLO_HOST", "127.0.0.1")
    for p in range(port, port + 10):
        try:
            srv = ThreadingHTTPServer((host, p), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit("nessuna porta libera")
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    print(f"\n  pannello dell'addestramento → {url}\n  (chiudendo questa finestra l'addestramento continua; osservazione e sfida si chiudono)\n", flush=True)
    if not os.environ.get("PANNELLO_SENZA_BROWSER"):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        MGR.shutdown()


if __name__ == "__main__":
    main()
