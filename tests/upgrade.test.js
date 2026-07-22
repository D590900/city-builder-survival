import { describe, it, expect } from 'vitest';
import {
  CONFIG,
  MAX_LEVEL,
  createGameState,
  addBuilding,
  isUpgradeable,
  upgradeCost,
  upgradeBuilding,
} from '../src/sim/state.js';

const DEFS = {
  farm: {
    id: 'farm', name: 'Fattoria', cost: { wood: 10, metal: 4 }, w: 2, h: 2, hp: 100,
    produces: { food: 12 }, consumes: { water: 3 }, jobs: 2,
  },
  lumber: {
    id: 'lumber', name: 'Tagliaboschi', cost: { wood: 10 }, w: 1, h: 1, hp: 80,
    produces: {}, consumes: {}, jobs: 2, extracts: 'forest', extractRate: 6,
  },
  tower: {
    id: 'tower', name: 'Torre di guardia', cost: { wood: 10 }, w: 1, h: 1, hp: 60,
    produces: {}, consumes: {}, jobs: 1, isTower: true, damage: 10,
  },
  warehouse: {
    id: 'warehouse', name: 'Magazzino', cost: { wood: 10 }, w: 2, h: 2, hp: 100,
    produces: {}, consumes: {}, jobs: 0, capBonus: { food: 100 },
  },
  tent: {
    id: 'tent', name: 'Tenda', cost: { wood: 10 }, w: 1, h: 1, hp: 50,
    produces: {}, consumes: {}, jobs: 0, houses: 2,
  },
};

describe('addBuilding defaults', () => {
  it('initializes priority 1 (normale) and level 1', () => {
    const state = createGameState();
    const b = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    expect(b.priority).toBe(1);
    expect(b.level).toBe(1);
  });
});

describe('isUpgradeable', () => {
  it('is true for producers, extractors and towers', () => {
    expect(isUpgradeable(DEFS.farm)).toBe(true);
    expect(isUpgradeable(DEFS.lumber)).toBe(true);
    expect(isUpgradeable(DEFS.tower)).toBe(true);
  });

  it('is false for defs without produces/extracts/isTower and for null defs', () => {
    expect(isUpgradeable(DEFS.warehouse)).toBe(false); // solo capBonus
    expect(isUpgradeable(DEFS.tent)).toBe(false); // solo posti letto
    expect(isUpgradeable(null)).toBe(false);
    expect(isUpgradeable({})).toBe(false);
  });

  it('is false for the hq: unico e senza costo di costruzione', () => {
    expect(isUpgradeable(DEFS.hq)).toBe(false);
  });
});

describe('upgradeCost', () => {
  it('is the build cost times the current level (L1 1×, L2 2×)', () => {
    const state = createGameState();
    const b = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    expect(upgradeCost(b, DEFS.farm)).toEqual({ wood: 10, metal: 4 });
    b.level = 2;
    expect(upgradeCost(b, DEFS.farm)).toEqual({ wood: 20, metal: 8 });
  });

  it('treats a missing level as 1 (retrocompat)', () => {
    expect(upgradeCost({}, DEFS.farm)).toEqual({ wood: 10, metal: 4 });
  });
});

describe('upgradeBuilding', () => {
  it('pays the cost, raises the level and heals by the maxHp delta', () => {
    const state = createGameState();
    const b = addBuilding(state, 'farm', DEFS.farm, 0, 0); // hp 100/100
    b.hp = 40; // danneggiata

    expect(upgradeBuilding(state, b, DEFS.farm)).toBe(true);
    expect(b.level).toBe(2);
    expect(b.maxHp).toBe(150); // 100 × 1.5
    expect(b.hp).toBe(90); // 40 + delta 50
    expect(state.resources.wood).toBe(CONFIG.startResources.wood - 10);
    expect(state.resources.metal).toBe(CONFIG.startResources.metal - 4);
  });

  it('clamps the hp at the new maxHp when already (nearly) full', () => {
    const state = createGameState();
    const b = addBuilding(state, 'farm', DEFS.farm, 0, 0); // hp pieni

    expect(upgradeBuilding(state, b, DEFS.farm)).toBe(true);
    expect(b.hp).toBe(150);
    expect(b.hp).toBe(b.maxHp);
  });

  it('refuses without funds and leaves resources and level untouched', () => {
    const state = createGameState();
    state.resources.wood = 5; // ne servono 10
    const b = addBuilding(state, 'farm', DEFS.farm, 0, 0);

    expect(upgradeBuilding(state, b, DEFS.farm)).toBe(false);
    expect(b.level).toBe(1);
    expect(b.maxHp).toBe(100);
    expect(state.resources.wood).toBe(5);
    expect(state.resources.metal).toBe(CONFIG.startResources.metal);
  });

  it('refuses at MAX_LEVEL without charging', () => {
    const state = createGameState();
    const b = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    b.level = MAX_LEVEL;
    expect(MAX_LEVEL).toBe(3);

    expect(upgradeBuilding(state, b, DEFS.farm)).toBe(false);
    expect(b.level).toBe(3);
    expect(state.resources.wood).toBe(CONFIG.startResources.wood);
    expect(state.resources.metal).toBe(CONFIG.startResources.metal);
  });

  it('refuses non-upgradeable defs (warehouse, tent)', () => {
    const state = createGameState();
    const warehouse = addBuilding(state, 'warehouse', DEFS.warehouse, 0, 0);
    const tent = addBuilding(state, 'tent', DEFS.tent, 3, 0);

    expect(upgradeBuilding(state, warehouse, DEFS.warehouse)).toBe(false);
    expect(upgradeBuilding(state, tent, DEFS.tent)).toBe(false);
    expect(warehouse.level).toBe(1);
    expect(tent.level).toBe(1);
    expect(state.resources.wood).toBe(CONFIG.startResources.wood);
  });

  it('works on a switched-off building (la potenza resta alla riattivazione)', () => {
    const state = createGameState();
    const b = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    b.enabled = false;

    expect(upgradeBuilding(state, b, DEFS.farm)).toBe(true);
    expect(b.level).toBe(2);
    expect(b.enabled).toBe(false);
  });

  it('reaches level 3 in two steps with escalating costs', () => {
    const state = createGameState();
    const b = addBuilding(state, 'tower', DEFS.tower, 0, 0);

    expect(upgradeBuilding(state, b, DEFS.tower)).toBe(true); // L1→L2: 1× costo
    expect(b.maxHp).toBe(90); // 60 × 1.5
    expect(upgradeBuilding(state, b, DEFS.tower)).toBe(true); // L2→L3: 2× costo
    expect(b.level).toBe(3);
    expect(b.maxHp).toBe(120); // 60 × 2
    expect(b.hp).toBe(120);
    expect(state.resources.wood).toBe(CONFIG.startResources.wood - 10 - 20);
  });
});
