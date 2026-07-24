// Save/load and best-run record, persisted in localStorage (save v4).
// Pure data in/out — no DOM, no rendering: restoreSave rebuilds grid + state
// from the save data, saveGame serializes them back. The endless mode has no
// victory: the record is the number of nights survived, kept apart from the
// save so it survives restarts.

import {
  CONFIG,
  MAX_LEVEL,
  createGameState,
  addBuilding,
  addSurvivor,
} from './sim/state.js';
import { levelMultiplier, effectiveCaps } from './sim/economy.js';
import { createGrid, occupy, occupyTrap, getCell } from './world/grid.js';
import { generateMap } from './world/mapgen.js';
import { BUILDING_DEFS, getDef } from './buildings/definitions.js';

export const SAVE_KEY = 'cbs-save';
export const SAVE_VERSION = 4;
export const RECORD_KEY = 'cbs-record'; // best nights survived, across runs
const RESOURCE_KEYS = ['food', 'water', 'wood', 'metal', 'energy', 'fuel'];

// Best run (nights survived), persisted apart from the save so it survives
// restarts; 0 when no record exists or storage is unavailable.
export function readRecord() {
  try {
    const n = Number.parseInt(localStorage.getItem(RECORD_KEY), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeRecord(n) {
  try {
    localStorage.setItem(RECORD_KEY, String(n));
  } catch {
    // Storage unavailable: the record just won't persist.
  }
}

// Wipes the save (restart, defeat): the next load starts a fresh game.
export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore
  }
}

export function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Only v4 saves load; older versions silently start a fresh game.
    if (!data || data.version !== SAVE_VERSION) return null;
    if (typeof data.seed !== 'number' || !Array.isArray(data.buildings)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// Serializes the run (state + map seed + the changed-tile log) to a v4 save.
// Silently does nothing when storage is unavailable: keep playing without
// saves.
export function saveGame(state, seed, changedTiles) {
  try {
    const data = {
      version: SAVE_VERSION,
      seed,
      day: state.day,
      resources: { ...state.resources },
      survivors: state.survivors.map((s) => ({
        id: s.id,
        hunger: s.hunger,
        thirst: s.thirst,
        buildingId: s.buildingId,
      })),
      buildings: state.buildings.map((b) => ({
        id: b.id,
        defId: b.defId,
        x: b.x,
        z: b.z,
        hp: Math.round(b.hp),
        workers: [...b.workers],
        autoAssign: b.autoAssign,
        extracted: b.extracted,
        efficiency: b.efficiency,
        enabled: b.enabled !== false,
        repairing: b.repairing === true,
        priority: b.priority ?? 1,
        level: b.level ?? 1,
      })),
      changedTiles: changedTiles.map((t) => ({ ...t })),
      researchPoints: state.researchPoints,
      researched: [...state.researched],
      kills: state.kills,
      reputation: state.reputation ?? 0,
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable: keep playing without saves.
  }
}

// Rebuilds grid + state from a v4 save. Throws on inconsistent data; the
// caller falls back to a fresh game. Changed tiles are replayed onto the
// freshly generated grid, so buildTerrain (which runs after this) renders
// them natively.
export function restoreSave(data) {
  const grid = generateMap(createGrid(), data.seed);
  const state = createGameState();
  state.mapSeed = data.seed;

  if (typeof data.day === 'number' && data.day >= 1) {
    state.day = Math.floor(data.day);
  }
  if (data.resources && typeof data.resources === 'object') {
    for (const key of RESOURCE_KEYS) {
      if (typeof data.resources[key] === 'number') {
        // Lower clamp only: the upper one waits for the buildings below
        // (their capBonus raises the ceiling — see the effectiveCaps pass).
        state.resources[key] = Math.max(0, data.resources[key]);
      }
    }
  }
  if (typeof data.researchPoints === 'number') {
    state.researchPoints = Math.max(0, data.researchPoints);
  }
  if (Array.isArray(data.researched)) {
    state.researched = data.researched.filter((id) => typeof id === 'string');
  }
  if (typeof data.kills === 'number' && data.kills >= 0) {
    state.kills = Math.floor(data.kills);
  }
  // deathsToday non è persistito: riparte da 0 (createGameState).
  if (typeof data.reputation === 'number') {
    state.reputation = Math.min(100, Math.max(0, data.reputation));
  }

  // Tiles changed by extraction/planting since mapgen.
  const changedTiles = [];
  if (Array.isArray(data.changedTiles)) {
    for (const t of data.changedTiles) {
      if (!Number.isInteger(t?.x) || !Number.isInteger(t?.z)) continue;
      if (t.toType !== 'grass' && t.toType !== 'forest' && t.toType !== 'trail') continue;
      const cell = getCell(grid, t.x, t.z);
      if (!cell) continue;
      cell.type = t.toType;
      cell.walkable = true; // grass, (planted) forest and trails are all walkable
      changedTiles.push({ x: t.x, z: t.z, toType: t.toType });
    }
  }

  // Buildings keep their saved ids so the survivor ↔ workplace links (and
  // the worker rosters rebuilt below) stay valid across the reload.
  let maxBuildingId = 0;
  for (const b of data.buildings) {
    const def = getDef(b?.defId);
    if (!def || !Number.isInteger(b.x) || !Number.isInteger(b.z)) continue;
    const building = addBuilding(state, b.defId, def, b.x, b.z);
    if (Number.isInteger(b.id) && b.id > 0) {
      building.id = b.id;
      maxBuildingId = Math.max(maxBuildingId, b.id);
    }
    building.autoAssign = b.autoAssign !== false;
    // v4 fields added later: default to on / not repairing / normal
    // priority / level 1 on old saves.
    building.enabled = b.enabled !== false;
    building.repairing = b.repairing === true;
    if (Number.isInteger(b.priority)) {
      building.priority = Math.min(Math.max(b.priority, 0), 2);
    }
    if (Number.isInteger(b.level)) {
      building.level = Math.min(Math.max(b.level, 1), MAX_LEVEL);
    }
    // maxHp follows the level (hp saved as-is: niente cura all'upgrade qui).
    building.maxHp = def.hp * levelMultiplier(building.level);
    building.hp = building.maxHp;
    if (typeof b.hp === 'number' && b.hp > 0) {
      building.hp = Math.min(b.hp, building.maxHp);
    }
    if (typeof b.extracted === 'number') building.extracted = b.extracted;
    if (typeof b.efficiency === 'number') building.efficiency = b.efficiency;
    if (def.isTrap) {
      // Traps keep the tile walkable: restore the trap mark, not an occupation.
      occupyTrap(grid, b.x, b.z, building.id);
    } else {
      occupy(grid, b.x, b.z, building.w, building.h, building.id, def.isRoad === true);
    }
  }
  state.nextBuildingId = Math.max(state.nextBuildingId, maxBuildingId + 1);
  if (!state.buildings.some((b) => b.defId === 'hq')) {
    throw new Error('Save without a Refuge');
  }

  // Upper clamp on the restored resources, now that the buildings are back:
  // the effective caps (base + storage bonuses) are the ceiling the HUD
  // shows, so a stock saved above the base cap survives the reload.
  const effCaps = effectiveCaps(state, BUILDING_DEFS);
  for (const key of RESOURCE_KEYS) {
    state.resources[key] = Math.min(
      effCaps[key] ?? Infinity,
      state.resources[key] ?? 0
    );
  }

  // Survivors keep their saved ids and reconnect to their workplace via
  // the saved buildingId.
  const buildingIds = new Set(state.buildings.map((b) => b.id));
  const saved = Array.isArray(data.survivors) ? data.survivors : [];
  let maxSurvivorId = 0;
  for (const s of saved) {
    const survivor = addSurvivor(state);
    if (Number.isInteger(s?.id) && s.id > 0) {
      survivor.id = s.id;
      maxSurvivorId = Math.max(maxSurvivorId, s.id);
    }
    if (typeof s?.hunger === 'number') survivor.hunger = s.hunger;
    if (typeof s?.thirst === 'number') survivor.thirst = s.thirst;
    if (Number.isInteger(s?.buildingId) && buildingIds.has(s.buildingId)) {
      survivor.buildingId = s.buildingId;
    }
  }
  state.nextSurvivorId = Math.max(state.nextSurvivorId, maxSurvivorId + 1);
  if (state.survivors.length === 0) {
    for (let i = 0; i < CONFIG.startSurvivors; i++) addSurvivor(state);
  }

  // Worker rosters are rebuilt from the survivors' buildingId (single source
  // of truth), capped at the definition's job slots; the overflow goes idle.
  for (const b of state.buildings) {
    const def = getDef(b.defId);
    const slots = def?.jobs ?? 0;
    b.workers = [];
    for (const s of state.survivors) {
      if (s.buildingId !== b.id) continue;
      if (b.workers.length < slots) b.workers.push(s.id);
      else s.buildingId = null;
    }
  }

  return { grid, state, seed: data.seed, changedTiles };
}
