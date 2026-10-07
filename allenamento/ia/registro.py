"""Registri della corsa: CSV per i grafici, eventi in chiaro, salvataggi atomici."""
from __future__ import annotations

import csv
import os
import time
from pathlib import Path

import torch


class CsvLog:
    """CSV che accetta righe con colonne nuove (riscrive l'intestazione se serve)."""

    def __init__(self, path: Path):
        self.path = path
        self.cols: list[str] = []
        if path.exists():
            with path.open() as f:
                r = csv.reader(f)
                self.cols = next(r, [])

    def write(self, row: dict):
        new = [k for k in row if k not in self.cols]
        if new:
            rows = []
            if self.path.exists() and self.cols:
                with self.path.open() as f:
                    rows = list(csv.DictReader(f))
            self.cols += new
            with self.path.open("w", newline="") as f:
                w = csv.DictWriter(f, self.cols)
                w.writeheader()
                w.writerows(rows)
        with self.path.open("a", newline="") as f:
            csv.DictWriter(f, self.cols).writerow({k: _fmt(v) for k, v in row.items()})


def _fmt(v):
    if isinstance(v, float):
        return f"{v:.6g}"
    return v


class Events:
    """Eventi in chiaro (`eventi.log`), in console e, se c'e', nel diario della corsa."""

    def __init__(self, path: Path, anche=None):
        self.path = path
        self.anche = anche          # callable(msg) in piu', per esempio Diario.evento
        self.it = None              # iterazione corrente, se nota (la mette allena.py)

    def __call__(self, msg: str):
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}"
        print("  ·", msg, flush=True)
        with self.path.open("a") as f:
            f.write(line + "\n")
        if self.anche is not None:
            self.anche(msg, self.it)


def save_atomic(obj, path: Path):
    tmp = path.with_suffix(path.suffix + ".tmp")
    torch.save(obj, tmp)
    os.replace(tmp, path)
