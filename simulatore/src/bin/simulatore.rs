//! simulatore — riga di comando.
//!
//!   simulatore vedi      [--porta 8080] [--bot 1-4] [--velocita 1] [--spettatore]   il gioco nel browser; ci puoi giocare
//!   simulatore valida    [--sessioni DIR...]                                          fisica rigiocata sulle sessioni vere
//!   simulatore registra  --secondi 300 --cartella DIR [--abilita 0.6-1.0]             partita simulata come sessione di analizer
//!   simulatore bench     [--mondi 64] [--secondi 10]                                  velocita' di simulazione
//!   simulatore parametri                                                              i parametri in uso
//!
//! Opzione comune: --analizer FILE per prendere da un estratto le grandezze che la fisica
//! vera non copre (tick, arena, RTT, orb di bottino per anello). Senza, si usano i default
//! di config.rs: identici su ogni macchina (Mac o RunPod), come l'addestramento.

use simulatore::bots::Brain;
use simulatore::config::{EnvConfig, Params};
use simulatore::env::{ActionMode, ACTION_SIZE, INFO_SIZE};
use simulatore::features::OBS_SIZE;
use simulatore::record::Recorder;
use simulatore::rng::Rng;
use simulatore::validate::validate_sessions;
use simulatore::vecenv::VecEnv;
use simulatore::viewer::{serve, ViewerHub};
use std::path::{Path, PathBuf};
use std::time::Instant;

struct Args(Vec<String>);

impl Args {
    fn flag(&self, k: &str) -> bool { self.0.iter().any(|a| a == k) }
    fn val(&self, k: &str) -> Option<&str> { self.0.iter().position(|a| a == k).and_then(|i| self.0.get(i + 1)).map(|s| s.as_str()) }
    fn num(&self, k: &str, d: f64) -> f64 { self.val(k).and_then(|v| v.parse().ok()).unwrap_or(d) }
    fn list(&self, k: &str) -> Vec<String> {
        let Some(i) = self.0.iter().position(|a| a == k) else { return vec![] };
        self.0[i + 1..].iter().take_while(|a| !a.starts_with("--")).cloned().collect()
    }
}

fn base_config(a: &Args) -> EnvConfig {
    let mut cfg = EnvConfig::default();
    let path = a.val("--analizer").map(String::from);
    if let Some(p) = path {
        match Params::from_analizer(&p) {
            Ok((params, used)) => {
                eprintln!("  parametri misurati da {p} ({} grandezze)", used.len());
                cfg.params = params;
            }
            Err(e) => eprintln!("  (estratto non leggibile, uso i default: {e})"),
        }
    }
    cfg.seed = a.num("--seme", 1.0) as u64;
    if let Some(s) = a.val("--abilita") {
        let mut it = s.split('-').filter_map(|x| x.parse::<f64>().ok());
        let lo = it.next().unwrap_or(0.3);
        cfg.lobby.skill = [lo, it.next().unwrap_or(lo)];
    }
    if let Some(b) = a.val("--bot") {
        let mut it = b.split('-').filter_map(|x| x.parse::<usize>().ok());
        let lo = it.next().unwrap_or(1);
        cfg.lobby.bots_min = lo;
        cfg.lobby.bots_max = it.next().unwrap_or(lo);
    }
    cfg
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let cmd = raw.first().cloned().unwrap_or_else(|| "vedi".into());
    let a = Args(raw);
    match cmd.as_str() {
        "vedi" | "--porta" | "--bot" => vedi(&a),
        "valida" => valida(&a),
        "registra" => registra(&a),
        "bench" => bench(&a),
        "parametri" => println!("{}", serde_json::to_string_pretty(&base_config(&a).params).unwrap()),
        _ => {
            eprintln!("comandi: vedi | valida | registra | bench | parametri");
            std::process::exit(1);
        }
    }
}

/// Il gioco nel browser, a tempo reale. Senza --spettatore il serpente e' tuo.
fn vedi(a: &Args) {
    let mut cfg = base_config(a);
    let spect = a.flag("--spettatore");
    cfg.agents_per_env = if spect { 0 } else { 1 };
    cfg.num_envs = 1;
    cfg.max_episode_s = 1e9;
    let mut v = VecEnv::new(cfg);
    v.set_action_mode(ActionMode::Absolute);
    let hub = ViewerHub::new();
    let addr = serve(hub.clone(), a.num("--porta", 8080.0) as u16).expect("porta occupata: usa --porta");
    v.envs[0].viewer = Some(hub.clone());
    println!("\n  simulatore → {addr}   ({})\n", if spect { "spettatore" } else { "giochi tu: mouse, clic/spazio, C tenuto" });
    let _ = std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" }).arg(&addr).spawn();
    let n = v.total_agents();
    let mut obs = vec![0f32; n.max(1) * OBS_SIZE];
    let mut info = vec![0f32; n.max(1) * INFO_SIZE];
    let mut rew = vec![0f32; n.max(1)];
    let mut done = vec![0u8; n.max(1)];
    v.reset(&mut obs, &mut info);
    v.set_realtime(a.num("--velocita", 1.0));
    let mut act = vec![0f32; n * ACTION_SIZE];
    let mut last_report = Instant::now();
    loop {
        if n > 0 {
            let h = hub.human();
            act[0] = h.dir as f32;
            act[1] = h.boost as u8 as f32;
            act[2] = h.cash as u8 as f32;
        }
        v.step(&act, &mut obs, &mut rew, &mut done, &mut info);
        if n > 0 && done[0] != 0 {
            let motivo = match info[0] as i32 { 1 => "morto", 2 => "incassato", 4 => "incassato a fine partita", _ => "fine" };
            println!("  episodio: {motivo} · profitto {:+.3} poste · {:.0} s", info[8], info[4]);
        }
        if last_report.elapsed().as_secs() >= 30 {
            last_report = Instant::now();
            let w = &v.envs[0].world;
            println!("  t {:.0} s · vivi {} · raggio {:.0} · cibo {}", w.time_ms / 1000.0, w.alive_count(), w.r, w.foods.len());
        }
    }
}

fn valida(a: &Args) {
    let cfg = base_config(a);
    let mut dirs: Vec<PathBuf> = a.list("--sessioni").into_iter().map(PathBuf::from).collect();
    if dirs.is_empty() {
        for root in ["../analizer/sessioni", "analizer/sessioni"] {
            if let Ok(rd) = std::fs::read_dir(root) {
                for e in rd.flatten() {
                    if e.path().join("rete/frames.ndjson.gz").exists() { dirs.push(e.path()); }
                }
                break;
            }
        }
    }
    dirs.sort();
    if dirs.is_empty() { eprintln!("nessuna sessione: usa --sessioni DIR..."); std::process::exit(1); }
    eprintln!("  sessioni: {}", dirs.iter().map(|d| d.file_name().unwrap().to_string_lossy().to_string()).collect::<Vec<_>>().join(", "));
    let refs: Vec<&Path> = dirs.iter().map(|d| d.as_path()).collect();
    match validate_sessions(&refs, &cfg.params) {
        Ok(r) => { println!("{}", r.text); std::process::exit(if r.ok { 0 } else { 2 }); }
        Err(e) => { eprintln!("errore: {e}"); std::process::exit(1); }
    }
}

/// Una partita simulata, vista dal client dell'agente (pilotato da un bot), scritta
/// come sessione di analizer: poi `node analizer.js analizza` la misura come il server vero.
fn registra(a: &Args) {
    let mut cfg = base_config(a);
    cfg.agents_per_env = 1;
    cfg.num_envs = 1;
    cfg.max_episode_s = 1e9;
    let secs = a.num("--secondi", 300.0);
    let dir = PathBuf::from(a.val("--cartella").unwrap_or("sessione-simulata"));
    let mut v = VecEnv::new(cfg);
    v.set_action_mode(ActionMode::Absolute);
    v.envs[0].recorder = Some(Recorder::create(&dir).expect("cartella non scrivibile"));
    let mut obs = vec![0f32; OBS_SIZE];
    let mut info = vec![0f32; INFO_SIZE];
    let (mut rew, mut done) = (vec![0f32; 1], vec![0u8; 1]);
    v.reset(&mut obs, &mut info);
    let mut rng = Rng::new(cfg_seed_for_brain(a));
    let skill = v.envs[0].cfg.lobby.skill;
    let mut brain = Brain::new(rng.range(skill[0], skill[1]), &mut rng);
    let mut act = [0f32; 3];
    let (mut deaths, mut cashouts) = (0, 0);
    let t0 = Instant::now();
    while v.envs[0].world.time_ms < secs * 1000.0 {
        let env = &v.envs[0];
        if let Some(i) = env.agents[0].uid.and_then(|u| env.world.index_of(u)) {
            if let Some((d, b, c)) = brain.think(&env.world, i, &mut rng) { act = [d as f32, b as u8 as f32, c as u8 as f32]; }
        }
        v.step(&act, &mut obs, &mut rew, &mut done, &mut info);
        if done[0] != 0 {
            if info[0] as i32 == 2 { cashouts += 1 } else { deaths += 1 }
            brain = Brain::new(rng.range(skill[0], skill[1]), &mut rng);
        }
    }
    let frames = v.envs[0].recorder.as_ref().map(|r| r.frames).unwrap_or(0);
    if let Some(mut r) = v.envs[0].recorder.take() { r.finish().unwrap(); }
    println!("  registrati {secs:.0} s di gioco in {:.1} s: {frames} frame, {deaths} morti, {cashouts} cashout → {}", t0.elapsed().as_secs_f64(), dir.display());
    println!("  misurala:  cd ../analizer && SESSIONS_DIR={} EXTRACT_DIR=<uscita> node analizer.js analizza", dir.parent().unwrap_or(Path::new(".")).display());
}

fn cfg_seed_for_brain(a: &Args) -> u64 { a.num("--seme", 1.0) as u64 * 7919 + 7 }

fn bench(a: &Args) {
    let mut cfg = base_config(a);
    cfg.num_envs = a.num("--mondi", 64.0) as usize;
    cfg.agents_per_env = 1;
    let secs = a.num("--secondi", 10.0);
    let mut v = VecEnv::new(cfg);
    let n = v.total_agents();
    let mut obs = vec![0f32; n * OBS_SIZE];
    let mut info = vec![0f32; n * INFO_SIZE];
    let (mut rew, mut done) = (vec![0f32; n], vec![0u8; n]);
    v.reset(&mut obs, &mut info);
    let mut rng = Rng::new(3);
    let mut act = vec![0f32; n * ACTION_SIZE];
    let t0 = Instant::now();
    let tick0: u64 = v.envs.iter().map(|e| e.world.tick).sum();
    let mut steps = 0u64;
    let mut eps = 0u64;
    while t0.elapsed().as_secs_f64() < secs {
        for k in 0..n {
            act[k * 3] = rng.range(-0.3, 0.3) as f32;
            act[k * 3 + 1] = rng.chance(0.1) as u8 as f32;
            act[k * 3 + 2] = 0.0;
        }
        v.step(&act, &mut obs, &mut rew, &mut done, &mut info);
        steps += n as u64;
        eps += done.iter().filter(|&&d| d != 0).count() as u64;
    }
    let el = t0.elapsed().as_secs_f64();
    let ticks: u64 = v.envs.iter().map(|e| e.world.tick).sum::<u64>() - tick0;
    let game_s = ticks as f64 / v.envs[0].p.tick_hz;
    println!("  {} mondi · {:.0} passi agente/s · {:.0} tick/s · {:.0}× il tempo reale · {} episodi", v.envs.len(), steps as f64 / el, ticks as f64 / el, game_s / el, eps);
}
