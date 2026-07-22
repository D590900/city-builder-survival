// Dirt trails: idle survivors slowly trample paths from the Refuge to the
// outlying buildings, for free. Pure logic, no I/O.
//
// Algorithm (at most one tile per call):
// - every TRAIL_INTERVAL seconds (timer kept on state.trailTimer), if there
//   is at least one idle survivor (idleCount), try to place ONE 'trail'
//   tile, up to MAX_TRAILS tiles in total; the attempt consumes the
//   interval even when nothing can be placed;
// - the network starts from the Refuge footprint and grows through the
//   trail tiles already placed;
// - targets are the buildings, in placement order, without a 'trail' tile
//   orthogonally adjacent to their footprint; the Refuge itself (it is the
//   source) and the roads (they are paths already) are never targets;
// - for each target, the sources (Refuge tiles + trail tiles) are tried by
//   rising Manhattan distance to the footprint; the step is greedy — x axis
//   first, then z — onto a free 'grass' tile (no building, no trap);
// - if a source is blocked in both directions the next source is tried, and
//   if every source is blocked the next building is tried.
//
// tickTrails only DECIDES the tile: it returns { x, z } (or null) and never
// mutates the grid — the caller (main.js) sets cell.type = 'trail', recolors
// the terrain and logs the change for the save file. A 'trail' tile stays
// walkable (only 'water' blocks movement) and is not buildable on:
// BUILDABLE_TYPES in grid.js is grass/road only.

import { idleCount } from './survivors.js';

export const TRAIL_INTERVAL = 10; // seconds between one placement attempt and the next
export const MAX_TRAILS = 100; // total trail tiles cap

// Manhattan distance from (sx, sz) to the building footprint (0 inside).
function footprintDistance(b, sx, sz) {
  const dx = Math.max(b.x - sx, 0, sx - (b.x + b.w - 1));
  const dz = Math.max(b.z - sz, 0, sz - (b.z + b.h - 1));
  return dx + dz;
}

// The footprint tile of `b` closest to (sx, sz), Manhattan distance.
function nearestFootprintTile(b, sx, sz) {
  let best = null;
  let bestDist = Infinity;
  for (let z = b.z; z < b.z + b.h; z++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const d = Math.abs(x - sx) + Math.abs(z - sz);
      if (d < bestDist) {
        bestDist = d;
        best = { x, z };
      }
    }
  }
  return best;
}

// True when a 'trail' tile is orthogonally adjacent to the footprint.
function hasAdjacentTrail(grid, b) {
  for (let z = b.z - 1; z <= b.z + b.h; z++) {
    for (let x = b.x - 1; x <= b.x + b.w; x++) {
      const ring = z === b.z - 1 || z === b.z + b.h || x === b.x - 1 || x === b.x + b.w;
      if (!ring) continue; // solo l'anello esterno, non l'impronta
      if (grid.cells[z]?.[x]?.type === 'trail') return true;
    }
  }
  return false;
}

// A trail grows only onto free grass: no building on it, no trap.
function canPlaceTrail(grid, x, z) {
  const cell = grid.cells[z]?.[x];
  return !!cell && cell.type === 'grass' && cell.occupiedBy == null && !cell.trap;
}

// The next greedy step from (sx, sz) toward (tx, tz), x axis first.
// Returns { x, z }, or null when both directions are blocked.
function greedyStep(grid, sx, sz, tx, tz) {
  const dx = Math.sign(tx - sx);
  const dz = Math.sign(tz - sz);
  if (dx !== 0 && canPlaceTrail(grid, sx + dx, sz)) return { x: sx + dx, z: sz };
  if (dz !== 0 && canPlaceTrail(grid, sx, sz + dz)) return { x: sx, z: sz + dz };
  return null;
}

// One placement attempt per TRAIL_INTERVAL, gated on idle survivors.
// Returns the chosen tile { x, z }, or null when nothing was placed.
export function tickTrails(state, grid, dt) {
  state.trailTimer = (state.trailTimer ?? 0) + dt;
  if (state.trailTimer < TRAIL_INTERVAL) return null;
  state.trailTimer = 0; // il tentativo consuma l'intervallo, anche a vuoto
  if (idleCount(state) <= 0) return null;

  // Network sources: every trail tile plus the Refuge footprint.
  const sources = [];
  let trailCount = 0;
  for (let z = 0; z < grid.size; z++) {
    for (let x = 0; x < grid.size; x++) {
      if (grid.cells[z][x].type === 'trail') {
        trailCount += 1;
        sources.push({ x, z });
      }
    }
  }
  if (trailCount >= MAX_TRAILS) return null;
  const hq = (state.buildings ?? []).find((b) => b.defId === 'hq');
  if (hq) {
    for (let z = hq.z; z < hq.z + hq.h; z++) {
      for (let x = hq.x; x < hq.x + hq.w; x++) {
        sources.push({ x, z });
      }
    }
  }
  if (sources.length === 0) return null;

  for (const b of state.buildings ?? []) {
    // Il Rifugio è la sorgente; le strade sono già percorsi.
    if (b.defId === 'hq' || b.defId === 'road') continue;
    if (hasAdjacentTrail(grid, b)) continue; // già servito dal sentiero
    const ordered = sources
      .map((s) => ({ x: s.x, z: s.z, d: footprintDistance(b, s.x, s.z) }))
      .sort((a, c) => a.d - c.d);
    for (const s of ordered) {
      // Già attaccato alla rete: nessuna tile da aggiungere (tipico degli
      // edifici adiacenti al Rifugio, che non hanno ancora un sentiero).
      if (s.d <= 1) continue;
      const t = nearestFootprintTile(b, s.x, s.z);
      const step = greedyStep(grid, s.x, s.z, t.x, t.z);
      if (step) return step;
    }
  }
  return null;
}
