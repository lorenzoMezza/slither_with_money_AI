//! Il corpo di un serpente, come lo tiene il server.
//!
//! La testa lascia un PERCORSO campionato a distanza fissa (un punto ogni
//! `point_dist` unita' percorse, indipendente dalla velocita'): l'anello `i` e' il
//! punto `i·spacing_points` del percorso. Numero di anelli e spessore vengono dalle
//! funzioni del client `segmentsForSize` e `thicknessForSegments`, verificate esatte
//! sugli snapshot del server (spessore: scarto zero su 28 valori).

use crate::config::Params;
use std::collections::VecDeque;

/// Anelli al massimo (verita' del server, 2026-10-07).
pub const MAX_RINGS: usize = 1200;

/// segmentsForSize(): fino a 100 di taglia 8 + (taglia − 40)·18/60 (taglia minima
/// considerata 40), oltre 26 + (taglia − 100)·0,08; arrotondato, minimo 8, massimo 1200.
#[inline]
pub fn segments_for_size(size: f64, min_size: f64) -> usize {
    let sz = size.max(min_size);
    let mut seg = 8.0 + (sz - 40.0) * (26.0 - 8.0) / (100.0 - 40.0);
    if sz > 100.0 { seg = 26.0 + (sz - 100.0) * 0.08; }
    (js_round(seg).max(8.0) as usize).min(MAX_RINGS)
}

/// thicknessForSegments(): (7,5 + 0,55·√n + [n > 26]·0,17·(n − 26)^0,7)·1,43, minimo 10;
/// uguale lungo tutto il corpo.
#[inline]
pub fn thickness_for_segments(n: usize) -> f64 {
    let n = n.max(1) as f64;
    let mut t = 7.5 + 0.55 * n.sqrt();
    if n > 26.0 { t += (n - 26.0).powf(0.7) * 0.17; }
    (t * 1.43).max(10.0)
}

/// Math.round di JavaScript (le meta' vanno verso +∞, non lontano da zero).
#[inline]
pub fn js_round(x: f64) -> f64 { (x + 0.5).floor() }

#[derive(Clone, Debug)]
pub struct Snake {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub size: f64,
    pub num_segments: usize,
    pub thickness: f64,
    pub boost_amount: f64,
    /// Percorso: indice 0 = punto piu' recente (come `path.unshift` del server).
    pub path: VecDeque<[f64; 2]>,
    pub last_path: [f64; 2],
    pub path_acc: f64,
    pub pending_growth: f64,
}

impl Snake {
    /// Come makeSnake(): percorso pre-riempito all'indietro lungo la direzione iniziale.
    pub fn new(x: f64, y: f64, angle: f64, size: f64, p: &Params) -> Snake { Self::new_curled(x, y, angle, size, 0.0, p) }

    /// Come `new`, ma il corpo dietro la testa segue un arco: e' il serpente che stava
    /// girando con curvatura `curl` (rad per punto del percorso) quando lo si incontra.
    pub fn new_curled(x: f64, y: f64, angle: f64, size: f64, curl: f64, p: &Params) -> Snake {
        let num_segments = segments_for_size(size, p.min_size);
        let max_path = Self::max_path_for(num_segments, p);
        let mut path = VecDeque::with_capacity(max_path + 8);
        let (mut px, mut py) = (x, y);
        path.push_back([px, py]);
        for i in 1..max_path {
            // Rotta che la testa aveva i punti fa: ruotata all'indietro di curl per punto.
            let a = angle - curl * i as f64;
            px -= a.cos() * p.point_dist;
            py -= a.sin() * p.point_dist;
            path.push_back([px, py]);
        }
        Snake {
            x, y, angle, size, num_segments,
            thickness: thickness_for_segments(num_segments),
            boost_amount: 0.0,
            path,
            last_path: [x, y],
            path_acc: 0.0,
            pending_growth: 0.0,
        }
    }

    #[inline]
    pub fn max_path_for(num_segments: usize, p: &Params) -> usize {
        (num_segments * p.spacing_points + 200).max(800)
    }

    /// Anelli e spessore dopo un cambio di taglia (lo spessore solo se gli anelli cambiano).
    #[inline]
    pub fn refresh_shape(&mut self, p: &Params) {
        let n = segments_for_size(self.size, p.min_size);
        if n != self.num_segments {
            self.num_segments = n;
            self.thickness = thickness_for_segments(n);
        }
    }

    /// Punto del percorso con indice dato (o l'ultimo, come `path[idx] || path[last]`).
    #[inline]
    pub fn path_point(&self, idx: usize) -> [f64; 2] {
        match self.path.get(idx) {
            Some(p) => *p,
            None => *self.path.back().unwrap_or(&[self.x, self.y]),
        }
    }

    /// Anello `i` del corpo.
    #[inline]
    pub fn ring(&self, i: usize, p: &Params) -> [f64; 2] { self.path_point(i * p.spacing_points) }

    /// Avanza la testa di `step` lungo l'angolo corrente e campiona il percorso.
    pub fn advance(&mut self, step: f64, p: &Params) {
        self.x += self.angle.cos() * step;
        self.y += self.angle.sin() * step;
        let dx = self.x - self.last_path[0];
        let dy = self.y - self.last_path[1];
        let d = (dx * dx + dy * dy).sqrt();
        if d > 0.0 {
            self.path_acc += d;
            let ux = dx / d;
            let uy = dy / d;
            let mut remaining = self.path_acc;
            while remaining >= p.point_dist {
                self.last_path[0] += ux * p.point_dist;
                self.last_path[1] += uy * p.point_dist;
                self.path.push_front(self.last_path);
                remaining -= p.point_dist;
            }
            self.path_acc = remaining;
        }
        let max_path = Self::max_path_for(self.num_segments, p);
        while self.path.len() > max_path { self.path.pop_back(); }
    }
}
