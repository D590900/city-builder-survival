// Building repair: pay a prorated share of the build cost up front, then
// the hp climbs back to maxHp at a fixed rate. Pure logic, no I/O.

import { payCost } from './economy.js';

export const REPAIR_COST_RATIO = 0.5; // a full repair costs half the build cost
export const REPAIR_SECONDS = 30; // duration of a 0→maxHp repair (prorated on damage)

// Cost of repairing b back to full hp: def.cost scaled by the missing-hp
// ratio and REPAIR_COST_RATIO, rounded up per resource; entries that round
// to zero are dropped. Returns {} when the building is already at full hp.
export function repairCost(b, def) {
  const cost = {};
  if (!def?.cost || !(b.maxHp > 0)) return cost;
  const missing = 1 - Math.max(0, b.hp) / b.maxHp;
  if (missing <= 0) return cost;
  for (const [resource, amount] of Object.entries(def.cost)) {
    const price = Math.ceil(amount * missing * REPAIR_COST_RATIO);
    if (price > 0) cost[resource] = price;
  }
  return cost;
}

// Starts the repair of b: refuses when the hp is already full, a repair is
// in progress or the resources don't cover the prorated cost (left
// untouched in that case). On success pays the cost once and flags
// b.repairing. Returns true on success.
export function startRepair(state, b, def) {
  if (!b || b.repairing) return false;
  if (!(b.maxHp > 0) || b.hp >= b.maxHp) return false;
  if (!payCost(state, { cost: repairCost(b, def) })) return false;
  b.repairing = true;
  return true;
}

// Advances every active repair by dt seconds: hp climbs at maxHp /
// REPAIR_SECONDS per second (so a half-wrecked building takes 15 s) and is
// clamped at maxHp, where repairing clears. Returns the ids of the
// buildings whose hp changed (for the damage visuals).
export function tickRepairs(state, dt) {
  const changed = [];
  for (const b of state.buildings) {
    if (!b.repairing) continue;
    b.hp = Math.min(b.maxHp, b.hp + (b.maxHp / REPAIR_SECONDS) * dt);
    if (b.hp >= b.maxHp) b.repairing = false;
    changed.push(b.id);
  }
  return changed;
}
