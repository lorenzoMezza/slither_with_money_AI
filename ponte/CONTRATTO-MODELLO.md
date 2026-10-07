# Contratto lato modello: osservazione, azioni, rete

Questo documento dice **cosa l'agente si aspetta di ricevere e cosa produce**, e


## 1. Cosa l'agente riceve: lo snapshot `state`

L'agente è addestrato su osservazioni costruite **soltanto** dal messaggio `state`
che il server manda al client, così com'è, già in ritardo e già quantizzato. Il
simulatore produce esattamente lo stesso JSON (`simulatore/src/snapshot.rs`,
`Snapshot::to_json`) e lo rilegge con `Snapshot::from_json`; il resoconto delle
regole e dei campi è in `analizer/RESOCONTO-GIOCO.md`.

Campi che l'osservazione usa (per ogni snapshot):

| livello | campi |
|---|---|
| mondo | `ts` (ora d'invio del server), `world.r` (raggio del muro) |
| cibo | per ogni orb: `x`, `y`, tipo (`normal`/`gold`), valore (solo l'oro) |
| giocatori | `id`, `alive`, `boosting`, `boostAmount`, `cashingOut`, `cashoutProgress`, `size`, `balance`, `buyIn`, `thickness`, `hx`, `hy`, `angle`, `segs` (gli anelli del corpo) |

Serve inoltre l'`id` del proprio giocatore (quello che il server assegna all'ingresso).

La funzione che trasforma uno snapshot in osservazione è la stessa dell'addestramento
e si chiama da Python senza simulatore:

```python
from slither_sim import Featurizer          # simulatore/python
f = Featurizer()
obs = f.push(state_json, my_id, last_action)   # last_action = [svolta/π, boost, cashout tenuto]
```

Va chiamata **a ogni snapshot, nell'ordine di arrivo, senza saltarne**: il dossier
degli avversari e la memoria della rete dipendono dalla sequenza.

## 2. Cosa l'agente produce: un input per snapshot

A ogni snapshot la rete decide tre cose (`allenamento/ia/azioni.py`):

| uscita | significato | come diventa un input del client |
|---|---|---|
| svolta | una di 21 categorie di angolo relativo (rad) | `targetDir` = `angle` osservato + angolo, normalizzato in (−π, π] |
| boost | sì/no | `boost` |
| cashout | interruttore: inizia / interrompi | `cashingOut` tenuto; dopo 3000 ms d'orologio del client il messaggio di cashout |

Il client vero manda l'input a ogni fotogramma (60 Hz); l'agente ne manda uno per
snapshot (~24 Hz) e il server applica comunque l'ultimo ricevuto. Mentre il cashout
è in carica la direzione è bloccata dal server: svolta e boost vanno ignorati.
Rilasciare il cashout prima dei 3 s azzera la carica.

Il modello si carica con `ia.carica.load_policy` (da `migliore.pt`) e si guida con
`ia.carica.Driver`: memoria GRU azzerata a ogni ingresso in partita, interruttore del
cashout tenuto per posto. Il tempo di calcolo per snapshot deve restare sotto i
30 ms (in addestramento è randomizzato fra 5 e 30): sopra, si decide sull'ultimo
snapshot arrivato e si scartano gli altri.

## 3. Condizioni di rete per cui è addestrato

| grandezza | in addestramento |
|---|---|
| latenza di sola andata | 12–35 ms (misurata 17,6) |
| jitter | 2–10 ms (misurato p95 5) |
| singhiozzi (messaggi in ritardo di 40–250 ms) | 0–1 % |
| tempo di decisione | 5–25 ms |
| cadenza degli snapshot | quella misurata sul server (uno ogni 2–3 tick a 60 Hz) |

Fuori da questi intervalli l'agente non è stato addestrato: una linea peggiore va
prima aggiunta alla randomizzazione (`simulatore/src/config.rs`, `Randomization`).

## 4. La verifica offline

`allenamento/replay_reale.py` mette l'agente nei panni di ogni giocatore delle
partite registrate dall'analizzatore e dice se capisce il traffico vero (osservazioni
valide, cadenza), cosa avrebbe fatto (svolte, boost, cashout, e quanto coincidono con
la persona) e se vede il pericolo (la testa «muoio entro 2 s» negli ultimi secondi
delle partite finite con una morte). Se qualcosa non torna lì, non tornerà nemmeno
dal vivo.

`simulatore valida` controlla sulle stesse sessioni che la fisica rigiocata dagli
input reali coincida con quella del server (85 % dei passi esatti).


eistono gia vari ponti testi dall utente ma sono fragili
