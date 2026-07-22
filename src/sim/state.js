// Pure game-state module: no three.js, no DOM. Safe to import in node tests.

import { levelMultiplier, payCost } from './economy.js';

export const CONFIG = {
  dayLength: 90,
  nightLength: 60,
  startResources: { food: 50, water: 40, wood: 80, metal: 40, energy: 0, fuel: 10 },
  caps: { food: 150, water: 100, wood: 150, metal: 150, energy: 60, fuel: 50 },
  startSurvivors: 4,
};

const MAX_EVENTS = 50;

// Livello massimo di potenziamento degli edifici (★3); il moltiplicatore di
// resa per livello è levelMultiplier in sim/economy.js.
export const MAX_LEVEL = 3;

export function createGameState() {
  return {
    day: 1,
    phase: 'day', // 'day' | 'night'
    timeInPhase: 0,
    mapSeed: 0,
    resources: { ...CONFIG.startResources },
    caps: { ...CONFIG.caps },
    survivors: [],
    buildings: [],
    weather: { current: 'clear' },
    researchPoints: 0,
    researched: [],
    nextSurvivorId: 1,
    nextBuildingId: 1,
    events: [],
    gameOver: null,
    kills: 0,
    reputation: 0, // 0-100: cresce sopravvivendo e con le Radio, cala con le morti
    deathsToday: 0, // morti del giorno in corso, lette e azzerate all'alba
  };
}

// def is the building definition from src/buildings/definitions.js
// (needs at least { w, h, hp }). Returns the created building.
export function addBuilding(state, defId, def, x, z) {
  const building = {
    id: state.nextBuildingId++,
    defId,
    x,
    z,
    w: def.w,
    h: def.h,
    hp: def.hp,
    maxHp: def.hp,
    powered: true,
    workers: [],
    autoAssign: true,
    extracted: 0,
    efficiency: 1,
    enabled: true, // interruttore on/off: da spento l'edificio è inerte
    repairing: false, // riparazione in corso (vedi sim/repair.js)
    priority: 1, // priorità lavoratori: 0 bassa, 1 normale, 2 alta
    level: 1, // livello di potenziamento (fino a MAX_LEVEL)
  };
  state.buildings.push(building);
  return building;
}

// Un edificio è potenziabile quando produce risorse, estrae dai nodi o è una
// torre. Restano esclusi ricerca, posti letto, capBonus, guarnigione,
// trappole e muri.
export function isUpgradeable(def) {
  if (!def) return false;
  // Il Rifugio è unico e non ha costo di costruzione: non si potenzia.
  if (def.id === 'hq') return false;
  return (
    Object.keys(def.produces ?? {}).length > 0 || def.extracts != null || def.isTower === true
  );
}

// Costo del passaggio al livello successivo: il costo di costruzione × il
// livello attuale (L1→L2 costa 1×, L2→L3 costa 2×).
export function upgradeCost(b, def) {
  const cost = {};
  const level = b?.level ?? 1;
  for (const [resource, amount] of Object.entries(def?.cost ?? {})) {
    const price = amount * level;
    if (price > 0) cost[resource] = price;
  }
  return cost;
}

// Alza b di un livello: rifiuta — lasciando le risorse intoccate — al
// livello massimo, per def non potenziabili o senza fondi. In caso di
// successo paga upgradeCost, applica il nuovo livello e gli hp massimi
// maggiorati (def.hp × levelMultiplier); gli hp correnti salgono dello
// stesso delta. Funziona anche da spento: la potenza resta alla riattivazione.
// Il chiamante rinfreschi la tinta danno (visuals.setDamaged) col nuovo
// rapporto hp. Returns true on success.
export function upgradeBuilding(state, b, def) {
  if (!b || !isUpgradeable(def)) return false;
  const level = b.level ?? 1;
  if (level >= MAX_LEVEL) return false;
  if (!payCost(state, { cost: upgradeCost(b, def) })) return false;
  const prevMaxHp = b.maxHp;
  b.level = level + 1;
  b.maxHp = def.hp * levelMultiplier(b.level);
  b.hp = Math.min(b.maxHp, b.hp + (b.maxHp - prevMaxHp));
  return true;
}

export function addSurvivor(state) {
  const survivor = {
    id: state.nextSurvivorId++,
    hunger: 0,
    thirst: 0,
    buildingId: null,
  };
  state.survivors.push(survivor);
  return survivor;
}

export function removeBuilding(state, id) {
  const index = state.buildings.findIndex((b) => b.id === id);
  if (index === -1) return false;
  state.buildings.splice(index, 1);
  // Free any survivors who worked there.
  for (const s of state.survivors) {
    if (s.buildingId === id) s.buildingId = null;
  }
  return true;
}

export function findBuilding(state, id) {
  return state.buildings.find((b) => b.id === id) ?? null;
}

// Appends to the event log consumed by the UI; keeps only the last ~50 entries.
export function pushEvent(state, type, msg) {
  state.events.push({ day: state.day, phase: state.phase, type, msg });
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}
