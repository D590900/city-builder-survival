import { describe, it, expect } from 'vitest';
import { CONFIG, createGameState, addBuilding } from '../src/sim/state.js';
import {
  REPAIR_COST_RATIO,
  REPAIR_SECONDS,
  repairCost,
  startRepair,
  tickRepairs,
} from '../src/sim/repair.js';

const DEFS = {
  farm: {
    id: 'farm', name: 'Fattoria', cost: { wood: 10, metal: 4 }, w: 2, h: 2, hp: 100,
  },
  wall: {
    id: 'wall', name: 'Muro', cost: { wood: 5 }, w: 1, h: 1, hp: 50,
  },
};

function damaged(state, defId, def, hp) {
  const b = addBuilding(state, defId, def, 0, 0);
  b.hp = hp;
  return b;
}

describe('repairCost', () => {
  it('scales the build cost by the missing-hp ratio and REPAIR_COST_RATIO', () => {
    const state = createGameState();
    const b = damaged(state, 'farm', DEFS.farm, 50); // half hp
    // wood: 10 × 0.5 × 0.5 = 2.5 → 3; metal: 4 × 0.5 × 0.5 = 1
    expect(repairCost(b, DEFS.farm)).toEqual({ wood: 3, metal: 1 });
    expect(REPAIR_COST_RATIO).toBe(0.5);
  });

  it('rounds every resource up', () => {
    const state = createGameState();
    const b = damaged(state, 'wall', DEFS.wall, 49); // 2% missing
    // wood: 5 × 0.02 × 0.5 = 0.05 → 1
    expect(repairCost(b, DEFS.wall)).toEqual({ wood: 1 });
  });

  it('drops zero-cost entries and returns {} at full hp', () => {
    const state = createGameState();
    const def = { ...DEFS.wall, cost: { wood: 5, metal: 0 } };
    const b = damaged(state, 'wall', def, 25);
    expect(repairCost(b, def)).toEqual({ wood: 2 }); // 5 × 0.5 × 0.5 = 1.25 → 2

    const full = addBuilding(state, 'wall', DEFS.wall, 2, 0);
    expect(repairCost(full, DEFS.wall)).toEqual({});
  });

  it('handles a missing or empty def cost', () => {
    const state = createGameState();
    const b = damaged(state, 'wall', DEFS.wall, 10);
    expect(repairCost(b, {})).toEqual({});
    expect(repairCost(b, null)).toEqual({});
  });
});

describe('startRepair', () => {
  it('pays the prorated cost once and flags repairing', () => {
    const state = createGameState();
    const b = damaged(state, 'farm', DEFS.farm, 50);
    expect(startRepair(state, b, DEFS.farm)).toBe(true);
    expect(b.repairing).toBe(true);
    expect(state.resources.wood).toBe(CONFIG.startResources.wood - 3);
    expect(state.resources.metal).toBe(CONFIG.startResources.metal - 1);
  });

  it('refuses full hp, an active repair and short funds (resources untouched)', () => {
    const state = createGameState();
    const full = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    expect(startRepair(state, full, DEFS.farm)).toBe(false);

    const b = damaged(state, 'farm', DEFS.farm, 50);
    state.resources.wood = 0; // needs 3
    expect(startRepair(state, b, DEFS.farm)).toBe(false);
    expect(b.repairing).toBeFalsy();
    expect(state.resources.metal).toBe(CONFIG.startResources.metal);

    // Already repairing: no double charge.
    state.resources.wood = 80;
    expect(startRepair(state, b, DEFS.farm)).toBe(true);
    const woodAfter = state.resources.wood;
    expect(startRepair(state, b, DEFS.farm)).toBe(false);
    expect(state.resources.wood).toBe(woodAfter);
  });
});

describe('tickRepairs', () => {
  it('climbs at maxHp / REPAIR_SECONDS per second and returns the changed ids', () => {
    const state = createGameState();
    const b = damaged(state, 'farm', DEFS.farm, 50);
    const idle = addBuilding(state, 'wall', DEFS.wall, 2, 0);
    expect(REPAIR_SECONDS).toBe(30);

    b.repairing = true;
    const changed = tickRepairs(state, 3); // 100/30 × 3 = 10 hp
    expect(b.hp).toBeCloseTo(60);
    expect(changed).toEqual([b.id]);
    expect(idle.hp).toBe(idle.maxHp);
  });

  it('takes a prorated time: from half hp it completes in 15 s', () => {
    const state = createGameState();
    const b = damaged(state, 'farm', DEFS.farm, 50);
    b.repairing = true;
    tickRepairs(state, 14);
    expect(b.repairing).toBe(true);
    tickRepairs(state, 1);
    expect(b.hp).toBe(b.maxHp);
    expect(b.repairing).toBe(false);
  });

  it('clamps at maxHp and clears the flag', () => {
    const state = createGameState();
    const b = damaged(state, 'farm', DEFS.farm, 90);
    b.repairing = true;
    tickRepairs(state, 60); // way past the remaining damage
    expect(b.hp).toBe(b.maxHp);
    expect(b.repairing).toBe(false);
    // Nothing left to repair: no further changes.
    expect(tickRepairs(state, 1)).toEqual([]);
  });
});
