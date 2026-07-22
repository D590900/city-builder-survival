// Tech tree: research point generation, spending and unlock checks.
// Pure logic, no I/O.

import { pushEvent } from './state.js';

const DAY_LENGTH = 90; // seconds per game day (mirrors state.js CONFIG)

export const TECHS = {
  forestry: {
    name: 'Forestry',
    desc: 'Unlocks the Forester: plants new trees on grassy terrain.',
    cost: 10,
    effects: {},
    unlocks: ['forester'],
  },
  batteries: {
    name: 'Energy Storage',
    desc: 'Unlocks the Battery: stores surplus energy production.',
    cost: 15,
    effects: {},
    unlocks: ['battery'],
  },
  solar2: {
    name: 'Advanced Photovoltaics',
    desc: 'Unlocks the Solar Plant, far more efficient than basic panels.',
    cost: 15,
    effects: {},
    unlocks: ['solar-plant'],
  },
  mining: {
    name: 'Deep Mining',
    desc: 'Unlocks the Mine: extracts metal from ore deposits.',
    cost: 20,
    effects: {},
    unlocks: ['mine'],
  },
  efficiency: {
    name: 'Efficiency',
    desc: 'Extractors produce 25% more resources.',
    cost: 20,
    effects: { extractProd: 1.25 },
    unlocks: [],
  },
  medicine: {
    name: 'Medicine',
    desc: 'Hunger and thirst grow 30% more slowly.',
    cost: 25,
    effects: { hungerRate: 0.7, thirstRate: 0.7 },
    unlocks: [],
  },
  ballistics: {
    name: 'Ballistics',
    desc: 'Towers deal 50% more damage and see farther. Unlocks the Sniper Turret.',
    cost: 25,
    effects: { towerDamage: 1.5, towerRangeMul: 1.17 },
    unlocks: ['sniper'],
  },
  concrete: {
    name: 'Reinforced Concrete',
    desc: 'Unlocks the Concrete Wall, the ultimate passive defense.',
    cost: 25,
    effects: {},
    unlocks: ['concrete-wall'],
  },
};

// Advances research by dt seconds: every lab (def.researchRate > 0) adds
// researchRate * (workers / jobs) * dt / dayLength points. Power is not
// required. Returns the updated total.
export function tickResearch(state, dt, DEFS) {
  let gain = 0;
  for (const b of state.buildings) {
    const def = DEFS[b.defId];
    if (!def || !(def.researchRate > 0)) continue;
    const ratio = def.jobs ? Math.min(b.workers.length, def.jobs) / def.jobs : 1;
    if (ratio <= 0) continue;
    gain += (def.researchRate * ratio * dt) / DAY_LENGTH;
  }
  if (gain > 0) {
    state.researchPoints = (state.researchPoints ?? 0) + gain;
  }
  return state.researchPoints ?? 0;
}

// True when the tech exists, is not yet researched and is affordable.
export function canResearch(state, id) {
  const tech = TECHS[id];
  if (!tech) return false;
  if (state.researched?.includes(id)) return false;
  return (state.researchPoints ?? 0) >= tech.cost;
}

// Spends the points and unlocks the tech. Returns true on success
// (points are left untouched on failure).
export function research(state, id) {
  if (!canResearch(state, id)) return false;
  const tech = TECHS[id];
  state.researchPoints -= tech.cost;
  state.researched = state.researched ?? [];
  state.researched.push(id);
  pushEvent(state, 'research', `Research complete: ${tech.name}.`);
  return true;
}

// True when the building definition is available given the researched techs.
export function isUnlocked(state, def) {
  return !def.requiresTech || (state.researched ?? []).includes(def.requiresTech);
}
