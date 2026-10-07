//! Simulatore di moneyslither.com per l'addestramento di un'AI.
//!
//! - `world`     il server: fisica, collisioni, cibo, bottino, cashout, arena — per tick
//! - `snapshot`  lo stato come lo manda il server (stesso JSON, stessa quantizzazione)
//! - `env`       una lobby vista da client emulati: snapshot ogni 2–4 tick, latenze, timer del cashout
//! - `bots`      avversari con tempi di reazione, tattiche e strato di sicurezza
//! - `features`  osservazione egocentrica costruita SOLO dallo snapshot (vale anche sui dati veri)
//! - `vecenv`    molti mondi in parallelo; `ffi` l'interfaccia C per Python
//! - `viewer`    il gioco nel browser; `record` le partite nel formato di analizer
//! - `validate`  la fisica rigiocata sulle sessioni registrate dal server vero

pub mod bots;
pub mod config;
pub mod env;
pub mod features;
pub mod ffi;
pub mod record;
pub mod rng;
pub mod snake;
pub mod snapshot;
pub mod validate;
pub mod vecenv;
pub mod viewer;
pub mod world;
