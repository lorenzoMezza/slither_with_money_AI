//! Osservazione dell'agente, costruita SOLO dallo snapshot che il client riceve
//! (gia' quantizzato, gia' in ritardo), mai dallo stato interno del simulatore. Lo
//! stesso codice gira identico sugli snapshot del server vero (`push_json`): e' la
//! garanzia che l'agente non impari a sfruttare cio' che online non vedrebbe.
//!
//! Tutto e' EGOCENTRICO (asse x = direzione della testa, y = sinistra) e diviso in
//! blocchi pensati per il tipo di rete che li legge:
//!
//!   se stesso   40 numeri: stato proprio, cinematica (velocita', sterzata con segno), budget e
//!               costo del boost, muro che sta per stringersi, minacce piu' vicine, economia della
//!               lobby (nessun orologio di partita: la fine in addestramento non va prevista)
//!   raggi       32 direzioni × 4 canali (muro, corpo, testa piu' grande, testa piu' piccola), fino a 1000 u
//!   avversari   8 entita' × 36: posizione (anche prevista fra 0,5 s), rotta, velocita', sterzata,
//!               taglia, saldo, minacce reciproche,
//!               e il DOSSIER: le abitudini di quel giocatore su ~20 s (boost, mira verso di
//!               me, inseguimenti, guadagni, uccisioni, cashout finti, sterzate, vicinanza).
//!               E' memoria a lungo termine calcolata dagli snapshot, quindi vale anche online:
//!               la GRU non deve ricordarsi da sola chi ha fatto cosa mezzo minuto fa.
//!   oro         8 entita' × 5: posizione, distanza, valore (nessun timer: online la
//!               scadenza del bottino non si conosce)
//!   cibo        16 settori × 2: densita' e distanza del piu' vicino
//!   griglia     6 canali × 32 × 32 celle da 20 u attorno alla testa: corpi, teste, cibo,
//!               oro, fuori dal muro, il proprio corpo
//!   mappa       gli stessi 6 canali × 24 × 24 celle da 200 u: ±2400 u, praticamente tutta
//!               l'arena (lo snapshot vero contiene tutto il mondo, corpi interi compresi)
//!
//! I blocchi «entita'» vanno letti da un codificatore di insiemi (attenzione), i raggi
//! da una convoluzione circolare, la griglia da una CNN: `layout()` li descrive.

use crate::snapshot::{PlayerView, Snapshot};
use std::collections::HashMap;
use std::sync::Arc;

pub const SELF_N: usize = 40;
pub const RAYS: usize = 32;
pub const RAY_CH: usize = 4;
pub const ENEMIES: usize = 8;
pub const ENEMY_N: usize = 36;
/// Gli 8 ori piu' vicini (erano 16): un bottino e' un mucchio, gli orb oltre l'ottavo
/// stanno nello stesso mucchio, e la massa d'oro per zona e' gia' nella griglia e nella
/// mappa. Ogni token in meno nel transformer e' calcolo risparmiato a ogni passo.
pub const GOLDS: usize = 8;
pub const GOLD_N: usize = 5;
pub const SECTORS: usize = 16;
pub const SECTOR_N: usize = 2;
pub const GRID: usize = 32;
pub const GRID_CH: usize = 6;
pub const GRID_CELL: f64 = 20.0;
pub const MAP: usize = 24;
pub const MAP_CH: usize = 6;
pub const MAP_CELL: f64 = 200.0;

pub const OFF_SELF: usize = 0;
pub const OFF_RAYS: usize = OFF_SELF + SELF_N;
pub const OFF_ENEMIES: usize = OFF_RAYS + RAYS * RAY_CH;
pub const OFF_GOLD: usize = OFF_ENEMIES + ENEMIES * ENEMY_N;
pub const OFF_SECTORS: usize = OFF_GOLD + GOLDS * GOLD_N;
pub const OFF_GRID: usize = OFF_SECTORS + SECTORS * SECTOR_N;
pub const OFF_MAP: usize = OFF_GRID + GRID_CH * GRID * GRID;
pub const OBS_SIZE: usize = OFF_MAP + MAP_CH * MAP * MAP;

const RAY_RANGE: f64 = 1000.0;
const VIEW: f64 = 1000.0;
const FOOD_RANGE: f64 = 1200.0;
const TICK_MS: f64 = 1000.0 / 60.0;
/// Fattori delle hitbox (client, coerenti col server): testa 1,19947·t, corpo 1,0165·t.
const HEAD_K: f64 = 1.19947;
const BODY_K: f64 = 1.0165;
/// Costante di tempo delle medie del dossier, secondi.
const DOSSIER_S: f64 = 20.0;

/// Le abitudini di un avversario, medie mobili su ~20 s di snapshot.
#[derive(Default, Clone)]
struct Dossier {
    boost: f64,
    aim: f64,
    chase: f64,
    gain: f64,
    kills: f64,
    aborts: f64,
    turn: f64,
    near: f64,
    last_bal: f64,
    gap: f64,
    was_cashing: bool,
    seen: bool,
}

#[derive(Default, Clone)]
pub struct Featurizer {
    prev: HashMap<Arc<str>, (f64, f64, f64)>,
    first_seen: HashMap<Arc<str>, i64>,
    dossier: HashMap<Arc<str>, Dossier>,
    prev_ts: Option<i64>,
    pub last_action: [f32; 3],
}

#[inline]
fn clamp(x: f64, lo: f64, hi: f64) -> f32 { x.clamp(lo, hi) as f32 }

impl Featurizer {
    pub fn new() -> Self { Self::default() }

    pub fn reset(&mut self) { *self = Self::default(); }

    /// Osservazione da uno snapshot JSON del server vero.
    pub fn push_json(&mut self, json: &str, my_id: &str, out: &mut [f32]) -> bool {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return false };
        let Some(s) = Snapshot::from_json(&v) else { return false };
        self.push(&s, my_id, out);
        true
    }

    pub fn push(&mut self, s: &Snapshot, my_id: &str, out: &mut [f32]) {
        assert!(out.len() >= OBS_SIZE);
        let o = &mut out[..OBS_SIZE];
        o.fill(0.0);
        let dt_ms = self.prev_ts.map(|p| (s.ts - p) as f64).filter(|d| *d > 0.0).unwrap_or(42.0);
        let dt_ticks = (dt_ms / TICK_MS).max(0.5);
        let Some(me) = s.player(my_id).filter(|m| m.alive) else {
            self.remember(s);
            return;
        };
        let (c, sn) = (me.angle.cos(), me.angle.sin());
        let rel = |x: f64, y: f64| -> (f64, f64) {
            let (dx, dy) = (x - me.hx, y - me.hy);
            (dx * c + dy * sn, -dx * sn + dy * c)
        };
        let buy = if me.buy_in > 0.0 { me.buy_in } else { 1.0 };
        let dist_c = me.hx.hypot(me.hy);
        let to_center = (-me.hy).atan2(-me.hx) - me.angle;
        // Cinematica propria dagli ultimi due snapshot: velocita' e sterzata (con segno).
        let (speed, turn_signed) = self.prev.get(&me.id)
            .map(|&(x, y, a)| ((me.hx - x).hypot(me.hy - y) / dt_ticks, crate::rng::normalize(me.angle - a) / dt_ticks))
            .unwrap_or((0.0, 0.0));
        let turn = turn_signed.abs();
        let enemies: Vec<&PlayerView> = s.players.iter().filter(|p| p.alive && p.id != me.id).collect();
        let r2 = s.r * s.r;
        let golds: Vec<_> = s.foods.iter().filter(|f| f.gold && f.x * f.x + f.y * f.y <= r2).collect();
        let gold_value: f64 = golds.iter().map(|f| f.value).sum();
        let richest = enemies.iter().map(|e| e.balance).fold(0.0, f64::max);
        let sum_bal: f64 = enemies.iter().map(|e| e.balance).sum();
        let rank = |f: &dyn Fn(&PlayerView) -> f64| -> f64 {
            if enemies.is_empty() { return 1.0; }
            enemies.iter().filter(|e| f(e) < f(me)).count() as f64 / enemies.len() as f64
        };

        // --- se stesso -------------------------------------------------------------------
        let x = &mut o[OFF_SELF..OFF_SELF + SELF_N];
        x[0] = 1.0;
        x[1] = clamp((me.size.max(1.0) / 100.0).ln(), -3.0, 4.0);
        x[2] = clamp(me.size / 1000.0, 0.0, 5.0);
        x[3] = (me.thickness / 20.0) as f32;
        x[4] = me.boost_amount as f32;
        x[5] = me.cashing_out as u8 as f32;
        x[6] = me.cashout_progress as f32;
        x[7] = clamp(me.balance / buy, 0.0, 10.0);
        x[8] = clamp((me.balance - buy) / buy, -1.0, 10.0);
        x[9] = (dist_c / s.r) as f32;
        x[10] = ((s.r - dist_c - me.thickness * 0.95) / s.r) as f32;
        x[11] = clamp((s.r - dist_c - me.thickness * 0.95) / 500.0, -1.0, 1.0);
        x[12] = to_center.cos() as f32;
        x[13] = to_center.sin() as f32;
        x[14] = (s.r / 2000.0) as f32;
        x[15] = s.players.iter().filter(|p| p.alive).count() as f32 / 10.0;
        x[16] = enemies.len() as f32 / 4.0;
        x[17] = (dt_ms / 50.0) as f32;
        x[18] = clamp(speed / 10.5, 0.0, 2.0);
        x[19] = clamp(turn / 0.135, 0.0, 2.0);
        x[20] = self.last_action[0];
        x[21] = self.last_action[1];
        x[22] = self.last_action[2];
        x[23] = (me.segs.len() as f64 / 50.0) as f32;
        // x[24] era il tempo dall'ingresso in partita (tolto: la fine della partita in
        // addestramento non va prevista). Ora: sterzata con segno (+ = a sinistra).
        x[24] = clamp(turn_signed / 0.135, -2.0, 2.0);
        x[25] = clamp(gold_value / buy, 0.0, 10.0);
        x[26] = golds.len() as f32 / 20.0;
        x[27] = clamp(richest / buy, 0.0, 10.0);
        x[28] = clamp(sum_bal / buy, 0.0, 20.0);
        x[29] = rank(&|p| p.size) as f32;
        x[30] = rank(&|p| p.balance) as f32;
        x[31] = 1.0;
        // Economia del boost (verita' del server): il boost costa il 10,8 % della taglia al
        // secondo, quindi la taglia cala come e^(−0,108·t). Secondi di boost che restano
        // prima della taglia minima 40, in decine di secondi.
        x[32] = clamp((me.size.max(40.0) / 40.0).ln() / 0.108 / 10.0, 0.0, 2.0);
        // Tetto della taglia legato al saldo, max(100, floor(saldo/posta·300)): quanto ne ho
        // gia' raggiunto (a 1 il cibo non fa piu' crescere).
        let cap = (me.balance / buy * 300.0).floor().max(100.0);
        x[33] = clamp(me.size / cap, 0.0, 1.0);
        // Il muro insegue 2000 + 100·(vivi − 1): se e' piu' largo del bersaglio sta per stringersi.
        let alive_n = s.players.iter().filter(|p| p.alive).count().max(1) as f64;
        let r_target = 2000.0 + 100.0 * (alive_n - 1.0);
        x[34] = clamp((r_target - s.r) / 500.0, -2.0, 2.0);
        // Le minacce piu' vicine, come scalari (il transformer le ha per entita', la MLP no).
        let nearest_head = enemies.iter().map(|e| (e.hx - me.hx).hypot(e.hy - me.hy)).fold(f64::INFINITY, f64::min);
        let nearest_body = enemies.iter().flat_map(|e| e.segs.iter().skip(2)).map(|g| (g[0] - me.hx).hypot(g[1] - me.hy)).fold(f64::INFINITY, f64::min);
        x[35] = clamp(nearest_head / 1000.0, 0.0, 2.0);
        x[36] = clamp(nearest_body / 1000.0, 0.0, 2.0);
        x[37] = enemies.iter().filter(|e| e.size >= me.size).count() as f32 / 4.0;
        // Quanto porterei a casa incassando adesso (commissione del 20 %), in profitto sulla posta.
        x[38] = clamp((0.8 * me.balance - buy) / buy, -1.0, 10.0);
        // Tempo minimo alla collisione con una testa (calcolato sotto, per entita').
        x[39] = 1.0;

        // --- raggi -----------------------------------------------------------------------
        let ray_dirs: [(f64, f64); RAYS] = std::array::from_fn(|k| {
            let a = k as f64 / RAYS as f64 * std::f64::consts::TAU;
            (a.cos(), a.sin())
        });
        let my_head_r = me.thickness * HEAD_K;
        for (k, &(rc, rs)) in ray_dirs.iter().enumerate() {
            let (dx, dy) = (rc * c - rs * sn, rc * sn + rs * c);
            let b = me.hx * dx + me.hy * dy;
            let disc = b * b - (dist_c * dist_c - s.r * s.r);
            let t = if disc >= 0.0 { (-b + disc.sqrt() - me.thickness * 0.95).max(0.0) } else { 0.0 };
            o[OFF_RAYS + k * RAY_CH] = (1.0 - (t / RAY_RANGE).clamp(0.0, 1.0)) as f32;
        }
        for e in &enemies {
            if (e.hx - me.hx).hypot(e.hy - me.hy) > RAY_RANGE + e.segs.len() as f64 * 6.4 + 60.0 { continue; }
            let body_r = e.thickness * BODY_K + my_head_r;
            let head_r = e.thickness * HEAD_K + my_head_r;
            let head_ch = if e.size >= me.size { 2 } else { 3 };
            let head = [e.hx, e.hy];
            let pts = e.segs.iter().skip(2).map(|g| (g, 1usize, body_r)).chain(std::iter::once((&head, head_ch, head_r)));
            for (g, ch, rad) in pts {
                let (px, py) = rel(g[0], g[1]);
                if px * px + py * py > (RAY_RANGE + rad) * (RAY_RANGE + rad) { continue; }
                for (k, &(rc, rs)) in ray_dirs.iter().enumerate() {
                    let t = px * rc + py * rs;
                    if t <= -rad { continue; }
                    let perp = (px * rs - py * rc).abs();
                    if perp > rad { continue; }
                    let hit = (t - (rad * rad - perp * perp).sqrt()).max(0.0);
                    let v = (1.0 - hit / RAY_RANGE).clamp(0.0, 1.0) as f32;
                    let idx = OFF_RAYS + k * RAY_CH + ch;
                    if v > o[idx] { o[idx] = v; }
                }
            }
        }

        self.update_dossiers(s, me, &enemies, dt_ms, dt_ticks);

        // --- avversari -------------------------------------------------------------------
        let mut ranked: Vec<(&PlayerView, f64)> = enemies.iter().map(|p| (*p, (p.hx - me.hx).hypot(p.hy - me.hy))).collect();
        ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
        for (slot, (e, d)) in ranked.iter().take(ENEMIES).enumerate() {
            let j = OFF_ENEMIES + slot * ENEMY_N;
            let (ex, ey) = rel(e.hx, e.hy);
            let (vx, vy) = self.prev.get(&e.id).map(|&(px, py, _)| ((e.hx - px) / dt_ticks, (e.hy - py) / dt_ticks)).unwrap_or((0.0, 0.0));
            let (rvx, rvy) = (vx * c + vy * sn, -vx * sn + vy * c);
            // Velocita' relativa: la mia, nel mio riferimento, e' (speed, 0).
            let closing = if *d > 1e-6 { -(ex * (rvx - speed) + ey * rvy) / d } else { 0.0 };
            let my_to_body = e.segs.iter().skip(2).map(|g| (g[0] - me.hx).hypot(g[1] - me.hy)).fold(f64::INFINITY, f64::min);
            let their_to_my_body = me.segs.iter().skip(2).map(|g| (g[0] - e.hx).hypot(g[1] - e.hy)).fold(f64::INFINITY, f64::min);
            let aim = if *d > 1e-6 { (e.angle.cos() * (me.hx - e.hx) + e.angle.sin() * (me.hy - e.hy)) / d } else { 0.0 };
            let ttc = if closing > 0.05 { (d / closing) / 100.0 } else { 1.0 };
            if (ttc as f32) < o[OFF_SELF + 39] { o[OFF_SELF + 39] = clamp(ttc, 0.0, 1.0); }
            // Velocita' ESATTA dal boostAmount (legge del server: 4,8 + 5,7·boost per tick) e
            // rotazione per tick dagli ultimi due snapshot (al massimo 0,135, la sterzata massima).
            let speed_e = 4.8 + 5.7 * e.boost_amount.clamp(0.0, 1.0);
            let turn_e = self.prev.get(&e.id)
                .map(|&(_, _, pa)| (crate::rng::normalize(e.angle - pa) / dt_ticks).clamp(-0.135, 0.135))
                .unwrap_or(0.0);
            // Dove sara' fra 12 tick (0,5 s) se mantiene velocita' e rotazione: la somma esatta
            // dei 12 passi del server (sterzata, poi passo), in forma chiusa.
            let (fwd, lat) = arc_displacement(speed_e, turn_e, 12.0);
            let (pwx, pwy) = (e.hx + e.angle.cos() * fwd - e.angle.sin() * lat, e.hy + e.angle.sin() * fwd + e.angle.cos() * lat);
            let (px12, py12) = rel(pwx, pwy);
            let edist = e.hx.hypot(e.hy);
            let age = self.first_seen.get(&e.id).map(|&t| (s.ts - t) as f64).unwrap_or(0.0);
            let ra = e.angle - me.angle;
            let z = &mut o[j..j + ENEMY_N];
            z[0] = 1.0;
            z[1] = (ex / VIEW) as f32;
            z[2] = (ey / VIEW) as f32;
            z[3] = (d / VIEW) as f32;
            z[4] = ra.cos() as f32;
            z[5] = ra.sin() as f32;
            z[6] = clamp((e.size.max(1.0) / 100.0).ln(), -3.0, 4.0);
            z[7] = clamp(e.size / me.size.max(1.0), 0.0, 4.0) / 4.0;
            z[8] = (e.thickness / 20.0) as f32;
            z[9] = e.boost_amount as f32;
            z[10] = e.boosting as u8 as f32;
            z[11] = e.cashing_out as u8 as f32;
            z[12] = e.cashout_progress as f32;
            z[13] = clamp(e.balance / buy, 0.0, 10.0);
            z[14] = clamp(rvx / 10.0, -2.0, 2.0);
            z[15] = clamp(rvy / 10.0, -2.0, 2.0);
            z[16] = clamp(closing / 10.0, -3.0, 3.0);
            z[17] = clamp(my_to_body / VIEW, 0.0, 2.0);
            z[18] = clamp(their_to_my_body / VIEW, 0.0, 2.0);
            z[19] = aim as f32;
            z[20] = clamp(ttc, 0.0, 1.0);
            z[21] = (e.segs.len() as f64 / 50.0) as f32;
            z[22] = ((s.r - edist) / s.r) as f32;
            z[23] = clamp(age / 10_000.0, 0.0, 1.0);
            if let Some(q) = self.dossier.get(&e.id) {
                z[24] = q.boost as f32;
                z[25] = clamp(q.aim, -1.0, 1.0);
                z[26] = clamp(q.chase / 5.0, -1.0, 1.0);
                z[27] = clamp(q.gain * 10.0, 0.0, 3.0);
                z[28] = (q.kills.ln_1p() / 2.0) as f32;
                z[29] = (q.aborts.ln_1p() / 2.0) as f32;
                z[30] = clamp(q.turn, 0.0, 2.0);
                z[31] = q.near as f32;
            }
            // Dove sara' fra mezzo secondo (arco di cerchio), nel mio riferimento di adesso.
            z[32] = (px12 / VIEW) as f32;
            z[33] = (py12 / VIEW) as f32;
            z[34] = clamp(speed_e / 10.5, 0.0, 2.0);
            z[35] = clamp(turn_e / 0.135, -1.0, 1.0);
        }

        // --- oro come entita' ------------------------------------------------------------
        let mut gl: Vec<(f64, f64, f64, f64)> = golds.iter().map(|f| {
            let (gx, gy) = rel(f.x, f.y);
            (gx, gy, gx.hypot(gy), f.value)
        }).collect();
        gl.sort_by(|a, b| a.2.total_cmp(&b.2));
        for (k, &(gx, gy, d, v)) in gl.iter().take(GOLDS).enumerate() {
            let z = &mut o[OFF_GOLD + k * GOLD_N..OFF_GOLD + (k + 1) * GOLD_N];
            z[0] = 1.0;
            z[1] = (gx / VIEW) as f32;
            z[2] = (gy / VIEW) as f32;
            z[3] = (d / VIEW) as f32;
            z[4] = clamp(v / buy, 0.0, 5.0);
        }

        // --- cibo per settori --------------------------------------------------------------
        let mut nearest = [FOOD_RANGE; SECTORS];
        for f in &s.foods {
            if f.gold || f.x * f.x + f.y * f.y > r2 { continue; }
            let (fx, fy) = rel(f.x, f.y);
            let d = fx.hypot(fy);
            if d > FOOD_RANGE { continue; }
            let sec = (((fy.atan2(fx) + std::f64::consts::TAU) % std::f64::consts::TAU) / std::f64::consts::TAU * SECTORS as f64) as usize % SECTORS;
            o[OFF_SECTORS + sec * SECTOR_N] += (1.0 / (1.0 + d / 150.0)) as f32;
            if d < nearest[sec] { nearest[sec] = d; }
        }
        for (sec, d) in nearest.iter().enumerate() { o[OFF_SECTORS + sec * SECTOR_N + 1] = (1.0 - d / FOOD_RANGE) as f32; }

        // --- griglia egocentrica -------------------------------------------------------------
        let half = GRID as f64 / 2.0;
        let cell = |px: f64, py: f64| -> Option<usize> {
            let (cx, cy) = (px / GRID_CELL + half, py / GRID_CELL + half);
            if cx < 0.0 || cy < 0.0 || cx >= GRID as f64 || cy >= GRID as f64 { return None; }
            Some(cy as usize * GRID + cx as usize)
        };
        let plane = |ch: usize| OFF_GRID + ch * GRID * GRID;
        let reach = GRID_CELL * half * std::f64::consts::SQRT_2 + 40.0;
        for e in &enemies {
            if (e.hx - me.hx).hypot(e.hy - me.hy) > reach + e.segs.len() as f64 * 6.4 { continue; }
            for g in &e.segs {
                let (px, py) = rel(g[0], g[1]);
                if let Some(i) = cell(px, py) { o[plane(0) + i] = 1.0; }
            }
            let (px, py) = rel(e.hx, e.hy);
            if let Some(i) = cell(px, py) { o[plane(1) + i] = clamp(e.size / me.size.max(1.0), 0.0, 4.0); }
        }
        for f in &s.foods {
            let (px, py) = rel(f.x, f.y);
            if let Some(i) = cell(px, py) {
                if f.gold { o[plane(3) + i] += clamp(f.value / buy, 0.0, 5.0); } else { o[plane(2) + i] += 1.0; }
            }
        }
        for g in me.segs.iter().skip(1) {
            let (px, py) = rel(g[0], g[1]);
            if let Some(i) = cell(px, py) { o[plane(5) + i] = 1.0; }
        }
        // Fuori dal muro: centro di ogni cella riportato in coordinate mondo.
        if dist_c + reach > s.r {
            for gy in 0..GRID {
                for gx in 0..GRID {
                    let (lx, ly) = ((gx as f64 + 0.5 - half) * GRID_CELL, (gy as f64 + 0.5 - half) * GRID_CELL);
                    let (wx, wy) = (me.hx + lx * c - ly * sn, me.hy + lx * sn + ly * c);
                    if wx * wx + wy * wy > r2 { o[plane(4) + gy * GRID + gx] = 1.0; }
                }
            }
        }
        // --- mappa larga ----------------------------------------------------------------------
        let mhalf = MAP as f64 / 2.0;
        let mcell = |px: f64, py: f64| -> Option<usize> {
            let (cx, cy) = (px / MAP_CELL + mhalf, py / MAP_CELL + mhalf);
            if cx < 0.0 || cy < 0.0 || cx >= MAP as f64 || cy >= MAP as f64 { return None; }
            Some(cy as usize * MAP + cx as usize)
        };
        let mplane = |ch: usize| OFF_MAP + ch * MAP * MAP;
        // Corpi come «quanto corpo c'e' nella cella» (anelli ogni 6,4 u, ~31 per cella piena).
        for e in &enemies {
            for g in &e.segs {
                let (px, py) = rel(g[0], g[1]);
                if let Some(i) = mcell(px, py) { o[mplane(0) + i] += 1.0 / 32.0; }
            }
            let (px, py) = rel(e.hx, e.hy);
            if let Some(i) = mcell(px, py) {
                let v = clamp(e.size / me.size.max(1.0), 0.0, 4.0);
                if v > o[mplane(1) + i] { o[mplane(1) + i] = v; }
            }
        }
        for f in &s.foods {
            if f.x * f.x + f.y * f.y > r2 { continue; }
            let (px, py) = rel(f.x, f.y);
            if let Some(i) = mcell(px, py) {
                if f.gold { o[mplane(3) + i] += clamp(f.value / buy, 0.0, 5.0); } else { o[mplane(2) + i] += 1.0; }
            }
        }
        for g in me.segs.iter().skip(1) {
            let (px, py) = rel(g[0], g[1]);
            if let Some(i) = mcell(px, py) { o[mplane(5) + i] += 1.0 / 32.0; }
        }
        for gy in 0..MAP {
            for gx in 0..MAP {
                let (lx, ly) = ((gx as f64 + 0.5 - mhalf) * MAP_CELL, (gy as f64 + 0.5 - mhalf) * MAP_CELL);
                let (wx, wy) = (me.hx + lx * c - ly * sn, me.hy + lx * sn + ly * c);
                // Frazione di cella fuori dal muro, sfumata sul bordo (una cella e' larga 200 u).
                let out = ((wx.hypot(wy) - s.r) / MAP_CELL + 0.5).clamp(0.0, 1.0);
                o[mplane(4) + gy * MAP + gx] = out as f32;
            }
        }
        self.remember(s);
    }

    /// Aggiorna le abitudini di ogni avversario vivo e attribuisce le uccisioni: chi
    /// sparisce senza essere in cashout e' morto, e l'ha ucciso il corpo piu' vicino
    /// alla sua ultima testa (se abbastanza vicino; altrimenti e' stato il muro).
    fn update_dossiers(&mut self, s: &Snapshot, me: &PlayerView, enemies: &[&PlayerView], dt_ms: f64, dt_ticks: f64) {
        let a = 1.0 - (-dt_ms / 1000.0 / DOSSIER_S).exp();
        let ema = |x: &mut f64, v: f64| *x += a * (v - *x);
        let gone: Vec<(f64, f64)> = self.prev.iter()
            .filter(|(id, _)| **id != me.id && !s.players.iter().any(|p| p.alive && p.id == **id))
            .filter(|(id, _)| !self.dossier.get(*id).is_some_and(|q| q.was_cashing))
            .map(|(_, &(x, y, _))| (x, y)).collect();
        for (vx, vy) in gone {
            let mut best: Option<(&Arc<str>, f64)> = None;
            for e in enemies {
                let d = e.segs.iter().map(|g| (g[0] - vx).hypot(g[1] - vy)).fold(f64::INFINITY, f64::min);
                if d < e.thickness * 1.5 + 60.0 && best.is_none_or(|b| d < b.1) { best = Some((&e.id, d)); }
            }
            if let Some((id, _)) = best { self.dossier.entry(id.clone()).or_default().kills += 1.0; }
        }
        for e in enemies {
            let prev = self.prev.get(&e.id).copied();
            let d_me = (e.hx - me.hx).hypot(e.hy - me.hy);
            // Il bersaglio piu' vicino di quel giocatore (io compreso): se ci si avvicina, insegue.
            let gap = s.players.iter().filter(|p| p.alive && p.id != e.id)
                .map(|p| (p.hx - e.hx).hypot(p.hy - e.hy)).fold(f64::INFINITY, f64::min);
            let q = self.dossier.entry(e.id.clone()).or_default();
            ema(&mut q.boost, e.boosting as u8 as f64);
            let aim = if d_me > 1e-6 { (e.angle.cos() * (me.hx - e.hx) + e.angle.sin() * (me.hy - e.hy)) / d_me } else { 0.0 };
            ema(&mut q.aim, aim * (1.0 - d_me / 1200.0).max(0.0));
            ema(&mut q.near, (1.0 - d_me / 1500.0).max(0.0));
            // Dal secondo snapshot in cui lo si vede: inseguimenti, guadagni, sterzate, cashout finti.
            if let Some((_, _, prev_angle)) = prev.filter(|_| q.seen) {
                if gap.is_finite() && q.gap.is_finite() && q.gap > 0.0 {
                    ema(&mut q.chase, ((q.gap - gap) / dt_ticks).clamp(-15.0, 15.0));
                }
                let buy = if e.buy_in > 0.0 { e.buy_in } else { 1.0 };
                ema(&mut q.gain, ((e.balance - q.last_bal).max(0.0) / buy) / (dt_ms / 1000.0).max(1e-3));
                ema(&mut q.turn, crate::rng::normalize(e.angle - prev_angle).abs() / dt_ticks / 0.135);
                if q.was_cashing && !e.cashing_out { q.aborts += 1.0; }
            }
            q.gap = gap;
            q.last_bal = e.balance;
            q.was_cashing = e.cashing_out;
            q.seen = true;
        }
    }

    fn remember(&mut self, s: &Snapshot) {
        self.prev.clear();
        for p in &s.players {
            if !p.alive { continue; }
            self.prev.insert(p.id.clone(), (p.hx, p.hy, p.angle));
            self.first_seen.entry(p.id.clone()).or_insert(s.ts);
        }
        self.prev_ts = Some(s.ts);
    }
}

/// Spostamento (avanti, a sinistra) di chi per `n` tick ruota di `w` rad e poi avanza di
/// `v`, nell'ordine del server (prima la sterzata, poi il passo lungo la nuova rotta).
/// E' la somma ESATTA dei passi discreti Σ_{k=1..n} v·(cos kw, sin kw), in forma chiusa:
/// modulo v·sin(nw/2)/sin(w/2), direzione (n+1)·w/2. Il limite continuo (arco di raggio
/// v/w) sbaglierebbe di mezza sterzata di fase (~3,5 u su 12 tick alla sterzata massima).
pub fn arc_displacement(v: f64, w: f64, n: f64) -> (f64, f64) {
    if w.abs() < 1e-9 { return (v * n, 0.0); }
    let r = v * (n * w / 2.0).sin() / (w / 2.0).sin();
    let a = (n + 1.0) * w / 2.0;
    (r * a.cos(), r * a.sin())
}

/// Struttura del vettore di osservazione, per chi costruisce la rete.
pub fn layout() -> serde_json::Value {
    serde_json::json!({
        "dimensione": OBS_SIZE,
        "se_stesso": {"inizio": OFF_SELF, "n": SELF_N},
        "raggi": {"inizio": OFF_RAYS, "raggi": RAYS, "canali": RAY_CH, "nomi": ["muro", "corpo", "testa piu' grande", "testa piu' piccola"], "ordine": "raggio-major"},
        "avversari": {"inizio": OFF_ENEMIES, "entita": ENEMIES, "n": ENEMY_N},
        "oro": {"inizio": OFF_GOLD, "entita": GOLDS, "n": GOLD_N},
        "cibo": {"inizio": OFF_SECTORS, "settori": SECTORS, "n": SECTOR_N},
        "griglia": {"inizio": OFF_GRID, "canali": GRID_CH, "lato": GRID, "cella": GRID_CELL,
                    "nomi": ["corpi nemici", "teste nemiche (taglia relativa)", "cibo", "oro (valore)", "fuori dal muro", "proprio corpo"]},
        "mappa": {"inizio": OFF_MAP, "canali": MAP_CH, "lato": MAP, "cella": MAP_CELL,
                  "nomi": ["corpi nemici (quantita')", "teste nemiche (taglia relativa)", "cibo", "oro (valore)", "fuori dal muro (frazione)", "proprio corpo (quantita')"]},
    })
}

#[cfg(test)]
mod tests {
    use super::arc_displacement;
    use crate::config::Params;
    use crate::snake::Snake;

    /// La previsione coincide con la fisica del server: un serpente che sterza per 12 tick
    /// finisce ESATTAMENTE dove dice la formula chiusa (solo errore di arrotondamento).
    #[test]
    fn previsione_ad_arco_come_il_server() {
        let p = Params::default();
        for &(boost, w) in &[(0.0, 0.135), (1.0, -0.135), (0.5, 0.05), (0.3, 0.001), (0.0, 0.0)] {
            let v = p.base_step + (p.boost_step - p.base_step) * boost;
            let mut s = Snake::new(100.0, 50.0, 0.7, 150.0, &p);
            let (x0, y0, a0) = (s.x, s.y, s.angle);
            for _ in 0..12 {
                s.angle = crate::rng::normalize(s.angle + w);     // sterzata costante per tick, come il server
                s.advance(v, &p);
            }
            let (fwd, lat) = arc_displacement(v, w, 12.0);
            let (px, py) = (x0 + a0.cos() * fwd - a0.sin() * lat, y0 + a0.sin() * fwd + a0.cos() * lat);
            let err = (px - s.x).hypot(py - s.y);
            assert!(err < 1e-6, "boost {boost} w {w}: errore {err:.3e} u");
        }
    }
}
