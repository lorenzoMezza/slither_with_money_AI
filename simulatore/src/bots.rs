//! Gli avversari: bot che giocano come persone.
//!
//! Sul server vero gli avversari sono umani: reagiscono in 150–300 ms, hanno la
//! loro latenza di rete, inseguono il bottino, tagliano la strada, scappano,
//! incassano quando hanno guadagnato abbastanza. Un agente addestrato contro bot
//! che non fanno queste cose si troverebbe online in un gioco diverso.
//!
//! Ogni bot ha una PERSONALITA' (aggressivita', avidita', prudenza, uso del boost,
//! obiettivo di incasso) e un'ABILITA' che governa tempo di reazione, orizzonte di
//! previsione e precisione. Decide a intervalli di reazione, non a ogni tick, e
//! sceglie un piano (tattica) che tiene per un po': le manovre che uccidono durano
//! secondi, non un tick. Sopra a tutto c'e' lo strato di sicurezza: le direzioni
//! candidate vengono simulate con la fisica vera (sterzata limitata, passo, muro)
//! contro i corpi degli altri.
//!
//! Il livello alto viene dai bot open source piu' forti per slither.io
//! (ErmiyaEskandary/Slither.io-bot e il fork di j-c-m) e dalle tecniche dei giocatori
//! esperti:
//! - mappa ANGOLARE dei corpi attorno alla testa (settori, ostacolo piu' vicino per
//!   settore) e fuga verso il VARCO piu' largo;
//! - rilevamento dell'ACCERCHIAMENTO: se un serpente (o tutti insieme) chiude oltre il
//!   56 % dei settori entro ~20 spessori, si esce dal varco col boost prima che si chiuda;
//! - difesa a SPIRALE: chi e' lungo e minacciato si avvolge su se stesso (nessuno puo'
//!   chiuderlo, il cibo dentro e' suo);
//! - cibo a GRAPPOLI (massa² / distanza, pesata per l'angolo), non il pellet singolo;
//! - TAGLIO DI STRADA calcolato: il punto in cui si arriva prima del bersaglio, col
//!   boost solo se serve per arrivarci in tempo, poi la sterzata davanti alla sua testa;
//! - teste nemiche previste anche mentre GIRANO, non solo in linea retta;
//! - CASHOUT solo con un corridoio dritto libero per tutti i 3 s (lo sterzo e' bloccato);
//! - ACCERCHIAMENTO opportunista: chi e' molto piu' lungo della preda la chiude invece
//!   di inseguirla.
//!
//! Ogni tecnica va misurata con `diagnosi_morti_dei_bot` (morti dei forti su 240
//! partite per seme, SU PIU' SEMI: una partita sola e' deterministica ma basta un
//! dettaglio diverso nel codice per cambiarla tutta, e il rumore e' di ±15 morti).
//! Si tiene solo cio' che le riduce in media. Provate e scartate: simulare la latenza
//! del comando nelle traiettorie, orizzonti diversi da 16 tick in piu', un margine di
//! 24 u, premiare lo spazio libero dopo l'orizzonte.

use crate::config::Params;
use crate::rng::{dist2, normalize, Rng, PI, TAU};
use crate::world::{Player, World};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tactic {
    Farm,
    Loot,
    Hunt,
    Escape,
    Cashout,
    Wander,
    /// Frontale cercato apposta da chi e' piu' grande (vince il piu' grande).
    Ram,
    /// Cashout finto per attirare chi caccia, poi interrotto per tagliargli la strada.
    Bait,
    /// Ci si mette fra il bersaglio e il centro e lo si spinge contro il muro.
    Pin,
    /// Ci si avvicina a due serpenti che si stanno scontrando, per prenderne il bottino.
    Vulture,
    /// Ci si avvolge attorno a un serpente piu' piccolo e si stringe il cerchio.
    Encircle,
    /// Si corre affiancati al bersaglio, lo si supera e gli si taglia la strada.
    Shadow,
    /// Accerchiati: fuori dal varco piu' largo, col boost, prima che si chiuda.
    Breakout,
    /// Spirale difensiva: ci si avvolge su se stessi finche' il pericolo passa.
    Coil,
}

/// Settori della mappa angolare attorno alla testa.
const ARCS: usize = 32;

/// Le strategie degli avversari scriptati. Ognuna e' una persona diversa contro cui
/// l'agente deve saper vincere: chi raccoglie, chi caccia, chi aspetta il bottino
/// altrui, chi cerca il frontale, chi finge il cashout, chi scappa, chi spinge al muro.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Mixed,
    Farmer,
    Hunter,
    Vulture,
    Rammer,
    Baiter,
    Coward,
    Pinner,
    Circler,
    Shadow,
    /// Nessuno schema: tattica e personalita' cambiano di continuo, mescolando le altre.
    Wild,
}

impl Style {
    pub const ALL: [Style; 11] = [Style::Mixed, Style::Farmer, Style::Hunter, Style::Vulture, Style::Rammer, Style::Baiter, Style::Coward, Style::Pinner,
                                  Style::Circler, Style::Shadow, Style::Wild];

    pub fn parse(s: &str) -> Style {
        match s {
            "raccoglitore" | "farmer" => Style::Farmer,
            "cacciatore" | "hunter" => Style::Hunter,
            "avvoltoio" | "vulture" => Style::Vulture,
            "ariete" | "rammer" => Style::Rammer,
            "esca" | "baiter" => Style::Baiter,
            "codardo" | "coward" => Style::Coward,
            "spingitore" | "pinner" => Style::Pinner,
            "accerchiatore" | "circler" => Style::Circler,
            "affiancatore" | "shadow" => Style::Shadow,
            "imprevedibile" | "wild" => Style::Wild,
            _ => Style::Mixed,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Style::Mixed => "misto", Style::Farmer => "raccoglitore", Style::Hunter => "cacciatore",
            Style::Vulture => "avvoltoio", Style::Rammer => "ariete", Style::Baiter => "esca",
            Style::Coward => "codardo", Style::Pinner => "spingitore",
            Style::Circler => "accerchiatore", Style::Shadow => "affiancatore", Style::Wild => "imprevedibile",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Brain {
    pub style: Style,
    pub skill: f64,
    pub aggression: f64,
    pub greed: f64,
    pub caution: f64,
    pub boost_tendency: f64,
    /// Incassa quando il saldo arriva a questo multiplo della posta.
    pub cash_goal: f64,
    /// Dopo quanti secondi di gioco si accontenta di meno (pazienza).
    pub patience_s: f64,
    pub reaction_ticks: u32,
    pub horizon: usize,
    pub next_decision: u64,
    pub tactic: Tactic,
    pub tactic_until: u64,
    pub target: Option<u64>,
    pub wander: (f64, f64),
    pub out_dir: f64,
    pub out_boost: bool,
    pub out_cash: bool,
    pub wants_exit: bool,
    /// Verso dell'accerchiamento (+1 antiorario, −1 orario).
    pub orbit: f64,
    /// Le tecniche dei bot forti (spento solo per misurarne il valore).
    pub pro: bool,
    /// Tick di orizzonte in piu' per i bot forti.
    pub horizon_pro: usize,
    /// Margine di sicurezza (u) oltre l'hitbox nelle traiettorie simulate dei bot forti.
    pub margin: f64,
    /// Accerchiamento opportunista di chi e' molto piu' lungo della preda.
    pub encircle: bool,
}

impl Brain {
    pub fn new(skill: f64, rng: &mut Rng) -> Brain {
        let skill = skill.clamp(0.0, 1.0);
        Brain {
            style: Style::Mixed,
            skill,
            aggression: rng.range(0.1, 1.0),
            greed: rng.range(0.2, 1.0),
            caution: rng.range(0.2, 1.0),
            // Sul server i giocatori vivi hanno il boost acceso un terzo del tempo.
            boost_tendency: rng.range(0.55, 1.0),
            cash_goal: if rng.chance(0.25) { rng.range(1.1, 1.4) } else { rng.range(1.4, 3.5) },
            patience_s: rng.range(30.0, 240.0),
            // 270 ms a abilita' zero, 110 ms a abilita' uno (in tick a ~61,7 Hz).
            reaction_ticks: (17.0 - 10.0 * skill + rng.range(-2.0, 2.0)).round().max(5.0) as u32,
            horizon: (24.0 + 26.0 * skill) as usize,
            next_decision: 0,
            tactic: Tactic::Farm,
            tactic_until: 0,
            target: None,
            wander: (0.0, 0.0),
            out_dir: 0.0,
            out_boost: false,
            out_cash: false,
            wants_exit: false,
            orbit: 1.0,
            pro: true,
            horizon_pro: 16,
            margin: 12.0,
            encircle: true,
        }
    }

    /// Un bot con una strategia precisa: la personalita' viene dallo stile, la
    /// precisione (riflessi, orizzonte, rumore) dall'abilita'.
    pub fn with_style(style: Style, skill: f64, rng: &mut Rng) -> Brain {
        let mut b = Brain::new(skill, rng);
        b.style = style;
        match style {
            Style::Mixed => {}
            Style::Farmer => { b.aggression = rng.range(0.0, 0.15); b.greed = rng.range(0.6, 1.0); b.caution = rng.range(0.5, 1.0); b.cash_goal = rng.range(1.1, 1.6); }
            Style::Hunter => { b.aggression = rng.range(0.8, 1.0); b.greed = rng.range(0.5, 1.0); b.caution = rng.range(0.1, 0.5); b.cash_goal = rng.range(1.8, 3.5); b.boost_tendency = rng.range(0.7, 1.0); }
            Style::Vulture => { b.aggression = rng.range(0.2, 0.5); b.greed = 1.0; b.caution = rng.range(0.3, 0.7); b.cash_goal = rng.range(1.4, 2.5); }
            Style::Rammer => { b.aggression = rng.range(0.6, 1.0); b.caution = rng.range(0.2, 0.5); b.cash_goal = rng.range(1.5, 3.0); }
            Style::Baiter => { b.aggression = rng.range(0.6, 0.9); b.caution = rng.range(0.3, 0.6); b.cash_goal = rng.range(1.5, 3.0); }
            Style::Coward => { b.aggression = 0.0; b.greed = rng.range(0.3, 0.7); b.caution = 1.0; b.cash_goal = rng.range(1.1, 1.3); b.patience_s = rng.range(20.0, 90.0); }
            Style::Pinner => { b.aggression = rng.range(0.7, 1.0); b.caution = rng.range(0.2, 0.5); b.cash_goal = rng.range(1.5, 3.0); }
            Style::Circler => { b.aggression = rng.range(0.7, 1.0); b.caution = rng.range(0.3, 0.6); b.cash_goal = rng.range(1.6, 3.0); }
            Style::Shadow => { b.aggression = rng.range(0.7, 1.0); b.caution = rng.range(0.2, 0.5); b.cash_goal = rng.range(1.5, 3.0); b.boost_tendency = rng.range(0.7, 1.0); }
            Style::Wild => {}
        }
        b
    }

    /// Decide (se e' il momento) e restituisce l'input da mandare: (direzione, boost, cashout).
    pub fn think(&mut self, w: &World, me_i: usize, rng: &mut Rng) -> Option<(f64, bool, bool)> {
        if w.tick < self.next_decision { return None; }
        let jitter = rng.range(0.8, 1.25);
        self.next_decision = w.tick + (self.reaction_ticks as f64 * jitter).round().max(3.0) as u64;
        let me = &w.players[me_i];
        if !me.alive { return None; }
        if self.style == Style::Wild && rng.chance(0.01) {
            // ~ogni 15 s un'altra persona: chi lo osserva non puo' contare su un'abitudine.
            self.aggression = rng.range(0.0, 1.0);
            self.greed = rng.range(0.2, 1.0);
            self.caution = rng.range(0.1, 1.0);
            self.boost_tendency = rng.range(0.3, 1.0);
        }
        let p = &w.p;
        let s = &me.snake;
        // Quanto vede una persona: lo schermo a zoom 1 copre circa ±700 unita'.
        let view = Perception::gather(w, me_i, 650.0, self.pro);
        let r_safe = safe_radius(w, self.pro);
        // Lo strato di sicurezza: muro da rispettare, orizzonte (i forti guardano piu'
        // lontano) e margine attorno ai corpi.
        let safety = Safety {
            r: r_safe,
            horizon: self.horizon + if self.pro { self.horizon_pro } else { 0 },
            margin: if self.pro { self.margin } else { 6.0 },
        };

        // --- scelta della tattica ------------------------------------------------
        let threat = view.threat(me, p);
        let age_s = (w.time_ms - me.joined_ms) / 1000.0;
        // Col passare del tempo ci si accontenta: prima la meta' del guadagno sperato,
        // poi anche solo di non perdere (le partite vere durano pochi minuti).
        let goal = if age_s > 2.0 * self.patience_s { 1.0 } else if age_s > self.patience_s { (1.0 + (self.cash_goal - 1.0) * 0.5).max(1.12) } else { self.cash_goal };
        let rich = me.balance >= goal * me.buy_in || (self.wants_exit && me.balance >= 1.12 * me.buy_in);
        let crowd = view.nearest_enemy_head;
        let escape_at = if self.style == Style::Coward { 0.25 } else { 0.5 };
        if self.tactic == Tactic::Bait && me.cashing_out {
            // L'esca: si tiene la carica finche' il cacciatore non e' vicino, poi si
            // interrompe e gli si taglia la strada.
            if let Some((uid, d)) = view.nearest_head() {
                if d < 230.0 { self.tactic = Tactic::Hunt; self.target = Some(uid); self.tactic_until = w.tick + 90; }
            }
            if me.cashout_progress > 0.8 { self.tactic = Tactic::Hunt; }
        } else if me.cashing_out {
            // Si interrompe se qualcuno arriva: perdere la carica costa meno che morire.
            let danger = crowd < 260.0 + 300.0 * self.caution;
            self.tactic = if danger && me.cashout_progress < 0.9 { Tactic::Escape } else { Tactic::Cashout };
        } else if self.pro && (view.enc_single > 0.56 || view.enc_all > 0.62) && rng.chance(0.3 + 0.7 * self.skill) {
            // Il trucco che distingue i bot forti: accorgersi della trappola prima che si chiuda.
            self.tactic = Tactic::Breakout;
            self.tactic_until = w.tick + 30;
        } else if threat > escape_at && !(self.style == Style::Rammer && view.can_ram(me)) {
            // Lungo e minacciato da piu' parti: la spirale protegge meglio della fuga.
            let coil = self.pro && s_len(me) > 900.0 && view.heads_within(450.0) >= 2 && rng.chance(self.caution * self.skill);
            self.tactic = if coil { Tactic::Coil } else { Tactic::Escape };
            self.tactic_until = w.tick + if coil { 120 } else { 40 };
        } else if self.tactic == Tactic::Coil && w.tick < self.tactic_until && view.heads_within(500.0) > 0 {
            // La spirale si tiene finche' qualcuno ronza attorno.
        } else if rich && crowd > 450.0 + 500.0 * self.caution
            && (!self.pro || self.skill < 0.6 || view.cashout_lane_clear(me, p, r_safe)) {
            self.tactic = Tactic::Cashout;
        } else if w.tick >= self.tactic_until || self.tactic == Tactic::Cashout || self.tactic == Tactic::Escape {
            let gold_near = view.best_gold.is_some_and(|g| g.2 < 700.0);
            let prey = if self.style == Style::Coward || self.style == Style::Farmer { None } else { view.prey(me, self.aggression) };
            let approaching = view.nearest_head().filter(|&(_, d)| d < 550.0);
            let long_enough = s_len(me) > 260.0;
            self.tactic = if self.style == Style::Wild {
                // Una tattica qualsiasi fra quelle possibili adesso, senza preferenze di stile.
                let prey = view.prey(me, 1.0);
                let mut opts = vec![Tactic::Farm, Tactic::Wander];
                if gold_near { opts.push(Tactic::Loot); opts.push(Tactic::Loot); }
                if prey.is_some() { opts.extend([Tactic::Hunt, Tactic::Shadow, Tactic::Pin]); }
                if prey.is_some() && long_enough { opts.push(Tactic::Encircle); }
                if prey.is_some() && view.can_ram(me) { opts.push(Tactic::Ram); }
                if approaching.is_some() { opts.push(Tactic::Bait); }
                if view.fight_spot(me).is_some() { opts.push(Tactic::Vulture); }
                self.target = prey;
                self.orbit = if rng.chance(0.5) { 1.0 } else { -1.0 };
                opts[rng.below(opts.len())]
            } else if gold_near && rng.chance(0.5 + 0.5 * self.greed) {
                Tactic::Loot
            } else if self.style == Style::Vulture && view.fight_spot(me).is_some() {
                Tactic::Vulture
            } else if self.style == Style::Baiter && approaching.is_some() && rng.chance(0.6) {
                Tactic::Bait
            } else if let Some(t) = prey.filter(|_| self.style == Style::Rammer && view.can_ram(me) && rng.chance(0.8)) {
                self.target = Some(t);
                Tactic::Ram
            } else if let Some(t) = prey.filter(|uid| self.style == Style::Pinner && w.player(*uid).is_some_and(|q| q.snake.x.hypot(q.snake.y) > 0.55 * w.r)) {
                self.target = Some(t);
                Tactic::Pin
            } else if let Some(t) = prey.filter(|uid| self.style == Style::Circler && long_enough && w.player(*uid).is_some_and(|q| q.snake.size < me.snake.size * 1.1)) {
                self.target = Some(t);
                // Si gira dal lato verso cui il bersaglio sta gia' curvando: lo si chiude prima.
                self.orbit = w.player(t).map(|q| {
                    let (dx, dy) = (me.snake.x - q.snake.x, me.snake.y - q.snake.y);
                    if q.snake.angle.cos() * dy - q.snake.angle.sin() * dx > 0.0 { 1.0 } else { -1.0 }
                }).unwrap_or(1.0);
                Tactic::Encircle
            } else if let Some(t) = prey.filter(|_| self.style == Style::Shadow) {
                self.target = Some(t);
                Tactic::Shadow
            } else if let Some(t) = prey.filter(|uid| self.pro && self.encircle && long_enough && s_len(me) > 500.0
                && w.player(*uid).is_some_and(|q| q.snake.size < me.snake.size * 0.6) && rng.chance(self.aggression * 0.6)) {
                // Molto piu' lungo della preda: la si chiude, non la si insegue.
                self.target = Some(t);
                self.orbit = w.player(t).map(|q| {
                    let (dx, dy) = (me.snake.x - q.snake.x, me.snake.y - q.snake.y);
                    if q.snake.angle.cos() * dy - q.snake.angle.sin() * dx > 0.0 { 1.0 } else { -1.0 }
                }).unwrap_or(1.0);
                Tactic::Encircle
            } else if let Some(t) = prey.filter(|_| rng.chance(self.aggression * (0.4 + 0.6 * self.skill))) {
                self.target = Some(t);
                Tactic::Hunt
            } else if view.best_food.is_some() {
                Tactic::Farm
            } else {
                Tactic::Wander
            };
            self.tactic_until = w.tick + rng.range(30.0, 150.0) as u64;
        }

        // --- direzione desiderata dalla tattica --------------------------------------
        let mut boost = false;
        let mut cash = false;
        let mut goal_dir = s.angle;
        match self.tactic {
            Tactic::Cashout => {
                cash = true;
                goal_dir = s.angle;
            }
            Tactic::Escape => {
                goal_dir = view.escape_dir.unwrap_or(s.angle);
                boost = threat > 0.7 && s.size > 45.0 && rng.chance(self.boost_tendency + 0.3);
            }
            Tactic::Loot => {
                if let Some((x, y, d, _)) = view.best_gold {
                    goal_dir = (y - s.y).atan2(x - s.x);
                    boost = d > 120.0 && s.size > 45.0 && rng.chance(self.boost_tendency);
                }
            }
            Tactic::Hunt => {
                if let Some(t) = self.target.and_then(|uid| w.player(uid)).filter(|t| t.alive) {
                    let ts = &t.snake;
                    let d = (ts.x - s.x).hypot(ts.y - s.y);
                    let tv = p.base_step + (p.boost_step - p.base_step) * ts.boost_amount;
                    let (hx, hy) = (ts.angle.cos(), ts.angle.sin());
                    let (rx, ry) = (s.x - ts.x, s.y - ts.y);
                    let along = rx * hx + ry * hy;
                    let lateral = (-hy * rx + hx * ry).abs();
                    if !self.pro {
                        let lead = 18.0 + 30.0 * self.skill + 0.08 * d;
                        let (ax, ay) = (ts.x + hx * tv * lead, ts.y + hy * tv * lead);
                        goal_dir = (ay - s.y).atan2(ax - s.x);
                        boost = d < 420.0 && d > 90.0 && s.size > 50.0 && rng.chance(self.boost_tendency * self.aggression + 0.15);
                    } else if along > 0.0 && lateral < 60.0 + 2.0 * s.thickness {
                        // Gia' davanti alla sua testa: si attraversa la sua strada, col corpo come muro.
                        let side = (-hy * rx + hx * ry).signum();
                        goal_dir = ts.angle - side * PI / 2.0;
                        boost = s.size > 50.0 && rng.chance(0.5 + 0.5 * self.skill);
                    } else if let Some((ix, iy, need_boost)) = intercept(s.x, s.y, ts, tv, p, 12.0 + 12.0 * self.skill) {
                        // Il punto della sua strada in cui arrivo prima di lui, con margine.
                        goal_dir = (iy - s.y).atan2(ix - s.x);
                        boost = need_boost && s.size > 50.0 && rng.chance(self.boost_tendency * (0.5 + 0.5 * self.skill));
                    } else {
                        // Irraggiungibile adesso: lo si segue di lato, pronti al taglio.
                        let lead = 18.0 + 30.0 * self.skill + 0.08 * d;
                        let (ax, ay) = (ts.x + hx * tv * lead, ts.y + hy * tv * lead);
                        goal_dir = (ay - s.y).atan2(ax - s.x);
                        boost = d < 420.0 && d > 90.0 && s.size > 50.0 && rng.chance(self.boost_tendency * self.aggression + 0.15);
                    }
                } else {
                    self.tactic = Tactic::Farm;
                }
            }
            Tactic::Breakout => {
                goal_dir = view.best_gap(s.angle);
                boost = s.size > 45.0;
            }
            Tactic::Coil => {
                // Verso la propria coda: il corpo diventa un anello chiuso attorno alla testa.
                let n = s.num_segments.min(p.max_segments_listed);
                let k = n.saturating_sub(1 + n / 12);
                let tail = s.ring(k, p);
                goal_dir = (tail[1] - s.y).atan2(tail[0] - s.x);
            }
            Tactic::Farm => {
                if let Some((x, y, d)) = view.best_food {
                    goal_dir = (y - s.y).atan2(x - s.x);
                    // Le persone danno colpi di boost anche solo per arrivare prima al cibo.
                    boost = d > 100.0 && s.size > 45.0 && rng.chance(self.boost_tendency * 0.6);
                }
            }
            Tactic::Bait => {
                // Carica finta: sterzo bloccato come in un cashout vero.
                cash = true;
                goal_dir = s.angle;
            }
            Tactic::Ram => {
                if let Some(t) = self.target.and_then(|uid| w.player(uid)).filter(|t| t.alive && t.snake.size < s.size) {
                    // Si punta la TESTA: nel frontale vince il piu' grande.
                    goal_dir = (t.snake.y - s.y).atan2(t.snake.x - s.x);
                    let d = (t.snake.x - s.x).hypot(t.snake.y - s.y);
                    boost = d < 320.0 && rng.chance(0.7);
                } else {
                    self.tactic = Tactic::Farm;
                }
            }
            Tactic::Pin => {
                if let Some(t) = self.target.and_then(|uid| w.player(uid)).filter(|t| t.alive) {
                    // Dal lato del centro, appena dentro al bersaglio: gli resta solo il muro.
                    let ts = &t.snake;
                    let rr = ts.x.hypot(ts.y).max(1.0);
                    let inner = (rr - 160.0).max(0.0) / rr;
                    let (gx, gy) = (ts.x * inner + ts.angle.cos() * 60.0, ts.y * inner + ts.angle.sin() * 60.0);
                    let d = (gx - s.x).hypot(gy - s.y);
                    goal_dir = if d > 90.0 { (gy - s.y).atan2(gx - s.x) } else {
                        // Arrivati in posizione: si stringe verso l'esterno davanti a lui.
                        let (ax, ay) = (ts.x + ts.angle.cos() * 120.0, ts.y + ts.angle.sin() * 120.0);
                        (ay - s.y).atan2(ax - s.x)
                    };
                    boost = d > 150.0 && s.size > 50.0 && rng.chance(self.boost_tendency);
                } else {
                    self.tactic = Tactic::Farm;
                }
            }
            Tactic::Vulture => {
                if let Some((x, y)) = view.fight_spot(me) {
                    // A distanza di sicurezza dal combattimento, pronto a prendere il bottino.
                    let d = (x - s.x).hypot(y - s.y);
                    goal_dir = if d > 260.0 { (y - s.y).atan2(x - s.x) } else { s.angle + 1.2 };
                    boost = d > 500.0 && rng.chance(self.boost_tendency * 0.5);
                } else {
                    self.tactic = Tactic::Farm;
                }
            }
            Tactic::Encircle => {
                if let Some(t) = self.target.and_then(|uid| w.player(uid)).filter(|t| t.alive) {
                    let ts = &t.snake;
                    let (dx, dy) = (s.x - ts.x, s.y - ts.y);
                    let d = dx.hypot(dy);
                    // Il cerchio che il proprio corpo riesce a chiudere, mai addosso al bersaglio.
                    let r_goal = (s_len(me) / TAU * 0.8).min(d * 0.92).max(ts.thickness * 3.0 + 45.0);
                    let a2 = dy.atan2(dx) + self.orbit * 0.7;
                    let (gx, gy) = (ts.x + a2.cos() * r_goal, ts.y + a2.sin() * r_goal);
                    goal_dir = (gy - s.y).atan2(gx - s.x);
                    boost = d < 450.0 && s.size > 60.0 && rng.chance(self.boost_tendency * 0.6);
                } else {
                    self.tactic = Tactic::Farm;
                }
            }
            Tactic::Shadow => {
                if let Some(t) = self.target.and_then(|uid| w.player(uid)).filter(|t| t.alive) {
                    let ts = &t.snake;
                    let (hx, hy) = (ts.angle.cos(), ts.angle.sin());
                    let (rx, ry) = (s.x - ts.x, s.y - ts.y);
                    let along = rx * hx + ry * hy;              // quanto sono davanti alla sua testa
                    let side = (-hy * rx + hx * ry).signum();    // da che parte sto
                    if along > 50.0 + 50.0 * self.skill {
                        // Abbastanza avanti: si sterza dentro la sua strada.
                        let (gx, gy) = (ts.x + hx * (along + 90.0), ts.y + hy * (along + 90.0));
                        goal_dir = (gy - s.y).atan2(gx - s.x);
                        boost = rng.chance(self.boost_tendency);
                    } else {
                        let off = (ts.thickness + s.thickness) * 2.5 + 25.0;
                        let fwd = along.max(0.0) + 140.0;
                        let (gx, gy) = (ts.x + hx * fwd - hy * side * off, ts.y + hy * fwd + hx * side * off);
                        goal_dir = (gy - s.y).atan2(gx - s.x);
                        boost = s.size > 50.0 && rng.chance(self.boost_tendency * 0.8);
                    }
                } else {
                    self.tactic = Tactic::Farm;
                }
            }
            Tactic::Wander => {
                if dist2(self.wander.0, self.wander.1, s.x, s.y) < 120.0 * 120.0 || (self.wander.0 == 0.0 && self.wander.1 == 0.0) {
                    let a = rng.f64() * TAU;
                    let d = rng.f64().sqrt() * w.r * 0.7;
                    self.wander = (a.cos() * d, a.sin() * d);
                }
                goal_dir = (self.wander.1 - s.y).atan2(self.wander.0 - s.x);
                boost = s.size > 60.0 && rng.chance(self.boost_tendency * 0.3);
            }
        }

        // --- strato di sicurezza --------------------------------------------------------
        let dir = if cash {
            // In carica lo sterzo e' bloccato: resta solo da decidere se rinunciare.
            if view.straight_danger(me, p, &safety) { cash = false; self.tactic = Tactic::Escape; view.safest(me, p, &safety, goal_dir, self.caution) } else { goal_dir }
        } else if self.tactic == Tactic::Ram {
            // L'ariete accetta il contatto di testa: la sicurezza guarda solo corpi e muro.
            view.safest_ignoring_heads(me, p, &safety, goal_dir)
        } else {
            view.safest(me, p, &safety, goal_dir, self.caution)
        };
        // Il boost si da' solo se la strada regge anche a quella velocita'.
        if boost && self.pro && view.trajectory_risk(me, p, &safety, dir, p.boost_step) > 0.0 { boost = false; }
        let noise = rng.normal() * 0.25 * (1.0 - self.skill);
        self.out_dir = normalize(dir + noise);
        self.out_boost = boost;
        self.out_cash = cash;
        Some((self.out_dir, self.out_boost, self.out_cash))
    }
}

/// Il muro con cui fare i conti: si stringe di 100 u a ogni morte (in ~1 s). Chi gioca
/// bene lo sa e tiene il margine di una morte in piu'; il bersaglio del raggio si
/// ricava dal numero di vivi, che il client vede.
fn safe_radius(w: &World, pro: bool) -> f64 {
    let alive = w.players.iter().filter(|q| q.alive).count().max(1) as f64;
    let target = w.p.arena_base + w.p.arena_per_snake * (alive - 1.0);
    if pro { w.r.min(target) - w.p.arena_per_snake } else { w.r }
}

/// Lunghezza del corpo (anelli ogni 6,4 u).
fn s_len(me: &Player) -> f64 { me.snake.num_segments as f64 * 6.4 }

/// Cio' che il bot vede attorno a se'.
struct Perception {
    /// Punti dei corpi altrui (x, y, raggio di collisione per la mia testa).
    obstacles: Vec<(f64, f64, f64)>,
    /// Teste altrui: x, y, angolo, passo, taglia, uid.
    heads: Vec<(f64, f64, f64, f64, f64, u64)>,
    best_food: Option<(f64, f64, f64)>,
    best_gold: Option<(f64, f64, f64, f64)>,
    nearest_enemy_head: f64,
    escape_dir: Option<f64>,
    me: (f64, f64),
    /// Distanza del corpo altrui piu' vicino in ogni settore attorno alla testa (angoli mondo).
    arcs: [f64; ARCS],
    /// Frazione dei settori chiusa entro il raggio d'accerchiamento da UN serpente / da tutti.
    enc_single: f64,
    enc_all: f64,
    enc_r: f64,
    pro: bool,
    r: f64,
}

/// I parametri dello strato di sicurezza per una decisione.
#[derive(Clone, Copy)]
struct Safety {
    /// Raggio del muro da rispettare (vedi `safe_radius`).
    r: f64,
    /// Tick simulati in avanti.
    horizon: usize,
    /// Margine (u) oltre l'hitbox attorno ai corpi altrui.
    margin: f64,
}

/// Settore (angolo mondo) di un punto visto dalla testa.
fn arc_of(dx: f64, dy: f64) -> usize {
    (((dy.atan2(dx) + TAU) % TAU) / TAU * ARCS as f64) as usize % ARCS
}

/// Taglio di strada: il primo punto della strada del bersaglio `ts` (che avanza di
/// `tv` per tick lungo la sua rotta) in cui, partendo da (x, y), arrivo con `margin`
/// tick di anticipo. → (punto, serve il boost).
fn intercept(x: f64, y: f64, ts: &crate::snake::Snake, tv: f64, p: &Params, margin: f64) -> Option<(f64, f64, bool)> {
    let (hx, hy) = (ts.angle.cos(), ts.angle.sin());
    for boost in [false, true] {
        let v = if boost { p.boost_step } else { p.base_step };
        for t in (6..=150).step_by(3) {
            let (px, py) = (ts.x + hx * tv * t as f64, ts.y + hy * tv * t as f64);
            let mine = (px - x).hypot(py - y) / v;
            if mine + margin < t as f64 { return Some((px, py, boost)); }
        }
    }
    None
}

impl Perception {
    fn gather(w: &World, me_i: usize, range: f64, pro: bool) -> Perception {
        let p = &w.p;
        let me = &w.players[me_i];
        let s = &me.snake;
        let head_r = s.thickness * p.hitbox_base * p.hitbox_scale * p.head_hitbox_scale;
        let mut obstacles = Vec::with_capacity(256);
        let mut heads = Vec::new();
        let mut nearest = f64::INFINITY;
        let mut away = (0.0, 0.0);
        let r2 = range * range;
        let mut arcs = [f64::INFINITY; ARCS];
        // ~20 spessori, come enCircleDistanceMult dei bot open source.
        let enc_r = (s.thickness * 20.0).clamp(220.0, 600.0);
        let mut enc_single: f64 = 0.0;
        for (j, o) in w.players.iter().enumerate() {
            if j == me_i || !o.alive { continue; }
            let os = &o.snake;
            let dh = dist2(os.x, os.y, s.x, s.y);
            let body_len = os.num_segments as f64 * 6.4;
            if dh > (range + body_len) * (range + body_len) { continue; }
            nearest = nearest.min(dh.sqrt());
            let rad = head_r + os.thickness * p.hitbox_base * p.hitbox_scale;
            let mut closed = [false; ARCS];
            for k in 0..os.num_segments.min(p.max_segments_listed) {
                let pt = os.ring(k, p);
                let d2 = dist2(pt[0], pt[1], s.x, s.y);
                if d2 >= r2 { continue; }
                if k >= 2 { obstacles.push((pt[0], pt[1], rad)); }
                let a = arc_of(pt[0] - s.x, pt[1] - s.y);
                let free = d2.sqrt() - rad;
                if free < arcs[a] { arcs[a] = free; }
                if free < enc_r { closed[a] = true; }
            }
            enc_single = enc_single.max(closed.iter().filter(|c| **c).count() as f64 / ARCS as f64);
            let step = p.base_step + (p.boost_step - p.base_step) * os.boost_amount;
            heads.push((os.x, os.y, os.angle, step, os.size, o.uid));
            let d = dh.sqrt().max(1.0);
            let wgt = 1.0 / (d * d);
            away.0 += (s.x - os.x) / d * wgt;
            away.1 += (s.y - os.y) / d * wgt;
        }
        let mut best_food = None;
        let mut best_gold = None;
        let (mut bf, mut bg) = (0.0, 0.0);
        let wall2 = (safe_radius(w, pro) - 60.0).max(0.0).powi(2);
        // Cibo a grappoli (celle da 80 u): conta la massa raggiungibile, non il pellet.
        let mut clusters: Vec<(i32, i32, f64, f64, f64)> = Vec::new();
        for f in &w.foods {
            if f.x * f.x + f.y * f.y > wall2 { continue; }
            let d2 = dist2(f.x, f.y, s.x, s.y);
            if d2 > r2 { continue; }
            let d = d2.sqrt();
            // Preferenza per cio' che sta davanti: girarsi costa tempo.
            let ahead = ((f.y - s.y).atan2(f.x - s.x) - s.angle).cos() * 0.5 + 1.0;
            if f.gold {
                let sc = f.value / me.buy_in.max(0.01) * 400.0 * ahead / (d + 60.0);
                if sc > bg { bg = sc; best_gold = Some((f.x, f.y, d, f.value)); }
            } else if !pro {
                let sc = ahead / (d + 40.0);
                if sc > bf { bf = sc; best_food = Some((f.x, f.y, d)); }
            } else {
                let key = ((f.x / 80.0).floor() as i32, (f.y / 80.0).floor() as i32);
                match clusters.iter_mut().find(|c| c.0 == key.0 && c.1 == key.1) {
                    Some(c) => { c.2 += 1.0; c.3 += f.x; c.4 += f.y; }
                    None => clusters.push((key.0, key.1, 1.0, f.x, f.y)),
                }
            }
        }
        for &(_, _, m, sx, sy) in &clusters {
            let (cx, cy) = (sx / m, sy / m);
            let d = (cx - s.x).hypot(cy - s.y);
            let ahead = ((cy - s.y).atan2(cx - s.x) - s.angle).cos() * 0.5 + 1.0;
            let sc = m.powf(1.5) * ahead / (d + 40.0);
            if sc > bf { bf = sc; best_food = Some((cx, cy, d)); }
        }
        let escape_dir = if away.0 != 0.0 || away.1 != 0.0 { Some(away.1.atan2(away.0)) } else { None };
        let enc_all = arcs.iter().filter(|d| **d < enc_r).count() as f64 / ARCS as f64;
        Perception { obstacles, heads, best_food, best_gold, nearest_enemy_head: nearest, escape_dir, me: (s.x, s.y), arcs, enc_single, enc_all, enc_r, pro, r: w.r }
    }

    /// Il centro del tratto libero piu' largo attorno alla testa (a parita', il piu'
    /// vicino alla direzione attuale): la via d'uscita da un accerchiamento.
    fn best_gap(&self, heading: f64) -> f64 {
        let clear = |k: usize| self.arcs[k % ARCS] > self.enc_r * 1.5;
        let (mut best_len, mut best_mid, mut best_score) = (0usize, None, f64::NEG_INFINITY);
        for start in 0..ARCS {
            if !clear(start) || clear(start + ARCS - 1) { continue; }    // inizio di un tratto libero
            let mut len = 0;
            while len < ARCS && clear(start + len) { len += 1; }
            let mid = (start as f64 + len as f64 / 2.0) / ARCS as f64 * TAU;
            let score = len as f64 + 0.5 * (normalize(mid - heading)).cos();
            if score > best_score { best_score = score; best_len = len; best_mid = Some(mid); }
        }
        if best_len == ARCS || (best_mid.is_none() && clear(0)) { return heading; }
        best_mid.unwrap_or_else(|| {
            // Nessun tratto libero: il settore col corpo piu' lontano.
            let k = (0..ARCS).max_by(|&a, &b| self.arcs[a].total_cmp(&self.arcs[b])).unwrap_or(0);
            (k as f64 + 0.5) / ARCS as f64 * TAU
        })
    }

    /// Teste altrui entro `d`.
    fn heads_within(&self, d: f64) -> usize {
        self.heads.iter().filter(|h| (h.0 - self.me.0).hypot(h.1 - self.me.1) < d).count()
    }

    /// Il cashout blocca lo sterzo per 3 s e rallenta fino a fermarsi: serve un
    /// corridoio dritto libero (~650 u) e nessuna testa che possa arrivarci prima.
    fn cashout_lane_clear(&self, me: &Player, p: &Params, r: f64) -> bool {
        let s = &me.snake;
        let ticks = (p.cashout_hold_ms / p.tick_ms()) as usize;
        let (c, sn) = (s.angle.cos(), s.angle.sin());
        let (mut x, mut y) = (s.x, s.y);
        let margin = s.thickness * 2.5 + 20.0;
        for t in 0..ticks {
            let f = t as f64 / ticks as f64;
            let step = p.base_step * (1.0 - p.cashout_slow_m * f.powf(p.cashout_slow_p)).max(0.0);
            x += c * step;
            y += sn * step;
            if t % 6 != 0 { continue; }
            if (x * x + y * y).sqrt() + s.thickness * p.wall_head_factor + 20.0 > r { return false; }
            if self.obstacles.iter().any(|o| dist2(x, y, o.0, o.1) < (o.2 + margin) * (o.2 + margin)) { return false; }
            // Una testa che col boost arriva sul corridoio prima di me.
            for &(hx, hy, _, _, _, _) in &self.heads {
                if (hx - x).hypot(hy - y) < p.boost_step * t as f64 + 60.0 { return false; }
            }
        }
        true
    }

    /// Pericolo immediato in [0, 1]: una testa nemica che punta verso di me ed e' vicina.
    fn threat(&self, me: &Player, p: &Params) -> f64 {
        let s = &me.snake;
        let mut t: f64 = 0.0;
        for &(x, y, a, step, size, _) in &self.heads {
            let d = (x - s.x).hypot(y - s.y);
            let toward = ((s.y - y).atan2(s.x - x) - a).cos();
            let reach = step * 40.0;
            if d < reach && toward > 0.6 {
                let w = (1.0 - d / reach) * toward * if size >= s.size { 1.0 } else { 0.7 };
                t = t.max(w);
            }
        }
        let _ = p;
        t.min(1.0)
    }

    /// Un bersaglio da cacciare: vicino, non troppo piu' grande, e con un saldo che valga la pena.
    fn prey(&self, me: &Player, aggression: f64) -> Option<u64> {
        let s = &me.snake;
        let mut best = None;
        let mut bs = 0.0;
        for &(x, y, _, _, size, uid) in &self.heads {
            let d = (x - s.x).hypot(y - s.y);
            if d > 650.0 || s.num_segments < 14 { continue; }
            let mut sc = (1.0 - d / 650.0) * (1.0 + aggression) * if size < s.size * 1.6 { 1.0 } else { 0.3 };
            if self.pro {
                // Prede isolate (nessun terzo che si prenda il bottino o tagli me) e gia'
                // schiacciate contro il muro, dove hanno meno vie di fuga.
                let others = self.heads.iter().filter(|h| h.5 != uid && (h.0 - x).hypot(h.1 - y) < 350.0).count();
                sc *= 0.5f64.powi(others as i32);
                if x.hypot(y) > 0.75 * self.r { sc *= 1.5; }
            }
            if sc > bs { bs = sc; best = Some(uid); }
        }
        best
    }

    /// Simula una traiettoria verso `heading` a passo `step` per `horizon` tick e ne
    /// misura il rischio: 0 se libera, altrimenti 1 (corpo o muro) o 0,8 (testa) piu'
    /// l'urgenza (quanto presto si muore).
    fn trajectory_risk(&self, me: &Player, p: &Params, sf: &Safety, heading: f64, step: f64) -> f64 {
        let s = &me.snake;
        let (r, horizon) = (sf.r, sf.horizon);
        let (mut x, mut y, mut a) = (s.x, s.y, s.angle);
        let wall_k = s.thickness * p.wall_head_factor;
        let reach = horizon as f64 * step + 60.0;
        let near: Vec<&(f64, f64, f64)> = self.obstacles.iter().filter(|o| dist2(o.0, o.1, x, y) < reach * reach).collect();
        for t in 1..=horizon {
            let diff = normalize(heading - a);
            a = normalize(a + diff.signum() * diff.abs().min(p.max_turn));
            let (c, sn) = (a.cos(), a.sin());
            x += c * step;
            y += sn * step;
            if t % 2 != 0 && t != horizon { continue; }
            let urgency = 1.0 - (t as f64 - 1.0) / horizon as f64;
            if (x * x + y * y).sqrt() + wall_k + 8.0 > r { return 1.0 + urgency; }
            for &&(ox, oy, rad) in &near {
                let m = rad + sf.margin;
                if dist2(x, y, ox, oy) < m * m { return 1.0 + urgency; }
            }
            for &(hx, hy, ha, hs, _, _) in &self.heads {
                // Dritta o in curva: una testa puo' girare mentre io arrivo.
                let m = s.thickness * 2.6 + 10.0;
                let bends: &[f64] = if self.pro { &[0.0, 0.5, -0.5] } else { &[0.0] };
                for &bend in bends {
                    let a = ha + bend * (t as f64 * p.max_turn).min(1.2);
                    let (px, py) = (hx + a.cos() * hs * t as f64, hy + a.sin() * hs * t as f64);
                    if dist2(x, y, px, py) < m * m { return 0.8 + urgency; }
                }
            }
        }
        0.0
    }

    /// La direzione piu' vicina a quella desiderata fra quelle sicure (i prudenti
    /// guardano un po' piu' avanti e provano piu' direzioni).
    fn safest(&self, me: &Player, p: &Params, sf: &Safety, goal: f64, caution: f64) -> f64 {
        let s = &me.snake;
        let step = p.base_step + (p.boost_step - p.base_step) * s.boost_amount;
        let sf = Safety { horizon: sf.horizon + (caution * 12.0) as usize, ..*sf };
        let mut best = goal;
        let mut best_score = f64::NEG_INFINITY;
        let n = if caution > 0.0 && self.pro { 32 } else { 16 };
        let candidates = std::iter::once(goal).chain((0..n).map(|k| s.angle + (k as f64 / n as f64) * TAU - PI));
        for c in candidates {
            let risk = self.trajectory_risk(me, p, &sf, c, step);
            let align = (normalize(c - goal)).cos();
            let center = if (s.x * s.x + s.y * s.y).sqrt() > sf.r * 0.8 { ((-s.y).atan2(-s.x) - c).cos() * 0.4 } else { 0.0 };
            let score = -risk * 10.0 + align + center;
            if score > best_score { best_score = score; best = c; }
        }
        best
    }

    /// La testa nemica piu' vicina: (uid, distanza).
    fn nearest_head(&self) -> Option<(u64, f64)> {
        let mut best: Option<(u64, f64)> = None;
        for &(x, y, _, _, _, uid) in &self.heads {
            let d = (x - self.me.0).hypot(y - self.me.1);
            if best.is_none_or(|b| d < b.1) { best = Some((uid, d)); }
        }
        best
    }

    /// Posso vincere un frontale? Basta essere piu' grande del piu' vicino.
    fn can_ram(&self, me: &Player) -> bool {
        self.heads.iter().filter(|h| (h.0 - self.me.0).hypot(h.1 - self.me.1) < 500.0).all(|h| h.4 < me.snake.size * 0.9)
            && self.heads.iter().any(|h| (h.0 - self.me.0).hypot(h.1 - self.me.1) < 500.0)
    }

    /// Il punto medio fra due teste altrui vicine fra loro: li' sta per esserci bottino.
    fn fight_spot(&self, me: &Player) -> Option<(f64, f64)> {
        let _ = me;
        for (i, a) in self.heads.iter().enumerate() {
            for b in &self.heads[i + 1..] {
                if (a.0 - b.0).hypot(a.1 - b.1) < 320.0 { return Some(((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0)); }
            }
        }
        None
    }

    fn safest_ignoring_heads(&self, me: &Player, p: &Params, sf: &Safety, goal: f64) -> f64 {
        let no_heads = Perception { obstacles: self.obstacles.clone(), heads: Vec::new(), best_food: None, best_gold: None, nearest_enemy_head: self.nearest_enemy_head,
                                    escape_dir: None, me: self.me, arcs: self.arcs, enc_single: self.enc_single, enc_all: self.enc_all, enc_r: self.enc_r, pro: self.pro, r: self.r };
        no_heads.safest(me, p, sf, goal, 0.0)
    }

    /// Andando dritti (cashout: sterzo bloccato) si muore entro l'orizzonte?
    fn straight_danger(&self, me: &Player, p: &Params, sf: &Safety) -> bool {
        let s = &me.snake;
        self.trajectory_risk(me, p, sf, s.angle, p.base_step * 0.6) > 0.0
            || self.heads.iter().any(|&(x, y, a, _, _, _)| (x - s.x).hypot(y - s.y) < 300.0 && ((s.y - y).atan2(s.x - x) - a).cos() > 0.5)
    }
}
