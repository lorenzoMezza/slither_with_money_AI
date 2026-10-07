//! Il mondo autoritativo: cio' che fa il server a ogni tick.
//!
//! L'ordine delle operazioni e' quello del port del server nel client
//! (`simTick` → `stepMovement` per ogni giocatore → `checkCollisions` → `topUpFood`),
//! con i numeri misurati sul server vero dove il client sbaglia:
//!
//!  0. ogni `cashout_check_ms` (30 ms) il server guarda il tasto del cashout: chi lo tiene
//!     comincia a caricare, chi l'ha rilasciato riparte da zero
//!  1. per ogni giocatore vivo, nell'ordine di ingresso:
//!     sterzata (bloccata in cashout) → rampa del boost → passo (rallentato in cashout)
//!     → avanzamento e campionamento del percorso → crescita in coda → muro
//!     → costo del boost → raccolta del cibo → tetto della taglia → progresso del cashout
//!  2. collisioni: prima testa-testa (cono di 75°), poi testa-corpo;
//!     chi muore in questo tick non uccide piu' nessuno
//!  3. via gli orb fuori dal muro; il cibo torna a `food_target` orb, bottino compreso
//!  4. il muro insegue 2000 + 100·(vivi − 1) al 2 % per tick
//!
//! La fisica e' la verita' data dall'utente il 2026-10-07 (config.rs, [V]): il bottino non
//! scade mai, la taglia e' limitata dal saldo, il boost costa il 10,8 % della taglia al
//! secondo, il cashout trattiene il 20 %.

use crate::config::{HeadOnRule, Params};
use crate::rng::{dist2, normalize, Rng, PI, TAU};
use crate::snake::Snake;
use std::sync::Arc;

pub const FOOD_COLORS: [&str; 6] = ["#ff4d4d", "#4dff4d", "#4d4dff", "#ff4dff", "#4dffff", "#ffffff"];
pub const GOLD_COLOR: &str = "#ffd700";
/// Ogni quanti tick si campiona la distanza dal nemico piu' vicino (misure di stile).
const STYLE_EVERY: u64 = 6;
pub const SNAKE_COLORS: [&str; 12] = [
    "#8b1e1e", "#0cd116", "#fcb311", "#ff7ac8", "#1cff6a", "#44aaff", "#ff8800", "#aa00ff", "#00aaff", "#ffccaa", "#ff0088", "#00ff88",
];
const NAMES: [&str; 40] = [
    "imYeat", "shifty", "loll", "Light7", "werihwodifs", "vortex", "noodle", "SolKing", "degen42", "pepe",
    "zigzag", "Mamba", "snek", "kaiju", "orbit", "Blitz", "luna", "ratatat", "cobra_x", "nova",
    "pixel", "Drako", "frosty", "bigmac", "tilt", "ghost", "moneyman", "sly", "Rex", "yolo",
    "kiwi", "matrix", "turbo", "slinky", "Zed", "hydra", "neon", "banshee", "crypto_kid", "wormy",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Bot(usize),
    Agent(usize),
    Human,
}

#[derive(Clone, Debug)]
pub struct Food {
    pub x: f64,
    pub y: f64,
    pub gold: bool,
    pub color: &'static str,
    pub value: f64,
    /// Bottino: uid di chi ha ucciso il serpente da cui e' caduto (0 = muro, nessuno o
    /// bottino messo a mano) e la parte del bottino che vale (1 / orb della caduta: chi
    /// raccoglie tutta una caduta somma 1). Servono alla ricompensa a punti.
    pub killer: u64,
    pub share: f64,
}

#[derive(Clone, Debug)]
pub struct Player {
    pub uid: u64,
    pub id: Arc<str>,
    pub name: Arc<str>,
    pub color: &'static str,
    pub kind: Kind,
    pub alive: bool,
    /// Morto che ha premuto «guarda» (messaggio spectate): resta in lista come spettatore.
    pub spectator: bool,
    /// Input correntemente in vigore sul server.
    pub target_dir: f64,
    pub boosting: bool,
    pub wants_cashing: bool,
    pub cashing_out: bool,
    pub cashout_progress: f64,
    /// Ora del server in cui la carica e' cominciata (il progresso e' a tempo).
    pub cash_start_ms: f64,
    pub balance: f64,
    pub buy_in: f64,
    /// Saldo con cui e' entrato (per misurarne il profitto anche se parte «ricco»).
    pub start_balance: f64,
    /// Incassato al cashout (0 se e' morto o e' ancora in campo).
    pub payout: f64,
    pub level: u32,
    pub snake: Snake,
    pub joined_ms: f64,
    pub died_ms: f64,
    /// Uscito per cashout completato (alive:false ma non morto).
    pub cashed: bool,
    pub kills: u32,
    /// Di cui vinte testa contro testa (il piu' piccolo muore).
    pub kills_head_on: u32,
    /// Bottino raccolto, in parti di caduta (1 = una caduta intera): delle proprie
    /// uccisioni e di quelle altrui (o del muro). Orb di cibo normale raccolti.
    pub loot_own: f64,
    pub loot_other: f64,
    pub food_eaten: u32,
    /// Al cashout: orb d'oro rimasti dentro il muro e avversari ancora in campo.
    pub exit_gold: u32,
    pub exit_enemies: u32,
    /// Stile di gioco (per la diversita' della lega): tick da vivo, tick col boost, e la
    /// distanza dalla testa nemica piu' vicina campionata ogni `STYLE_EVERY` tick.
    pub alive_ticks: u32,
    pub boost_ticks: u32,
    pub near_sum: f64,
    pub near_n: u32,
    /// Come e' morto (`reason` di you_died: "border", "hit", "head-to-head", …; "" se vivo o uscito).
    pub death_reason: &'static str,
    /// Non muore mai (ostacolo mobile delle fasi di addestramento).
    pub immortal: bool,
}

#[derive(Clone, Debug)]
pub enum Event {
    /// Morte: `killer` e' il nome dell'uccisore o "WALL"; `reason` come in you_died.
    Kill { victim: u64, victim_name: String, killer: String, reason: &'static str, streak: u32, balance: f64, size: f64 },
    /// Cashout completato.
    Cashout { uid: u64, balance: f64, payout: f64, rake: f64 },
    /// Orb raccolto (per le ricompense e le statistiche).
    Eat { uid: u64, gold: bool, value: f64, killer: u64, share: f64 },
}

pub struct World {
    pub p: Params,
    pub rng: Rng,
    pub players: Vec<Player>,
    pub foods: Vec<Food>,
    pub r: f64,
    pub tick: u64,
    pub time_ms: f64,
    /// Ora di sistema simulata (ms epoch) del tick 0: serve al campo `ts`.
    pub epoch_ms: f64,
    pub events: Vec<(f64, Event)>,
    next_uid: u64,
    died: Vec<bool>,
}

impl World {
    pub fn new(p: Params, seed: u64) -> World {
        let mut w = World {
            r: p.arena_base,
            p,
            rng: Rng::new(seed),
            players: Vec::new(),
            foods: Vec::new(),
            tick: 0,
            time_ms: 0.0,
            epoch_ms: 1_791_000_000_000.0,
            events: Vec::new(),
            next_uid: 1,
            died: Vec::new(),
        };
        w.seed_food();
        w
    }

    /// Il cibo come lo si trova entrando: `food_target` orb dentro il muro (fuori non ce
    /// ne sono: vengono tolti).
    fn seed_food(&mut self) {
        self.top_up_food();
    }

    /// Tetto della taglia per un saldo: max(100, floor(saldo/posta · 300)).
    #[inline]
    pub fn size_cap(p: &Params, balance: f64, buy_in: f64) -> f64 {
        p.size_cap_min.max((balance / buy_in.max(1e-9) * p.size_cap_per_stake).floor())
    }

    pub fn index_of(&self, uid: u64) -> Option<usize> { self.players.iter().position(|p| p.uid == uid) }
    pub fn player(&self, uid: u64) -> Option<&Player> { self.players.iter().find(|p| p.uid == uid) }
    pub fn player_mut(&mut self, uid: u64) -> Option<&mut Player> { self.players.iter_mut().find(|p| p.uid == uid) }
    pub fn alive_count(&self) -> usize { self.players.iter().filter(|p| p.alive).count() }

    fn random_id(&mut self) -> String {
        const A: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        (0..19).map(|_| A[self.rng.below(36)] as char).collect()
    }

    pub fn random_name(&mut self) -> String {
        let n = NAMES[self.rng.below(NAMES.len())];
        if self.players.iter().any(|p| &*p.name == n) { format!("{n}{}", self.rng.below(90) + 10) } else { n.to_string() }
    }

    /// Ingresso in partita (join). La posizione di nascita e' una STIMA: sul server
    /// le nascite osservate stanno fra 0,43 e 0,71 del raggio, con direzione casuale;
    /// qui si sceglie, fra alcuni candidati in quell'anello, il piu' lontano dagli altri
    /// (dieci candidati: in una lobby affollata il primo posto libero non basta).
    pub fn join(&mut self, name: String, kind: Kind, buy_in: f64) -> u64 {
        let uid = self.next_uid;
        self.next_uid += 1;
        let (mut bx, mut by, mut best) = (0.0, 0.0, -1.0);
        for _ in 0..10 {
            let a = self.rng.f64() * TAU;
            let rr = (self.rng.range(0.35 * 0.35, 0.72 * 0.72)).sqrt() * self.r;
            let (x, y) = (a.cos() * rr, a.sin() * rr);
            let mut clearance = f64::INFINITY;
            for o in self.players.iter().filter(|o| o.alive) {
                clearance = clearance.min(dist2(x, y, o.snake.x, o.snake.y).sqrt());
                for i in (0..o.snake.num_segments).step_by(3) {
                    let pt = o.snake.ring(i, &self.p);
                    clearance = clearance.min(dist2(x, y, pt[0], pt[1]).sqrt());
                }
            }
            if clearance > best { best = clearance; bx = x; by = y; }
        }
        let angle = normalize(self.rng.f64() * TAU - PI);
        let snake = Snake::new(bx, by, angle, self.p.start_size, &self.p);
        let id: Arc<str> = self.random_id().into();
        let name: Arc<str> = name.into();
        let color = SNAKE_COLORS[self.rng.below(SNAKE_COLORS.len())];
        let level = 1 + self.rng.below(40) as u32;
        self.players.push(Player {
            uid, id, name, color, kind,
            alive: true,
            spectator: false,
            target_dir: angle,
            boosting: false,
            wants_cashing: false,
            cashing_out: false,
            cashout_progress: 0.0,
            cash_start_ms: 0.0,
            balance: buy_in,
            buy_in,
            start_balance: buy_in,
            payout: 0.0,
            level,
            snake,
            joined_ms: self.time_ms,
            died_ms: f64::NAN,
            cashed: false,
            kills: 0,
            kills_head_on: 0,
            loot_own: 0.0,
            loot_other: 0.0,
            food_eaten: 0,
            exit_gold: 0,
            exit_enemies: 0,
            alive_ticks: 0,
            boost_ticks: 0,
            near_sum: 0.0,
            near_n: 0,
            death_reason: "",
            immortal: false,
        });
        uid
    }

    /// Uscita dalla lobby (leave): il giocatore sparisce dalla lista.
    pub fn leave(&mut self, uid: u64) {
        if let Some(i) = self.index_of(uid) {
            if self.players[i].alive { self.kill(i, "WALL".to_string(), "leave"); }
            self.players.remove(i);
        }
    }

    /// Il messaggio {"t":"spectate"} di un morto.
    pub fn spectate(&mut self, uid: u64) {
        if let Some(pl) = self.player_mut(uid) { if !pl.alive && !pl.cashed { pl.spectator = true; } }
    }

    /// Un messaggio `input` arrivato al server (all'ora `now_ms` del server).
    pub fn apply_input(&mut self, uid: u64, target_dir: f64, boost: bool, cashing: bool) {
        let now = self.time_ms;
        if let Some(pl) = self.player_mut(uid) {
            if !pl.alive { return; }
            if target_dir.is_finite() { pl.target_dir = target_dir; }
            pl.boosting = boost;
            // Il tasto del cashout lo guarda il server ogni `cashout_check_ms` (step).
            pl.wants_cashing = cashing;
        }
        let _ = now;
    }

    /// Il controllo del cashout del server, ogni `cashout_check_ms`: chi tiene il tasto
    /// comincia a caricare; chi l'ha rilasciato prima della fine riparte da zero.
    fn check_cashout_keys(&mut self) {
        let now = self.time_ms;
        for pl in self.players.iter_mut().filter(|p| p.alive) {
            if pl.wants_cashing && !pl.cashing_out {
                pl.cashing_out = true;
                pl.cashout_progress = 0.0;
                pl.cash_start_ms = now;
            } else if !pl.wants_cashing && pl.cashing_out {
                pl.cashing_out = false;
                pl.cashout_progress = 0.0;
            }
        }
    }

    /// Cashout forzato (fine partita in allenamento): come un cashout completo, ma di
    /// `quota` del saldo (1 = tutto).
    pub fn force_cashout(&mut self, uid: u64, quota: f64) {
        let Some(i) = self.index_of(uid) else { return };
        if !self.players[i].alive { return; }
        self.players[i].balance *= quota.clamp(0.0, 1.0);
        self.players[i].cashing_out = true;
        self.players[i].cash_start_ms = self.time_ms - self.p.cashout_hold_ms;
        self.request_cashout(uid);
    }

    /// Taglia e saldo iniziali diversi da quelli del server (avversari che giocano da un po').
    pub fn set_start(&mut self, uid: u64, size: f64, balance: f64) {
        let p = self.p.clone();
        if let Some(pl) = self.player_mut(uid) {
            if balance > 0.0 { pl.balance = balance; pl.start_balance = balance; }
            if size > 0.0 {
                // La taglia non puo' superare il tetto del saldo.
                let cap = World::size_cap(&p, pl.balance, pl.buy_in);
                let (x, y, a) = (pl.snake.x, pl.snake.y, pl.snake.angle);
                pl.snake = Snake::new(x, y, a, size.max(p.min_size).min(cap), &p);
            }
        }
    }

    /// Mette un giocatore in un punto preciso, con la rotta e la curvatura del corpo
    /// date (le «situazioni» di addestramento). La taglia resta quella che ha.
    pub fn place(&mut self, uid: u64, x: f64, y: f64, angle: f64, curl: f64) {
        let p = self.p.clone();
        if let Some(pl) = self.player_mut(uid) {
            let a = if angle.is_finite() { normalize(angle) } else { pl.snake.angle };
            pl.snake = Snake::new_curled(x, y, a, pl.snake.size, curl, &p);
            pl.target_dir = a;
        }
    }

    /// Bottino gia' a terra (non scade mai). Senza uccisore; vale come parte di caduta il
    /// suo valore in poste (1 posta = una caduta).
    pub fn drop_gold(&mut self, x: f64, y: f64, value: f64) {
        let share = (value / self.p.buy_in.max(1e-9)).clamp(0.0, 1.0);
        self.foods.push(Food { x, y, gold: true, color: GOLD_COLOR, value, killer: 0, share });
    }

    /// Orb d'oro dentro il muro (quelli che si possono ancora raccogliere).
    pub fn gold_inside(&self) -> usize {
        let r2 = self.r * self.r;
        self.foods.iter().filter(|f| f.gold && f.x * f.x + f.y * f.y <= r2).count()
    }

    /// Il messaggio {"t":"cashout"}: incassa se la carica e' completa.
    pub fn request_cashout(&mut self, uid: u64) -> bool {
        let Some(i) = self.index_of(uid) else { return false };
        let held = self.time_ms - self.players[i].cash_start_ms;
        let need = self.p.cashout_hold_ms - self.p.cashout_accept_tolerance_ms;
        let pl = &mut self.players[i];
        if !pl.alive || !pl.cashing_out || held < need { return false; }
        let bal = pl.balance;
        let payout = bal * (1.0 - self.p.rake);
        let uid = pl.uid;
        // La situazione al momento dell'uscita (ricompensa della fase 2): oro ancora a
        // terra dentro il muro, avversari ancora in campo.
        let gold_left = self.gold_inside() as u32;
        let enemies = self.players.iter().filter(|q| q.alive && q.uid != uid).count() as u32;
        let pl = &mut self.players[i];
        pl.exit_gold = gold_left;
        pl.exit_enemies = enemies;
        // Chi incassa resta in lista con cashingOut:true e progresso 1 (come sul server).
        pl.alive = false;
        pl.cashed = true;
        pl.payout = payout;
        pl.cashout_progress = 1.0;
        pl.boosting = false;
        pl.snake.boost_amount = 0.0;
        pl.died_ms = self.time_ms;
        self.events.push((self.time_ms, Event::Cashout { uid, balance: bal, payout, rake: bal - payout }));
        true
    }

    /// Un tick del server.
    pub fn step(&mut self) {
        self.tick += 1;
        let prev = self.time_ms;
        self.time_ms += self.p.tick_ms();
        let every = self.p.cashout_check_ms.max(1e-9);
        if (self.time_ms / every).floor() > (prev / every).floor() { self.check_cashout_keys(); }
        for i in 0..self.players.len() {
            if self.players[i].alive { self.step_movement(i); }
        }
        self.check_collisions();
        self.style_stats();
        self.top_up_food();
        self.update_arena();
    }

    fn step_movement(&mut self, i: usize) {
        let p = &self.p;
        let pl = &mut self.players[i];
        let s = &mut pl.snake;

        // Sterzata: costante in rad per tick; bloccata durante il cashout.
        if !pl.cashing_out {
            let diff = normalize(pl.target_dir - s.angle);
            s.angle = normalize(s.angle + diff.signum() * diff.abs().min(p.max_turn));
        }
        // Rampa del boost.
        if pl.boosting && s.size > p.min_size && !pl.cashing_out {
            s.boost_amount = (s.boost_amount + p.boost_ramp).min(1.0);
        } else {
            s.boost_amount = (s.boost_amount - p.boost_ramp).max(0.0);
        }
        if pl.cashing_out { s.boost_amount = 0.0; }
        let mut step = p.base_step + (p.boost_step - p.base_step) * s.boost_amount;
        if pl.cashing_out {
            // Il rallentamento segue il tempo trascorso, come il progresso.
            let t = ((self.time_ms - pl.cash_start_ms) / p.cashout_hold_ms).clamp(0.0, 1.0);
            step = p.base_step * (1.0 - p.cashout_slow_m * t.powf(p.cashout_slow_p)).max(0.0);
        }
        s.advance(step, p);

        // Crescita in coda: al massimo 15 + 0,03·taglia per tick in tutto (anche con cio' che
        // si mangia in questo tick), sempre entro il tetto del saldo. Cio' che il tetto non
        // lascia crescere va perso.
        let mut budget = p.growth_drain_base + s.size * p.growth_drain_per_size;
        let cap = World::size_cap(p, pl.balance, pl.buy_in);
        if s.pending_growth > 0.0 {
            let apply = s.pending_growth.min(budget);
            s.pending_growth -= apply;
            budget -= apply;
            if s.pending_growth < 0.1 { s.pending_growth = 0.0; }
            s.size = if s.size >= cap { s.size } else { (s.size + apply).min(cap) };
            s.refresh_shape(p);
        }

        // Muro.
        if (s.x * s.x + s.y * s.y).sqrt() + s.thickness * p.wall_head_factor > self.r {
            self.kill(i, "WALL".to_string(), "border");
            return;
        }

        // Costo del boost: il 10,8 % della taglia al secondo, mentre il boost e' premuto
        // (anche sulla rampa), NON moltiplicato per boostAmount. Sotto la taglia minima il
        // boost si spegne.
        if pl.boosting && !pl.cashing_out {
            if s.size <= p.min_size {
                pl.boosting = false;
            } else {
                s.size = (s.size - s.size * p.boost_cost_frac).max(p.min_size);
                s.refresh_shape(p);
                if s.size <= p.min_size { pl.boosting = false; }
            }
        }

        // Raccolta: spessore GREZZO + raggio di raccolta.
        let head_r = s.thickness;
        let (hx, hy) = (s.x, s.y);
        let mut k = self.foods.len();
        while k > 0 {
            k -= 1;
            let f = &self.foods[k];
            let rr = head_r + if f.gold { p.pickup_gold } else { p.pickup_normal };
            if dist2(hx, hy, f.x, f.y) > rr * rr { continue; }
            let f = self.foods.swap_remove(k);
            let pl = &mut self.players[i];
            if f.gold {
                if f.killer != 0 && f.killer == pl.uid { pl.loot_own += f.share; } else { pl.loot_other += f.share; }
            } else {
                pl.food_eaten += 1;
            }
            if f.value > 0.0 { pl.balance += f.value; }
            let cap = World::size_cap(p, pl.balance, pl.buy_in);
            let s = &mut pl.snake;
            let gain = if f.gold { p.gold_gain } else { p.gain_base * (s.size / 100.0).powf(p.gain_exp) };
            s.pending_growth += gain;
            let apply = s.pending_growth.min(budget);
            s.pending_growth -= apply;
            budget -= apply;
            if s.pending_growth < 0.1 { s.pending_growth = 0.0; }
            s.size = if s.size >= cap { s.size } else { (s.size + apply).min(cap) };
            s.refresh_shape(p);
            let uid = pl.uid;
            self.events.push((self.time_ms, Event::Eat { uid, gold: f.gold, value: f.value, killer: f.killer, share: f.share }));
        }

        let pl = &mut self.players[i];
        // Tetto della taglia legato al saldo, applicato a ogni tick.
        let cap = World::size_cap(p, pl.balance, pl.buy_in);
        if pl.snake.size > cap {
            pl.snake.size = cap;
            pl.snake.refresh_shape(p);
        }
        if pl.cashing_out { pl.cashout_progress = ((self.time_ms - pl.cash_start_ms) / p.cashout_hold_ms).clamp(0.0, 1.0); }
    }

    /// Misure di stile: tempo col boost e, ogni `STYLE_EVERY` tick, la distanza dalla testa
    /// nemica piu' vicina (solo se c'e' almeno un altro vivo).
    fn style_stats(&mut self) {
        let sample = self.tick % STYLE_EVERY == 0;
        let heads: Vec<(u64, f64, f64)> = if sample {
            self.players.iter().filter(|p| p.alive).map(|p| (p.uid, p.snake.x, p.snake.y)).collect()
        } else { Vec::new() };
        for pl in self.players.iter_mut().filter(|p| p.alive) {
            pl.alive_ticks += 1;
            if pl.snake.boost_amount > 0.5 { pl.boost_ticks += 1; }
            if sample {
                let d = heads.iter().filter(|h| h.0 != pl.uid).map(|h| dist2(h.1, h.2, pl.snake.x, pl.snake.y)).fold(f64::INFINITY, f64::min);
                if d.is_finite() { pl.near_sum += d.sqrt(); pl.near_n += 1; }
            }
        }
    }

    /// checkCollisions() del server, nello stesso ordine e con la stessa regola
    /// «chi e' morto in questo tick non uccide piu'».
    fn check_collisions(&mut self) {
        let p = self.p.clone();
        let n = self.players.len();
        self.died.clear();
        self.died.resize(n, false);
        let alive: Vec<usize> = (0..n).filter(|&i| self.players[i].alive).collect();
        let face = if p.head_on_facing_deg > 0.0 { (p.head_on_facing_deg * PI / 180.0).cos() } else { -2.0 };
        let arc = if p.front_arc_only { (p.front_arc_deg * PI / 180.0 / 2.0).cos() } else { -2.0 };
        let head_mult = p.hitbox_base * p.hitbox_scale * p.head_hitbox_scale;
        let body_mult = p.hitbox_base * p.hitbox_scale;

        // Testa contro testa.
        for (ai, &a) in alive.iter().enumerate() {
            if self.died[a] { continue; }
            for &b in &alive[ai + 1..] {
                if self.died[a] { break; }
                if self.died[b] { continue; }
                let (sa, sb) = (&self.players[a].snake, &self.players[b].snake);
                let rr = (sa.thickness * head_mult + sb.thickness * head_mult) * p.hitbox_scale;
                if dist2(sa.x, sa.y, sb.x, sb.y) > rr * rr { continue; }
                if p.head_on_facing_deg > 0.0 {
                    let (dx, dy) = (sb.x - sa.x, sb.y - sa.y);
                    let d = (dx * dx + dy * dy).sqrt().max(1e-9);
                    let da = sa.angle.cos() * dx / d + sa.angle.sin() * dy / d;
                    let db = sb.angle.cos() * (-dx / d) + sb.angle.sin() * (-dy / d);
                    if da < face || db < face { continue; }
                }
                let (size_a, size_b) = (sa.size, sb.size);
                let coin = self.rng.chance(0.5);
                let loser = match p.head_on_rule {
                    HeadOnRule::BothDie => None,
                    HeadOnRule::Random => Some(if coin { a } else { b }),
                    // Muore il piu' piccolo con entrambe le regole del server (anche
                    // `biggest_wins`); a taglia uguale decide la moneta.
                    HeadOnRule::BiggestWins | HeadOnRule::SmallestWins if size_a != size_b => Some(if size_a < size_b { a } else { b }),
                    HeadOnRule::BiggestWins | HeadOnRule::SmallestWins => Some(if coin { a } else { b }),
                };
                match loser {
                    None => {
                        self.died[a] = true;
                        self.died[b] = true;
                        let (na, nb) = (self.players[a].name.to_string(), self.players[b].name.to_string());
                        self.kill(a, nb, "head-on-collision");
                        self.kill(b, na, "head-on-collision");
                    }
                    Some(l) => {
                        let w = if l == a { b } else { a };
                        self.died[l] = true;
                        let wn = self.players[w].name.to_string();
                        self.players[w].kills += 1;
                        self.players[w].kills_head_on += 1;
                        self.kill(l, wn, "head-to-head");
                    }
                }
            }
        }

        // Testa contro corpo: i punti 4·k del percorso, k da 2 in su.
        for &a in &alive {
            if self.died[a] || !self.players[a].alive { continue; }
            let (hx, hy, ang, th_a) = {
                let s = &self.players[a].snake;
                (s.x, s.y, s.angle, s.thickness)
            };
            let head_r = th_a * head_mult;
            for &b in &alive {
                if b == a || self.died[b] { continue; }
                let sb = &self.players[b].snake;
                let cr = head_r + sb.thickness * body_mult;
                let lim = sb.num_segments.min(p.max_segments_listed);
                // Filtro esatto: il punto k*4 dista al massimo 6,4·k lungo il percorso dalla testa.
                let reach = lim as f64 * p.point_dist * p.spacing_points as f64 + cr + 2.0;
                if dist2(hx, hy, sb.x, sb.y) > reach * reach { continue; }
                let cr2 = cr * cr;
                let mut hit = false;
                for k in 2..lim {
                    let seg = sb.path_point(k * p.spacing_points);
                    if dist2(hx, hy, seg[0], seg[1]) > cr2 { continue; }
                    if p.front_arc_only {
                        let (sx, sy) = (seg[0] - hx, seg[1] - hy);
                        let sd = (sx * sx + sy * sy).sqrt().max(1e-9);
                        if ang.cos() * sx / sd + ang.sin() * sy / sd < arc { continue; }
                    }
                    hit = true;
                    break;
                }
                if hit {
                    self.died[a] = true;
                    let kn = self.players[b].name.to_string();
                    self.players[b].kills += 1;
                    self.kill(a, kn, "hit");
                    break;
                }
            }
        }
    }

    /// killPlayer(): bottino d'oro lungo il corpo, ceil(anelli/4) orb, 100 % del saldo.
    pub fn kill(&mut self, i: usize, killer: String, reason: &'static str) {
        let p = self.p.clone();
        let by = self.players.iter().find(|q| *q.name == *killer);
        let streak = by.map(|q| q.kills.max(1)).unwrap_or(0);
        let killer_uid = by.map(|q| q.uid).unwrap_or(0);
        let pl = &mut self.players[i];
        if !pl.alive || pl.immortal { return; }
        pl.alive = false;
        pl.cashing_out = false;
        pl.cashout_progress = 0.0;
        pl.boosting = false;
        pl.snake.boost_amount = 0.0;
        pl.died_ms = self.time_ms;
        pl.death_reason = reason;
        let n = pl.snake.num_segments;
        let step = p.loot_step_min.max(n / p.loot_step_div.max(1)).max(1);
        let count = n.div_ceil(step).max(1);
        let bal = pl.balance;
        let per = bal / count as f64;
        let share = 1.0 / count as f64;
        let spread = (pl.snake.thickness * p.loot_spread_mult).min(p.loot_spread_max);
        let (color, uid, name, size) = (pl.color, pl.uid, pl.name.to_string(), pl.snake.size);
        let pts: Vec<[f64; 2]> = (0..n).step_by(step).map(|k| self.players[i].snake.ring(k, &p)).collect();
        // Il bottino non scade mai.
        for pt in pts {
            let ox = (self.rng.f64() - 0.5) * spread;
            let oy = (self.rng.f64() - 0.5) * spread;
            if bal > 0.0 {
                self.foods.push(Food { x: pt[0] + ox, y: pt[1] + oy, gold: true, color: GOLD_COLOR, value: per, killer: killer_uid, share });
            } else {
                self.foods.push(Food { x: pt[0] + ox, y: pt[1] + oy, gold: false, color, value: 0.0, killer: 0, share: 0.0 });
            }
        }
        self.events.push((self.time_ms, Event::Kill { victim: uid, victim_name: name, killer, reason, streak, balance: bal, size }));
    }

    /// topUpFood(): via gli orb fuori dal muro; se in campo ci sono meno di `food_target`
    /// orb (bottino a terra compreso), ne nascono di normali, uniformi per area entro
    /// 0,95·R.
    fn top_up_food(&mut self) {
        let r2 = self.r * self.r;
        self.foods.retain(|f| f.x * f.x + f.y * f.y <= r2);
        let mut n = self.foods.len();
        while n < self.p.food_target {
            let a = self.rng.f64() * TAU;
            let d = self.rng.f64().sqrt() * self.r * self.p.food_spawn_frac;
            let c = FOOD_COLORS[self.rng.below(FOOD_COLORS.len())];
            self.foods.push(Food { x: a.cos() * d, y: a.sin() * d, gold: false, color: c, value: 0.0, killer: 0, share: 0.0 });
            n += 1;
        }
    }

    fn update_arena(&mut self) {
        let alive = self.alive_count().max(1) as f64;
        let target = self.p.arena_base + self.p.arena_per_snake * (alive - 1.0);
        self.r += (target - self.r) * self.p.arena_relax;
        if (target - self.r).abs() < self.p.arena_snap { self.r = target; }
    }

    /// Il `ts` del server (ms di tempo reale).
    pub fn ts(&self) -> i64 { (self.epoch_ms + self.time_ms).round() as i64 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snake::Snake;

    fn world() -> World {
        let p = Params::default();
        let mut w = World::new(p, 42);
        w.foods.clear();
        w
    }

    /// Mette un serpente fermo in (x, y) con la direzione data e la taglia data.
    fn place(w: &mut World, name: &str, x: f64, y: f64, angle: f64, size: f64) -> u64 {
        let uid = w.join(name.to_string(), Kind::Human, 1.0);
        let p = w.p.clone();
        let pl = w.player_mut(uid).unwrap();
        pl.snake = Snake::new(x, y, angle, size, &p);
        pl.target_dir = angle;
        uid
    }

    #[test]
    fn frontale_vince_il_piu_grande() {
        for (sa, sb) in [(150.0, 100.0), (100.0, 150.0)] {
            let mut w = world();
            let a = place(&mut w, "a", -20.0, 0.0, 0.0, sa);
            let b = place(&mut w, "b", 20.0, 0.0, PI, sb);
            w.step();
            let (alive_a, alive_b) = (w.player(a).unwrap().alive, w.player(b).unwrap().alive);
            assert_eq!(alive_a, sa > sb, "taglie {sa} contro {sb}: deve sopravvivere il piu' grande");
            assert_eq!(alive_b, sb > sa);
            assert!(w.events.iter().any(|(_, e)| matches!(e, Event::Kill { reason: "head-to-head", .. })));
        }
    }

    #[test]
    fn muro_come_una_collisione() {
        // Stessa vittima (taglia, saldo, anelli): una volta contro il muro, una volta contro un corpo.
        let mut w1 = world();
        let v1 = place(&mut w1, "v", 1990.0, 0.0, 0.0, 120.0);
        w1.step();
        let mut w2 = world();
        let v2 = place(&mut w2, "v", 0.0, 0.0, 0.0, 120.0);
        // Un corpo lungo che attraversa la strada della vittima: testa in (60, 150) che
        // punta verso +y, corpo che scende all'indietro fino oltre y = 0.
        let blocker = place(&mut w2, "muro_di_carne", 60.0, 150.0, PI / 2.0, 400.0);
        for _ in 0..20 { w2.step(); }
        assert!(w2.player(blocker).unwrap().alive);
        let gold = |w: &World| -> (usize, f64) {
            let g: Vec<&Food> = w.foods.iter().filter(|f| f.gold).collect();
            (g.len(), g.iter().map(|f| f.value).sum())
        };
        assert!(!w1.player(v1).unwrap().alive && !w2.player(v2).unwrap().alive);
        let (n1, val1) = gold(&w1);
        let (n2, val2) = gold(&w2);
        assert_eq!(n1, n2, "stesso numero di orb di bottino");
        assert!((val1 - 1.0).abs() < 1e-9 && (val2 - 1.0).abs() < 1e-9, "100 % del saldo in entrambi i casi");
        assert!(w1.events.iter().any(|(_, e)| matches!(e, Event::Kill { reason: "border", .. })));
        assert!(w2.events.iter().any(|(_, e)| matches!(e, Event::Kill { reason: "hit", .. })));
    }

    /// La ricompensa a punti: ogni orb di una caduta sa chi ha ucciso e quanto vale della
    /// caduta (1/orb); chi raccoglie somma le parti, separate fra uccisioni proprie e altrui.
    /// Al cashout restano scritti l'oro ancora a terra e gli avversari in campo.
    #[test]
    fn bottino_attribuito_a_chi_uccide() {
        let mut w = world();
        let v = place(&mut w, "v", 0.0, 0.0, 0.0, 120.0);
        let k = place(&mut w, "k", 600.0, 600.0, 0.0, 100.0);
        let o = place(&mut w, "o", -600.0, -600.0, 0.0, 100.0);
        let iv = w.index_of(v).unwrap();
        w.kill(iv, "k".to_string(), "hit");
        let golds: Vec<(f64, f64)> = w.foods.iter().filter(|f| f.gold).map(|f| (f.x, f.y)).collect();
        let n = golds.len() as f64;
        assert!(n >= 2.0, "servono almeno due orb: {n}");
        assert!(w.foods.iter().filter(|f| f.gold).all(|f| f.killer == k), "uccisore segnato su ogni orb");
        let parti: f64 = w.foods.iter().filter(|f| f.gold).map(|f| f.share).sum();
        assert!((parti - 1.0).abs() < 1e-9, "le parti di una caduta sommano 1: {parti}");
        let porta = |w: &mut World, uid: u64, x: f64, y: f64| {
            let p = w.p.clone();
            let pl = w.player_mut(uid).unwrap();
            pl.snake = Snake::new(x - 5.0, y, 0.0, pl.snake.size, &p);
            pl.target_dir = 0.0;
            w.step();
        };
        // L'altro raccoglie dal primo orb, chi ha ucciso dall'ultimo.
        porta(&mut w, o, golds[0].0, golds[0].1);
        let (own_o, oth_o) = { let p = w.player(o).unwrap(); (p.loot_own, p.loot_other) };
        assert!(own_o == 0.0 && oth_o > 0.0, "l'altro prende bottino altrui: {own_o} {oth_o}");
        { let p = w.p.clone(); let pl = w.player_mut(o).unwrap(); pl.snake = Snake::new(-600.0, -600.0, 0.0, pl.snake.size, &p); }
        porta(&mut w, k, golds[golds.len() - 1].0, golds[golds.len() - 1].1);
        let (own_k, oth_k) = { let p = w.player(k).unwrap(); (p.loot_own, p.loot_other) };
        assert!(own_k > 0.0 && oth_k == 0.0, "chi ha ucciso prende il suo: {own_k} {oth_k}");
        assert!(((own_k * n).round() - own_k * n).abs() < 1e-6, "parti multiple di 1/{n}: {own_k}");
        // L'altro esce con oro ancora a terra e un avversario in campo.
        let left = w.gold_inside() as u32;
        assert!(left > 0, "deve restare oro a terra");
        assert!(w.player(k).unwrap().alive && w.player(o).unwrap().alive);
        let t = w.time_ms - w.p.cashout_hold_ms;
        { let pl = w.player_mut(o).unwrap(); pl.cashing_out = true; pl.cash_start_ms = t; }
        assert!(w.request_cashout(o));
        let p = w.player(o).unwrap();
        assert_eq!((p.exit_gold, p.exit_enemies), (left, 1), "oro rimasto e avversari al momento dell'uscita");
        // Il cibo normale si conta a parte.
        let food_before = w.player(k).unwrap().food_eaten;
        w.foods.push(Food { x: 0.0, y: 300.0, gold: false, color: "#fff", value: 0.0, killer: 0, share: 0.0 });
        porta(&mut w, k, 0.0, 300.0);
        assert_eq!(w.player(k).unwrap().food_eaten, food_before + 1);
    }

    /// Il bottino non scade mai e conta nei 86 orb in campo.
    #[test]
    fn bottino_non_scade_e_conta_nel_cibo() {
        let mut w = World::new(Params::default(), 7);
        let v = place(&mut w, "v", 1500.0, 0.0, 0.0, 200.0);
        let other = place(&mut w, "o", 0.0, 0.0, PI, 100.0);
        w.player_mut(other).unwrap().immortal = true;   // resta in campo: il muro non si stringe a 2000
        let iv = w.index_of(v).unwrap();
        w.kill(iv, "WALL".to_string(), "border");
        let n_gold = w.foods.iter().filter(|f| f.gold).count();
        assert!(n_gold > 0);
        for _ in 0..(60 * 60) { w.step(); }
        assert!(w.player(other).unwrap().alive);
        assert_eq!(w.foods.iter().filter(|f| f.gold).count(), n_gold, "dopo 60 s il bottino e' ancora a terra");
        assert!(w.foods.len() >= w.p.food_target, "almeno 86 orb in campo, bottino compreso (si rabbocca solo sotto)");
        let r2 = w.r * w.r;
        assert!(w.foods.iter().all(|f| f.x * f.x + f.y * f.y <= r2), "niente orb fuori dal muro");
    }

    /// Il boost costa il 10,8 % della taglia al secondo, anche sulla rampa, e non dipende
    /// da boostAmount; sotto 40 si spegne.
    #[test]
    fn costo_del_boost() {
        let mut w = world();
        w.p.food_target = 0;
        let a = place(&mut w, "a", 0.0, 0.0, 0.0, 200.0);
        { let pl = w.player_mut(a).unwrap(); pl.boosting = true; }
        w.step();
        let s1 = w.player(a).unwrap().snake.size;
        assert!((s1 - 200.0 * (1.0 - 0.108 / 60.0)).abs() < 1e-9, "primo tick (rampa a 0,075): {s1}");
        for _ in 0..59 { w.step(); }
        let s60 = w.player(a).unwrap().snake.size;
        assert!((s60 - 200.0 * (1.0f64 - 0.108 / 60.0).powi(60)).abs() < 1e-6, "un secondo di boost: {s60}");
        { let pl = w.player_mut(a).unwrap(); pl.snake.size = 40.5; }
        for _ in 0..10 { w.step(); }
        let pl = w.player(a).unwrap();
        assert!(pl.snake.size >= 40.0 && !pl.boosting, "sotto 40 il boost si spegne: {} {}", pl.snake.size, pl.boosting);
    }

    /// Crescita: 3·(taglia/100)^0,6 per orb normale, +12 per orb d'oro; tetto della taglia
    /// max(100, floor(saldo/posta·300)) a ogni tick.
    #[test]
    fn crescita_e_tetto_della_taglia() {
        let mut w = world();
        w.p.food_target = 0;
        let a = place(&mut w, "a", 0.0, 0.0, 0.0, 100.0);
        w.foods.push(Food { x: 6.0, y: 0.0, gold: false, color: "#fff", value: 0.0, killer: 0, share: 0.0 });
        w.step();
        let s1 = w.player(a).unwrap().snake.size;
        assert!((s1 - 103.0).abs() < 1e-9, "un orb normale a taglia 100 vale 3: {s1}");
        let (x, y) = { let s = &w.player(a).unwrap().snake; (s.x + 6.0, s.y) };
        w.foods.push(Food { x, y, gold: true, color: GOLD_COLOR, value: 0.0, killer: 0, share: 0.0 });
        w.step();
        let s2 = w.player(a).unwrap().snake.size;
        assert!((s2 - 115.0).abs() < 1e-9, "un orb d'oro vale +12: {s2}");
        // Saldo 1: tetto 300.
        { let pl = w.player_mut(a).unwrap(); pl.snake.size = 450.0; }
        w.step();
        assert_eq!(w.player(a).unwrap().snake.size, 300.0, "saldo 1 → tetto 300");
        { let pl = w.player_mut(a).unwrap(); pl.balance = 2.0; pl.snake.size = 650.0; }
        w.step();
        assert_eq!(w.player(a).unwrap().snake.size, 600.0, "saldo 2 → tetto 600");
        assert_eq!(World::size_cap(&w.p, 0.2, 1.0), 100.0, "mai sotto 100");
    }

    /// Cashout: la carica parte al controllo dei 30 ms, rallenta fino al 40 % e trattiene il 10 %.
    #[test]
    fn cashout_trattiene_il_dieci_per_cento() {
        let mut w = world();
        let a = place(&mut w, "a", 0.0, 0.0, 0.0, 100.0);
        w.apply_input(a, 0.0, false, true);
        for _ in 0..2 { w.step(); }
        assert!(w.player(a).unwrap().cashing_out, "in carica entro 30 ms");
        let start = w.player(a).unwrap().cash_start_ms;
        while w.time_ms - start < w.p.cashout_hold_ms { w.step(); }
        let (x0, y0) = { let s = &w.player(a).unwrap().snake; (s.x, s.y) };
        w.step();
        let (x1, y1) = { let s = &w.player(a).unwrap().snake; (s.x, s.y) };
        let passo = (x1 - x0).hypot(y1 - y0);
        assert!((passo - 4.8 * 0.4).abs() < 1e-6, "a fine carica il passo e' il 40 %: {passo}");
        assert!(w.request_cashout(a));
        let pl = w.player(a).unwrap();
        assert!((pl.payout - 0.9).abs() < 1e-12, "incasso 90 % del saldo: {}", pl.payout);
    }
}
