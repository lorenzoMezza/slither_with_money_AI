//! Generatore pseudo-casuale veloce e deterministico (PCG32 + SplitMix64 per il seme).
//!
//! Ogni mondo ha il suo: con lo stesso seme una partita si ripete identica, che e'
//! la condizione per poter confrontare due versioni del simulatore o riprodurre un bug.

#[derive(Clone, Debug)]
pub struct Rng {
    state: u64,
    inc: u64,
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut s = seed;
        let mut r = Rng { state: splitmix(&mut s), inc: splitmix(&mut s) | 1 };
        r.next_u32();
        r
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniforme in [0, 1), 53 bit come Math.random().
    #[inline]
    pub fn f64(&mut self) -> f64 {
        let hi = (self.next_u32() >> 5) as u64;
        let lo = (self.next_u32() >> 6) as u64;
        ((hi << 26) | lo) as f64 / (1u64 << 53) as f64
    }

    #[inline]
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 { lo + (hi - lo) * self.f64() }

    #[inline]
    pub fn below(&mut self, n: usize) -> usize { ((self.f64() * n as f64) as usize).min(n.saturating_sub(1)) }

    #[inline]
    pub fn chance(&mut self, p: f64) -> bool { self.f64() < p }

    /// Normale standard (Box-Muller).
    pub fn normal(&mut self) -> f64 {
        let u = self.f64().max(1e-12);
        let v = self.f64();
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }

    /// Un seme nuovo derivato da questo generatore (per i mondi figli).
    pub fn fork(&mut self) -> u64 { ((self.next_u32() as u64) << 32) | self.next_u32() as u64 }
}

pub const TAU: f64 = std::f64::consts::TAU;
pub const PI: f64 = std::f64::consts::PI;

/// Angolo in (−π, π], come angleNormalize del server.
#[inline]
pub fn normalize(a: f64) -> f64 {
    // Come il server: sottrazioni ripetute (piu' veloci di fmod per angoli vicini).
    let mut x = a;
    if !x.is_finite() { return 0.0; }
    while x > PI { x -= TAU; }
    while x < -PI { x += TAU; }
    x
}

#[inline]
pub fn dist2(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let dx = x1 - x2;
    let dy = y1 - y2;
    dx * dx + dy * dy
}
