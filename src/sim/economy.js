// Economy tick: resource production, fuel consumption, energy storage grid,
// build costs. Pure logic, no I/O.

import { CONFIG, pushEvent } from './state.js';
import { countNodesInRange } from './extraction.js';

// Minimum in-game seconds between two 'fuel' warnings from the same building.
const FUEL_WARN_INTERVAL = 30;

const DEFAULT_MODS = { farmProd: 1, rainProd: 1, solarProd: 1, windProd: 1, extractProd: 1 };

// Map node type extracted -> resource gained.
const EXTRACT_RESOURCES = { forest: 'wood', ruins: 'metal', ore: 'metal' };

// Resources covered by the HUD balance, in display order.
const BALANCE_RESOURCES = ['food', 'water', 'wood', 'metal', 'energy', 'fuel'];

// Per-survivor daily upkeep, derived from the survivors.js constants:
// hunger reaches 100 in 1.5 days and a meal (1 food) restores 40 points;
// thirst reaches 100 in 1 day and a drink (1 water) restores 40 points.
const SURVIVOR_FOOD_PER_DAY = 100 / (1.5 * 40); // ~1.67
const SURVIVOR_WATER_PER_DAY = 100 / (1 * 40); // 2.5

// Moltiplicatore di resa per livello di potenziamento (vedi upgradeBuilding
// in state.js): L1 ×1, L2 ×1.5, L3 ×2. Livello assente (vecchi save) = L1.
// Si applica a produzione, estrazione e danno delle torri — non a ricerca,
// posti letto, capBonus, guarnigione, trappole o muri.
export function levelMultiplier(level) {
  return 1 + 0.5 * ((level ?? 1) - 1);
}

function staffingRatio(building, def) {
  if (!def.jobs) return 1; // buildings without jobs run at full output
  return Math.min(building.workers.length, def.jobs) / def.jobs;
}

// A building has fuel when every resource in its `consumes` covers the whole
// tick. When fuel is missing the building stalls: it neither produces nor
// consumes anything.
function hasFuel(state, def, dt) {
  for (const [resource, perDay] of Object.entries(def.consumes ?? {})) {
    const needed = (perDay * dt) / CONFIG.dayLength;
    if ((state.resources[resource] ?? 0) < needed) return false;
  }
  return true;
}

function consumeFuel(state, def, dt) {
  for (const [resource, perDay] of Object.entries(def.consumes ?? {})) {
    const used = (perDay * dt) / CONFIG.dayLength;
    state.resources[resource] = Math.max(0, (state.resources[resource] ?? 0) - used);
  }
}

// Monotonic in-game clock in seconds, derived from day/phase/timeInPhase.
// Only used to throttle warnings, so the fixed day/night split is fine.
function gameTimeSeconds(state) {
  const dayCycle = CONFIG.dayLength + CONFIG.nightLength;
  const phaseOffset = state.phase === 'night' ? CONFIG.dayLength : 0;
  return (state.day - 1) * dayCycle + phaseOffset + state.timeInPhase;
}

function warnNoFuel(state, building, def) {
  const now = gameTimeSeconds(state);
  if (building.warnedAt != null && now - building.warnedAt < FUEL_WARN_INTERVAL) {
    return;
  }
  building.warnedAt = now;
  pushEvent(state, 'fuel', `${def.name} è fermo: manca carburante.`);
}

// Per-day energy output of a single building. Solar (energyDayOnly) only
// flows during the day phase and is scaled by mods.solarProd; wind turbines
// run around the clock and are scaled by mods.windProd. The building level
// scales the output like any other production.
function energyOutput(state, building, def, mods) {
  if (!def.produces?.energy) return 0;
  if (def.energyDayOnly && state.phase !== 'day') return 0;
  let mod = 1;
  if (def.energyDayOnly) mod = mods.solarProd;
  else if (building.defId === 'wind') mod = mods.windProd;
  return def.produces.energy * staffingRatio(building, def) * mod * levelMultiplier(building.level);
}

// Effective storage caps: the base caps plus every building's capBonus
// (batteries raise energy, cisterns water, warehouses food/wood/metal).
export function effectiveCaps(state, DEFS) {
  const caps = { ...(state.caps ?? {}) };
  for (const b of state.buildings) {
    for (const [resource, bonus] of Object.entries(DEFS[b.defId]?.capBonus ?? {})) {
      caps[resource] = (caps[resource] ?? 0) + bonus;
    }
  }
  return caps;
}

// Per-resource production modifiers from weather/research (mods) and the
// building's own site efficiency. Defs with a `proximity` rule (well, hunt,
// fish) scale only with their placement efficiency: in particular their
// food does not scale with farmProd.
function productionMod(building, def, resource, mods) {
  if (def.proximity) return building.efficiency ?? 1;
  if (resource === 'food') return mods.farmProd;
  if (resource === 'water' && building.defId === 'rain') return mods.rainProd;
  return 1;
}

// Advances the economy by dt seconds. DEFS maps defId -> building definition
// ({ cost, produces, consumes, jobs, requiresEnergy, energyDayOnly,
// capBonus, ... }); produces/consumes amounts are per full game day.
// mods carries optional production modifiers ({ farmProd, rainProd,
// solarProd, windProd }); it may be undefined, every modifier defaults to 1.
export function tickEconomy(state, dt, DEFS, mods) {
  const m = { ...DEFAULT_MODS, ...(mods ?? {}) };
  const caps = effectiveCaps(state, DEFS);

  // 1. Decide which buildings run this tick: a building needs staff (when it
  // has jobs) and fuel (its `consumes` resources for the whole tick).
  // Switched-off buildings are inert: no production, no fuel, no warnings.
  const running = new Map();
  for (const b of state.buildings) {
    const def = DEFS[b.defId];
    if (!def || b.enabled === false) {
      running.set(b, false);
      continue;
    }
    const staffed = staffingRatio(b, def) > 0;
    const fueled = hasFuel(state, def, dt);
    running.set(b, staffed && fueled);
    if (staffed && !fueled && def.produces?.energy) {
      warnNoFuel(state, b, def); // fuel-powered generators complain when dry
    }
  }

  // 2. Energy storage: integrate production minus consumption into the
  // stock, clamped to the effective capacity (base cap + cap bonuses).
  let produced = 0;
  let consumers = 0;
  for (const b of state.buildings) {
    const def = DEFS[b.defId];
    if (!def) continue;
    if (running.get(b)) produced += energyOutput(state, b, def, m);
    if (def.requiresEnergy && b.enabled !== false) consumers += def.requiresEnergy;
  }
  const stored =
    (state.resources.energy ?? 0) + ((produced - consumers) * dt) / CONFIG.dayLength;
  state.resources.energy = Math.min(caps.energy ?? Infinity, Math.max(0, stored));

  // 3. Power state: requiresEnergy buildings run while there is charge left;
  // switched-off buildings stay unpowered whatever the grid charge.
  for (const b of state.buildings) {
    const def = DEFS[b.defId];
    b.powered =
      b.enabled !== false && (!def || !def.requiresEnergy || state.resources.energy > 0);
  }

  // 4. Fuel consumption and resource production. Energy itself is handled
  // by the grid balance above, never added as a regular resource here.
  // Production = base × staffing × modifiers/site efficiency × level.
  for (const b of state.buildings) {
    const def = DEFS[b.defId];
    if (!def || !running.get(b) || !b.powered) continue;
    consumeFuel(state, def, dt);
    if (!def.produces) continue;
    const ratio = staffingRatio(b, def);
    const levelMul = levelMultiplier(b.level);
    for (const [resource, perDay] of Object.entries(def.produces)) {
      if (resource === 'energy') continue;
      const cap = caps[resource] ?? Infinity;
      const gain =
        (perDay * ratio * productionMod(b, def, resource, m) * levelMul * dt) / CONFIG.dayLength;
      state.resources[resource] = Math.min(cap, (state.resources[resource] ?? 0) + gain);
    }
  }
}

export function canAfford(state, def) {
  if (!def.cost) return true;
  // Epsilon: resources accumulate fractionally, so 29.999999 must count as 30.
  return Object.entries(def.cost).every(
    ([resource, amount]) => (state.resources[resource] ?? 0) + 1e-9 >= amount
  );
}

// Subtracts the cost if affordable. Returns true on success, false otherwise
// (resources are left untouched in that case).
export function payCost(state, def) {
  if (!canAfford(state, def)) return false;
  for (const [resource, amount] of Object.entries(def.cost ?? {})) {
    state.resources[resource] -= amount;
  }
  return true;
}

// Production modifier for the balance projection: mirrors productionMod and
// extends it to energy (solar/wind scaling).
function balanceProdMod(building, def, resource, mods) {
  if (resource === 'energy') {
    if (def.energyDayOnly) return mods.solarProd;
    if (building.defId === 'wind') return mods.windProd;
    return 1;
  }
  return productionMod(building, def, resource, mods);
}

// Effective per-day output of a single building, per resource: the same
// projection computeResourceBalance uses (staffing, power state, modifiers,
// site efficiency and building level folded in). Returns {} when the
// building produces nothing (switched off, unstaffed, unpowered or no
// `produces`). mods may be undefined.
export function buildingDailyOutput(b, def, mods) {
  const m = { ...DEFAULT_MODS, ...(mods ?? {}) };
  const output = {};
  if (!def || b.enabled === false || b.powered === false) return output;
  const ratio = staffingRatio(b, def);
  if (ratio <= 0) return output;
  const levelMul = levelMultiplier(b.level);
  for (const [resource, perDay] of Object.entries(def.produces ?? {})) {
    output[resource] = perDay * ratio * balanceProdMod(b, def, resource, m) * levelMul;
  }
  return output;
}

// Per-day resource balance for the HUD, projected from the current state.
// For every resource (food, water, wood, metal, energy, fuel) returns
// { produced: [{ label, rate }], consumed: [{ label, rate }], net } where
// label is the def name (suffixed with ' ×N' when several copies contribute)
// and rate is per game day. Buildings contribute when switched on, powered
// and staffed; fuel is counted only while the resource is in stock;
// extractors are skipped when a grid is passed and no nodes remain in
// range. Research points are not a resource and are excluded. mods may be
// undefined.
export function computeResourceBalance(state, DEFS, mods, grid) {
  const m = { ...DEFAULT_MODS, ...(mods ?? {}) };
  const buckets = {};
  for (const resource of BALANCE_RESOURCES) {
    buckets[resource] = { produced: new Map(), consumed: new Map() };
  }

  const add = (resource, kind, key, label, rate) => {
    const map = buckets[resource]?.[kind];
    if (!map || rate <= 0) return;
    const entry = map.get(key) ?? { label, rate: 0, count: 0 };
    entry.rate += rate;
    entry.count += 1;
    map.set(key, entry);
  };

  for (const b of state.buildings) {
    const def = DEFS[b.defId];
    if (!def || b.enabled === false) continue; // spento: inerte, zero consumi
    // Energy grid drain applies regardless of staffing.
    if (def.requiresEnergy) add('energy', 'consumed', b.defId, def.name, def.requiresEnergy);
    if (b.powered === false) continue;
    const ratio = staffingRatio(b, def);
    if (ratio <= 0) continue;
    for (const [resource, rate] of Object.entries(buildingDailyOutput(b, def, m))) {
      add(resource, 'produced', b.defId, def.name, rate);
    }
    for (const [resource, perDay] of Object.entries(def.consumes ?? {})) {
      if ((state.resources?.[resource] ?? 0) <= 0) continue; // stalled: no fuel to burn
      add(resource, 'consumed', b.defId, def.name, perDay);
    }
    if (def.extracts && def.extractRate) {
      const resource = EXTRACT_RESOURCES[def.extracts];
      const depleted = grid && countNodesInRange(grid, b, def.extracts) === 0;
      if (resource && !depleted) {
        const rate = def.extractRate * ratio * m.extractProd * levelMultiplier(b.level);
        add(resource, 'produced', b.defId, def.name, rate);
      }
    }
  }

  const survivors = state.survivors?.length ?? 0;
  if (survivors > 0) {
    const label = `Sopravvissuti ×${survivors}`;
    add('food', 'consumed', '__survivors', label, SURVIVOR_FOOD_PER_DAY * survivors);
    add('water', 'consumed', '__survivors', label, SURVIVOR_WATER_PER_DAY * survivors);
  }

  const balance = {};
  for (const resource of BALANCE_RESOURCES) {
    const { produced, consumed } = buckets[resource];
    const toList = (map) =>
      [...map.values()].map((e) => ({
        label: e.count > 1 ? `${e.label} ×${e.count}` : e.label,
        rate: e.rate,
      }));
    const producedList = toList(produced);
    const consumedList = toList(consumed);
    const sum = (list) => list.reduce((total, e) => total + e.rate, 0);
    balance[resource] = {
      produced: producedList,
      consumed: consumedList,
      net: sum(producedList) - sum(consumedList),
    };
  }
  return balance;
}
