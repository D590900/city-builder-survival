import { describe, it, expect } from 'vitest';
import { CONFIG, createGameState, addBuilding, addSurvivor } from '../src/sim/state.js';
import {
  tickEconomy,
  canAfford,
  payCost,
  effectiveCaps,
  computeResourceBalance,
  buildingDailyOutput,
  levelMultiplier,
} from '../src/sim/economy.js';

// Minimal defs shaped like the real v3 definitions, with round numbers.
const DEFS = {
  hq: {
    id: 'hq', name: 'Rifugio', cost: {}, w: 3, h: 3, hp: 100,
    produces: { energy: 4 }, consumes: {}, jobs: 0,
  },
  farm: {
    id: 'farm', name: 'Fattoria', cost: { wood: 10 }, w: 2, h: 2, hp: 50,
    produces: { food: 12 }, consumes: { water: 3 }, jobs: 2,
  },
  rain: {
    id: 'rain', name: 'Raccoglitore di pioggia', cost: { wood: 5 }, w: 1, h: 1, hp: 20,
    produces: { water: 4 }, consumes: {}, jobs: 0,
  },
  well: {
    id: 'well', name: 'Pozzo', cost: { wood: 5 }, w: 1, h: 1, hp: 20,
    produces: { water: 8 }, consumes: {}, jobs: 0,
    proximity: { tile: 'water', range: 3, poor: 0.4 },
  },
  hunt: {
    id: 'hunt', name: 'Capanno da caccia', cost: { wood: 5 }, w: 1, h: 1, hp: 20,
    produces: { food: 6 }, consumes: {}, jobs: 1,
    proximity: { tile: 'forest', range: 3, poor: 0.5 },
  },
  fish: {
    id: 'fish', name: 'Capanno da pesca', cost: { wood: 5 }, w: 1, h: 1, hp: 20,
    produces: { food: 5 }, consumes: {}, jobs: 1,
    proximity: { tile: 'water', range: 2, poor: 0.5 },
  },
  solar: {
    id: 'solar', name: 'Pannello solare', cost: { metal: 5 }, w: 1, h: 1, hp: 20,
    produces: { energy: 10 }, consumes: {}, jobs: 0, energyDayOnly: true,
  },
  wind: {
    id: 'wind', name: 'Turbina eolica', cost: { metal: 5 }, w: 1, h: 1, hp: 20,
    produces: { energy: 3 }, consumes: {}, jobs: 0,
  },
  generator: {
    id: 'generator', name: 'Generatore', cost: { metal: 10 }, w: 1, h: 1, hp: 30,
    produces: { energy: 6 }, consumes: { wood: 3 }, jobs: 1,
  },
  battery: {
    id: 'battery', name: 'Batteria', cost: { metal: 10 }, w: 1, h: 1, hp: 20,
    produces: {}, consumes: {}, jobs: 0, capBonus: { energy: 50 },
  },
  cistern: {
    id: 'cistern', name: 'Cisterna', cost: { metal: 5 }, w: 1, h: 1, hp: 20,
    produces: { water: 2 }, consumes: {}, jobs: 0, capBonus: { water: 60 },
  },
  warehouse: {
    id: 'warehouse', name: 'Magazzino', cost: { wood: 10 }, w: 2, h: 2, hp: 30,
    produces: {}, consumes: {}, jobs: 0, capBonus: { food: 100, wood: 100, metal: 100 },
  },
  lumber: {
    id: 'lumber', name: 'Tagliaboschi', cost: { wood: 5 }, w: 1, h: 1, hp: 30,
    produces: {}, consumes: {}, jobs: 2, extracts: 'forest', extractRate: 6,
  },
  tower: {
    id: 'tower', name: 'Torre di guardia', cost: { wood: 5, metal: 5 }, w: 1, h: 1, hp: 40,
    produces: {}, consumes: {}, jobs: 1, requiresEnergy: 1,
  },
  sniper: {
    id: 'sniper', name: 'Torretta automatica', cost: { metal: 5 }, w: 1, h: 1, hp: 40,
    produces: {}, consumes: {}, jobs: 1, requiresEnergy: 2,
  },
};

function staff(state, building, count) {
  for (let i = 0; i < count; i++) {
    const s = addSurvivor(state);
    s.buildingId = building.id;
    building.workers.push(s.id);
  }
}

// Assigns fake worker ids without creating survivors (keeps the survivor
// upkeep out of resource-balance expectations).
function fakeStaff(building, count) {
  for (let i = 0; i < count; i++) building.workers.push(1000 + i);
}

function fuelEvents(state) {
  return state.events.filter((e) => e.type === 'fuel');
}

// Minimal grid shaped like world/grid.js output: all grass unless overridden
// by `types` ('x,z' -> cell type).
function mkGrid(types = {}) {
  const size = 9;
  const cells = [];
  for (let z = 0; z < size; z++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push({ type: types[`${x},${z}`] ?? 'grass' });
    cells.push(row);
  }
  return { size, cells };
}

describe('resource production', () => {
  it('produces nothing and consumes nothing without workers', () => {
    const state = createGameState();
    addBuilding(state, 'farm', DEFS.farm, 0, 0);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBe(CONFIG.startResources.food);
    expect(state.resources.water).toBe(CONFIG.startResources.water);
  });

  it('produces the full per-day amount and burns fuel with full staff', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    tickEconomy(state, CONFIG.dayLength, DEFS); // mods omitted: all default to 1
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 12);
    expect(state.resources.water).toBeCloseTo(CONFIG.startResources.water - 3);
  });

  it('scales production linearly with assigned workers', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 1); // 1 of 2 jobs
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 6);
  });

  it('respects resource caps', () => {
    const state = createGameState();
    state.resources.food = 149;
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBe(state.caps.food);
  });

  it('cap bonuses raise the production clamp (warehouse food cap)', () => {
    const state = createGameState();
    state.resources.food = 149;
    addBuilding(state, 'warehouse', DEFS.warehouse, 4, 0); // +100 food cap
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBeCloseTo(161); // not clamped at 150 anymore
  });

  it('stalls without fuel: no production and no consumption', () => {
    const state = createGameState();
    state.resources.water = 0;
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBe(CONFIG.startResources.food);
    expect(state.resources.water).toBe(0);
  });

  it('stalls when the fuel left covers only part of the tick', () => {
    const state = createGameState();
    state.resources.water = 2; // needs 3 for a full day
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBe(CONFIG.startResources.food);
    expect(state.resources.water).toBe(2);
  });
});

describe('production modifiers', () => {
  it('farmProd scales food production', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    tickEconomy(state, CONFIG.dayLength, DEFS, { farmProd: 2 });
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 24);
  });

  it('rainProd scales water from rain collectors', () => {
    const state = createGameState();
    addBuilding(state, 'rain', DEFS.rain, 0, 0);
    tickEconomy(state, CONFIG.dayLength, DEFS, { rainProd: 1.5 });
    expect(state.resources.water).toBeCloseTo(CONFIG.startResources.water + 6);
  });

  it('rain collectors produce the base amount without modifiers', () => {
    const state = createGameState();
    addBuilding(state, 'rain', DEFS.rain, 0, 0);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.water).toBeCloseTo(CONFIG.startResources.water + 4);
  });

  it('well production scales with the site efficiency (passive, no workers)', () => {
    const state = createGameState();
    const well = addBuilding(state, 'well', DEFS.well, 0, 0);
    well.efficiency = 0.5;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.water).toBeCloseTo(CONFIG.startResources.water + 4);
  });

  it('hunt production scales with the site efficiency', () => {
    const state = createGameState();
    const hunt = addBuilding(state, 'hunt', DEFS.hunt, 0, 0);
    staff(state, hunt, 1);
    hunt.efficiency = 0.5;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 3); // 6 × 0.5
  });

  it('fish production scales with the site efficiency', () => {
    const state = createGameState();
    const fish = addBuilding(state, 'fish', DEFS.fish, 0, 0);
    staff(state, fish, 1);
    fish.efficiency = 0.5;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 2.5); // 5 × 0.5
  });

  it('food from hunt and fish does not scale with farmProd', () => {
    const state = createGameState();
    const hunt = addBuilding(state, 'hunt', DEFS.hunt, 0, 0);
    staff(state, hunt, 1); // full efficiency (1)
    const fish = addBuilding(state, 'fish', DEFS.fish, 2, 0);
    staff(state, fish, 1);
    tickEconomy(state, CONFIG.dayLength, DEFS, { farmProd: 3 });
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 6 + 5);
  });

  it('solarProd scales solar energy production', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    tickEconomy(state, CONFIG.dayLength, DEFS, { solarProd: 2 });
    expect(state.resources.energy).toBeCloseTo(20);
  });

  it('windProd scales wind turbine production, day and night', () => {
    const state = createGameState();
    addBuilding(state, 'wind', DEFS.wind, 0, 0);
    tickEconomy(state, CONFIG.dayLength, DEFS, { windProd: 2 });
    expect(state.resources.energy).toBeCloseTo(6);

    state.resources.energy = 0;
    state.phase = 'night';
    tickEconomy(state, CONFIG.dayLength, DEFS, { windProd: 2 });
    expect(state.resources.energy).toBeCloseTo(6); // turbines also run at night
  });

  it('wind turbines produce the base amount without modifiers', () => {
    const state = createGameState();
    addBuilding(state, 'wind', DEFS.wind, 0, 0);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBeCloseTo(3);
  });
});

describe('effectiveCaps', () => {
  it('returns the base caps when no building grants a bonus', () => {
    const state = createGameState();
    addBuilding(state, 'farm', DEFS.farm, 0, 0);
    expect(effectiveCaps(state, DEFS)).toEqual(state.caps);
  });

  it('sums capBonus over every building, per resource', () => {
    const state = createGameState();
    addBuilding(state, 'battery', DEFS.battery, 0, 0);
    addBuilding(state, 'battery', DEFS.battery, 1, 0);
    addBuilding(state, 'cistern', DEFS.cistern, 2, 0);
    addBuilding(state, 'warehouse', DEFS.warehouse, 0, 2);
    const caps = effectiveCaps(state, DEFS);
    expect(caps.energy).toBe(state.caps.energy + 100); // 2 batteries × 50
    expect(caps.water).toBe(state.caps.water + 60);
    expect(caps.food).toBe(state.caps.food + 100);
    expect(caps.wood).toBe(state.caps.wood + 100);
    expect(caps.metal).toBe(state.caps.metal + 100);
  });

  it('ignores unknown def ids and defs without capBonus', () => {
    const state = createGameState();
    addBuilding(state, 'ghost', { id: 'ghost', w: 1, h: 1, hp: 1 }, 0, 0);
    addBuilding(state, 'farm', DEFS.farm, 2, 0);
    expect(effectiveCaps(state, DEFS)).toEqual(state.caps);
  });
});

describe('energy storage', () => {
  it('solar charges the stock only during the day phase', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBeCloseTo(10);

    state.phase = 'night';
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBeCloseTo(10); // no nightly production
  });

  it('integrates production minus the requiresEnergy drain of each consumer', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    addBuilding(state, 'tower', DEFS.tower, 2, 0);
    addBuilding(state, 'sniper', DEFS.sniper, 3, 0); // drains 2/day
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBeCloseTo(7); // 10 produced - 1 - 2
  });

  it('the hq generator runs day and night without workers', () => {
    const state = createGameState();
    addBuilding(state, 'hq', DEFS.hq, 0, 0);
    state.phase = 'night';
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBeCloseTo(4);
  });

  it('powers requiresEnergy buildings while any charge is left', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    const tower = addBuilding(state, 'tower', DEFS.tower, 2, 0);
    tickEconomy(state, 1, DEFS); // a single second already stores some charge
    expect(state.resources.energy).toBeGreaterThan(0);
    expect(tower.powered).toBe(true);
  });

  it('drains the stock and unpowers consumers when it hits zero', () => {
    const state = createGameState();
    const tower = addBuilding(state, 'tower', DEFS.tower, 0, 0);
    state.resources.energy = 5;
    tickEconomy(state, CONFIG.dayLength, DEFS); // -1/day, no production
    expect(state.resources.energy).toBeCloseTo(4);
    expect(tower.powered).toBe(true);

    state.resources.energy = 0.5;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBe(0);
    expect(tower.powered).toBe(false);
  });

  it('clamps the stock at the base cap', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    state.resources.energy = 55;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBe(state.caps.energy); // 60
  });

  it('batteries add their capBonus to the storage cap', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    addBuilding(state, 'battery', DEFS.battery, 2, 0);
    state.resources.energy = 105;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBe(110); // 60 base + 50 battery
  });
});

describe('generator fuel', () => {
  it('burns wood to produce energy, even at night', () => {
    const state = createGameState();
    const gen = addBuilding(state, 'generator', DEFS.generator, 0, 0);
    staff(state, gen, 1);
    state.phase = 'night';
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBeCloseTo(6);
    expect(state.resources.wood).toBeCloseTo(CONFIG.startResources.wood - 3);
  });

  it('without wood it stalls and pushes a single throttled fuel event', () => {
    const state = createGameState();
    state.resources.wood = 0;
    const gen = addBuilding(state, 'generator', DEFS.generator, 0, 0);
    staff(state, gen, 1);
    tickEconomy(state, 1, DEFS);
    expect(state.resources.energy).toBe(0);
    expect(state.resources.wood).toBe(0);
    expect(fuelEvents(state)).toHaveLength(1);

    // Same in-game clock: the warning is throttled.
    tickEconomy(state, 1, DEFS);
    expect(fuelEvents(state)).toHaveLength(1);
  });

  it('warns again once the throttle interval has passed', () => {
    const state = createGameState();
    state.resources.wood = 0;
    const gen = addBuilding(state, 'generator', DEFS.generator, 0, 0);
    staff(state, gen, 1);
    tickEconomy(state, 1, DEFS);
    state.timeInPhase = 31; // > 30s later
    tickEconomy(state, 1, DEFS);
    expect(fuelEvents(state)).toHaveLength(2);
  });
});

describe('distillery and garage fuel', () => {
  // Local fake defs shaped like the real distillery/garage, round numbers.
  const distillery = {
    id: 'distillery', name: 'Distillatore', cost: { wood: 10 }, w: 1, h: 1, hp: 30,
    produces: { fuel: 4 }, consumes: { wood: 3 }, jobs: 1,
  };
  const garage = {
    id: 'garage', name: 'Autorimessa', cost: { wood: 10 }, w: 2, h: 2, hp: 30,
    produces: {}, consumes: { fuel: 3 }, jobs: 1,
  };
  const defs = { ...DEFS, distillery, garage };

  it('the distillery burns wood to produce fuel', () => {
    const state = createGameState();
    const d = addBuilding(state, 'distillery', defs.distillery, 0, 0);
    staff(state, d, 1);
    tickEconomy(state, CONFIG.dayLength, defs);
    expect(state.resources.fuel).toBeCloseTo(CONFIG.startResources.fuel + 4);
    expect(state.resources.wood).toBeCloseTo(CONFIG.startResources.wood - 3);
  });

  it('the distillery stalls without wood: no fuel, no consumption', () => {
    const state = createGameState();
    state.resources.wood = 0;
    const d = addBuilding(state, 'distillery', defs.distillery, 0, 0);
    staff(state, d, 1);
    tickEconomy(state, CONFIG.dayLength, defs);
    expect(state.resources.fuel).toBe(CONFIG.startResources.fuel);
    expect(state.resources.wood).toBe(0);
  });

  it('the garage burns fuel and stalls without it', () => {
    const state = createGameState();
    const g = addBuilding(state, 'garage', defs.garage, 0, 0);
    staff(state, g, 1);
    tickEconomy(state, CONFIG.dayLength, defs);
    expect(state.resources.fuel).toBeCloseTo(CONFIG.startResources.fuel - 3);

    state.resources.fuel = 2; // meno dei 3/giorno richiesti: resta intatto
    tickEconomy(state, CONFIG.dayLength, defs);
    expect(state.resources.fuel).toBe(2);
  });

  it('fuel production respects the fuel cap', () => {
    const state = createGameState();
    state.resources.fuel = state.caps.fuel - 1;
    const d = addBuilding(state, 'distillery', defs.distillery, 0, 0);
    staff(state, d, 1);
    tickEconomy(state, CONFIG.dayLength, defs);
    expect(state.resources.fuel).toBe(state.caps.fuel);
  });

  it('the balance reports fuel production and consumption', () => {
    const state = createGameState();
    fakeStaff(addBuilding(state, 'distillery', defs.distillery, 0, 0), 1);
    fakeStaff(addBuilding(state, 'garage', defs.garage, 2, 0), 1);
    const balance = computeResourceBalance(state, defs);
    expect(balance.fuel.produced).toEqual([{ label: 'Distillatore', rate: 4 }]);
    expect(balance.fuel.consumed).toEqual([{ label: 'Autorimessa', rate: 3 }]);
    expect(balance.wood.consumed).toEqual([{ label: 'Distillatore', rate: 3 }]);
    expect(balance.fuel.net).toBeCloseTo(1);

    // Senza carburante a stock il consumo del garage sparisce dal bilancio.
    state.resources.fuel = 0;
    expect(computeResourceBalance(state, defs).fuel.consumed).toEqual([]);
  });
});

describe('computeResourceBalance', () => {
  it('reports producers, consumers and the net per resource', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    fakeStaff(farm, 2);
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.food.produced).toEqual([{ label: 'Fattoria', rate: 12 }]);
    expect(balance.water.consumed).toEqual([{ label: 'Fattoria', rate: 3 }]);
    expect(balance.food.net).toBeCloseTo(12);
    expect(balance.water.net).toBeCloseTo(-3);
    expect(balance.wood.net).toBe(0);
    expect(balance.metal.net).toBe(0);
    expect(balance.energy.net).toBe(0);
  });

  it('groups identical buildings into a single ×N entry', () => {
    const state = createGameState();
    fakeStaff(addBuilding(state, 'farm', DEFS.farm, 0, 0), 2);
    fakeStaff(addBuilding(state, 'farm', DEFS.farm, 3, 0), 2);
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.food.produced).toEqual([{ label: 'Fattoria ×2', rate: 24 }]);
    expect(balance.water.consumed).toEqual([{ label: 'Fattoria ×2', rate: 6 }]);
  });

  it('applies production modifiers (farmProd, rainProd, solarProd, windProd, efficiency)', () => {
    const state = createGameState();
    fakeStaff(addBuilding(state, 'farm', DEFS.farm, 0, 0), 2);
    addBuilding(state, 'rain', DEFS.rain, 3, 0);
    const well = addBuilding(state, 'well', DEFS.well, 4, 0);
    well.efficiency = 0.5;
    addBuilding(state, 'solar', DEFS.solar, 5, 0);
    addBuilding(state, 'wind', DEFS.wind, 6, 0);
    const mods = { farmProd: 2, rainProd: 3, solarProd: 0.5, windProd: 2 };
    const balance = computeResourceBalance(state, DEFS, mods);
    expect(balance.food.produced).toEqual([{ label: 'Fattoria', rate: 24 }]);
    expect(balance.water.produced).toEqual([
      { label: 'Raccoglitore di pioggia', rate: 12 },
      { label: 'Pozzo', rate: 4 },
    ]);
    expect(balance.energy.produced).toEqual([
      { label: 'Pannello solare', rate: 5 },
      { label: 'Turbina eolica', rate: 6 },
    ]);
  });

  it('counts the requiresEnergy drain as energy consumption, even unpowered', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    const tower = addBuilding(state, 'tower', DEFS.tower, 2, 0);
    const sniper = addBuilding(state, 'sniper', DEFS.sniper, 3, 0);
    tower.powered = false;
    sniper.powered = false;
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.energy.consumed).toEqual([
      { label: 'Torre di guardia', rate: 1 },
      { label: 'Torretta automatica', rate: 2 },
    ]);
    expect(balance.energy.net).toBeCloseTo(10 - 3);
  });

  it('skips unstaffed and unpowered producers', () => {
    const state = createGameState();
    addBuilding(state, 'farm', DEFS.farm, 0, 0); // no workers
    const rain = addBuilding(state, 'rain', DEFS.rain, 3, 0);
    rain.powered = false;
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.food.produced).toEqual([]);
    expect(balance.water.produced).toEqual([]);
  });

  it('counts fuel consumption only while the resource is in stock', () => {
    const state = createGameState();
    state.resources.water = 0;
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    fakeStaff(farm, 2);
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.water.consumed).toEqual([]); // stalled: nothing to burn
    expect(balance.food.produced).toEqual([{ label: 'Fattoria', rate: 12 }]);
  });

  it('scales extractor output with extractProd when no grid is passed', () => {
    const state = createGameState();
    const lumber = addBuilding(state, 'lumber', DEFS.lumber, 0, 0);
    fakeStaff(lumber, 1); // 1 of 2 jobs
    const balance = computeResourceBalance(state, DEFS, { extractProd: 1.25 });
    expect(balance.wood.produced).toEqual([{ label: 'Tagliaboschi', rate: 6 * 0.5 * 1.25 }]);
  });

  it('includes extractors with nodes in range, skips depleted ones', () => {
    const state = createGameState();
    const lumber = addBuilding(state, 'lumber', DEFS.lumber, 0, 0);
    fakeStaff(lumber, 2);

    const withForest = computeResourceBalance(state, DEFS, undefined, mkGrid({ '2,2': 'forest' }));
    expect(withForest.wood.produced).toEqual([{ label: 'Tagliaboschi', rate: 6 }]);

    const depleted = computeResourceBalance(state, DEFS, undefined, mkGrid());
    expect(depleted.wood.produced).toEqual([]);
  });

  it('counts survivor upkeep: ~1.67 food and 2.5 water per survivor per day', () => {
    const state = createGameState();
    addSurvivor(state);
    addSurvivor(state);
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.food.consumed).toEqual([
      { label: 'Survivors ×2', rate: (100 / (1.5 * 40)) * 2 },
    ]);
    expect(balance.water.consumed).toEqual([{ label: 'Survivors ×2', rate: 5 }]);
    expect(balance.food.net).toBeCloseTo(-3.333, 2);
    expect(balance.water.net).toBeCloseTo(-5);
  });

  it('excludes research points from the balance', () => {
    const state = createGameState();
    const defs = { ...DEFS, lab: { id: 'lab', name: 'Laboratorio', w: 2, h: 2, jobs: 2, researchRate: 4, produces: {}, consumes: {} } };
    const lab = addBuilding(state, 'lab', defs.lab, 0, 0);
    fakeStaff(lab, 2);
    const balance = computeResourceBalance(state, defs);
    for (const resource of ['food', 'water', 'wood', 'metal', 'energy']) {
      expect(balance[resource].produced, resource).toEqual([]);
      expect(balance[resource].consumed, resource).toEqual([]);
    }
  });
});

describe('buildingDailyOutput', () => {
  it('returns the base per-day rate with no modifiers and full staffing', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    expect(buildingDailyOutput(farm, DEFS.farm)).toEqual({ food: 12 });
  });

  it('folds the site efficiency in: a well at 0.4 yields 3.2 water/day', () => {
    const state = createGameState();
    const well = addBuilding(state, 'well', DEFS.well, 0, 0); // passive: jobs 0
    well.efficiency = 0.4;
    expect(buildingDailyOutput(well, DEFS.well).water).toBeCloseTo(3.2);
  });

  it('scales with staffing and site efficiency, ignoring farmProd for hunt', () => {
    const state = createGameState();
    const hunt = addBuilding(state, 'hunt', DEFS.hunt, 0, 0);
    staff(state, hunt, 1);
    hunt.efficiency = 0.5;
    expect(buildingDailyOutput(hunt, DEFS.hunt, { farmProd: 3 }).food).toBeCloseTo(3);
  });

  it('returns {} when unstaffed or unpowered', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0); // no workers
    expect(buildingDailyOutput(farm, DEFS.farm)).toEqual({});
    staff(state, farm, 2);
    farm.powered = false;
    expect(buildingDailyOutput(farm, DEFS.farm)).toEqual({});
  });

  it('matches the produced rates of computeResourceBalance', () => {
    const state = createGameState();
    const well = addBuilding(state, 'well', DEFS.well, 0, 0);
    well.efficiency = 0.4;
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.water.produced).toEqual([
      { label: 'Pozzo', rate: buildingDailyOutput(well, DEFS.well).water },
    ]);
  });
});

describe('building levels (potenziamento)', () => {
  it('levelMultiplier: L1 ×1, L2 ×1.5, L3 ×2, missing level = L1', () => {
    expect(levelMultiplier(1)).toBe(1);
    expect(levelMultiplier(2)).toBe(1.5);
    expect(levelMultiplier(3)).toBe(2);
    expect(levelMultiplier(undefined)).toBe(1);
  });

  it('scales production with the level', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    farm.level = 2;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 18); // 12 × 1.5
    expect(state.resources.water).toBeCloseTo(CONFIG.startResources.water - 3); // consumi invariati
  });

  it('scales energy production with the level', () => {
    const state = createGameState();
    const solar = addBuilding(state, 'solar', DEFS.solar, 0, 0);
    solar.level = 3;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBeCloseTo(20); // 10 × 2
  });

  it('applies after the site efficiency: base × efficiency × level', () => {
    const state = createGameState();
    const well = addBuilding(state, 'well', DEFS.well, 0, 0);
    well.efficiency = 0.5;
    well.level = 2;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.water).toBeCloseTo(CONFIG.startResources.water + 6); // 8 × 0.5 × 1.5
  });

  it('buildingDailyOutput folds the level in', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    farm.level = 3;
    expect(buildingDailyOutput(farm, DEFS.farm)).toEqual({ food: 24 }); // 12 × 2
  });

  it('computeResourceBalance shows leveled production and extraction rates', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    fakeStaff(farm, 2);
    farm.level = 2;
    const lumber = addBuilding(state, 'lumber', DEFS.lumber, 3, 0);
    fakeStaff(lumber, 2);
    lumber.level = 2;
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.food.produced).toEqual([{ label: 'Fattoria', rate: 18 }]); // 12 × 1.5
    expect(balance.wood.produced).toEqual([{ label: 'Tagliaboschi', rate: 9 }]); // 6 × 1.5
    expect(balance.water.consumed).toEqual([{ label: 'Fattoria', rate: 3 }]); // consumi invariati
  });

  it('a missing level field counts as level 1 (retrocompat)', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    delete farm.level;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBeCloseTo(CONFIG.startResources.food + 12);
  });
});

describe('switched-off buildings (enabled === false)', () => {
  it('produce nothing and consume nothing, even staffed and fueled', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    farm.enabled = false;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.food).toBe(CONFIG.startResources.food);
    expect(state.resources.water).toBe(CONFIG.startResources.water);
  });

  it('skip the energy grid: no production and no requiresEnergy drain', () => {
    const state = createGameState();
    const solar = addBuilding(state, 'solar', DEFS.solar, 0, 0);
    const tower = addBuilding(state, 'tower', DEFS.tower, 2, 0);
    solar.enabled = false;
    tower.enabled = false;
    tickEconomy(state, CONFIG.dayLength, DEFS);
    expect(state.resources.energy).toBe(0); // né 10 prodotti né 1 consumato
    expect(solar.powered).toBe(false);
    expect(tower.powered).toBe(false);
  });

  it('stay unpowered even with charge in the grid, and repower when re-enabled', () => {
    const state = createGameState();
    addBuilding(state, 'solar', DEFS.solar, 0, 0);
    const tower = addBuilding(state, 'tower', DEFS.tower, 2, 0);
    tower.enabled = false;
    tickEconomy(state, 1, DEFS);
    expect(state.resources.energy).toBeGreaterThan(0);
    expect(tower.powered).toBe(false);

    tower.enabled = true;
    tickEconomy(state, 1, DEFS);
    expect(tower.powered).toBe(true);
  });

  it('buildingDailyOutput returns {} for a switched-off building', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    staff(state, farm, 2);
    farm.enabled = false; // powered resta true: conta enabled
    expect(buildingDailyOutput(farm, DEFS.farm)).toEqual({});
  });

  it('computeResourceBalance skips them entirely (production, fuel, drain)', () => {
    const state = createGameState();
    const farm = addBuilding(state, 'farm', DEFS.farm, 0, 0);
    fakeStaff(farm, 2);
    const tower = addBuilding(state, 'tower', DEFS.tower, 3, 0);
    farm.enabled = false;
    tower.enabled = false;
    const balance = computeResourceBalance(state, DEFS);
    expect(balance.food.produced).toEqual([]);
    expect(balance.water.consumed).toEqual([]);
    expect(balance.energy.consumed).toEqual([]);
    expect(balance.energy.net).toBe(0);
  });
});

describe('costs', () => {
  it('canAfford checks every cost resource', () => {
    const state = createGameState();
    expect(canAfford(state, DEFS.farm)).toBe(true); // { wood: 10 }
    expect(canAfford(state, { cost: { wood: 20, metal: 10 } })).toBe(true);
    expect(canAfford(state, { cost: { wood: 999 } })).toBe(false);
    expect(canAfford(state, { cost: { wood: 10, metal: 999 } })).toBe(false);
    expect(canAfford(state, { cost: {} })).toBe(true);
    expect(canAfford(state, {})).toBe(true);
  });

  it('canAfford tolerates fractional resources just below an integer cost', () => {
    const state = createGameState();
    state.resources.wood = 30 - 1e-10; // produced fractionally, displayed as 30
    expect(canAfford(state, { cost: { wood: 30 } })).toBe(true);
    state.resources.wood = 29.5;
    expect(canAfford(state, { cost: { wood: 30 } })).toBe(false);
  });

  it('payCost subtracts every resource and returns true', () => {
    const state = createGameState();
    expect(payCost(state, { cost: { wood: 20, metal: 10 } })).toBe(true);
    expect(state.resources.wood).toBe(CONFIG.startResources.wood - 20);
    expect(state.resources.metal).toBe(CONFIG.startResources.metal - 10);
  });

  it('payCost fails without enough resources and leaves them untouched', () => {
    const state = createGameState();
    expect(payCost(state, { cost: { wood: 20, metal: 999 } })).toBe(false);
    expect(state.resources.wood).toBe(CONFIG.startResources.wood);
    expect(state.resources.metal).toBe(CONFIG.startResources.metal);
  });
});
