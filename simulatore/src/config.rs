//! I parametri del gioco e della simulazione.
//!
//! I default sono la fisica del server. Accanto a ogni campo la fonte:
//!   [V] VERITA' data dall'utente il 2026-10-07 dai dati reali del server: movimento, corpo,
//!       taglia, cibo, collisioni, cashout. Fissa: non si randomizza e l'estratto
//!       dell'analizzatore non la sovrascrive.
//!   [M] misurato sul traffico (4–5 ottobre 2026)   [S] dal sorgente del client   [P] scelta di progetto
//!
//! Tutto e' sovrascrivibile da JSON (anche parzialmente). `Params::from_analizer` legge
//! `analizer/estratto/simulatore.json`, ma prende solo le grandezze [M] che la verita'
//! non copre (tick, rete, arena, passo del bottino).

use crate::rng::Rng;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadOnRule {
    /// [V] Muore il PIU' PICCOLO, vince il piu' grande. A taglia uguale decide il caso.
    /// E' la regola del server.
    #[serde(alias = "vince_il_piu_grande")]
    SmallestWins,
    /// [V] Nel codice del server `biggest_wins` fa la STESSA cosa di `smallest_wins`:
    /// muore comunque il piu' piccolo.
    BiggestWins,
    BothDie,
    Random,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Params {
    // --- tempo ---------------------------------------------------------------
    /// [M] frequenza dei tick del server: 60 Hz (59,94–60,01 contando i tick dallo
    /// spostamento; i «61,7 Hz» contati col `ts` erano un artefatto: il `ts` e' l'ora
    /// d'invio dello snapshot, preso da un timer diverso da quello del tick).
    pub tick_hz: f64,
    /// [M] valore mandato in init.tickRate.
    pub declared_tick_rate: f64,

    // --- movimento -----------------------------------------------------------
    /// [V] unita' per tick senza boost (288 u/s).
    pub base_step: f64,
    /// [V] unita' per tick a boost pieno (630 u/s): passo = 4,8 + 5,7·boostAmount.
    pub boost_step: f64,
    /// [V] variazione di boostAmount per tick, in salita e in discesa (4,5/s).
    pub boost_ramp: f64,
    /// [V] sterzata per tick (rad), costante, verso targetAngle (8,1 rad/s). Raggio di
    /// curvatura 35,6 u da fermo, 77,8 u in boost.
    pub max_turn: f64,
    /// [V] taglia minima; il boost e' consentito solo sopra.
    pub min_size: f64,
    /// [V] taglia alla nascita.
    pub start_size: f64,
    /// [V] costo del boost: questa frazione della taglia per tick (10,8 % al secondo:
    /// taglia·0,108/60). Si paga mentre il boost e' premuto, anche sulla rampa, e NON e'
    /// moltiplicato per boostAmount. Sotto la taglia minima il boost si spegne.
    pub boost_cost_frac: f64,
    /// [V] tetto della taglia legato al saldo: max(size_cap_min, floor(saldo/posta ·
    /// size_cap_per_stake)), applicato a ogni tick (saldo 1 → 300).
    pub size_cap_min: f64,
    pub size_cap_per_stake: f64,

    // --- corpo ---------------------------------------------------------------
    /// [V] un punto di percorso ogni 1,6 u di strada.
    pub point_dist: f64,
    /// [V] l'anello i e' il punto 4·i del percorso (anelli ogni 6,4 u).
    pub spacing_points: usize,
    /// [V] anelli al massimo (anche nelle collisioni e nello snapshot).
    pub max_segments_listed: usize,

    // --- cibo ----------------------------------------------------------------
    /// [V] orb in campo, CONTANDO ANCHE IL BOTTINO A TERRA: il rabbocco avviene a ogni
    /// tick e solo se si scende sotto. Gli orb fuori dal muro vengono tolti.
    pub food_target: usize,
    /// [V] gli orb nascono uniformi per area entro questa frazione del raggio del muro.
    pub food_spawn_frac: f64,
    /// [V] raggio di raccolta oltre lo spessore, orb normale (raggio 7 + calamita 22).
    pub pickup_normal: f64,
    /// [V] raggio di raccolta oltre lo spessore, orb d'oro (raggio 10 + calamita 32).
    pub pickup_gold: f64,
    /// [V] crescita per orb normale = gain_base·(taglia/100)^gain_exp = 3·(taglia/100)^0,6.
    pub gain_base: f64,
    pub gain_exp: f64,
    /// [V] crescita FISSA per orb d'oro: +12.
    pub gold_gain: f64,
    /// [V] la crescita in coda si applica al massimo base + perSize·taglia per tick
    /// (15 + 0,03·taglia), sempre entro il tetto della taglia.
    pub growth_drain_base: f64,
    pub growth_drain_per_size: f64,

    // --- arena ---------------------------------------------------------------
    /// [M] raggio con un solo serpente vivo.
    pub arena_base: f64,
    /// [M] raggio aggiunto per ogni serpente vivo in piu'.
    pub arena_per_snake: f64,
    /// [M] frazione della distanza dal bersaglio recuperata per tick.
    pub arena_relax: f64,
    /// [S] sotto questa distanza il muro si aggancia al bersaglio.
    pub arena_snap: f64,
    /// [V] morte sul muro se dist dal centro + 0,95·spessore > r.
    pub wall_head_factor: f64,

    // --- combattimento -------------------------------------------------------
    /// [V] moltiplicatori delle hitbox: testa = spessore·0,95·1,07·1,18 (1,1995), corpo =
    /// spessore·0,95·1,07 (1,0165); frontale se distanza ≤ (testa A + testa B)·1,07 e
    /// ciascuno punta verso l'altro entro 75°; testa-corpo sugli anelli 2..min(anelli,1200)−1,
    /// senza arco frontale e senza il proprio corpo.
    pub hitbox_base: f64,
    pub hitbox_scale: f64,
    pub head_hitbox_scale: f64,
    pub head_on_facing_deg: f64,
    pub head_on_rule: HeadOnRule,
    pub front_arc_only: bool,
    pub front_arc_deg: f64,

    // --- bottino -------------------------------------------------------------
    /// [M] un orb ogni max(min, floor(anelli/div)) anelli (verificato fino a 39 anelli).
    pub loot_step_min: usize,
    pub loot_step_div: usize,
    /// [S✓] dispersione: uniforme in ±min(spessore·mult, max)/2 per asse.
    /// [V] Il bottino non sparisce mai (resta finche' qualcuno non lo raccoglie o il
    /// muro non lo lascia fuori).
    pub loot_spread_mult: f64,
    pub loot_spread_max: f64,

    // --- cashout -------------------------------------------------------------
    /// [V] il tasto si tiene 3000 ms d'orologio del client; il progresso e' a tempo.
    pub cashout_hold_ms: f64,
    /// [V] il server controlla la carica ogni tanti ms: si risulta «in carica» (e la
    /// carica si azzera al rilascio) entro questo tempo.
    pub cashout_check_ms: f64,
    /// [P] il server accetta {"t":"cashout"} se la carica dura almeno hold − tolleranza
    /// (il client lo manda dopo 3000 ms del SUO orologio: il jitter puo' anticiparlo).
    pub cashout_accept_tolerance_ms: f64,
    /// [V] passo durante la carica: base·(1 − m·t^p) = 4,8·(1 − 0,6·t^2,6), fino al 40 %;
    /// direzione bloccata sull'ultima mira, boost spento.
    pub cashout_slow_m: f64,
    pub cashout_slow_p: f64,
    /// [V] commissione trattenuta al cashout: 20 % del saldo.
    pub rake: f64,
    /// [M] il client manda {"t":"cashout"} dopo questi ms di tasto tenuto.
    pub cashout_client_hold_ms: f64,

    // --- rete ----------------------------------------------------------------
    /// [M] distribuzione congiunta (passi della griglia del `ts`, tick veri) di un
    /// intervallo fra snapshot: [k_ts, n_tick, peso]. Il `ts` avanza sulla griglia del
    /// timer d'invio (Δts ≈ 33/48/64 ms per k = 2/3/4), i tick veri a volte uno in meno
    /// o in piu'. Misurata su 1112 intervalli contati dallo spostamento.
    pub snapshot_joint: Vec<[f64; 3]>,
    /// [M] ritardo server→client e client→server (RTT 35 ms), piu' jitter uniforme.
    pub downlink_ms: f64,
    pub uplink_ms: f64,
    pub jitter_ms: f64,
    /// [P] singhiozzi di rete: con questa probabilita' un messaggio verso il client arriva
    /// in ritardo di un tempo in `stall_ms` (una connessione domestica non e' una linea
    /// di laboratorio: pacchetti ritrasmessi, Wi‑Fi, un'altra scheda che carica).
    pub stall_p: f64,
    pub stall_ms: [f64; 2],
    /// [M] i giocatori fermi (morti, incassati) restano in lista con alive:false.
    pub dead_listed: bool,

    // --- economia ------------------------------------------------------------
    /// [M] posta della lobby (1, 10 o 100).
    pub buy_in: f64,
    /// [M] numero della lobby (campo `lobby` dello snapshot).
    pub lobby: u32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            tick_hz: 60.0,
            declared_tick_rate: 60.0,
            base_step: 4.8,
            boost_step: 10.5,
            boost_ramp: 0.075,
            max_turn: 0.135,
            min_size: 40.0,
            start_size: 100.0,
            boost_cost_frac: 0.108 / 60.0,
            size_cap_min: 100.0,
            size_cap_per_stake: 300.0,
            point_dist: 1.6,
            spacing_points: 4,
            max_segments_listed: 1200,
            food_target: 86,
            food_spawn_frac: 0.95,
            pickup_normal: 29.0,
            pickup_gold: 42.0,
            gain_base: 3.0,
            gain_exp: 0.6,
            gold_gain: 12.0,
            growth_drain_base: 15.0,
            growth_drain_per_size: 0.03,
            arena_base: 2000.0,
            arena_per_snake: 100.0,
            arena_relax: 0.02,
            arena_snap: 1.0,
            wall_head_factor: 0.95,
            hitbox_base: 0.95,
            hitbox_scale: 1.07,
            head_hitbox_scale: 1.18,
            head_on_facing_deg: 75.0,
            head_on_rule: HeadOnRule::SmallestWins,
            front_arc_only: false,
            front_arc_deg: 100.0,
            loot_step_min: 4,
            loot_step_div: 20,
            loot_spread_mult: 0.6,
            loot_spread_max: 15.0,
            cashout_hold_ms: 3000.0,
            cashout_check_ms: 30.0,
            cashout_accept_tolerance_ms: 100.0,
            cashout_slow_m: 0.6,
            cashout_slow_p: 2.6,
            rake: 0.20,
            cashout_client_hold_ms: 3000.0,
            snapshot_joint: vec![
                [2.0, 1.0, 8.0], [2.0, 2.0, 449.0], [3.0, 2.0, 59.0], [2.0, 3.0, 2.0],
                [3.0, 3.0, 582.0], [4.0, 3.0, 9.0], [4.0, 4.0, 3.0],
            ],
            downlink_ms: 17.5,
            uplink_ms: 17.5,
            jitter_ms: 5.0,
            stall_p: 0.0,
            stall_ms: [40.0, 250.0],
            dead_listed: true,
            buy_in: 1.0,
            lobby: 1,
        }
    }
}

impl Params {
    #[inline]
    pub fn tick_ms(&self) -> f64 { 1000.0 / self.tick_hz }

    /// Legge `analizer/estratto/simulatore.json` e sovrascrive i parametri MISURATI che la
    /// verita' [V] non copre: frequenza dei tick, rete, arena, passo del bottino. La fisica
    /// [V] (movimento, corpo, taglia, cibo, collisioni, cashout) resta quella dei default.
    pub fn from_analizer(path: &str) -> Result<(Params, Vec<String>), String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
        let mut p = Params::default();
        let mut used = Vec::new();
        let par = &v["parametri"];
        let get = |k: &str| -> Option<&serde_json::Value> {
            let e = &par[k];
            if e.is_null() || e["fonte"].as_str() != Some("misura") { return None; }
            let val = &e["valore"];
            if val.is_null() { None } else { Some(val) }
        };
        let mut num = |k: &str, f: &mut f64| {
            if let Some(x) = get(k).and_then(|x| x.as_f64()) { *f = x; used.push(k.to_string()); }
        };
        num("tempo.tickHzMisurato", &mut p.tick_hz);
        num("tempo.tickRateDichiarato", &mut p.declared_tick_rate);
        num("arena.raggioBase", &mut p.arena_base);
        num("arena.raggioPerSerpente", &mut p.arena_per_snake);
        num("arena.rilassamentoPerTick", &mut p.arena_relax);
        let mut half_rtt = f64::NAN;
        num("rete.rttMs", &mut half_rtt);
        if half_rtt.is_finite() { p.downlink_ms = half_rtt / 2.0; p.uplink_ms = half_rtt / 2.0; }
        if let Some(x) = get("bottino.anelliPerOrb").and_then(|x| x.as_f64()) { p.loot_step_min = x.round() as usize; used.push("bottino.anelliPerOrb".into()); }
        Ok((p, used))
    }
}

/// Randomizzazione dei parametri per l'addestramento: si perturbano solo le grandezze
/// INCERTE (la rete, il timer del server, il tempo di decisione). La fisica [V] data
/// dall'utente (costo del boost, crescita, cibo, hitbox, cashout) e' certa: i suoi
/// intervalli valgono 1 (o 86 orb) e restano qui solo come leva esplicita.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Randomization {
    pub enabled: bool,
    /// Frequenza dei tick (misurata 59,94–60,01: il timer del server non e' perfetto).
    pub tick_hz: [f64; 2],
    /// [V] fattore sul costo del boost: 1 (non si randomizza).
    pub boost_cost: [f64; 2],
    /// [V] fattore sulla crescita per orb normale: 1 (non si randomizza).
    pub gain: [f64; 2],
    /// [V] orb in campo, bottino compreso: 86 (non si randomizza).
    pub food_target: [f64; 2],
    /// Latenza di sola andata (ms). Misurata 17,6 (RTT 35,3, p95 41,7) con una buona
    /// connessione: l'agente deve reggere anche una linea un po' peggiore. Ristretta il
    /// 2026-10-06 (era 10–60, jitter 2–15, singhiozzi 0–2 %, tick 59,7–60,3, decisione 5–30)
    /// verso i valori misurati, su richiesta dell'utente.
    pub one_way_ms: [f64; 2],
    pub jitter_ms: [f64; 2],
    /// Probabilita' per messaggio di un singhiozzo di rete (ritardo di 40–250 ms).
    pub stall_p: [f64; 2],
    /// Tempo di calcolo dell'agente fra snapshot e input (ms): dipende dalla macchina su
    /// cui girera' la rete, quindi si randomizza per partita.
    pub decision_ms: [f64; 2],
    /// [V] scala delle hitbox: 1 (non si randomizza).
    pub hitbox_scale: [f64; 2],
}

impl Default for Randomization {
    fn default() -> Self {
        Randomization {
            enabled: false,
            tick_hz: [59.85, 60.15],
            boost_cost: [1.0, 1.0],
            gain: [1.0, 1.0],
            food_target: [86.0, 86.0],
            one_way_ms: [12.0, 35.0],
            jitter_ms: [2.0, 10.0],
            stall_p: [0.0, 0.01],
            decision_ms: [5.0, 25.0],
            hitbox_scale: [1.0, 1.0],
        }
    }
}

impl Randomization {
    pub fn apply(&self, base: &Params, rng: &mut Rng) -> Params {
        let mut p = base.clone();
        if !self.enabled { return p; }
        let mut r = |a: [f64; 2]| rng.range(a[0], a[1]);
        p.tick_hz = r(self.tick_hz);
        p.boost_cost_frac *= r(self.boost_cost);
        p.gain_base *= r(self.gain);
        p.food_target = r(self.food_target).round().max(1.0) as usize;
        let ow = r(self.one_way_ms);
        p.downlink_ms = ow;
        p.uplink_ms = ow;
        p.jitter_ms = r(self.jitter_ms);
        p.stall_p = r(self.stall_p);
        p.hitbox_scale *= r(self.hitbox_scale);
        p
    }
}

/// Popolazione della lobby: gli avversari entrano, giocano, muoiono o incassano, escono.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct LobbyConfig {
    /// Numero di bot vivi a cui la lobby tende (oggi sul server: 1–3 giocatori).
    pub bots_min: usize,
    pub bots_max: usize,
    /// Secondi medi fra un ingresso e l'altro quando la lobby e' sotto il bersaglio.
    pub join_every_s: f64,
    /// Ogni quanto (secondi) il bersaglio di popolazione cambia.
    pub retarget_every_s: f64,
    /// Un morto resta in lista con alive:false per un tempo in [min, max] secondi.
    pub dead_linger_s: [f64; 2],
    /// Abilita' dei bot in [0, 1].
    pub skill: [f64; 2],
    /// Durata di una partita di un bot (secondi): poi cerca l'uscita, e se non ci riesce
    /// se ne va comunque. Le partite vere durano pochi minuti.
    pub session_s: [f64; 2],
}

impl Default for LobbyConfig {
    fn default() -> Self {
        // Misurato il 4 ottobre: 0–1 avversari vivi (1–2 vivi in tutto, te compreso),
        // 2–4 giocatori in lista, taglia mediana 118. Per allenarsi anche a lobby piu'
        // piene si alza bots_max.
        LobbyConfig { bots_min: 0, bots_max: 2, join_every_s: 20.0, retarget_every_s: 90.0, dead_linger_s: [5.0, 60.0], skill: [0.3, 0.9], session_s: [40.0, 240.0] }
    }
}

/// Dove nasce un partecipante: una posizione precisa (le «situazioni» di addestramento)
/// o, se le coordinate non sono finite, una a caso come sul server.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    /// Rotta della testa (rad).
    pub angle: f64,
    /// Curvatura del corpo dietro la testa, rad per punto del percorso (0 = dritto;
    /// 0,045 e' la sterzata massima). Serve a costruire corpi gia' avvolti attorno a qualcuno.
    pub curl: f64,
}

impl Default for Placement {
    fn default() -> Self { Placement { x: f64::NAN, y: f64::NAN, angle: f64::NAN, curl: 0.0 } }
}

impl Placement {
    pub fn is_set(&self) -> bool { self.x.is_finite() && self.y.is_finite() }
}

/// Un partecipante comandato dall'esterno (l'agente che impara o un avversario neurale).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SlotSpec {
    /// Taglia iniziale (0 = quella del server, 100).
    pub start_size: f64,
    /// Saldo iniziale (0 = la posta). Un avversario «ricco» simula chi gioca da un po'.
    pub start_balance: f64,
    /// Nome mostrato in partita (vuoto = «agenteN»).
    pub name: String,
    /// Entra in lobby solo dopo tanti secondi dall'inizio della partita (0 = subito): chi
    /// e' gia' dentro ha avuto il tempo di mangiare.
    pub join_after_s: f64,
    /// Posizione di nascita (facoltativa).
    #[serde(flatten)]
    pub at: Placement,
}

/// Un avversario scriptato di una partita.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BotSpec {
    /// raccoglitore | cacciatore | avvoltoio | ariete | esca | codardo | spingitore | misto
    pub style: String,
    pub skill: f64,
    pub start_size: f64,
    pub start_balance: f64,
    /// Senza le tecniche dei bot forti (solo per misurare quanto valgono).
    pub classico: bool,
    /// Posizione di nascita (facoltativa).
    #[serde(flatten)]
    pub at: Placement,
    /// Entra gia' con la carica del cashout in corso (una preda ferma per 3 s).
    pub cashing: bool,
    /// Non muore mai e non incassa: un ostacolo mobile (la fase «sopravvivere»).
    pub immortal: bool,
}

/// Una partita: chi c'e', quanto dura. Finisce quando tutti i partecipanti esterni
/// sono usciti (morti o incassati) o scade il tempo (cashout forzato).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MatchSpec {
    pub agents: Vec<SlotSpec>,
    pub bots: Vec<BotSpec>,
    /// Durata massima in secondi di gioco: poi cashout forzato di chi e' ancora in campo.
    pub max_s: f64,
    /// Se in campo non resta nessun altro e non c'e' oro, la partita chiude dopo questi secondi.
    pub end_when_alone_s: f64,
    /// Seme della partita (0 = continua la sequenza del mondo).
    pub seed: u64,
    /// Bottino gia' a terra all'inizio: [x, y, valore].
    pub gold: Vec<[f64; 3]>,
    /// Raggio iniziale del muro (0 = quello del server). Piu' grande del bersaglio: il
    /// muro si stringe subito, come dopo una morte.
    pub arena_r: f64,
    /// Parte del saldo pagata (al netto della commissione) a chi e' ancora in campo alla
    /// fine della partita. 1 = come un cashout fatto da se'. Meno di 1 = aspettare costa:
    /// online nessuno ti fa uscire, o esci tu o muori, e l'agente deve imparare a uscire
    /// da solo (vedi `allenamento/ia/raccolta.py`).
    pub fine_quota: f64,
    /// Secondi di gioco dei soli bot prima dell'ingresso degli agenti: si allontanano dai
    /// punti di nascita e l'ingresso e' piu' sicuro (lobby affollate).
    pub warm_s: f64,
}

impl Default for MatchSpec {
    fn default() -> Self {
        MatchSpec { agents: vec![SlotSpec::default()], bots: Vec::new(), max_s: 300.0, end_when_alone_s: 10.0, seed: 0, gold: Vec::new(), arena_r: 0.0, fine_quota: 1.0, warm_s: 0.0 }
    }
}

impl MatchSpec {
    /// Senza posizioni esplicite (se una situazione costruita a mano fa morire qualcuno
    /// all'ingresso, si ripiega sulle nascite casuali).
    pub fn without_placements(&self) -> MatchSpec {
        let mut s = self.clone();
        for a in s.agents.iter_mut() { a.at = Placement::default(); }
        for b in s.bots.iter_mut() { b.at = Placement::default(); }
        s
    }
}

/// Ricompensa: per default e' il PROFITTO, nella stessa unita' della posta.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct RewardConfig {
    /// Peso della variazione di «equity» (saldo in gioco; 0 alla morte; il pagato al cashout).
    /// La somma su un episodio e' esattamente (incassato − posta) / posta.
    pub equity: f64,
    /// Peso della crescita di taglia (shaping, 0 = spento).
    pub size: f64,
    /// Bonus per ogni snapshot da vivo (shaping, 0 = spento).
    pub alive: f64,
}

impl Default for RewardConfig {
    fn default() -> Self { RewardConfig { equity: 1.0, size: 0.0, alive: 0.0 } }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct EnvConfig {
    pub num_envs: usize,
    /// Agenti controllati in ogni mondo (piu' di uno = self-play nella stessa lobby).
    pub agents_per_env: usize,
    pub seed: u64,
    /// Durata massima di un episodio dell'agente (secondi di gioco): poi troncato.
    pub max_episode_s: f64,
    /// Tempo fra la morte (o il cashout) e il rientro in partita, secondi.
    pub rejoin_delay_s: f64,
    /// Tempo di calcolo dell'agente fra l'arrivo dello snapshot e l'invio dell'input.
    pub decision_ms: f64,
    pub params: Params,
    pub randomize: Randomization,
    pub lobby: LobbyConfig,
    pub reward: RewardConfig,
    /// Percorso di analizer/estratto/simulatore.json da cui leggere i parametri misurati.
    pub analizer: Option<String>,
    /// Modalita' partita (allenamento): niente rientri, la lobby e' quella della MatchSpec.
    pub match_mode: bool,
}

impl Default for EnvConfig {
    fn default() -> Self {
        EnvConfig {
            num_envs: 1,
            agents_per_env: 1,
            seed: 1,
            max_episode_s: 600.0,
            rejoin_delay_s: 1.0,
            decision_ms: 0.0,
            params: Params::default(),
            randomize: Randomization::default(),
            lobby: LobbyConfig::default(),
            reward: RewardConfig::default(),
            analizer: None,
            match_mode: false,
        }
    }
}

impl EnvConfig {
    pub fn from_json(text: &str) -> Result<EnvConfig, String> {
        let mut c: EnvConfig = if text.trim().is_empty() { EnvConfig::default() } else { serde_json::from_str(text).map_err(|e| e.to_string())? };
        if let Some(path) = c.analizer.clone() {
            // I parametri dell'estratto prendono il posto dei default; quelli scritti
            // esplicitamente nel JSON di configurazione restano i padroni.
            let (p, _) = Params::from_analizer(&path)?;
            let explicit: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
            let mut merged = serde_json::to_value(&p).unwrap();
            if let Some(obj) = explicit.get("params").and_then(|x| x.as_object()) {
                for (k, v) in obj { merged[k] = v.clone(); }
            }
            c.params = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        }
        Ok(c)
    }
}
