import { createArena } from './arena.js';
import { createBody } from './body.js';
import { createBoost } from './boost.js';
import { createCashout } from './cashout.js';
import { createClock } from './clock.js';
import { createCombat } from './combat.js';
import { createCoverage } from './coverage.js';
import { createFood } from './food.js';
import { createLife } from './life.js';
import { createMovement } from './movement.js';
import { createProtocol } from './protocol.js';

/** I moduli, nell'ordine in cui compaiono nel rapporto. Il clock va per primo: calibra il tick. */
export function createModules() {
  return [
    createClock(), createMovement(), createBody(), createBoost(), createFood(), createArena(),
    createLife(), createCombat(), createCashout(), createProtocol(), createCoverage(),
  ];
}
