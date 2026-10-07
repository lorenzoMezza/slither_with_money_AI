//! Lo snapshot `state`, esattamente come lo manda il server.
//!
//! Stessi campi, stesso ordine, stessa QUANTIZZAZIONE misurata sul traffico:
//! `angle` a 3 decimali, `size` intera, coordinate del cibo a 1 decimale, il resto a
//! piena precisione. I morti e chi ha incassato restano in lista con `alive:false`
//! e `segs:[]`. Un agente che legge questo snapshot legge esattamente cio' che
//! leggerebbe sul server vero; `from_json` fa il percorso inverso sui dati reali.

use crate::config::Params;
use crate::snake::js_round;
use crate::world::World;
use std::borrow::Cow;
use std::fmt::Write;
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
pub struct FoodView {
    pub x: f64,
    pub y: f64,
    pub gold: bool,
    pub color: Cow<'static, str>,
    pub value: f64,
}

#[derive(Clone, Debug, Default)]
pub struct PlayerView {
    pub id: Arc<str>,
    pub name: Arc<str>,
    pub alive: bool,
    pub spectator: bool,
    pub boosting: bool,
    pub boost_amount: f64,
    pub cashing_out: bool,
    pub cashout_progress: f64,
    pub size: f64,
    pub balance: f64,
    pub buy_in: f64,
    pub color: Cow<'static, str>,
    pub level: u32,
    pub thickness: f64,
    pub hx: f64,
    pub hy: f64,
    pub angle: f64,
    pub segs: Vec<[f64; 2]>,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub ts: i64,
    /// Tick del server a cui lo snapshot e' stato preso (solo simulatore).
    pub tick: u64,
    pub r: f64,
    pub lobby: u32,
    pub foods: Vec<FoodView>,
    pub players: Vec<PlayerView>,
    pub lc: [u32; 3],
}

#[inline]
fn round_to(x: f64, decimals: i32) -> f64 {
    let m = 10f64.powi(decimals);
    js_round(x * m) / m
}

impl Snapshot {
    pub fn from_world(w: &World) -> Snapshot {
        let p: &Params = &w.p;
        let alive = w.alive_count() as u32;
        let lobby_index = match p.lobby { 10 => 1, 100 => 2, _ => 0 };
        let mut lc = [0u32; 3];
        lc[lobby_index] = alive;
        Snapshot {
            ts: w.ts(),
            tick: w.tick,
            r: w.r,
            lobby: p.lobby,
            foods: w.foods.iter().map(|f| FoodView {
                x: round_to(f.x, 1), y: round_to(f.y, 1), gold: f.gold, color: Cow::Borrowed(f.color), value: f.value,
            }).collect(),
            players: w.players.iter().map(|pl| {
                let s = &pl.snake;
                let segs = if pl.alive {
                    let n = s.num_segments.min(p.max_segments_listed);
                    (0..n).map(|i| s.ring(i, p)).collect()
                } else { Vec::new() };
                PlayerView {
                    id: pl.id.clone(),
                    name: pl.name.clone(),
                    alive: pl.alive,
                    spectator: pl.spectator,
                    boosting: pl.alive && pl.boosting,
                    boost_amount: s.boost_amount,
                    cashing_out: pl.cashing_out,
                    cashout_progress: pl.cashout_progress,
                    size: js_round(s.size),
                    balance: pl.balance,
                    buy_in: pl.buy_in,
                    color: Cow::Borrowed(pl.color),
                    level: pl.level,
                    thickness: s.thickness,
                    hx: s.x,
                    hy: s.y,
                    angle: round_to(s.angle, 3),
                    segs,
                }
            }).collect(),
            lc,
        }
    }

    pub fn player(&self, id: &str) -> Option<&PlayerView> { self.players.iter().find(|p| &*p.id == id) }

    /// Il messaggio JSON, identico a quello del server.
    pub fn to_json(&self) -> String {
        let mut s = String::with_capacity(4096 + self.foods.len() * 40 + self.players.len() * 900);
        let _ = write!(s, r#"{{"t":"state","ts":{},"world":{{"cx":0,"cy":0,"r":{}}},"lobby":{},"foods":["#, self.ts, num(self.r), self.lobby);
        for (i, f) in self.foods.iter().enumerate() {
            if i > 0 { s.push(','); }
            let _ = write!(s, r#"[{},{},"{}","{}",{}]"#, num(f.x), num(f.y), if f.gold { "gold" } else { "normal" }, f.color, num(f.value));
        }
        s.push_str(r#"],"players":["#);
        for (i, p) in self.players.iter().enumerate() {
            if i > 0 { s.push(','); }
            let _ = write!(
                s,
                r#"{{"id":"{}","name":{},"alive":{},"spectator":{},"boosting":{},"boostAmount":{},"cashingOut":{},"cashoutProgress":{},"size":{},"balance":{},"buyIn":{},"color":"{}","skinImage":null,"boostColor":null,"eyeColor":null,"eyeStyle":null,"chainImage":null,"level":{},"thickness":{},"hx":{},"hy":{},"angle":{},"bubble":"","emote":null,"bounty":false,"segs":["#,
                p.id, serde_json::to_string(&*p.name).unwrap_or_else(|_| "\"\"".into()), p.alive, p.spectator, p.boosting, num(p.boost_amount), p.cashing_out,
                num(p.cashout_progress), num(p.size), num(p.balance), num(p.buy_in), p.color, p.level, num(p.thickness), num(p.hx), num(p.hy), num(p.angle)
            );
            for (k, g) in p.segs.iter().enumerate() {
                if k > 0 { s.push(','); }
                let _ = write!(s, "[{},{}]", num(g[0]), num(g[1]));
            }
            s.push_str("]}");
        }
        let _ = write!(s, r#"],"lc":[{},{},{}]}}"#, self.lc[0], self.lc[1], self.lc[2]);
        s
    }

    /// Lo snapshot da un messaggio `state` vero (o generato): serve a usare le stesse
    /// osservazioni sui dati registrati dal server.
    pub fn from_json(v: &serde_json::Value) -> Option<Snapshot> {
        if v["t"].as_str()? != "state" { return None; }
        let f = |x: &serde_json::Value| x.as_f64().unwrap_or(0.0);
        let foods = v["foods"].as_array().map(|a| a.iter().filter_map(|t| {
            let t = t.as_array()?;
            Some(FoodView {
                x: t.first().map(f)?, y: t.get(1).map(f)?,
                gold: t.get(2).and_then(|x| x.as_str()) == Some("gold"),
                color: Cow::Owned(t.get(3).and_then(|x| x.as_str()).unwrap_or("").to_string()),
                value: t.get(4).map(f).unwrap_or(0.0),
            })
        }).collect()).unwrap_or_default();
        let players = v["players"].as_array().map(|a| a.iter().map(|p| PlayerView {
            id: p["id"].as_str().unwrap_or("").into(),
            name: p["name"].as_str().unwrap_or("").into(),
            alive: p["alive"].as_bool().unwrap_or(false),
            spectator: p["spectator"].as_bool().unwrap_or(false),
            boosting: p["boosting"].as_bool().unwrap_or(false),
            boost_amount: f(&p["boostAmount"]),
            cashing_out: p["cashingOut"].as_bool().unwrap_or(false),
            cashout_progress: f(&p["cashoutProgress"]),
            size: f(&p["size"]),
            balance: f(&p["balance"]),
            buy_in: f(&p["buyIn"]),
            color: Cow::Owned(p["color"].as_str().unwrap_or("").to_string()),
            level: p["level"].as_u64().unwrap_or(1) as u32,
            thickness: f(&p["thickness"]),
            hx: f(&p["hx"]),
            hy: f(&p["hy"]),
            angle: f(&p["angle"]),
            segs: p["segs"].as_array().map(|g| g.iter().filter_map(|q| Some([q.get(0)?.as_f64()?, q.get(1)?.as_f64()?])).collect()).unwrap_or_default(),
        }).collect()).unwrap_or_default();
        let lcv = v["lc"].as_array();
        let lc = |i: usize| lcv.and_then(|a| a.get(i)).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        Some(Snapshot {
            ts: v["ts"].as_i64().unwrap_or(0),
            tick: 0,
            r: v["world"]["r"].as_f64().unwrap_or(2000.0),
            lobby: v["lobby"].as_u64().unwrap_or(1) as u32,
            foods,
            players,
            lc: [lc(0), lc(1), lc(2)],
        })
    }
}

/// Numero come lo scrive JSON.stringify: interi senza ".0", il resto nella forma piu' corta.
pub fn num(x: f64) -> String {
    if !x.is_finite() { return "null".into(); }
    if x == x.trunc() && x.abs() < 1e15 { return format!("{}", x as i64); }
    format!("{}", x)
}
