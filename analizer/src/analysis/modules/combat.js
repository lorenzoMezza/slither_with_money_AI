/**
 * Il combattimento: le soglie delle hitbox e la regola del frontale.
 *
 * Le soglie si inquadrano da due lati, senza bisogno di vedere il tick esatto
 * della collisione:
 *
 *  - SOPRAVVISSUTI. Ogni snapshot mostra lo stato dopo il controllo delle
 *    collisioni: una testa viva a distanza d dal corpo di un altro dice che la
 *    soglia e' minore di d. Il minimo su migliaia di quasi-contatti e' un
 *    limite superiore stretto.
 *  - VITTIME. Alla morte la testa era entro la soglia. Con la testa proiettata
 *    in avanti fino allo snapshot della morte si ottiene una stima dal basso.
 *
 * Le distanze si confrontano con le soglie previste dalla formula del
 * sorgente, con i parametri live se il server li ha mandati (user_flags), cosi'
 * il risultato e' un rapporto: 1 vuol dire «la formula e' esatta».
 */
import { isAlive, Section } from '../engine.js';
import { hyp, median } from '../stats.js';

const KEEP = 3000;

function minBodyDist(hx, hy, segs, from = 2) {
  let best = Infinity;
  for (let k = from; k < segs.length; k += 1) {
    const dx = hx - segs[k][0]; const dy = hy - segs[k][1];
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const facing = (p, q) => {
  const dx = q.hx - p.hx; const dy = q.hy - p.hy;
  const d = Math.hypot(dx, dy) || 1;
  return Math.cos(p.angle) * (dx / d) + Math.sin(p.angle) * (dy / d);
};

export function createCombat() {
  let near = [];             // quasi-contatti di sopravvissuti
  const deaths = [];         // morti con i candidati uccisori e la geometria
  const kills = [];
  let prev = null;

  const trim = () => {
    near.sort((a, b) => a.score - b.score);
    near = near.slice(0, KEEP);
  };

  return {
    id: 'combat',
    beginSession() { prev = null; },
    onMessage(msg, fr, ctx) {
      if (fr.d === 'i' && msg.t === 'kill' && msg.killer && msg.killer !== 'WALL') kills.push({ ms: fr.ms, session: ctx.name, killer: msg.killer, victim: msg.victim });
    },
    onState(snap, pair, ctx) {
      const alive = snap.alive.filter((p) => Array.isArray(p.segs) && Number.isFinite(p.hx) && Number.isFinite(p.thickness));
      // Sopravvissuti: ogni testa contro ogni corpo, con un filtro grossolano prima.
      for (const a of alive) {
        for (const b of alive) {
          if (a === b) continue;
          const reach = b.segs.length * 7 + 150;
          if (Math.abs(a.hx - b.hx) > reach || Math.abs(a.hy - b.hy) > reach) continue;
          const tt = a.thickness + b.thickness;
          const dhb = minBodyDist(a.hx, a.hy, b.segs);
          if (dhb < 2.2 * tt) near.push({ kind: 'testa-corpo', d: dhb, tA: a.thickness, tB: b.thickness, score: dhb / tt });
          if (a.id < b.id) {
            const dhh = hyp(a.hx - b.hx, a.hy - b.hy);
            if (dhh < 2.2 * tt) near.push({ kind: 'testa-testa', d: dhh, tA: a.thickness, tB: b.thickness, score: dhh / tt, fa: facing(a, b), fb: facing(b, a) });
          }
        }
      }
      if (near.length > KEEP * 3) trim();

      // Vittime: chi era vivo nello snapshot precedente e ora e' morto.
      if (prev && pair?.ok) {
        for (const v of prev.alive) {
          const now = snap.players.get(v.id);
          if (!now || now.alive !== false || !Array.isArray(v.segs) || !Number.isFinite(v.thickness)) continue;
          const cand = [];
          for (const q of snap.alive) {
            const qa = prev.players.get(q.id);
            if (!Array.isArray(q.segs) || !isAlive(qa)) continue;
            cand.push({
              name: q.name, size: q.size, tQ: q.thickness,
              hbBefore: minBodyDist(v.hx, v.hy, qa.segs ?? q.segs),
              hhBefore: hyp(v.hx - qa.hx, v.hy - qa.hy),
              fv: facing(v, qa), fq: facing(qa, v),
              q, qa,
            });
          }
          cand.sort((x, y) => Math.min(x.hbBefore, x.hhBefore) - Math.min(y.hbBefore, y.hhBefore));
          deaths.push({ session: ctx.name, ms: snap.ms, name: v.name, size: v.size, tV: v.thickness, v, ticks: pair.ticks, cand: cand.slice(0, 4) });
          if (deaths.length > 2000) deaths.shift();
        }
      }
      prev = snap;
    },

    counts() { return { near: near.length, kills: kills.length }; },

    finalize(shared) {
      trim();
      const sec = new Section('combattimento', 'Combattimento', 'Soglie delle hitbox inquadrate fra i quasi-contatti dei sopravvissuti (limite superiore) e le uccisioni (stima dal basso), confrontate con la formula del sorgente.');
      const c = shared.combat ?? {};
      const HB = c.HITBOX_BASE ?? 0.95; const hbs = c.combatHitboxScale ?? NaN; const hhs = c.combatHeadHitboxScale ?? NaN;
      const faceCos = Number.isFinite(c.combatHeadOnFacingDegrees) ? Math.cos(c.combatHeadOnFacingDegrees * Math.PI / 180) : NaN;
      const haveFormula = Number.isFinite(hbs) && Number.isFinite(hhs);
      const thrHB = (tA, tB) => tA * HB * hbs * hhs + tB * HB * hbs;
      const thrHH = (tA, tB) => (tA * HB * hbs * hhs + tB * HB * hbs * hhs) * hbs;
      sec.item({ key: 'combattimento.parametri', label: 'parametri usati per le soglie previste', value: { HITBOX_BASE: HB, combatHitboxScale: hbs, combatHeadHitboxScale: hhs, combatHeadOnFacingDegrees: c.combatHeadOnFacingDegrees ?? null, combatHeadOnRule: c.combatHeadOnRule ?? null, fonte: c.fonte ?? 'nessuna' }, status: 'osservato' });

      const hb = near.filter((x) => x.kind === 'testa-corpo');
      const hh = near.filter((x) => x.kind === 'testa-testa');
      if (hb.length) {
        const best = hb.slice(0, 5);
        sec.item({ key: 'combattimento.sopravvissutoPiuVicinoTestaCorpo', label: 'quasi-contatto testa-corpo piu\' stretto di un sopravvissuto (d / somma spessori)', value: Number(best[0].score.toFixed(4)), n: hb.length, status: 'misurato', detail: `d = ${best[0].d.toFixed(2)} con spessori ${best[0].tA.toFixed(2)} e ${best[0].tB.toFixed(2)}` });
        if (haveFormula) {
          const ratios = hb.map((x) => x.d / thrHB(x.tA, x.tB));
          sec.item({ key: 'combattimento.margineSopravvissutiTestaCorpo', label: 'min( d / soglia prevista ) sui sopravvissuti, testa-corpo', value: Number(Math.min(...ratios).toFixed(4)), n: hb.length, detail: '> 1: nessun sopravvissuto e\' mai stato dentro la soglia prevista (la formula non e\' troppo grande). Il valore e\' il limite superiore della scala vera della soglia' });
        }
      } else sec.missing('quasi-contatti testa-corpo', 'combattimento.sopravvissutoPiuVicinoTestaCorpo', 'serve giocare vicino ad altri serpenti');
      if (hh.length && haveFormula) {
        const facingBoth = hh.filter((x) => !Number.isFinite(faceCos) || (x.fa > faceCos && x.fb > faceCos));
        if (facingBoth.length) sec.item({ key: 'combattimento.margineSopravvissutiFrontale', label: 'min( d / soglia prevista ) sui frontali sopravvissuti', value: Number(Math.min(...facingBoth.map((x) => x.d / thrHH(x.tA, x.tB))).toFixed(4)), n: facingBoth.length });
      }

      // Uccisioni: il candidato uccisore e' quello nominato dal messaggio kill.
      const rows = [];
      let rulesOk = 0; let rulesTot = 0;
      for (const d of deaths) {
        const k = kills.find((x) => x.victim === d.name && Math.abs(x.ms - d.ms) < 2500 && x.session === d.session);
        if (!k) continue;
        const q = d.cand.find((x) => x.name === k.killer);
        if (!q) continue;
        const stepGuess = shared.steps?.base ?? 4.8;
        const px = d.v.hx + Math.cos(d.v.angle) * stepGuess * d.ticks;
        const py = d.v.hy + Math.sin(d.v.angle) * stepGuess * d.ticks;
        const hbAfter = minBodyDist(px, py, q.q.segs);
        const hhAfter = hyp(px - q.q.hx, py - q.q.hy);
        const headOn = Number.isFinite(faceCos) ? q.fv > faceCos && q.fq > faceCos && q.hhBefore < 3 * (d.tV + q.tQ) : null;
        if (headOn) { rulesTot += 1; if (d.size < q.size) rulesOk += 1; }
        rows.push({
          victim: d.name, killer: k.killer, sizeV: d.size, sizeK: q.size, headOn,
          hb: [q.hbBefore, hbAfter], hh: [q.hhBefore, hhAfter],
          predHB: haveFormula ? thrHB(d.tV, q.tQ) : NaN, predHH: haveFormula ? thrHH(d.tV, q.tQ) : NaN,
        });
      }
      if (rows.length) {
        sec.table('Uccisioni fra serpenti', ['vittima', 'uccisore', 'taglie', 'frontale', 'testa-corpo prima → dopo', 'soglia prevista', 'testa-testa prima → dopo', 'soglia frontale'],
          rows.map((r) => [r.victim, r.killer, `${r.sizeV} vs ${r.sizeK}`, r.headOn == null ? '?' : r.headOn ? 'sì' : 'no',
            `${r.hb[0].toFixed(1)} → ${r.hb[1].toFixed(1)}`, Number.isFinite(r.predHB) ? r.predHB.toFixed(2) : '–',
            `${r.hh[0].toFixed(1)} → ${r.hh[1].toFixed(1)}`, Number.isFinite(r.predHH) ? r.predHH.toFixed(2) : '–']));
        const body = rows.filter((r) => !r.headOn && Number.isFinite(r.predHB));
        if (body.length) sec.item({ key: 'combattimento.vittimeTestaCorpoRapporto', label: 'd / soglia prevista alla morte (testa proiettata), testa-corpo', value: Number(median(body.map((r) => r.hb[1] / r.predHB)).toFixed(4)), n: body.length, status: 'stimato', detail: '≤ 1 atteso; e\' una stima perche\' la testa e\' proiettata dritta fino allo snapshot della morte' });
        if (rulesTot) sec.item({ key: 'combattimento.regolaFrontale', label: 'nei frontali muore il piu\' piccolo', value: Number((rulesOk / rulesTot).toFixed(3)), n: rulesTot, detail: '1 = sempre il piu\' piccolo (smallest_wins); 0 = sempre il piu\' grande' });
      } else sec.missing('uccisioni fra serpenti', 'combattimento.vittimeTestaCorpoRapporto', 'serve osservare una morte per collisione con un altro serpente');
      sec.table('Quasi-contatti piu\' stretti dei sopravvissuti', ['tipo', 'd', 'spessore testa', 'spessore altro', 'd/(tA+tB)', 'd/soglia prevista'],
        near.slice(0, 15).map((x) => [x.kind, Number(x.d.toFixed(2)), Number(x.tA.toFixed(2)), Number(x.tB.toFixed(2)), Number(x.score.toFixed(4)),
          haveFormula ? Number((x.d / (x.kind === 'testa-corpo' ? thrHB(x.tA, x.tB) : thrHH(x.tA, x.tB))).toFixed(4)) : '–']));
      return sec;
    },
  };
}
