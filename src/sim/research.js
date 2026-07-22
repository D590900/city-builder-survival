// Tech tree: research point generation, spending and unlock checks.
// Pure logic, no I/O.

import { pushEvent } from './state.js';

const DAY_LENGTH = 90; // seconds per game day (mirrors state.js CONFIG)

export const TECHS = {
  forestry: {
    name: 'Silvicoltura',
    desc: 'Sblocca il Guardaboschi: pianta nuovi alberi sui terreni erbosi.',
    cost: 10,
    effects: {},
    unlocks: ['forester'],
  },
  batteries: {
    name: 'Accumulo',
    desc: "Sblocca la Batteria: immagazzina l'energia prodotta in eccesso.",
    cost: 15,
    effects: {},
    unlocks: ['battery'],
  },
  solar2: {
    name: 'Fotovoltaico avanzato',
    desc: 'Sblocca la Centrale solare, molto più efficiente dei pannelli base.',
    cost: 15,
    effects: {},
    unlocks: ['solar-plant'],
  },
  mining: {
    name: 'Estrazione profonda',
    desc: 'Sblocca la Miniera: estrae metallo dai depositi di minerale.',
    cost: 20,
    effects: {},
    unlocks: ['mine'],
  },
  efficiency: {
    name: 'Efficienza',
    desc: 'Gli estrattori producono il 25% di risorse in più.',
    cost: 20,
    effects: { extractProd: 1.25 },
    unlocks: [],
  },
  medicine: {
    name: 'Medicina',
    desc: 'Fame e sete crescono il 30% più lentamente.',
    cost: 25,
    effects: { hungerRate: 0.7, thirstRate: 0.7 },
    unlocks: [],
  },
  ballistics: {
    name: 'Balistica',
    desc: 'Le torri infliggono il 50% di danni in più e vedono più lontano. Sblocca la Torretta automatica.',
    cost: 25,
    effects: { towerDamage: 1.5, towerRangeMul: 1.17 },
    unlocks: ['sniper'],
  },
  concrete: {
    name: 'Cemento armato',
    desc: 'Sblocca il Muro in cemento armato, la difesa passiva definitiva.',
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
  pushEvent(state, 'research', `Ricerca completata: ${tech.name}.`);
  return true;
}

// True when the building definition is available given the researched techs.
export function isUnlocked(state, def) {
  return !def.requiresTech || (state.researched ?? []).includes(def.requiresTech);
}
