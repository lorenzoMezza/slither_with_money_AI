"""La ricompensa a punti delle due fasi (vedi PIANO_ADDESTRAMENTO.md §3).

Fase 1 — predatore: uccidere e raccogliere soldi, niente cashout.
    uccisione                      0,5 punti (vinta testa contro testa: il 75 %, 0,375)
    bottino delle proprie uccisioni 1 punto per caduta intera, diviso per orb
                                   (1 orb su 10 = 0,1)
    bottino delle uccisioni altrui 0,6 per caduta intera, diviso per orb (muro compreso)
    cibo                           0,02 per orb normale (raddoppiato il 2026-10-06)
    morte testa contro testa       −0,5 (nel frontale muore il piu' piccolo: l'agente deve
                                   imparare a non cercarlo da piccolo); le altre morti 0

Fase 2 — giocatore completo: gli stessi punti × 0,7, piu' il cashout fatto da se':
    profitto ≥ +80 % e nessun orb d'oro a terra             5,0
    profitto ≥ +80 % ma ancora oro raccoglibile             2,6
    profitto > +20 %, nessun avversario in campo e niente oro 7,0
    (con +80 % e lobby vuota vale la condizione migliore: 7,0)
    profitto sotto +20 %                                    −5,0 (peggio che morire)
    altrimenti (o morte, o fine partita forzata)            0

La penalita' del frontale vale uguale nelle due fasi (non e' ridotta del 30 %).

Il profitto e' quello vero dell'episodio: incassato − saldo d'ingresso, in poste (come
x[38] dell'osservazione). «Oro a terra» = orb d'oro dentro il muro nel momento in cui
il cashout si completa; «avversari» = chiunque altro ancora vivo in quel momento.
"""
from __future__ import annotations

import numpy as np


def peso(rc, fase: int) -> float:
    """Peso dei punti di caccia e raccolta: pieno in fase 1, ridotto del 30 % in fase 2."""
    return 1.0 if fase == 1 else rc.peso_fase2


def punti_caccia(rc, fase: int, uccisioni, bottino_mio, bottino_altrui, cibo, frontali=0):
    """Uccisioni (di cui `frontali` vinte testa contro testa), parti di bottino e orb di
    cibo (scalari o array) → punti."""
    ucc = np.asarray(uccisioni, np.float64) - (1.0 - rc.quota_frontale) * np.asarray(frontali, np.float64)
    return peso(rc, fase) * (rc.uccisione * ucc + rc.bottino_mio * bottino_mio
                             + rc.bottino_altrui * bottino_altrui + rc.cibo * cibo)


def bonus_uscita(rc, fase: int, profitto, oro_uscita, nemici_uscita):
    """Il premio del cashout fatto da se' (solo in fase 2). Array o scalari."""
    profitto = np.asarray(profitto, np.float64)
    if fase == 1:
        return np.zeros_like(profitto)
    pulita = np.asarray(oro_uscita) < 0.5
    vuota = pulita & (np.asarray(nemici_uscita) < 0.5)
    b = np.where(profitto >= rc.obiettivo - 1e-4, np.where(pulita, rc.bonus_pulito, rc.bonus_oro), 0.0)
    b = np.where(vuota & (profitto > rc.soglia_vuoto), np.maximum(b, rc.bonus_vuoto), b)
    # Uscire sotto +20 % non deve succedere mai: costa piu' di una morte.
    return np.where(profitto < rc.soglia_vuoto - 1e-4, -rc.pena_sotto, b)


def tipo_uscita(rc, profitto: float, oro_uscita: float, nemici_uscita: float) -> str:
    """Per le statistiche: quale premio ha preso un cashout fatto da se'."""
    pulita = oro_uscita < 0.5
    if pulita and nemici_uscita < 0.5 and profitto > rc.soglia_vuoto:
        return "vuota"
    if profitto >= rc.obiettivo - 1e-4:
        return "pulita" if pulita else "con_oro"
    return "penale" if profitto < rc.soglia_vuoto - 1e-4 else "nessuna"


def penalita_frontale(rc, frontale):
    """Morte testa contro testa (scalare o array di 0/1)."""
    return rc.morte_frontale * np.asarray(frontale, np.float64)


def punti_resoconto(row: dict, rc, fase: int) -> float:
    """I punti di un partecipante a fine partita, dal resoconto del simulatore (bot
    compresi): la stessa somma che l'allievo riceve passo per passo."""
    p = float(punti_caccia(rc, fase, row.get("uccisioni", 0), row.get("bottino_mio", 0.0), row.get("bottino_altrui", 0.0),
                           row.get("cibo", 0), row.get("uccisioni_frontali", 0)))
    if row.get("incassato") and not row.get("forzato"):
        p += float(bonus_uscita(rc, fase, row.get("profitto", 0.0), row.get("oro_uscita", 0), row.get("nemici_uscita", 0)))
    p -= float(penalita_frontale(rc, bool(row.get("frontale", False))))
    return float(p)
