//! Validazione sulla realta': si prendono le sessioni registrate da `analizer` sul
//! server vero e si RIGIOCA il proprio serpente con la fisica del simulatore, dagli
//! stessi input che il client aveva mandato, con la latenza del modello di rete.
//!
//! Per ogni coppia di snapshot consecutivi (e su catene piu' lunghe, senza mai
//! riallinearsi) si confronta dove il simulatore mette la testa con dove il server
//! l'ha messa davvero. Il ritardo comando→server che spiega meglio i dati viene
//! cercato su una griglia: e' il numero che il modello di rete deve riprodurre.

use crate::config::Params;
use crate::rng::normalize;
use flate2::read::GzDecoder;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Clone, Copy, Debug)]
struct Own { x: f64, y: f64, angle: f64, ba: f64, size: f64, cashing: bool }

struct StateRec { m: f64, ts: i64, socket: u64, own: Option<Own> }

struct Input { m: f64, dir: f64, boost: bool }

pub struct Report { pub text: String, pub ok: bool }

fn quantile(v: &mut [f64], q: f64) -> f64 {
    if v.is_empty() { return f64::NAN; }
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() - 1) as f64 * q).round() as usize]
}

fn load(dir: &Path) -> Result<(Vec<StateRec>, Vec<Input>), String> {
    let f = File::open(dir.join("rete").join("frames.ndjson.gz")).map_err(|e| format!("{}: {e}", dir.display()))?;
    let rd = BufReader::new(GzDecoder::new(f));
    let mut states = Vec::new();
    let mut inputs = Vec::new();
    let mut my_id: Option<(u64, String)> = None;
    for line in rd.lines() {
        let Ok(line) = line else { break };
        let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if ev["k"] != "f" { continue; }
        let Some(p) = ev["p"].as_str() else { continue };
        let m = ev["m"].as_f64().map(|x| x * 1000.0).or_else(|| ev["w"].as_f64()).unwrap_or(0.0);
        let s = ev["s"].as_u64().unwrap_or(0);
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(p) else { continue };
        match (ev["d"].as_str(), msg["t"].as_str()) {
            (Some("o"), Some("input")) => inputs.push(Input { m, dir: msg["targetDir"].as_f64().unwrap_or(0.0), boost: msg["boost"].as_bool().unwrap_or(false) }),
            (Some("i"), Some("init")) => my_id = msg["id"].as_str().map(|x| (s, x.to_string())),
            (Some("i"), Some("state")) => {
                let own = my_id.as_ref().filter(|(sock, _)| *sock == s).and_then(|(_, id)| {
                    msg["players"].as_array()?.iter().find(|p| p["id"].as_str() == Some(id)).and_then(|p| {
                        if p["alive"].as_bool() != Some(true) { return None; }
                        Some(Own {
                            x: p["hx"].as_f64()?, y: p["hy"].as_f64()?, angle: p["angle"].as_f64()?,
                            ba: p["boostAmount"].as_f64().unwrap_or(0.0), size: p["size"].as_f64().unwrap_or(100.0),
                            cashing: p["cashingOut"].as_bool().unwrap_or(false),
                        })
                    })
                });
                states.push(StateRec { m, ts: msg["ts"].as_i64().unwrap_or(0), socket: s, own });
            }
            _ => {}
        }
    }
    Ok((states, inputs))
}

/// Simula `n` tick dalla posizione `o` con gli input arrivati entro il ritardo `lat_ms`.
fn simulate(o: Own, m_start: f64, n: usize, inputs: &[Input], lat_ms: f64, p: &Params) -> Own {
    let tick = p.tick_ms();
    let mut s = o;
    let mut idx = inputs.partition_point(|i| i.m <= m_start - 5000.0);
    let mut cur: Option<&Input> = None;
    for k in 1..=n {
        // Il server al tick k applica l'ultimo input arrivato: partito entro m_start + k·tick − ritardo.
        let limit = m_start + k as f64 * tick - lat_ms;
        while idx < inputs.len() && inputs[idx].m <= limit { cur = Some(&inputs[idx]); idx += 1; }
        if let Some(inp) = cur {
            let diff = normalize(inp.dir - s.angle);
            s.angle = normalize(s.angle + diff.signum() * diff.abs().min(p.max_turn));
            if inp.boost && s.size > p.min_size { s.ba = (s.ba + p.boost_ramp).min(1.0); } else { s.ba = (s.ba - p.boost_ramp).max(0.0); }
        } else {
            s.ba = (s.ba - p.boost_ramp).max(0.0);
        }
        let step = p.base_step + (p.boost_step - p.base_step) * s.ba;
        s.x += s.angle.cos() * step;
        s.y += s.angle.sin() * step;
    }
    s
}

/// Tick fra due snapshot. Il `ts` non basta (e' l'ora d'invio, da un timer diverso
/// da quello del tick): il numero vero e' quello che spiega lo spostamento, cercato fra
/// 1 e 4 con la fisica stessa. E' la sola libera scelta della validazione, ed e'
/// discreta: non puo' «aggiustare» un errore di fisica, solo il conteggio dei tick.
fn ticks_between(a: &StateRec, b: &StateRec, inputs: &[Input], lat: f64, p: &Params) -> usize {
    let (oa, ob) = (a.own.unwrap(), b.own.unwrap());
    (1..=4).min_by(|&x, &y| {
        let ex = { let s = simulate(oa, a.m, x, inputs, lat, p); (s.x - ob.x).hypot(s.y - ob.y) };
        let ey = { let s = simulate(oa, a.m, y, inputs, lat, p); (s.x - ob.x).hypot(s.y - ob.y) };
        ex.total_cmp(&ey)
    }).unwrap()
}

pub fn validate_sessions(dirs: &[&Path], p: &Params) -> Result<Report, String> {
    let mut all: Vec<(Vec<StateRec>, Vec<Input>)> = Vec::new();
    for d in dirs { all.push(load(d)?); }
    let ts_tick = 1000.0 / 60.0;
    // Coppie e catene di snapshot propri utilizzabili.
    let lats: Vec<f64> = (0..=24).map(|k| k as f64 * 5.0).collect();
    let mut best = (f64::INFINITY, 0.0);
    let mut per_lat = Vec::new();
    for &lat in &lats {
        let mut errs = Vec::new();
        for (states, inputs) in &all {
            for w in states.windows(2) {
                let (a, b) = (&w[0], &w[1]);
                let (Some(oa), Some(ob)) = (a.own, b.own) else { continue };
                if a.socket != b.socket || oa.cashing || ob.cashing { continue; }
                if b.ts - a.ts > 90 { continue; }
                let n = ticks_between(a, b, inputs, lat, p);
                let sim = simulate(oa, a.m, n, inputs, lat, p);
                errs.push((sim.x - ob.x).hypot(sim.y - ob.y));
            }
        }
        let med = quantile(&mut errs.clone(), 0.5);
        let mean = errs.iter().sum::<f64>() / errs.len().max(1) as f64;
        per_lat.push((lat, mean, med, errs.len()));
        if mean < best.0 { best = (mean, lat); }
    }
    let lat = best.1;

    // Statistiche complete al ritardo migliore: un intervallo, e catene da 10 e 25 snapshot.
    let mut pos1 = Vec::new(); let mut ang1 = Vec::new(); let mut ba_exact = 0usize; let mut n1 = 0usize; let mut ts_wrong = 0usize;
    let chain = |len: usize| -> Vec<f64> {
        let mut out = Vec::new();
        for (states, inputs) in &all {
            let mut i = 0;
            while i + len < states.len() {
                let seg = &states[i..=i + len];
                let ok = seg.iter().all(|s| s.own.is_some_and(|o| !o.cashing) && s.socket == seg[0].socket)
                    && seg.windows(2).all(|w| w[1].ts - w[0].ts <= 90);
                if ok {
                    // I tick di ogni intervallo si contano sulla traiettoria VERA; poi si
                    // simula tutta la catena senza mai riallinearsi alla posizione.
                    let mut o = seg[0].own.unwrap();
                    for w in seg.windows(2) {
                        let n = ticks_between(&w[0], &w[1], inputs, lat, p);
                        o = simulate(o, w[0].m, n, inputs, lat, p);
                    }
                    let last = seg[len].own.unwrap();
                    out.push((o.x - last.x).hypot(o.y - last.y));
                }
                i += len.max(1);
            }
        }
        out
    };
    for (states, inputs) in &all {
        for w in states.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            let (Some(oa), Some(ob)) = (a.own, b.own) else { continue };
            if a.socket != b.socket || oa.cashing || ob.cashing { continue; }
            if b.ts - a.ts > 90 { continue; }
            let n = ticks_between(a, b, inputs, lat, p);
            if n != ((b.ts - a.ts) as f64 / ts_tick).round() as usize { ts_wrong += 1; }
            let sim = simulate(oa, a.m, n, inputs, lat, p);
            pos1.push((sim.x - ob.x).hypot(sim.y - ob.y));
            ang1.push(normalize(sim.angle - ob.angle).abs());
            if (sim.ba - ob.ba).abs() < 1e-9 { ba_exact += 1; }
            n1 += 1;
        }
    }
    let mut c10 = chain(10);
    let mut c25 = chain(25);
    let within = |v: &[f64], t: f64| v.iter().filter(|&&x| x < t).count() as f64 / v.len().max(1) as f64 * 100.0;
    let mut t = String::new();
    use std::fmt::Write;
    let _ = writeln!(t, "\n  VALIDAZIONE SUL SERVER VERO — il tuo serpente rigiocato dai tuoi input\n");
    let _ = writeln!(t, "  intervalli fra snapshot confrontati: {n1} (tick contati dallo spostamento; il `ts` arrotondato a 60 Hz li avrebbe sbagliati nel {:.1} %)", ts_wrong as f64 / n1.max(1) as f64 * 100.0);
    let _ = writeln!(t, "  ritardo comando→server che spiega meglio i dati: {lat:.0} ms (modello di rete: {:.1} ms + jitter)", p.uplink_ms + p.downlink_ms);
    let _ = writeln!(t, "\n  errore sulla posizione della testa dopo UNO snapshot (2–4 tick):");
    let _ = writeln!(t, "    mediana {:.4} u · p90 {:.4} · p99 {:.4} · max {:.3}", quantile(&mut pos1.clone(), 0.5), quantile(&mut pos1.clone(), 0.9), quantile(&mut pos1.clone(), 0.99), quantile(&mut pos1.clone(), 1.0));
    let _ = writeln!(t, "    entro 0,01 u: {:.1} % · entro 0,1 u: {:.1} % · entro 1 u: {:.1} %", within(&pos1, 0.01), within(&pos1, 0.1), within(&pos1, 1.0));
    let _ = writeln!(t, "    angolo: mediana {:.5} rad · p99 {:.5} rad   (l'angolo arriva arrotondato a 0,001)", quantile(&mut ang1.clone(), 0.5), quantile(&mut ang1.clone(), 0.99));
    let _ = writeln!(t, "    boostAmount identico al server: {:.1} %", ba_exact as f64 / n1.max(1) as f64 * 100.0);
    let _ = writeln!(t, "\n  senza mai riallinearsi, errore dopo una catena di snapshot:");
    let _ = writeln!(t, "    10 snapshot (~0,45 s): mediana {:.3} u · p90 {:.3} · n {}", quantile(&mut c10, 0.5), quantile(&mut c10.clone(), 0.9), c10.len());
    let _ = writeln!(t, "    25 snapshot (~1,1 s):  mediana {:.3} u · p90 {:.3} · n {}", quantile(&mut c25, 0.5), quantile(&mut c25.clone(), 0.9), c25.len());
    let _ = writeln!(t, "\n  errore medio per ritardo ipotizzato (ms → u):");
    let line: Vec<String> = per_lat.iter().filter(|x| (x.0 as i64) % 10 == 0).map(|(l, m, _, _)| format!("{l:.0}→{m:.3}")).collect();
    let _ = writeln!(t, "    {}", line.join("  "));
    let med = quantile(&mut pos1.clone(), 0.5);
    Ok(Report { text: t, ok: med < 0.05 })
}
