// Node extraction: depletable resource tiles (forest/ruins/ore) drained by
// extractors, and renewable planting by foresters. Pure logic, no I/O.

import { levelMultiplier, effectiveCaps } from './economy.js';

const DAY_LENGTH = 90; // seconds per game day (mirrors state.js CONFIG)

// Yield of each depletable tile type.
export const TILE_YIELDS = {
  forest: { resource: 'wood', amount: 20 },
  ruins: { resource: 'metal', amount: 25 },
  ore: { resource: 'metal', amount: 60 },
};

const EXTRACT_RANGE = 2; // Chebyshev distance from the footprint edge
const PLANT_RANGE = 3; // Chebyshev distance from the footprint edge
const PLANT_WORK = 20; // worker-seconds needed to plant one tree
const PLANT_WATER_COST = 2;

// Chebyshev distance from cell (cx, cz) to the building footprint
// (0 for cells inside the footprint).
function footprintDistance(b, cx, cz) {
  const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w - 1));
  const dz = Math.max(b.z - cz, 0, cz - (b.z + b.h - 1));
  return Math.max(dx, dz);
}

// Calls fn(cell, x, z) for every grid cell within Chebyshev distance `range`
// of the building footprint, clipped to the grid bounds.
function forEachCellInRange(grid, b, range, fn) {
  const minX = Math.max(0, b.x - range);
  const maxX = Math.min(grid.size - 1, b.x + b.w - 1 + range);
  const minZ = Math.max(0, b.z - range);
  const maxZ = Math.min(grid.size - 1, b.z + b.h - 1 + range);
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      fn(grid.cells[z][x], x, z);
    }
  }
}

function staffingRatio(b, def) {
  if (!def.jobs) return 1; // buildings without jobs run at full output
  return Math.min(b.workers.length, def.jobs) / def.jobs;
}

// Number of tiles of the given type within extraction range (Chebyshev 2
// from the footprint edge).
export function countNodesInRange(grid, b, type) {
  let count = 0;
  forEachCellInRange(grid, b, EXTRACT_RANGE, (cell) => {
    if (cell.type === type) count += 1;
  });
  return count;
}

// The closest tile of the given type within extraction range, as
// { x, z, cell }, or null when none is left.
export function nearestNode(grid, b, type) {
  let best = null;
  let bestDist = Infinity;
  forEachCellInRange(grid, b, EXTRACT_RANGE, (cell, x, z) => {
    if (cell.type !== type) return;
    const d = footprintDistance(b, x, z);
    if (d < bestDist) {
      bestDist = d;
      best = { x, z, cell };
    }
  });
  return best;
}

// True when at least one unoccupied grass tile lies within `range`
// (Chebyshev distance from the footprint edge).
export function hasFreeGrassInRange(grid, b, range) {
  let found = false;
  forEachCellInRange(grid, b, range, (cell) => {
    if (cell.type === 'grass' && cell.occupiedBy == null) found = true;
  });
  return found;
}

// The closest unoccupied grass tile within `range`, as { x, z, cell },
// or null when none is available.
function nearestFreeGrass(grid, b, range) {
  let best = null;
  let bestDist = Infinity;
  forEachCellInRange(grid, b, range, (cell, x, z) => {
    if (cell.type !== 'grass' || cell.occupiedBy != null) return;
    const d = footprintDistance(b, x, z);
    if (d < bestDist) {
      bestDist = d;
      best = { x, z, cell };
    }
  });
  return best;
}

// Extractor tick: continuous production at extractRate * staffing *
// mods.extractProd * level per day, but only while matching nodes remain in
// range. Only production that actually fits under the effective resource cap
// (base cap + storage bonuses, see economy.js effectiveCaps) is accumulated
// in b.extracted; each full tile yield depletes the nearest node to grass.
function tickExtractor(state, grid, b, def, ratio, dt, mods, result, caps) {
  const yieldDef = TILE_YIELDS[def.extracts];
  if (!yieldDef) return;
  if (countNodesInRange(grid, b, def.extracts) === 0) return; // no nodes: idle
  const perDay = def.extractRate * ratio * (mods?.extractProd ?? 1) * levelMultiplier(b.level);
  const gained = (perDay * dt) / DAY_LENGTH;
  const cap = caps?.[yieldDef.resource] ?? Infinity;
  const before = state.resources[yieldDef.resource] ?? 0;
  const after = Math.min(cap, before + gained);
  state.resources[yieldDef.resource] = after;
  b.extracted = (b.extracted ?? 0) + (after - before);
  while (b.extracted >= yieldDef.amount) {
    const node = nearestNode(grid, b, def.extracts);
    if (!node) break;
    node.cell.type = 'grass';
    node.cell.walkable = true;
    b.extracted -= yieldDef.amount;
    result.depleted.push({ x: node.x, z: node.z, fromType: def.extracts });
  }
}

// Forester tick: with a free grass tile within range 3 and at least 2 water
// in stock, accumulates worker-seconds in b.extracted; at 20 it spends the
// water and turns the nearest free grass tile into forest.
function tickForester(state, grid, b, ratio, dt, result) {
  if (!hasFreeGrassInRange(grid, b, PLANT_RANGE)) return;
  if ((state.resources.water ?? 0) < PLANT_WATER_COST) return;
  b.extracted = Math.min(PLANT_WORK, (b.extracted ?? 0) + dt * ratio);
  if (b.extracted < PLANT_WORK) return;
  const tile = nearestFreeGrass(grid, b, PLANT_RANGE);
  if (!tile) return; // the tile was taken mid-tick: keep the progress
  state.resources.water -= PLANT_WATER_COST;
  tile.cell.type = 'forest';
  tile.cell.walkable = true; // planted forest stays walkable like mapgen forest
  result.planted.push({ x: tile.x, z: tile.z });
  b.extracted = 0;
}

// Advances extraction and planting for every building by dt seconds.
// Returns the tiles changed this tick:
// { depleted: [{ x, z, fromType }], planted: [{ x, z }] }.
export function tickExtraction(state, grid, dt, DEFS, mods) {
  const result = { depleted: [], planted: [] };
  // Effective caps (storage bonuses included): the same ceiling the HUD
  // shows, so extraction never stalls below the displayed capacity.
  const caps = effectiveCaps(state, DEFS);
  for (const b of state.buildings) {
    const def = DEFS[b.defId];
    if (!def || b.enabled === false) continue; // spento: niente estrazione
    const ratio = staffingRatio(b, def);
    if (ratio <= 0) continue;
    if (def.extracts) {
      tickExtractor(state, grid, b, def, ratio, dt, mods, result, caps);
    }
    if (def.plants === 'forest') {
      tickForester(state, grid, b, ratio, dt, result);
    }
  }
  return result;
}
