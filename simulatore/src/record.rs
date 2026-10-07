//! Registrazione di una partita simulata nel formato di sessione di `analizer`
//! (`rete/frames.ndjson.gz`), vista dal client dell'agente 0.
//!
//! Serve alla verifica piu' severa possibile: lo STESSO analizzatore che misura il
//! server vero misura il simulatore, e i due estratti si confrontano numero per
//! numero (`strumenti/confronta.mjs`). Un simulatore che si limita a «assomigliare»
//! non passa: deve produrre lo stesso traffico.

use crate::config::Params;
use crate::env::Down;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub struct Recorder {
    gz: Option<GzEncoder<BufWriter<File>>>,
    pub dir: PathBuf,
    epoch_ms: f64,
    pending_cashout: Option<f64>,
    next_ping_ms: f64,
    last_input: Option<(f64, String)>,
    pub frames: u64,
}

impl Recorder {
    pub fn create(dir: &Path) -> std::io::Result<Recorder> {
        fs::create_dir_all(dir.join("rete"))?;
        fs::create_dir_all(dir.join("runtime"))?;
        let f = File::create(dir.join("rete").join("frames.ndjson.gz"))?;
        let mut r = Recorder {
            gz: Some(GzEncoder::new(BufWriter::new(f), Compression::fast())),
            dir: dir.to_path_buf(),
            epoch_ms: 1_791_000_000_000.0,
            pending_cashout: None,
            next_ping_ms: 0.0,
            last_input: None,
            frames: 0,
        };
        let w = r.epoch_ms;
        r.raw(&format!(r#"{{"k":"ws","s":1,"url":"wss://simulatore.locale/","target":"page","w":{w}}}"#));
        fs::write(dir.join("meta.json"), r#"{"formato":1,"origine":"simulatore"}"#)?;
        Ok(r)
    }

    fn raw(&mut self, line: &str) {
        if let Some(gz) = self.gz.as_mut() {
            let _ = gz.write_all(line.as_bytes());
            let _ = gz.write_all(b"\n");
        }
    }

    fn frame(&mut self, dir: &str, t_ms: f64, payload: &str) {
        // Un cashout programmato parte appena l'orologio del client lo raggiunge.
        if let Some(tc) = self.pending_cashout {
            if t_ms >= tc {
                self.pending_cashout = None;
                self.frame("o", tc, r#"{"t":"cashout"}"#);
            }
        }
        // Il client vero manda un ping al secondo: serve all'analizzatore per l'RTT.
        if dir == "o" && t_ms >= self.next_ping_ms {
            let tp = t_ms;
            self.next_ping_ms = t_ms + 1000.0;
            let ping = format!(r#"{{"t":"ping","ts":{:.1}}}"#, tp);
            self.write_frame("o", tp, &ping);
            self.write_frame("i", tp + 35.0, &ping.replace("ping", "pong"));
        }
        self.write_frame(dir, t_ms, payload);
    }

    fn write_frame(&mut self, dir: &str, t_ms: f64, payload: &str) {
        let line = format!(
            r#"{{"k":"f","s":1,"d":"{}","m":{:.6},"w":{},"op":1,"p":{}}}"#,
            dir, t_ms / 1000.0, (self.epoch_ms + t_ms).round(), serde_json::to_string(payload).unwrap()
        );
        self.raw(&line);
        self.frames += 1;
    }

    /// Il client vero manda l'input a ogni fotogramma (60 Hz), anche quando non cambia.
    pub fn client_input(&mut self, t_ms: f64, dir: f64, boost: bool, cash: bool) {
        if let Some((t0, prev)) = self.last_input.take() {
            let mut t = t0 + 1000.0 / 60.0;
            while t < t_ms - 1.0 {
                self.frame("o", t, &prev);
                t += 1000.0 / 60.0;
            }
        }
        let msg = format!(r#"{{"t":"input","targetDir":{},"boost":{},"cashingOut":{}}}"#, dir, boost, cash);
        self.frame("o", t_ms, &msg);
        self.last_input = Some((t_ms, msg));
    }

    pub fn client_cashout(&mut self, t_ms: f64) { self.pending_cashout = Some(t_ms); }
    pub fn cancel_cashout(&mut self) { self.pending_cashout = None; }

    pub fn server_message(&mut self, t_ms: f64, m: &Down, p: &Params) {
        match m {
            Down::State(s) => { let j = s.to_json(); self.frame("i", t_ms, &j); }
            Down::Init { id } => {
                self.frame("o", t_ms - 40.0, r##"{"t":"join","name":"agente1","lobby":1,"skin":"#8b1e1e","skinItemId":null,"boostItemId":null,"eyeColorItemId":null,"chainItemId":null}"##);
                let j = format!(
                    r#"{{"t":"init","voiceEnabled":true,"id":"{}","tickRate":{},"world":{{"cx":0,"cy":0,"r":{}}},"lobbies":[1,10,100],"maintenance":false}}"#,
                    id, p.declared_tick_rate, p.arena_base
                );
                self.frame("i", t_ms, &j);
                self.frame("i", t_ms + 1.0, &format!(r#"{{"t":"join_ok","lobby":{}}}"#, p.lobby));
            }
            Down::Kill { killer, victim, streak } => {
                let j = format!(r#"{{"t":"kill","ts":{},"killer":{},"victim":{},"streak":{}}}"#,
                    (self.epoch_ms + t_ms).round(), serde_json::to_string(killer).unwrap(), serde_json::to_string(victim).unwrap(), streak);
                self.frame("i", t_ms, &j);
            }
            Down::YouDied { reason, killer, balance } => {
                let j = format!(r#"{{"t":"you_died","reason":"{}","killer":{},"balance":{}}}"#, reason, serde_json::to_string(killer).unwrap(), balance);
                self.frame("i", t_ms, &j);
            }
            Down::CashoutResult { balance, payout, rake } => {
                let sol = 121.2;
                let lam = |usd: f64| (usd / sol * 1e9).round() as i64;
                let j = format!(
                    r#"{{"t":"cashout_result","balance":{},"payoutLamports":{},"payoutUsd":"{:.2}","rakeLamports":{},"rakeUsd":"{:.2}","solPrice":{},"pending":true}}"#,
                    balance, lam(*payout), payout, lam(*rake), rake, sol
                );
                self.frame("i", t_ms, &j);
            }
        }
    }

    pub fn finish(&mut self) -> std::io::Result<()> {
        if let Some(gz) = self.gz.take() { gz.finish()?.flush()?; }
        Ok(())
    }
}

impl Drop for Recorder {
    fn drop(&mut self) { let _ = self.finish(); }
}
