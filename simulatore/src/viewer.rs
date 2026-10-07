//! Visualizzatore: un server HTTP minimo (solo libreria standard) che serve una
//! pagina e le manda gli snapshot in streaming (Server-Sent Events). Gli snapshot
//! sono lo stesso JSON `state` del server vero, quindi la pagina e' di fatto un
//! piccolo client del gioco. Dal browser si puo' anche giocare: mouse per la
//! direzione, tasto sinistro o spazio per il boost, C tenuto per il cashout.

use crate::config::Params;
use crate::snapshot::Snapshot;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const PAGE: &str = include_str!("../viewer/index.html");

#[derive(Clone, Debug, Default)]
pub struct HumanCmd {
    pub dir: f64,
    pub boost: bool,
    pub cash: bool,
    pub seq: u64,
}

pub struct ViewerHub {
    latest: Mutex<(u64, Arc<String>)>,
    cv: Condvar,
    pub human: Mutex<HumanCmd>,
    pub clients: Mutex<usize>,
}

impl ViewerHub {
    pub fn new() -> Arc<ViewerHub> {
        Arc::new(ViewerHub { latest: Mutex::new((0, Arc::new(String::new()))), cv: Condvar::new(), human: Mutex::new(HumanCmd::default()), clients: Mutex::new(0) })
    }

    /// Nuovo snapshot da mostrare (con l'id del giocatore da seguire).
    pub fn publish(&self, snap: &Snapshot, you: &str, p: &Params) {
        if *self.clients.lock().unwrap() == 0 { return; }
        let msg = format!(r#"{{"you":"{}","tickHz":{},"state":{}}}"#, you, p.tick_hz, snap.to_json());
        let mut g = self.latest.lock().unwrap();
        g.0 += 1;
        g.1 = Arc::new(msg);
        self.cv.notify_all();
    }

    pub fn human(&self) -> HumanCmd { self.human.lock().unwrap().clone() }
}

/// Avvia il server in un thread. Restituisce l'indirizzo effettivo.
pub fn serve(hub: Arc<ViewerHub>, port: u16) -> std::io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let addr = format!("http://{}", listener.local_addr()?);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let hub = hub.clone();
            std::thread::spawn(move || { let _ = handle(stream, hub); });
        }
    });
    Ok(addr)
}

fn handle(mut stream: TcpStream, hub: Arc<ViewerHub>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 { break; }
        let h = h.trim_end();
        if h.is_empty() { break; }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") { len = v.trim().parse().unwrap_or(0); }
    }
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");
    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => {
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\r\n", PAGE.len())?;
            stream.write_all(PAGE.as_bytes())?;
        }
        ("GET", "/stream") => {
            stream.set_read_timeout(None)?;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n")?;
            *hub.clients.lock().unwrap() += 1;
            let res = stream_loop(&mut stream, &hub);
            *hub.clients.lock().unwrap() -= 1;
            res?;
        }
        ("POST", "/input") => {
            let mut body = vec![0u8; len.min(4096)];
            reader.read_exact(&mut body)?;
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
                let mut h = hub.human.lock().unwrap();
                if let Some(d) = v["targetDir"].as_f64() { h.dir = d; }
                if let Some(b) = v["boost"].as_bool() { h.boost = b; }
                if let Some(c) = v["cashingOut"].as_bool() { h.cash = c; }
                h.seq += 1;
            }
            write!(stream, "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")?;
        }
        _ => { write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")?; }
    }
    Ok(())
}

fn stream_loop(stream: &mut TcpStream, hub: &ViewerHub) -> std::io::Result<()> {
    let mut seen = 0u64;
    loop {
        let msg = {
            let g = hub.latest.lock().unwrap();
            let (g, _) = hub.cv.wait_timeout_while(g, Duration::from_secs(2), |g| g.0 == seen).unwrap();
            if g.0 == seen { None } else { seen = g.0; Some(g.1.clone()) }
        };
        match msg {
            Some(m) => { stream.write_all(b"data: ")?; stream.write_all(m.as_bytes())?; stream.write_all(b"\n\n")?; }
            None => { stream.write_all(b": vivo\n\n")?; }
        }
        stream.flush()?;
    }
}
