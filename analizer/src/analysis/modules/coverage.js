/**
 * Cosa e' gia' stato osservato e cosa manca, con l'azione di gioco che lo
 * provoca. Alcune regole esistono solo quando succede qualcosa in partita: una
 * morte per collisione, un cashout completo, un money rain. Nessuna analisi
 * puo' inventarle; questo modulo dice, mentre giochi, cosa andare a cercare.
 */
import { Section } from '../engine.js';

const CHECKS = [
  ['partita', 'snapshot con te in partita', 'entra in partita', (c) => c.own > 0],
  ['passo', 'tratti dritti senza boost (passo per tick, frequenza vera)', 'gioca normalmente qualche secondo', (c) => c.mv.base >= 200],
  ['boost', 'boost pieno in linea retta (velocita\' in boost)', 'tieni premuto il boost ~1 s andando dritto', (c) => c.mv.boostFull >= 10],
  ['rampa', 'accelerazioni del boost (rampa)', 'premi il boost a colpi brevi, 10-20 volte', (c) => c.mv.rampUp >= 20],
  ['curve', 'curve strette (sterzata massima)', 'fai inversioni e curve secche', (c) => c.mv.turn >= 1000],
  ['costoBoost', 'tratti di boost lontano dal cibo (costo del boost)', 'boost lungo dove non c\'e\' cibo, a taglie diverse', (c) => c.boost.runs >= 12],
  ['cibo', 'raccolte di un orb solo senza boost (crescita, raggio)', 'mangia orb sparsi', (c) => c.food.gains >= 40],
  ['oro', 'raccolte di orb d\'oro (raggio e crescita dell\'oro)', 'raccogli il bottino di una morte', (c) => c.food.reachGold >= 15],
  ['taglie', 'taglie oltre 300 (esponente della crescita)', 'cresci il piu\' possibile', (c) => c.mv.maxSize >= 300],
  ['muro', 'una morte sul muro (soglia del muro)', 'tocca il bordo (meglio con posta minima)', (c) => c.arena.wallDeaths >= 1],
  ['uccisione', 'una morte per collisione fra serpenti (hitbox)', 'gioca vicino ad altri serpenti', (c) => c.combat.kills >= 1],
  ['bottino', 'un bottino lasciato scadere (durata)', 'resta in partita 2+ minuti dopo una morte, lontano dal bottino', (c) => c.life.expired >= 1],
  ['cashoutVisto', 'un cashout in corso (durata, rallentamento)', 'tieni premuto il cashout', (c) => c.cash.cashing >= 30],
  ['cashoutTuo', 'un tuo cashout completo (sequenza e commissione)', 'completa un cashout', (c) => c.cash.completed >= 1 || c.life.cashouts >= 1],
  ['folla', 'almeno due numeri di vivi stabili (legge del raggio dell\'arena)', 'gioca quando la lobby cambia di popolazione', (c) => c.arena.aliveCounts >= 2],
  ['rinascita', 'un rientro dopo la morte', 'dopo la morte, rientra senza chiudere', (c) => c.life.respawns >= 1],
  ['live', 'impostazioni di combattimento live (user_flags.gameSettings)', 'arrivano da sole se il server le manda', (c) => c.liveSettings],
  ['rain', 'un money rain', 'aspetta un evento (raro)', (c) => c.life.rain >= 1],
];

export function createCoverage() {
  let own = 0;
  return {
    id: 'coverage',
    onState(snap, _pair, ctx) { if (ctx.ownId && snap.players.get(ctx.ownId)?.alive) own += 1; },

    status(analyzer) {
      const m = analyzer.byId;
      const c = {
        own,
        mv: m.movement.counts(), boost: m.boost.counts(), food: m.food.counts(), arena: m.arena.counts(),
        combat: m.combat.counts(), life: m.life.counts(), cash: m.cashout.counts(),
        liveSettings: analyzer.runtime.has('server.gameSettings'),
      };
      return CHECKS.map(([key, label, how, test]) => ({ key, label, how, ok: Boolean(test(c)) }));
    },

    finalize(shared) {
      const sec = new Section('copertura', 'Copertura', 'Fenomeni di gioco gia\' osservati e quelli che mancano, con il modo di provocarli.');
      const st = this.status(shared.analyzer);
      sec.table('Copertura', ['', 'fenomeno', 'come ottenerlo'], st.map((s) => [s.ok ? '✓' : '·', s.label, s.ok ? '' : s.how]));
      sec.note(`${st.filter((s) => s.ok).length} su ${st.length} fenomeni osservati`);
      return sec;
    },
  };
}
