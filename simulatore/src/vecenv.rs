//! Molti mondi in parallelo, uno per lobby, su tutti i core (rayon). Le uscite sono
//! buffer piatti contigui: pronti per numpy senza copie.

use crate::config::{EnvConfig, MatchSpec};
use crate::env::{ActionMode, Env, ACTION_SIZE, INFO_SIZE};
use crate::features::OBS_SIZE;
use crate::rng::Rng;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::Instant;

pub struct VecEnv {
    pub envs: Vec<Env>,
    pub agents: usize,
    /// (inizio, ms di gioco trascorsi da allora, fattore): il tempo di gioco si somma
    /// passo per passo, cosi' una partita che riparte (orologio del mondo a zero) non
    /// lo confonde.
    realtime: Option<(Instant, f64, f64)>,
}

impl VecEnv {
    pub fn new(cfg: EnvConfig) -> VecEnv {
        let mut rng = Rng::new(cfg.seed);
        let envs = (0..cfg.num_envs.max(1)).map(|_| Env::new(cfg.clone(), rng.fork())).collect();
        VecEnv { envs, agents: cfg.agents_per_env, realtime: None }
    }

    pub fn total_agents(&self) -> usize { self.envs.len() * self.agents }

    pub fn set_action_mode(&mut self, mode: ActionMode) { for e in &mut self.envs { e.action_mode = mode; } }

    /// Rallenta al tempo reale (moltiplicato per `factor`): serve per guardare.
    pub fn set_realtime(&mut self, factor: f64) {
        self.realtime = if factor > 0.0 { Some((Instant::now(), 0.0, factor)) } else { None };
    }

    pub fn reset(&mut self, obs: &mut [f32], info: &mut [f32]) {
        let a = self.agents;
        if a == 0 {
            self.envs.par_iter_mut().for_each(|e| e.reset(&mut [], &mut []));
            return;
        }
        self.envs.par_iter_mut()
            .zip(obs.par_chunks_mut(a * OBS_SIZE))
            .zip(info.par_chunks_mut(a * INFO_SIZE))
            .for_each(|((e, o), i)| e.reset(o, i));
        if let Some(rt) = self.realtime.as_mut() { rt.0 = Instant::now(); rt.1 = 0.0; }
    }

    /// Nuove partite nei mondi indicati (in parallelo). `obs` e `info` sono i buffer
    /// COMPLETI: ogni mondo scrive solo nella propria parte.
    pub fn reset_matches(&mut self, specs: HashMap<usize, MatchSpec>, obs: &mut [f32], info: &mut [f32]) {
        let a = self.agents.max(1);
        self.envs.par_iter_mut()
            .zip(obs.par_chunks_mut(a * OBS_SIZE))
            .zip(info.par_chunks_mut(a * INFO_SIZE))
            .enumerate()
            .for_each(|(i, ((e, o), inf))| {
                if let Some(spec) = specs.get(&i) { e.reset_match(spec.clone(), o, inf); }
            });
    }

    pub fn step(&mut self, actions: &[f32], obs: &mut [f32], rew: &mut [f32], done: &mut [u8], info: &mut [f32]) {
        let a = self.agents;
        let t_before = self.envs[0].world.time_ms;
        if a == 0 {
            self.envs.par_iter_mut().for_each(|e| e.step(&[], &mut [], &mut [], &mut [], &mut []));
        } else {
            self.envs.par_iter_mut()
                .zip(actions.par_chunks(a * ACTION_SIZE))
                .zip(obs.par_chunks_mut(a * OBS_SIZE))
                .zip(rew.par_chunks_mut(a))
                .zip(done.par_chunks_mut(a))
                .zip(info.par_chunks_mut(a * INFO_SIZE))
                .for_each(|(((((e, ac), o), r), d), i)| e.step(ac, o, r, d, i));
        }
        if let Some(rt) = self.realtime.as_mut() {
            rt.1 += (self.envs[0].world.time_ms - t_before).max(0.0);
            let (start, elapsed, factor) = *rt;
            let sim = elapsed / 1000.0 / factor;
            let real = start.elapsed().as_secs_f64();
            if sim > real { std::thread::sleep(std::time::Duration::from_secs_f64(sim - real)); }
        }
    }
}
