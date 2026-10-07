//! L'ambiente di addestramento: una lobby del server con i suoi avversari, e uno o
//! piu' agenti che la vivono ESATTAMENTE come la vive un client vero.
//!
//! Per l'agente il mondo non avanza a tick ma a SNAPSHOT: uno ogni 2, 3 o 4 tick
//! (39 % / 59 % / 2 %, come il server), che arriva con la latenza di rete e un po'
//! di jitter. Un passo dell'ambiente e' quindi: l'agente decide sull'ultimo snapshot
//! ricevuto → il suo input viaggia verso il server (latenza di andata) e viene
//! applicato al primo tick utile → il server avanza fino allo snapshot successivo →
//! lo snapshot viaggia verso il client (latenza di ritorno). L'agente vede il mondo
//! in ritardo e agisce in ritardo, come online.
//!
//! Il cashout funziona come nel client vero: si tiene premuto (input con
//! cashingOut:true), e dopo 3000 ms d'orologio del client parte {"t":"cashout"}.
//! Rilasciare prima azzera la carica.
//!
//! Fine di una partita (modalita' partita): chi e' ancora in campo quando scade il
//! tempo viene fatto incassare, con la commissione, esattamente come se avesse
//! premuto lui (motivo 4). Non e' un troncamento: la sessione di un giocatore finisce
//! sempre o con la morte o con un cashout che paga il 10 %, anche online. Il momento
//! della fine lo decide chi prepara la partita (`MatchSpec.max_s`), e non e'
//! osservabile dall'agente.

use crate::bots::{Brain, Style, Tactic};
use crate::config::{BotSpec, EnvConfig, MatchSpec, Params};
use crate::features::{Featurizer, OBS_SIZE};
use crate::record::Recorder;
use crate::rng::{normalize, Rng, PI};
use crate::snapshot::Snapshot;
use crate::viewer::ViewerHub;
use crate::world::{Event, Kind, World};
use std::collections::VecDeque;
use std::sync::Arc;

pub const ACTION_SIZE: usize = 3;
pub const INFO_SIZE: usize = 26;
/// `motivo`: 0 in corso, 1 morte, 2 cashout, 3 troncato (solo fuori dalla modalita'
/// partita), 4 cashout forzato di fine partita (con la commissione, come il 2).
/// Per la ricompensa a punti: `bottino_mio` / `bottino_altrui` = parti di caduta raccolte
/// in questo passo (1 = tutta una caduta) delle proprie uccisioni e di quelle altrui;
/// `cibo_passo` = orb di cibo normale; al cashout `oro_uscita` (orb d'oro rimasti dentro
/// il muro) e `nemici_uscita` (avversari ancora in campo) nel momento dell'uscita;
/// `frontale` = morto in uno scontro testa contro testa (perso dal piu' piccolo);
/// `uccisioni_frontali_passo` = quante delle `uccisioni_passo` sono frontali vinti.
pub const INFO_NAMES: [&str; INFO_SIZE] = [
    "motivo", "saldo", "taglia", "pagato", "durata_s", "valido", "vivi", "progresso_cashout", "profitto_episodio", "uccisioni", "muro", "tick",
    "fine_partita", "attivo", "uccisioni_passo", "oro_passo", "x", "y", "boost",
    "bottino_mio", "bottino_altrui", "cibo_passo", "oro_uscita", "nemici_uscita", "frontale",
    "uccisioni_frontali_passo",
];

/// Morte in uno scontro testa contro testa (il server fa morire il piu' piccolo).
pub fn is_head_on(reason: &str) -> bool { reason == "head-to-head" || reason == "head-on-collision" }

/// Messaggi dal client al server.
#[derive(Clone, Debug)]
pub enum Up {
    Input { dir: f64, boost: bool, cash: bool },
    Cashout,
    Join,
    Leave,
}

/// Messaggi dal server al client.
#[derive(Clone, Debug)]
pub enum Down {
    Init { id: String },
    State(Arc<Snapshot>),
    Kill { killer: String, victim: String, streak: u32 },
    YouDied { reason: &'static str, killer: String, balance: f64 },
    CashoutResult { balance: f64, payout: f64, rake: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SlotState {
    Playing,
    /// Fuori partita: rientra quando il server avra' elaborato il join.
    Rejoining,
    /// Modalita' partita: uscito (morto o incassato), resta fuori fino alla partita successiva.
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionMode {
    /// turn ∈ [−1, 1] relativo alla direzione osservata (×π).
    Relative,
    /// turn = targetDir assoluto in radianti, come il messaggio input.
    Absolute,
}

pub struct AgentSlot {
    pub uid: Option<u64>,
    pub id: String,
    pub name: String,
    up: VecDeque<(f64, Up)>,
    down: VecDeque<(f64, Down)>,
    /// Ora del client: l'istante in cui e' arrivato l'ultimo snapshot.
    pub now_ms: f64,
    pub feat: Featurizer,
    pub last_snap: Option<Arc<Snapshot>>,
    state: SlotState,
    equity: f64,
    size: f64,
    ep_start_ms: f64,
    kills: u32,
    cash_holding: bool,
    cash_start_ms: f64,
    pub last_dir: f64,
    observed_angle: f64,
    /// Partecipa alla partita corrente (modalita' partita).
    pub active: bool,
    /// Il prossimo cashout e' quello forzato di fine partita.
    pub forced: bool,
    /// Saldo e taglia con cui e' entrato (la posta e 100, salvo partite «da ricco»).
    start_balance: f64,
    start_size: f64,
    /// Contatori del giocatore gia' riportati (bottino proprio, altrui, cibo): ogni passo
    /// riporta solo la differenza.
    seen_loot_own: f64,
    seen_loot_other: f64,
    seen_food: u32,
    seen_kills: u32,
    seen_kills_head_on: u32,
    /// Entra in ritardo (`SlotSpec.join_after_s`): la partita comincia senza aspettarlo.
    pub delayed: bool,
}

impl AgentSlot {
    fn new(name: String) -> AgentSlot {
        AgentSlot {
            uid: None, id: String::new(), name,
            up: VecDeque::new(), down: VecDeque::new(),
            now_ms: 0.0, feat: Featurizer::new(), last_snap: None,
            state: SlotState::Rejoining, equity: 0.0, size: 0.0, ep_start_ms: 0.0, kills: 0,
            cash_holding: false, cash_start_ms: 0.0, last_dir: 0.0, observed_angle: 0.0, active: true, forced: false,
            start_balance: 0.0, start_size: 0.0,
            seen_loot_own: 0.0, seen_loot_other: 0.0, seen_food: 0, seen_kills: 0, seen_kills_head_on: 0, delayed: false,
        }
    }

    /// Accoda un messaggio verso il server rispettando l'ordine di arrivo.
    fn send(&mut self, at_client_ms: f64, up_ms: f64, msg: Up) {
        let arrive = at_client_ms + up_ms;
        let pos = self.up.iter().position(|(t, _)| *t > arrive).unwrap_or(self.up.len());
        self.up.insert(pos, (arrive, msg));
    }
}

struct BotSlot {
    uid: u64,
    brain: Brain,
    up: VecDeque<(f64, Up)>,
    one_way_ms: f64,
    leave_at: Option<f64>,
    session_end_ms: f64,
    spectate_at: Option<f64>,
}

pub struct Env {
    pub cfg: EnvConfig,
    pub p: Params,
    pub world: World,
    pub agents: Vec<AgentSlot>,
    bots: Vec<BotSlot>,
    rng: Rng,
    next_snapshot_tick: u64,
    next_ts_steps: u64,
    last_ts: f64,
    target_bots: usize,
    next_join_ms: f64,
    next_retarget_ms: f64,
    pub action_mode: ActionMode,
    /// Tempo di calcolo dell'agente in questa partita (randomizzato se la randomizzazione e' accesa).
    pub decision_ms: f64,
    pub viewer: Option<Arc<ViewerHub>>,
    /// Posto comandato da una persona dal browser (mouse, boost, cashout), se c'e'.
    pub human_slot: Option<usize>,
    pub recorder: Option<Recorder>,
    /// Ultimo snapshot generato dal server (per chi guarda senza essere un agente).
    pub last_broadcast: Option<Arc<Snapshot>>,
    /// Modalita' partita.
    pub spec: Option<MatchSpec>,
    match_start_ms: f64,
    alone_since: Option<f64>,
    pub match_over: bool,
    /// Diagnosi: (vittima, causa, tattica del bot vittima) di ogni morte, se acceso.
    pub death_log: Option<Vec<(u64, &'static str, String)>>,
}

impl Env {
    pub fn new(cfg: EnvConfig, seed: u64) -> Env {
        let mut rng = Rng::new(seed);
        let p = cfg.randomize.apply(&cfg.params, &mut rng);
        let world = World::new(p.clone(), rng.fork());
        let mut env = Env {
            p, world, agents: Vec::new(), bots: Vec::new(), rng,
            next_snapshot_tick: 0, next_ts_steps: 2, last_ts: f64::NAN, target_bots: 0, next_join_ms: 0.0, next_retarget_ms: 0.0,
            action_mode: ActionMode::Relative, decision_ms: cfg.decision_ms, viewer: None, human_slot: None, recorder: None, last_broadcast: None,
            spec: None, match_start_ms: 0.0, alone_since: None, match_over: false, death_log: None,
            cfg,
        };
        for a in 0..env.cfg.agents_per_env {
            env.agents.push(AgentSlot::new(format!("agente{}", a + 1)));
        }
        env
    }

    /// Prossimo intervallo fra snapshot: (passi della griglia del `ts`, tick veri).
    fn sample_snapshot_gap(&mut self) -> (u64, u64) {
        let total: f64 = self.p.snapshot_joint.iter().map(|x| x[2]).sum();
        let mut u = self.rng.f64() * total;
        for x in &self.p.snapshot_joint {
            if u < x[2] { return (x[0] as u64, x[1] as u64); }
            u -= x[2];
        }
        (3, 3)
    }

    /// Ritardo server→client: latenza, jitter e, di rado, un singhiozzo di rete.
    fn down_delay(&mut self) -> f64 {
        let stall = if self.p.stall_p > 0.0 && self.rng.chance(self.p.stall_p) { self.rng.range(self.p.stall_ms[0], self.p.stall_ms[1]) } else { 0.0 };
        self.p.downlink_ms + self.rng.f64() * self.p.jitter_ms + stall
    }

    /// Il tempo di calcolo dell'agente per questa partita.
    fn sample_decision_ms(&mut self) {
        let rz = &self.cfg.randomize;
        self.decision_ms = if rz.enabled { self.rng.range(rz.decision_ms[0], rz.decision_ms[1]) } else { self.cfg.decision_ms };
    }
    fn up_delay(&mut self) -> f64 { self.p.uplink_ms + self.rng.f64() * self.p.jitter_ms }

    /// Avvia la lobby: avversari gia' in gioco da un po', poi l'ingresso degli agenti.
    pub fn reset(&mut self, obs: &mut [f32], info: &mut [f32]) {
        let lc = self.cfg.lobby.clone();
        self.target_bots = lc.bots_min + self.rng.below(lc.bots_max.saturating_sub(lc.bots_min) + 1);
        for _ in 0..self.target_bots { self.spawn_bot(); }
        self.next_retarget_ms = lc.retarget_every_s * 1000.0 * self.rng.range(0.5, 1.5);
        // La partita e' gia' in corso quando entri: qualche secondo di gioco dei soli bot.
        let warm = (self.rng.range(3.0, 25.0) * 1000.0 / self.p.tick_ms()) as usize;
        for _ in 0..warm { self.tick_world(); }
        self.next_snapshot_tick = self.world.tick + 2;
        for a in 0..self.agents.len() {
            let now = self.world.time_ms;
            let d = self.up_delay();
            self.agents[a].send(now, d, Up::Join);
            self.agents[a].state = SlotState::Rejoining;
        }
        self.advance_until_broadcast();
        let mut tmp_rew = vec![0.0f32; self.agents.len()];
        let mut tmp_done = vec![0u8; self.agents.len()];
        self.collect(obs, &mut tmp_rew, &mut tmp_done, info);
        // Si restituisce solo quando tutti gli agenti sono in partita.
        while self.agents.iter().any(|a| a.state != SlotState::Playing) {
            self.advance_until_broadcast();
            self.collect(obs, &mut tmp_rew, &mut tmp_done, info);
        }
    }

    /// Nuova partita (modalita' partita): mondo nuovo, partecipanti della `spec`,
    /// prima osservazione quando tutti gli agenti attivi sono in campo.
    pub fn reset_match(&mut self, mut spec: MatchSpec, obs: &mut [f32], info: &mut [f32]) {
        if spec.seed != 0 { self.rng = crate::rng::Rng::new(spec.seed); }
        // Un agente che muore prima che tutti siano entrati (spawn sopra un corpo lungo)
        // non diventerebbe mai `Playing`: la partita non e' cominciata, si rifa' da capo
        // con un mondo nuovo (il generatore e' andato avanti, quindi e' un mondo diverso).
        // Una situazione con posizioni esplicite sbagliate fallirebbe sempre: dopo tre
        // tentativi si ripiega sulle nascite casuali.
        let mut tries = 0;
        while !self.setup_match(spec.clone(), obs, info) {
            tries += 1;
            if tries == 3 { spec = spec.without_placements(); }
        }
    }

    /// Prepara la partita; `false` se va rifatta perche' qualcuno e' morto entrando.
    fn setup_match(&mut self, spec: MatchSpec, obs: &mut [f32], info: &mut [f32]) -> bool {
        self.p = self.cfg.randomize.apply(&self.cfg.params, &mut self.rng);
        self.sample_decision_ms();
        self.world = World::new(self.p.clone(), self.rng.fork());
        if spec.arena_r > 0.0 { self.world.r = spec.arena_r; }
        for g in &spec.gold { self.world.drop_gold(g[0], g[1], g[2]); }
        self.bots.clear();
        self.last_ts = f64::NAN;
        self.match_over = false;
        self.alone_since = None;
        let n = self.agents.len();
        for a in 0..n {
            let name = spec.agents.get(a).map(|s| s.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| format!("agente{}", a + 1));
            let mut slot = AgentSlot::new(name);
            slot.active = a < spec.agents.len();
            slot.state = if slot.active { SlotState::Rejoining } else { SlotState::Finished };
            self.agents[a] = slot;
        }
        for b in spec.bots.clone() { self.spawn_bot_spec(&b); }
        // Riscaldamento: i bot si allontanano dai punti di nascita prima che entrino gli agenti.
        let warm = (spec.warm_s.max(0.0) * 1000.0 / self.p.tick_ms()) as usize;
        for _ in 0..warm { self.tick_world(); }
        for a in 0..n {
            if !self.agents[a].active { continue; }
            let now = self.world.time_ms;
            let d = self.up_delay();
            let after = spec.agents.get(a).map(|s| s.join_after_s.max(0.0)).unwrap_or(0.0) * 1000.0;
            self.agents[a].delayed = after > 0.0;
            self.agents[a].send(now + after, d, Up::Join);
        }
        self.match_start_ms = self.world.time_ms;
        self.next_snapshot_tick = self.world.tick + 2;
        self.spec = Some(spec);
        let mut tmp_rew = vec![0.0f32; n];
        let mut tmp_done = vec![0u8; n];
        // Il join arriva in ~50 ms; 10 s senza che tutti siano dentro vuol dire un guasto.
        let deadline = self.world.time_ms + 10_000.0;
        loop {
            self.advance_until_broadcast();
            self.collect(obs, &mut tmp_rew, &mut tmp_done, info);
            if self.agents.iter().all(|a| !a.active || a.delayed || a.state == SlotState::Playing) {
                // Cio' che i primi entrati hanno raccolto mentre gli altri entravano finisce nel
                // primo passo vero (le info della preparazione non diventano ricompense).
                for a in self.agents.iter_mut() {
                    a.seen_kills = 0;
                    a.seen_kills_head_on = 0;
                    a.seen_loot_own = 0.0;
                    a.seen_loot_other = 0.0;
                    a.seen_food = 0;
                }
                return true;
            }
            if self.agents.iter().any(|a| a.active && a.state == SlotState::Finished) { return false; }
            if self.world.time_ms > deadline { return false; }
        }
    }

    /// Il risultato di ogni partecipante della partita corrente, bot compresi:
    /// profitto = incassato − saldo iniziale (chi e' ancora vivo viene valutato come
    /// se incassasse ora; chi e' morto ha perso tutto).
    pub fn match_report(&self) -> serde_json::Value {
        let rake = self.p.rake;
        let rows: Vec<serde_json::Value> = self.world.players.iter().map(|pl| {
            let slot = self.agents.iter().position(|a| a.uid == Some(pl.uid));
            let bot = self.bots.iter().find(|b| b.uid == pl.uid);
            let value = if pl.cashed { pl.payout } else if pl.alive { pl.balance * (1.0 - rake) } else { 0.0 };
            serde_json::json!({
                "nome": &*pl.name,
                "posto": slot,
                // Incassato perche' la partita e' finita, non per scelta sua.
                "forzato": slot.map(|a| self.agents[a].forced && pl.cashed).unwrap_or(false),
                "stile": bot.map(|b| b.brain.style.name()),
                "abilita": bot.map(|b| b.brain.skill),
                "vivo": pl.alive,
                "incassato": pl.cashed,
                "morto": !pl.alive && !pl.cashed,
                "saldo_iniziale": pl.start_balance,
                "valore_finale": value,
                "profitto": (value - pl.start_balance) / pl.buy_in.max(1e-9),
                "taglia": pl.snake.size,
                "uccisioni": pl.kills,
                "uccisioni_frontali": pl.kills_head_on,
                "bottino_mio": pl.loot_own,
                "bottino_altrui": pl.loot_other,
                "cibo": pl.food_eaten,
                "oro_uscita": pl.exit_gold,
                "nemici_uscita": pl.exit_enemies,
                // Stile: frazione del tempo col boost, distanza media dal nemico piu' vicino (−1 = mai misurata).
                "boost_frazione": pl.boost_ticks as f64 / pl.alive_ticks.max(1) as f64,
                "frontale": !pl.alive && !pl.cashed && is_head_on(pl.death_reason),
                "distanza_nemico": if pl.near_n > 0 { pl.near_sum / pl.near_n as f64 } else { -1.0 },
            })
        }).collect();
        serde_json::Value::Array(rows)
    }

    fn spawn_bot_spec(&mut self, b: &BotSpec) {
        let name = self.world.random_name();
        let uid = self.world.join(name, Kind::Bot(self.bots.len()), self.p.buy_in);
        self.world.set_start(uid, b.start_size, b.start_balance);
        let mut brain = Brain::with_style(Style::parse(&b.style), b.skill, &mut self.rng);
        brain.pro = !b.classico;
        let one_way = self.rng.range(12.0, 60.0);
        if b.at.is_set() { self.world.place(uid, b.at.x, b.at.y, b.at.angle, b.at.curl); }
        if b.immortal {
            // Ostacolo mobile: non muore, non incassa, non cerca l'uscita.
            if let Some(pl) = self.world.player_mut(uid) { pl.immortal = true; }
            brain.cash_goal = f64::INFINITY;
            brain.patience_s = f64::INFINITY;
        }
        if b.cashing {
            // Sta gia' incassando: fermo per 3 s, a meno che non si accorga del pericolo.
            let angle = self.world.player(uid).map(|p| p.snake.angle).unwrap_or(0.0);
            self.world.apply_input(uid, angle, false, true);
            // Gia' in carica (il controllo dei 30 ms e' gia' passato).
            let now = self.world.time_ms;
            if let Some(pl) = self.world.player_mut(uid) { pl.cashing_out = true; pl.cashout_progress = 0.0; pl.cash_start_ms = now; }
            brain.tactic = Tactic::Cashout;
            brain.tactic_until = self.world.tick + 300;
        }
        self.bots.push(BotSlot { uid, brain, up: VecDeque::new(), one_way_ms: one_way, leave_at: None, session_end_ms: f64::INFINITY, spectate_at: None });
    }

    /// Un passo: le azioni degli agenti sull'ultimo snapshot, poi il mondo fino al prossimo.
    pub fn step(&mut self, actions: &[f32], obs: &mut [f32], rew: &mut [f32], done: &mut [u8], info: &mut [f32]) {
        let human = self.human_slot.zip(self.viewer.as_ref().map(|h| h.human()));
        for a in 0..self.agents.len() {
            match human {
                // La persona manda la direzione assoluta, come il client vero.
                Some((k, ref h)) if k == a => self.act(a, &[h.dir as f32, h.boost as u8 as f32, h.cash as u8 as f32], true),
                _ => self.act(a, &actions[a * ACTION_SIZE..(a + 1) * ACTION_SIZE], false),
            }
        }
        self.advance_until_broadcast();
        self.collect(obs, rew, done, info);
        if self.cfg.match_mode {
            self.check_match_end(info);
            return;
        }
        // Con un agente solo, un episodio finito riparte subito (auto-reset): la prima
        // osservazione del nuovo episodio sostituisce quella terminale.
        if self.agents.len() == 1 && done[0] != 0 {
            let mut r2 = [0.0f32];
            let mut d2 = [0u8];
            let mut i2 = vec![0.0f32; INFO_SIZE];
            while self.agents[0].state != SlotState::Playing {
                self.advance_until_broadcast();
                self.collect(obs, &mut r2, &mut d2, &mut i2);
            }
        }
    }

    /// L'azione dell'agente diventa messaggi del client, come li manderebbe il client vero.
    fn act(&mut self, a: usize, act: &[f32], absolute: bool) {
        if self.agents[a].state != SlotState::Playing { return; }
        let send_at = self.agents[a].now_ms + self.decision_ms;
        let (turn, boost, cash) = (act[0] as f64, act[1] > 0.5, act[2] > 0.5);
        let dir = match (self.action_mode, absolute) {
            (ActionMode::Absolute, _) | (_, true) => normalize(turn),
            (ActionMode::Relative, false) => normalize(self.agents[a].observed_angle + turn.clamp(-1.0, 1.0) * PI),
        };
        let d1 = self.up_delay();
        let hold = self.p.cashout_client_hold_ms;
        let slot = &mut self.agents[a];
        slot.feat.last_action = [act[0].clamp(-1.0, 1.0), boost as u8 as f32, cash as u8 as f32];
        slot.last_dir = dir;
        slot.send(send_at, d1, Up::Input { dir, boost: boost && !cash, cash });
        if let Some(rec) = self.recorder.as_mut() {
            if a == 0 { rec.client_input(send_at, dir, boost && !cash, cash); }
        }
        if cash && !slot.cash_holding {
            slot.cash_holding = true;
            slot.cash_start_ms = send_at;
            // Il timer del client: dopo 3000 ms di tasto tenuto parte {"t":"cashout"}.
            let d2 = self.up_delay();
            let slot = &mut self.agents[a];
            slot.send(send_at + hold, d2, Up::Cashout);
            if let Some(rec) = self.recorder.as_mut() { if a == 0 { rec.client_cashout(send_at + hold); } }
        } else if !cash && slot.cash_holding {
            slot.cash_holding = false;
            // Rilasciato prima dei 3000 ms: il messaggio programmato non parte.
            if send_at < slot.cash_start_ms + hold {
                slot.up.retain(|(_, m)| !matches!(m, Up::Cashout));
                if let Some(rec) = self.recorder.as_mut() { if a == 0 { rec.cancel_cashout(); } }
            }
        }
    }

    fn spawn_bot(&mut self) {
        let lc = &self.cfg.lobby;
        let skill = self.rng.range(lc.skill[0], lc.skill[1]);
        let name = self.world.random_name();
        let uid = self.world.join(name, Kind::Bot(self.bots.len()), self.p.buy_in);
        let brain = Brain::new(skill, &mut self.rng);
        let one_way = self.rng.range(12.0, 60.0);
        let session = self.rng.range(lc.session_s[0], lc.session_s[1]) * 1000.0;
        let end = self.world.time_ms + session;
        self.bots.push(BotSlot { uid, brain, up: VecDeque::new(), one_way_ms: one_way, leave_at: None, session_end_ms: end, spectate_at: None });
    }

    /// Fine della partita: tutti fuori, tempo scaduto, o agenti rimasti soli senza oro in
    /// campo per troppo tempo (non c'e' piu' niente da imparare). Chi e' ancora in campo
    /// incassa (cashout forzato, con la commissione: motivo 4).
    fn check_match_end(&mut self, info: &mut [f32]) {
        let Some(spec) = self.spec.clone() else { return };
        if self.match_over { return; }
        let now = self.world.time_ms;
        let playing: Vec<usize> = (0..self.agents.len()).filter(|&a| self.agents[a].active && self.agents[a].state == SlotState::Playing).collect();
        let agent_uids: Vec<u64> = playing.iter().filter_map(|&a| self.agents[a].uid).collect();
        let others = self.world.players.iter().filter(|p| p.alive && !agent_uids.contains(&p.uid)).count();
        let gold = self.world.foods.iter().any(|f| f.gold);
        // Chi deve ancora entrare (ingresso ritardato) conta come avversario in arrivo.
        let waiting = self.agents.iter().any(|a| a.active && a.state == SlotState::Rejoining);
        let lonely = playing.len() == 1 && others == 0 && !gold && !waiting;
        self.alone_since = if lonely { Some(self.alone_since.unwrap_or(now)) } else { None };
        let timeout = now - self.match_start_ms > spec.max_s * 1000.0
            || self.alone_since.is_some_and(|t| now - t > spec.end_when_alone_s * 1000.0);
        if timeout {
            for &a in &playing {
                if let Some(uid) = self.agents[a].uid {
                    self.agents[a].forced = true;
                    self.world.force_cashout(uid, spec.fine_quota);
                }
            }
        }
        if playing.is_empty() {
            self.match_over = true;
            for a in 0..self.agents.len() { info[a * INFO_SIZE + 12] = 1.0; }
        }
    }

    /// La popolazione della lobby: chi muore o incassa resta in lista un po', poi esce;
    /// nuovi giocatori entrano quando la lobby e' sotto il bersaglio.
    fn manage_lobby(&mut self) {
        let now = self.world.time_ms;
        let lc = self.cfg.lobby.clone();
        if self.cfg.match_mode {
            // In partita la lobby e' fissa: i morti diventano spettatori e restano in lista.
            for i in 0..self.bots.len() {
                let (alive, cashed) = self.world.player(self.bots[i].uid).map(|p| (p.alive, p.cashed)).unwrap_or((true, false));
                if !alive && self.bots[i].leave_at.is_none() {
                    self.bots[i].leave_at = Some(f64::INFINITY);
                    if !cashed && self.rng.chance(0.85) { self.bots[i].spectate_at = Some(now + self.rng.range(1500.0, 4500.0)); }
                }
                if self.bots[i].spectate_at.is_some_and(|t| now >= t) {
                    self.bots[i].spectate_at = None;
                    self.world.spectate(self.bots[i].uid);
                }
            }
            return;
        }
        if now >= self.next_retarget_ms {
            self.target_bots = lc.bots_min + self.rng.below(lc.bots_max.saturating_sub(lc.bots_min) + 1);
            self.next_retarget_ms = now + lc.retarget_every_s * 1000.0 * self.rng.range(0.5, 1.5);
        }
        let mut i = 0;
        while i < self.bots.len() {
            let alive = self.world.player(self.bots[i].uid).is_some_and(|p| p.alive);
            if !alive && self.bots[i].leave_at.is_none() {
                let linger = self.rng.range(lc.dead_linger_s[0], lc.dead_linger_s[1]) * 1000.0;
                self.bots[i].leave_at = Some(now + linger);
                // Chi muore (non chi incassa) di solito preme «guarda» dopo qualche secondo.
                let cashed = self.world.player(self.bots[i].uid).is_some_and(|p| p.cashed);
                if !cashed && self.rng.chance(0.85) { self.bots[i].spectate_at = Some(now + self.rng.range(1500.0, 4500.0)); }
            }
            if self.bots[i].spectate_at.is_some_and(|t| now >= t) {
                self.bots[i].spectate_at = None;
                self.world.spectate(self.bots[i].uid);
            }
            if self.bots[i].leave_at.is_some_and(|t| now >= t) {
                self.world.leave(self.bots[i].uid);
                self.bots.swap_remove(i);
                continue;
            }
            i += 1;
        }
        let alive_bots = self.bots.iter().filter(|b| self.world.player(b.uid).is_some_and(|p| p.alive)).count();
        // Troppi in campo, o partita lunga: si comincia a pensare all'uscita.
        for b in self.bots.iter_mut() { b.brain.wants_exit = alive_bots > self.target_bots || now > b.session_end_ms; }
        // Chi non e' riuscito a uscire se ne va comunque (disconnessione).
        let mut i = 0;
        while i < self.bots.len() {
            let b = &self.bots[i];
            let alive = self.world.player(b.uid).is_some_and(|p| p.alive);
            if alive && now > b.session_end_ms + 120_000.0 {
                self.world.leave(b.uid);
                self.bots.swap_remove(i);
                continue;
            }
            i += 1;
        }
        if alive_bots < self.target_bots && now >= self.next_join_ms {
            self.spawn_bot();
            let gap = -(1.0 - self.rng.f64()).ln() * lc.join_every_s * 1000.0;
            self.next_join_ms = now + gap;
        }
    }

    /// Un tick del server, con tutto cio' che gli arriva e gli parte intorno.
    fn tick_world(&mut self) {
        let t_next = self.world.time_ms + self.p.tick_ms();

        // Messaggi arrivati al server prima di questo tick.
        for a in 0..self.agents.len() {
            while self.agents[a].up.front().is_some_and(|(t, _)| *t <= t_next) {
                let (_, msg) = self.agents[a].up.pop_front().unwrap();
                self.server_receive_agent(a, msg);
            }
        }
        for b in 0..self.bots.len() {
            while self.bots[b].up.front().is_some_and(|(t, _)| *t <= t_next) {
                let (_, msg) = self.bots[b].up.pop_front().unwrap();
                let uid = self.bots[b].uid;
                match msg {
                    Up::Input { dir, boost, cash } => self.world.apply_input(uid, dir, boost, cash),
                    Up::Cashout => { self.world.request_cashout(uid); }
                    _ => {}
                }
            }
        }

        // I bot decidono sul mondo corrente; il loro input parte con la loro latenza.
        for b in 0..self.bots.len() {
            let uid = self.bots[b].uid;
            let Some(i) = self.world.index_of(uid) else { continue };
            let decision = self.bots[b].brain.think(&self.world, i, &mut self.rng);
            if let Some((dir, boost, cash)) = decision {
                let now = self.world.time_ms;
                // Una persona vede lo snapshot in ritardo (rete + 45 ms di buffer del client)
                // e il suo comando ci mette altrettanto ad arrivare: il ritardo di percezione
                // si somma a quello di invio.
                let perception = self.bots[b].one_way_ms + 45.0;
                let delay = perception + self.bots[b].one_way_ms + self.rng.f64() * self.p.jitter_ms;
                let slot = &mut self.bots[b];
                slot.up.push_back((now + delay, Up::Input { dir, boost, cash }));
                // Il timer del client del bot: dopo 3000 ms di carica manda il cashout.
                let pl = &self.world.players[i];
                if cash && pl.cashing_out && now - pl.cash_start_ms >= self.p.cashout_hold_ms {
                    slot.up.push_back((now + delay, Up::Cashout));
                }
            }
        }

        self.manage_lobby();
        self.world.step();

        // Eventi del server verso i client.
        let events = std::mem::take(&mut self.world.events);
        for (t, ev) in events {
            match ev {
                Event::Kill { victim, victim_name, killer, reason, streak, balance, .. } => {
                    if let Some(log) = self.death_log.as_mut() {
                        let tactic = self.bots.iter().find(|b| b.uid == victim).map(|b| format!("{:?}{}", b.brain.tactic, if b.brain.pro { "" } else { "/classico" }));
                        log.push((victim, reason, tactic.unwrap_or_else(|| "agente".into())));
                    }
                    for a in 0..self.agents.len() {
                        let d = self.down_delay();
                        let slot = &mut self.agents[a];
                        slot.down.push_back((t + d, Down::Kill { killer: killer.clone(), victim: victim_name.clone(), streak }));
                        if slot.uid == Some(victim) {
                            slot.down.push_back((t + d, Down::YouDied { reason, killer: killer.clone(), balance }));
                        }
                    }
                }
                Event::Cashout { uid, balance, payout, rake } => {
                    for a in 0..self.agents.len() {
                        if self.agents[a].uid == Some(uid) {
                            let d = self.down_delay();
                            self.agents[a].down.push_back((t + d, Down::CashoutResult { balance, payout, rake }));
                        }
                    }
                }
                Event::Eat { .. } => {}
            }
        }
    }

    fn server_receive_agent(&mut self, a: usize, msg: Up) {
        match msg {
            Up::Input { dir, boost, cash } => {
                if let Some(uid) = self.agents[a].uid { self.world.apply_input(uid, dir, boost, cash); }
            }
            Up::Cashout => {
                if let Some(uid) = self.agents[a].uid { self.world.request_cashout(uid); }
            }
            Up::Leave => {
                if let Some(uid) = self.agents[a].uid.take() { self.world.leave(uid); }
            }
            Up::Join => {
                if let Some(old) = self.agents[a].uid.take() { self.world.leave(old); }
                let name = self.agents[a].name.clone();
                let uid = self.world.join(name, Kind::Agent(a), self.p.buy_in);
                let start = self.spec.as_ref().filter(|_| self.cfg.match_mode).and_then(|s| s.agents.get(a)).cloned().unwrap_or_default();
                self.world.set_start(uid, start.start_size, start.start_balance);
                if start.at.is_set() { self.world.place(uid, start.at.x, start.at.y, start.at.angle, start.at.curl); }
                let (b0, s0) = self.world.player(uid).map(|p| (p.balance, p.snake.size)).unwrap_or((self.p.buy_in, self.p.start_size));
                self.agents[a].start_balance = b0;
                self.agents[a].start_size = s0;
                let id: String = self.world.player(uid).map(|p| p.id.to_string()).unwrap_or_default();
                self.agents[a].uid = Some(uid);
                let d = self.down_delay();
                let t = self.world.time_ms;
                self.agents[a].down.push_back((t + d, Down::Init { id: id.to_string() }));
            }
        }
    }

    /// Fa girare il server fino al prossimo snapshot e lo mette in viaggio verso i client.
    fn advance_until_broadcast(&mut self) {
        loop {
            self.tick_world();
            if self.world.tick >= self.next_snapshot_tick { break; }
        }
        let (k_ts, n_ticks) = self.sample_snapshot_gap();
        self.next_snapshot_tick = self.world.tick + n_ticks;
        let mut s = Snapshot::from_world(&self.world);
        // Il `ts` e' l'ora d'invio, sulla griglia del timer d'invio (Δts ≈ 15,5·k + 2 ms),
        // non l'ora del tick: lo stesso scarto che il server vero mostra.
        let tick_time = self.world.epoch_ms + self.world.time_ms;
        let steps = std::mem::replace(&mut self.next_ts_steps, k_ts);
        // L'invio avviene dopo il tick (lo snapshot contiene l'ultimo tick gia' fatto).
        let ts = if self.last_ts.is_finite() {
            let d = (15.5 * steps as f64 + 2.0 + self.rng.range(-1.0, 1.0)).round();
            (self.last_ts + d).clamp(tick_time, tick_time + self.p.tick_ms()).round()
        } else { tick_time.round() };
        self.last_ts = ts;
        s.ts = ts as i64;
        let off = ts - tick_time;
        for pv in s.players.iter_mut() {
            if let Some(pl) = self.world.players.iter().find(|q| q.id == pv.id) {
                if pl.cashing_out { pv.cashout_progress = ((self.world.time_ms + off - pl.cash_start_ms) / self.p.cashout_hold_ms).clamp(0.0, 1.0); }
            }
        }
        let snap = Arc::new(s);
        // La latenza parte dall'invio: arrivo = ts + andata + jitter.
        let deliver = self.world.time_ms + off + self.down_delay();
        for slot in self.agents.iter_mut() { slot.down.push_back((deliver, Down::State(snap.clone()))); }
        if let Some(hub) = &self.viewer {
            // Il browser segue la persona, se gioca; altrimenti il primo agente.
            let you = self.agents.get(self.human_slot.unwrap_or(0)).map(|s| s.id.clone()).unwrap_or_default();
            hub.publish(&snap, &you, &self.p);
        }
        self.last_broadcast = Some(snap);
    }

    /// Consegna ai client cio' che e' arrivato e ne ricava osservazione, ricompensa, fine.
    ///
    /// Ogni chiamata segue una trasmissione del server: la coda di ogni client
    /// contiene gli eventi del periodo e, per ultimo, lo snapshot appena partito.
    fn collect(&mut self, obs: &mut [f32], rew: &mut [f32], done: &mut [u8], info: &mut [f32]) {
        let rc = self.cfg.reward.clone();
        let max_ep_ms = self.cfg.max_episode_s * 1000.0;
        let rejoin_ms = self.cfg.rejoin_delay_s * 1000.0;
        let buy = self.p.buy_in.max(1e-9);
        // L'equity e' il VALORE D'INCASSO della posizione: saldo × (1 − commissione), cioe'
        // quanto si porterebbe a casa incassando adesso. Cosi' la commissione e' gia' pagata
        // in ogni istante e il cashout vale 0: uscire ora o piu' tardi non cambia la
        // ricompensa di per se', conta solo cio' che si guadagna o si rischia nel frattempo.
        // Se la commissione fosse pagata solo all'uscita, lo sconto γ renderebbe conveniente
        // rimandarla, e l'agente resterebbe in campo piu' del dovuto.
        let cash_value = 1.0 - self.p.rake;
        for a in 0..self.agents.len() {
            let o = &mut obs[a * OBS_SIZE..(a + 1) * OBS_SIZE];
            let inf = &mut info[a * INFO_SIZE..(a + 1) * INFO_SIZE];
            o.fill(0.0);
            inf.fill(0.0);
            rew[a] = 0.0;
            done[a] = 0;
            let mut snap: Option<Arc<Snapshot>> = None;
            let mut terminal: Option<(f32, f64, bool)> = None; // (motivo, equity finale, muro)
            let mut kills_now = 0u32;
            inf[13] = self.agents[a].active as u8 as f32;
            while let Some((t, m)) = self.agents[a].down.pop_front() {
                if let Some(rec) = self.recorder.as_mut() { if a == 0 { rec.server_message(t, &m, &self.p); } }
                let slot = &mut self.agents[a];
                match m {
                    Down::State(s) => { slot.now_ms = slot.now_ms.max(t); snap = Some(s); }
                    Down::Init { id } => {
                        slot.id = id;
                        slot.state = SlotState::Playing;
                        slot.equity = slot.start_balance * cash_value;
                        slot.size = slot.start_size;
                        slot.ep_start_ms = t;
                        slot.kills = 0;
                        slot.seen_loot_own = 0.0;
                        slot.seen_loot_other = 0.0;
                        slot.seen_food = 0;
                        slot.seen_kills = 0;
                        slot.seen_kills_head_on = 0;
                        slot.cash_holding = false;
                        slot.forced = false;
                        slot.feat.reset();
                        terminal = None;
                    }
                    Down::YouDied { killer, .. } => {
                        if slot.state == SlotState::Playing { terminal = Some((1.0, 0.0, killer == "WALL")); }
                    }
                    Down::CashoutResult { payout, .. } => {
                        // 2 = ha incassato lui; 4 = incassato a fine partita (stessa commissione).
                        if slot.state == SlotState::Playing { terminal = Some((if slot.forced { 4.0 } else { 2.0 }, payout, false)); }
                    }
                    Down::Kill { killer, .. } => {
                        if killer == slot.name { slot.kills += 1; kills_now += 1; }
                    }
                }
            }
            let Some(s) = snap else { continue };
            let slot = &mut self.agents[a];
            slot.last_snap = Some(s.clone());
            if slot.state != SlotState::Playing { continue; }
            let me = s.player(&slot.id).cloned();
            slot.feat.push(&s, &slot.id, o);
            inf[6] = s.players.iter().filter(|p| p.alive).count() as f32;
            inf[11] = s.tick as f32;
            let (mut new_equity, mut new_size) = (slot.equity, slot.size);
            if let Some(me) = &me {
                inf[5] = 1.0;
                inf[1] = me.balance as f32;
                inf[2] = me.size as f32;
                inf[7] = me.cashout_progress as f32;
                // Posizione e boost della propria testa (per le statistiche: quanta mappa usa).
                inf[16] = me.hx as f32;
                inf[17] = me.hy as f32;
                inf[18] = me.boosting as u8 as f32;
                if me.alive {
                    slot.observed_angle = me.angle;
                    new_equity = me.balance * cash_value;
                    new_size = me.size;
                } else if terminal.is_none() {
                    // Morte vista nello snapshot prima del messaggio: e' gia' terminale.
                    terminal = Some((1.0, 0.0, false));
                }
            }
            let mut truncated = false;
            if let Some((_, eq, _)) = terminal { new_equity = eq; } else if !self.cfg.match_mode && slot.now_ms - slot.ep_start_ms > max_ep_ms { truncated = true; }
            inf[14] = kills_now as f32;
            // Uccisioni, bottino e cibo dall'ultimo passo (contatori del server, gli stessi del
            // resoconto di fine partita: gli eventi del periodo sono tutti nello snapshot
            // appena consegnato).
            if let Some(pl) = slot.uid.and_then(|u| self.world.players.iter().find(|q| q.uid == u)) {
                inf[14] = pl.kills.saturating_sub(slot.seen_kills) as f32;
                slot.seen_kills = pl.kills;
                inf[25] = pl.kills_head_on.saturating_sub(slot.seen_kills_head_on) as f32;
                slot.seen_kills_head_on = pl.kills_head_on;
                inf[19] = (pl.loot_own - slot.seen_loot_own) as f32;
                inf[20] = (pl.loot_other - slot.seen_loot_other) as f32;
                inf[21] = pl.food_eaten.saturating_sub(slot.seen_food) as f32;
                slot.seen_loot_own = pl.loot_own;
                slot.seen_loot_other = pl.loot_other;
                slot.seen_food = pl.food_eaten;
                if matches!(terminal, Some((m, _, _)) if m == 2.0 || m == 4.0) {
                    inf[22] = pl.exit_gold as f32;
                    inf[23] = pl.exit_enemies as f32;
                }
                if terminal.is_some() && !pl.alive && is_head_on(pl.death_reason) { inf[24] = 1.0; }
            }
            if terminal.is_none() && new_equity > slot.equity { inf[15] = ((new_equity - slot.equity) / self.p.buy_in.max(1e-9)) as f32; }
            // Equity: valore d'incasso del saldo in gioco; 0 alla morte; il pagato al cashout
            // (anche a quello forzato di fine partita), che coincide col valore d'incasso.
            // La somma delle ricompense di un episodio e' (incassato − 0,9·posta) / posta:
            // il profitto a meno di una costante (la commissione sulla posta iniziale), che
            // non cambia la politica migliore. `profitto_episodio` (info) resta quello vero.
            rew[a] = (rc.equity * (new_equity - slot.equity) / buy + rc.size * (new_size - slot.size) / 100.0 + rc.alive) as f32;
            slot.equity = new_equity;
            slot.size = new_size;
            if terminal.is_some() || truncated {
                let (motivo, _, wall) = terminal.unwrap_or((3.0, 0.0, false));
                done[a] = 1;
                inf[0] = motivo;
                inf[3] = if motivo == 2.0 || motivo == 4.0 { new_equity as f32 } else { 0.0 };
                inf[4] = ((slot.now_ms - slot.ep_start_ms) / 1000.0) as f32;
                // Profitto vero: incassato (0 alla morte, valore d'incasso se troncato) meno
                // il saldo d'ingresso. Non e' la somma delle ricompense: quella parte da 0,9·posta.
                inf[8] = ((new_equity - slot.start_balance) / buy) as f32;
                inf[9] = slot.kills as f32;
                inf[10] = wall as u8 as f32;
                slot.cash_holding = false;
                slot.up.clear();
                if self.cfg.match_mode {
                    // In partita non si rientra: il posto resta vuoto fino alla prossima.
                    slot.state = SlotState::Finished;
                    continue;
                }
                // Fuori partita: leave e, dopo un attimo, un nuovo join, come il client vero.
                slot.state = SlotState::Rejoining;
                let now = slot.now_ms;
                let d1 = self.p.uplink_ms + self.rng.f64() * self.p.jitter_ms;
                let d2 = self.p.uplink_ms + self.rng.f64() * self.p.jitter_ms;
                let slot = &mut self.agents[a];
                slot.send(now, d1, Up::Leave);
                slot.send(now + rejoin_ms, d2, Up::Join);
            }
        }
    }

    pub fn snapshot_json(&self, agent: usize) -> String {
        match self.agents.get(agent).and_then(|a| a.last_snap.as_ref()).or(self.last_broadcast.as_ref()) {
            Some(s) => s.to_json(),
            None => String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{BotSpec, SlotSpec};

    /// Lobby affollate di serpenti grandi: chi entra puo' nascere sopra un corpo e morire
    /// subito. La partita va rifatta, non aspettata per sempre (era un blocco infinito).
    #[test]
    #[ignore = "da riadattare alla fisica vera del 2026-10-07 (tetto della taglia, controllo del cashout a 30 ms)"]
    fn morte_all_ingresso_rifa_la_partita() {
        let cfg = EnvConfig { agents_per_env: 4, match_mode: true, ..EnvConfig::default() };
        let mut env = Env::new(cfg, 7);
        let mut obs = vec![0.0f32; 4 * OBS_SIZE];
        let mut info = vec![0.0f32; 4 * INFO_SIZE];
        // Taglia 900: serve saldo 3 (tetto della taglia = saldo·300).
        let big = SlotSpec { start_size: 900.0, start_balance: 3.0, ..SlotSpec::default() };
        let bot = BotSpec { style: "ariete".into(), skill: 1.0, start_size: 900.0, start_balance: 3.0, ..BotSpec::default() };
        let spec = MatchSpec { agents: vec![big; 4], bots: vec![bot; 3], max_s: 60.0, end_when_alone_s: 10.0, ..MatchSpec::default() };
        let mut rifatte = 0;
        for _ in 0..400 {
            while !env.setup_match(spec.clone(), &mut obs, &mut info) { rifatte += 1; }
            assert!(env.agents.iter().all(|a| !a.active || a.state == SlotState::Playing));
        }
        assert!(rifatte > 0, "il caso non si e' presentato: la prova non prova niente");
        env.reset_match(spec, &mut obs, &mut info);
        assert!(env.agents.iter().all(|a| a.state == SlotState::Playing));
    }

    /// A fine partita chi e' in campo incassa davvero: episodio terminale con motivo 4,
    /// ricompensa pari alla commissione, saldo pagato nelle info. Niente troncamento.
    #[test]
    fn fine_partita_e_un_cashout_con_commissione() {
        let cfg = EnvConfig { agents_per_env: 1, match_mode: true, ..EnvConfig::default() };
        let mut env = Env::new(cfg, 11);
        let mut obs = vec![0.0f32; OBS_SIZE];
        let mut info = vec![0.0f32; INFO_SIZE];
        let (mut rew, mut done) = (vec![0.0f32; 1], vec![0u8; 1]);
        let agent = SlotSpec { start_size: 300.0, start_balance: 2.5, ..SlotSpec::default() };
        // Nessun avversario: l'agente gira in tondo nel vuoto e la partita scade dopo 5 s.
        let spec = MatchSpec { agents: vec![agent], bots: vec![], max_s: 5.0, end_when_alone_s: 1e9, seed: 3, ..MatchSpec::default() };
        env.reset_match(spec, &mut obs, &mut info);
        let mut total = 0.0f32;
        let act = [0.3f32, 0.0, 0.0];
        for _ in 0..400 {
            env.step(&act, &mut obs, &mut rew, &mut done, &mut info);
            total += rew[0];
            if done[0] != 0 { break; }
        }
        assert_eq!(done[0], 1, "la partita deve finire");
        assert_eq!(info[0], 4.0, "motivo: cashout forzato di fine partita");
        assert!((info[3] - 2.0).abs() < 1e-6, "pagato l'80 % di 2,5 (commissione 20 %): {}", info[3]);
        assert!(total.abs() < 1e-6, "l'equity e' gia' al netto della commissione: incassare vale 0, non {total}");
        assert!((info[8] + 0.5).abs() < 1e-6, "profitto dell'episodio = −0,5 poste: {}", info[8]);
        assert_eq!(info[12], 1.0, "fine partita segnalata");
        let report = env.match_report();
        assert_eq!(report[0]["forzato"], true);
        assert_eq!(report[0]["incassato"], true);

        // Con fine_quota 0,7 chi non e' uscito da solo porta a casa il 70 %: −0,6 di equity.
        let spec = MatchSpec { agents: vec![SlotSpec { start_size: 300.0, start_balance: 2.5, ..SlotSpec::default() }], bots: vec![],
                               max_s: 5.0, end_when_alone_s: 1e9, seed: 3, fine_quota: 0.7, ..MatchSpec::default() };
        env.reset_match(spec, &mut obs, &mut info);
        let mut total = 0.0f32;
        for _ in 0..400 {
            env.step(&act, &mut obs, &mut rew, &mut done, &mut info);
            total += rew[0];
            if done[0] != 0 { break; }
        }
        assert_eq!(info[0], 4.0);
        assert!((info[3] - 2.5 * 0.7 * 0.8).abs() < 1e-5, "pagato il 70 % del valore d'incasso: {}", info[3]);
        assert!((total + 2.0 * 0.3).abs() < 1e-5, "aspettare la fine costa il 30 % del valore d'incasso: {total}");
    }

    /// Situazioni costruite a mano: posizioni, corpo avvolto, bottino a terra, muro
    /// largo, bot che sta gia' incassando. E se le posizioni sono impossibili (due teste
    /// nello stesso punto) si ripiega sulle nascite casuali invece di bloccarsi.
    #[test]
    #[ignore = "da riadattare alla fisica vera del 2026-10-07 (tetto della taglia, controllo del cashout a 30 ms)"]
    fn situazioni_con_posizioni_esplicite() {
        use crate::config::Placement;
        let cfg = EnvConfig { agents_per_env: 1, match_mode: true, ..EnvConfig::default() };
        let mut env = Env::new(cfg, 21);
        let mut obs = vec![0.0f32; OBS_SIZE];
        let mut info = vec![0.0f32; INFO_SIZE];
        let agent = SlotSpec { at: Placement { x: 100.0, y: 50.0, angle: 0.0, curl: 0.0 }, ..SlotSpec::default() };
        // Un gigante il cui corpo e' un arco di raggio 200 attorno all'agente, testa a nord.
        let r = 200.0;
        let circler = BotSpec { style: "accerchiatore".into(), skill: 1.0, start_size: 900.0, start_balance: 3.0,
                                at: Placement { x: 100.0, y: 50.0 + r, angle: std::f64::consts::PI, curl: 1.6 / r }, ..BotSpec::default() };
        let preda = BotSpec { style: "raccoglitore".into(), skill: 0.8, start_balance: 2.0, cashing: true,
                              at: Placement { x: 700.0, y: -400.0, angle: 1.0, curl: 0.0 }, ..BotSpec::default() };
        let spec = MatchSpec { agents: vec![agent], bots: vec![circler, preda], max_s: 60.0, end_when_alone_s: 10.0, seed: 5,
                               gold: vec![[400.0, 50.0, 0.5], [420.0, 60.0, 0.5]], arena_r: 2600.0, ..MatchSpec::default() };
        env.reset_match(spec, &mut obs, &mut info);
        let w = &env.world;
        let me = w.players.iter().find(|p| matches!(p.kind, Kind::Agent(0))).unwrap();
        assert!(me.alive && (me.snake.x - 100.0).abs() < 30.0 && (me.snake.y - 50.0).abs() < 30.0, "agente dove chiesto: {} {}", me.snake.x, me.snake.y);
        let big = w.players.iter().find(|p| p.snake.size > 800.0).unwrap();
        let dists: Vec<f64> = (0..big.snake.num_segments).map(|k| { let g = big.snake.ring(k, &w.p); (g[0] - 100.0).hypot(g[1] - 50.0) }).collect();
        assert!(dists.iter().all(|d| (d - r).abs() < 25.0), "corpo ad arco attorno all'agente: {:?}", &dists[..5]);
        assert!(w.foods.iter().filter(|f| f.gold).map(|f| f.value).sum::<f64>() > 0.99, "bottino a terra");
        assert!(w.r > 2400.0, "muro largo che si stringera': {}", w.r);
        let prey = w.players.iter().find(|p| p.balance > 1.5 && matches!(p.kind, Kind::Bot(_))).unwrap();
        assert!(prey.cashing_out, "la preda sta incassando");

        // Un bot immortale messo fuori dal muro non muore, e il riscaldamento fa passare il tempo.
        let fuori = BotSpec { style: "misto".into(), skill: 0.5, immortal: true, at: Placement { x: 2400.0, y: 0.0, angle: 0.0, curl: 0.0 }, ..BotSpec::default() };
        let spec = MatchSpec { agents: vec![SlotSpec::default()], bots: vec![fuori], max_s: 60.0, end_when_alone_s: 1e9, warm_s: 3.0, ..MatchSpec::default() };
        env.reset_match(spec, &mut obs, &mut info);
        assert!(env.world.time_ms >= 3000.0, "riscaldamento di 3 s: {}", env.world.time_ms);
        for _ in 0..200 { env.step(&[0.3, 0.0, 0.0], &mut obs, &mut [0.0], &mut [0], &mut info); }
        let b = env.world.players.iter().find(|p| matches!(p.kind, Kind::Bot(_))).unwrap();
        assert!(b.alive && b.immortal, "il bot immortale e' ancora vivo");

        // Due teste nello stesso punto: impossibile; dopo tre tentativi le posizioni cadono.
        let same = Placement { x: 0.0, y: 0.0, angle: 0.0, curl: 0.0 };
        let spec = MatchSpec { agents: vec![SlotSpec { at: same, ..SlotSpec::default() }],
                               bots: vec![BotSpec { style: "ariete".into(), skill: 1.0, start_size: 600.0, at: Placement { angle: std::f64::consts::PI, ..same }, ..BotSpec::default() }],
                               max_s: 30.0, end_when_alone_s: 10.0, ..MatchSpec::default() };
        env.reset_match(spec, &mut obs, &mut info);
        assert!(env.agents[0].state == SlotState::Playing);
    }

    /// Ingresso ritardato: la partita comincia con chi c'e', l'altro entra dopo
    /// `join_after_s`; nel frattempo la partita non chiude per «rimasto solo».
    #[test]
    fn ingresso_ritardato() {
        let cfg = EnvConfig { agents_per_env: 2, match_mode: true, ..EnvConfig::default() };
        let mut env = Env::new(cfg, 13);
        let mut obs = vec![0.0f32; 2 * OBS_SIZE];
        let mut info = vec![0.0f32; 2 * INFO_SIZE];
        let (mut rew, mut done) = (vec![0.0f32; 2], vec![0u8; 2]);
        let tardi = SlotSpec { join_after_s: 5.0, ..SlotSpec::default() };
        let spec = MatchSpec { agents: vec![SlotSpec::default(), tardi], bots: vec![], max_s: 60.0, end_when_alone_s: 1.0, seed: 4, ..MatchSpec::default() };
        env.reset_match(spec, &mut obs, &mut info);
        assert_eq!(env.agents[0].state, SlotState::Playing);
        assert_eq!(env.agents[1].state, SlotState::Rejoining, "il secondo non e' ancora entrato");
        let t0 = env.world.time_ms;
        let act = [0.2f32, 0.0, 0.0, 0.2, 0.0, 0.0];
        let mut entrato = None;
        while env.world.time_ms - t0 < 8000.0 {
            env.step(&act, &mut obs, &mut rew, &mut done, &mut info);
            assert!(!env.match_over, "la partita non deve chiudere mentre qualcuno deve ancora entrare");
            if entrato.is_none() && env.agents[1].state == SlotState::Playing { entrato = Some(env.world.time_ms - t0); }
        }
        let t = entrato.expect("il secondo agente deve entrare");
        assert!((4900.0..6000.0).contains(&t), "entrato dopo {t} ms");
        assert_eq!(env.world.players.iter().filter(|p| p.alive).count(), 2);
    }

    /// Come muoiono i bot forti e quelli classici, e in che tattica (`cargo test --release diagnosi -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn diagnosi_morti_dei_bot() {
        let cfg = EnvConfig { agents_per_env: 1, match_mode: true, ..EnvConfig::default() };
        // Un solo seme e' una misura sola: due versioni del codice che differiscono in un
        // dettaglio qualsiasi danno partite diverse (effetto farfalla) e ±15 morti di
        // rumore. Per confrontare due versioni servono piu' semi (DIAG_SEED) e la media.
        let seed: u64 = std::env::var("DIAG_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
        let mut env = Env::new(cfg, seed);
        let mut obs = vec![0.0f32; OBS_SIZE];
        let mut info = vec![0.0f32; INFO_SIZE];
        let styles = ["cacciatore", "raccoglitore", "misto", "ariete", "accerchiatore", "affiancatore", "spingitore", "esca", "codardo", "avvoltoio", "imprevedibile"];
        let mut log = Vec::new();
        for m in 0..120 {
            let st = styles[m % styles.len()];
            // Una partita su due con un forte e un classico gia' grandi e ricchi, come in una
            // lobby avviata: cosi' si misurano anche le tattiche dei lunghi (accerchiamento).
            let (size, bal) = if m % 2 == 0 { (300.0 + (m % 7) as f64 * 100.0, 2.0) } else { (0.0, 0.0) };
            let b = |c: bool, rich: bool| BotSpec { style: st.into(), skill: 1.0, classico: c,
                start_size: if rich { size } else { 0.0 }, start_balance: if rich { bal } else { 0.0 }, ..BotSpec::default() };
            let spec = MatchSpec { agents: vec![], bots: vec![b(false, true), b(false, false), b(true, true), b(true, false)], max_s: 120.0, end_when_alone_s: 30.0, ..MatchSpec::default() };
            env.reset_match(spec, &mut obs, &mut info);
            // Ablazioni da riga di comando: DIAG_HORIZON (tick), DIAG_MARGIN (u), DIAG_ENCIRCLE
            // (0/1), DIAG_SEED. Confrontare sempre la media su piu' semi.
            for b in env.bots.iter_mut() {
                if let Ok(v) = std::env::var("DIAG_HORIZON") { b.brain.horizon_pro = v.parse().unwrap_or(16); }
                if let Ok(v) = std::env::var("DIAG_MARGIN") { b.brain.margin = v.parse().unwrap_or(12.0); }
                if std::env::var("DIAG_ENCIRCLE").as_deref() == Ok("0") { b.brain.encircle = false; }
            }
            env.death_log = Some(Vec::new());
            for _ in 0..(120 * 60) { env.tick_world(); }
            log.extend(env.death_log.take().unwrap());
        }
        let mut count: std::collections::BTreeMap<String, usize> = Default::default();
        for (_, reason, tactic) in &log { *count.entry(format!("{tactic:22} {reason}")).or_default() += 1; }
        for (k, n) in count { eprintln!("{n:5}  {k}"); }
    }
}
