//! Interfaccia C: e' quella che usa il pacchetto Python (ctypes, nessuna compilazione
//! lato Python). Tutti i buffer sono allocati dal chiamante.

// Le funzioni ricevono puntatori dal chiamante C/Python, che e' responsabile della
// loro validita' (dimensioni da sim_obs_size & co.): e' il contratto dell'interfaccia.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use crate::config::EnvConfig;
use crate::env::{ActionMode, ACTION_SIZE, INFO_SIZE};
use crate::features::{layout, Featurizer, OBS_SIZE};
use crate::record::Recorder;
use crate::vecenv::VecEnv;
use crate::viewer::{serve, ViewerHub};
use std::ffi::{c_char, CStr};
use std::path::Path;

fn cstr<'a>(p: *const c_char) -> &'a str {
    if p.is_null() { return ""; }
    unsafe { CStr::from_ptr(p) }.to_str().unwrap_or("")
}

/// Copia una stringa nel buffer; restituisce la lunghezza necessaria.
fn out_str(s: &str, buf: *mut c_char, cap: usize) -> usize {
    let b = s.as_bytes();
    if !buf.is_null() && cap > 0 {
        let n = b.len().min(cap - 1);
        unsafe {
            std::ptr::copy_nonoverlapping(b.as_ptr(), buf as *mut u8, n);
            *buf.add(n) = 0;
        }
    }
    b.len()
}

thread_local! { static LAST_ERROR: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) }; }

#[no_mangle]
pub extern "C" fn sim_last_error(buf: *mut c_char, cap: usize) -> usize { LAST_ERROR.with(|e| out_str(&e.borrow(), buf, cap)) }

#[no_mangle]
pub extern "C" fn sim_obs_size() -> usize { OBS_SIZE }
#[no_mangle]
pub extern "C" fn sim_action_size() -> usize { ACTION_SIZE }
#[no_mangle]
pub extern "C" fn sim_info_size() -> usize { INFO_SIZE }
#[no_mangle]
pub extern "C" fn sim_layout_json(buf: *mut c_char, cap: usize) -> usize { out_str(&layout().to_string(), buf, cap) }

/// Crea l'ambiente vettoriale da una configurazione JSON (vuota = default).
#[no_mangle]
pub extern "C" fn sim_new(config_json: *const c_char) -> *mut VecEnv {
    match EnvConfig::from_json(cstr(config_json)) {
        Ok(cfg) => Box::into_raw(Box::new(VecEnv::new(cfg))),
        Err(e) => { LAST_ERROR.with(|x| *x.borrow_mut() = e); std::ptr::null_mut() }
    }
}

#[no_mangle]
pub extern "C" fn sim_free(h: *mut VecEnv) { if !h.is_null() { drop(unsafe { Box::from_raw(h) }); } }

#[no_mangle]
pub extern "C" fn sim_num_envs(h: *const VecEnv) -> usize { unsafe { &*h }.envs.len() }
#[no_mangle]
pub extern "C" fn sim_agents_per_env(h: *const VecEnv) -> usize { unsafe { &*h }.agents }

/// Parametri effettivi (dopo l'eventuale randomizzazione) del mondo `env`.
#[no_mangle]
pub extern "C" fn sim_params_json(h: *const VecEnv, env: usize, buf: *mut c_char, cap: usize) -> usize {
    let v = unsafe { &*h };
    out_str(&serde_json::to_string(&v.envs[env.min(v.envs.len() - 1)].p).unwrap_or_default(), buf, cap)
}

/// 0 = azione relativa (turn·π dalla direzione osservata), 1 = targetDir assoluto.
#[no_mangle]
pub extern "C" fn sim_set_action_mode(h: *mut VecEnv, mode: i32) {
    unsafe { &mut *h }.set_action_mode(if mode == 1 { ActionMode::Absolute } else { ActionMode::Relative });
}

#[no_mangle]
pub extern "C" fn sim_reset(h: *mut VecEnv, obs: *mut f32, info: *mut f32) {
    let v = unsafe { &mut *h };
    let n = v.total_agents();
    let obs = unsafe { std::slice::from_raw_parts_mut(obs, n * OBS_SIZE) };
    let info = unsafe { std::slice::from_raw_parts_mut(info, n * INFO_SIZE) };
    v.reset(obs, info);
}

#[no_mangle]
pub extern "C" fn sim_step(h: *mut VecEnv, actions: *const f32, obs: *mut f32, rew: *mut f32, done: *mut u8, info: *mut f32) {
    let v = unsafe { &mut *h };
    let n = v.total_agents();
    let (actions, obs, rew, done, info) = unsafe {
        (
            std::slice::from_raw_parts(actions, n * ACTION_SIZE),
            std::slice::from_raw_parts_mut(obs, n * OBS_SIZE),
            std::slice::from_raw_parts_mut(rew, n),
            std::slice::from_raw_parts_mut(done, n),
            std::slice::from_raw_parts_mut(info, n * INFO_SIZE),
        )
    };
    v.step(actions, obs, rew, done, info);
}

/// Nuove partite (modalita' partita). `specs_json` = {"<indice mondo>": MatchSpec, ...}.
/// `obs` e `info` sono i buffer completi (num_envs · agents_per_env righe). Restituisce 1 se ok.
#[no_mangle]
pub extern "C" fn sim_reset_matches(h: *mut VecEnv, specs_json: *const c_char, obs: *mut f32, info: *mut f32) -> i32 {
    let v = unsafe { &mut *h };
    let parsed: Result<std::collections::HashMap<String, crate::config::MatchSpec>, _> = serde_json::from_str(cstr(specs_json));
    let Ok(map) = parsed else {
        LAST_ERROR.with(|x| *x.borrow_mut() = format!("specifica non valida: {}", parsed.err().map(|e| e.to_string()).unwrap_or_default()));
        return 0;
    };
    let specs = map.into_iter().filter_map(|(k, s)| k.parse::<usize>().ok().filter(|&i| i < v.envs.len()).map(|i| (i, s))).collect();
    let n = v.total_agents();
    let obs = unsafe { std::slice::from_raw_parts_mut(obs, n * OBS_SIZE) };
    let info = unsafe { std::slice::from_raw_parts_mut(info, n * INFO_SIZE) };
    v.reset_matches(specs, obs, info);
    1
}

/// Risultato di tutti i partecipanti della partita del mondo `env` (JSON).
#[no_mangle]
pub extern "C" fn sim_match_report(h: *const VecEnv, env: usize, buf: *mut c_char, cap: usize) -> usize {
    let v = unsafe { &*h };
    out_str(&v.envs[env].match_report().to_string(), buf, cap)
}

/// L'ultimo snapshot ricevuto dall'agente `agent` del mondo `env`, nel JSON del server.
#[no_mangle]
pub extern "C" fn sim_snapshot_json(h: *const VecEnv, env: usize, agent: usize, buf: *mut c_char, cap: usize) -> usize {
    let v = unsafe { &*h };
    out_str(&v.envs[env].snapshot_json(agent), buf, cap)
}

/// Id del giocatore dell'agente (quello che compare negli snapshot).
#[no_mangle]
pub extern "C" fn sim_agent_id(h: *const VecEnv, env: usize, agent: usize, buf: *mut c_char, cap: usize) -> usize {
    let v = unsafe { &*h };
    out_str(v.envs[env].agents.get(agent).map(|a| a.id.as_str()).unwrap_or(""), buf, cap)
}

/// Mostra il mondo `env` nel browser. Restituisce la porta (0 = errore).
#[no_mangle]
pub extern "C" fn sim_viewer_start(h: *mut VecEnv, env: usize, port: u16) -> u16 {
    let v = unsafe { &mut *h };
    let hub = ViewerHub::new();
    match serve(hub.clone(), port) {
        Ok(addr) => {
            v.envs[env].viewer = Some(hub);
            addr.rsplit(':').next().and_then(|p| p.parse().ok()).unwrap_or(port)
        }
        Err(e) => { LAST_ERROR.with(|x| *x.borrow_mut() = e.to_string()); 0 }
    }
}

/// Il posto `slot` del mondo `env` lo comanda una persona dal browser (−1 = nessuno).
#[no_mangle]
pub extern "C" fn sim_set_human(h: *mut VecEnv, env: usize, slot: i64) {
    let v = unsafe { &mut *h };
    v.envs[env].human_slot = usize::try_from(slot).ok();
}

/// Rallenta i passi al tempo reale × factor (0 = a tutta velocita').
#[no_mangle]
pub extern "C" fn sim_set_realtime(h: *mut VecEnv, factor: f64) { unsafe { &mut *h }.set_realtime(factor); }

/// Registra la partita dell'agente 0 del mondo `env` come sessione di analizer.
#[no_mangle]
pub extern "C" fn sim_record_start(h: *mut VecEnv, env: usize, dir: *const c_char) -> i32 {
    let v = unsafe { &mut *h };
    match Recorder::create(Path::new(cstr(dir))) {
        Ok(r) => { v.envs[env].recorder = Some(r); 1 }
        Err(e) => { LAST_ERROR.with(|x| *x.borrow_mut() = e.to_string()); 0 }
    }
}

#[no_mangle]
pub extern "C" fn sim_record_stop(h: *mut VecEnv, env: usize) {
    let v = unsafe { &mut *h };
    if let Some(mut r) = v.envs[env].recorder.take() { let _ = r.finish(); }
}

// --- osservazioni dai dati del server vero --------------------------------------------

#[no_mangle]
pub extern "C" fn sim_featurizer_new() -> *mut Featurizer { Box::into_raw(Box::new(Featurizer::new())) }

#[no_mangle]
pub extern "C" fn sim_featurizer_free(f: *mut Featurizer) { if !f.is_null() { drop(unsafe { Box::from_raw(f) }); } }

/// Osservazione da un messaggio `state` reale. `last_action` puo' essere NULL.
#[no_mangle]
pub extern "C" fn sim_featurizer_push(f: *mut Featurizer, state_json: *const c_char, my_id: *const c_char, last_action: *const f32, out: *mut f32) -> i32 {
    let f = unsafe { &mut *f };
    if !last_action.is_null() {
        let a = unsafe { std::slice::from_raw_parts(last_action, 3) };
        f.last_action = [a[0], a[1], a[2]];
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out, OBS_SIZE) };
    f.push_json(cstr(state_json), cstr(my_id), out) as i32
}
