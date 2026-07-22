// Grid module: tile grid data model and coordinate helpers.
// Pure data + functions, no side effects on import.

export const TILE_SIZE = 2;
export const GRID_SIZE = 64;

// Cell types that buildings can be placed on (when not occupied). Everything
// else is rejected by isFree(): water, forest, ruins, wasteland and 'ore'
// (extraction node tiles stay walkable but cannot be built on).
const BUILDABLE_TYPES = new Set(['grass', 'road']);

export function createGrid() {
  const cells = [];
  for (let z = 0; z < GRID_SIZE; z++) {
    const row = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      row.push({ type: 'grass', occupiedBy: null, walkable: true });
    }
    cells.push(row);
  }
  return { size: GRID_SIZE, cells, spawnPoints: [], hqTile: null };
}

export function inBounds(grid, x, z) {
  return x >= 0 && z >= 0 && x < grid.size && z < grid.size;
}

export function getCell(grid, x, z) {
  if (!inBounds(grid, x, z)) return null;
  return grid.cells[z][x];
}

export function isFree(grid, x, z, w = 1, h = 1) {
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const cell = getCell(grid, x + dx, z + dz);
      if (!cell) return false;
      if (!BUILDABLE_TYPES.has(cell.type)) return false;
      if (cell.occupiedBy !== null) return false;
      if (cell.trap) return false; // a trap blocks building, but not walking
    }
  }
  return true;
}

// The optional `isRoad` flag marks the tiles with `cell.road = true`: road
// buildings still occupy their tiles (placement/demolition unchanged) but
// the zombie pathfinding treats them as traversable (see
// zombies/pathfinding.js). Like `trap`, the field is absent on fresh cells,
// so readers must tolerate undefined; release() clears the mark.
export function occupy(grid, x, z, w, h, id, isRoad = false) {
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const cell = getCell(grid, x + dx, z + dz);
      if (!cell) return false;
      cell.occupiedBy = id;
      cell.walkable = false;
      if (isRoad) cell.road = true;
    }
  }
  return true;
}

// Traps sit on a tile without blocking movement: the cell stays walkable
// and unoccupied, so pathfinding is unaffected, while isFree() still
// rejects it for further building. Single-tile by design. The `trap` field
// (null | buildingId) is added lazily: fresh cells simply do not have it,
// so every reader must tolerate undefined.
export function occupyTrap(grid, x, z, id) {
  const cell = getCell(grid, x, z);
  if (!cell) return false;
  cell.trap = id;
  return true;
}

export function release(grid, id) {
  for (let z = 0; z < grid.size; z++) {
    for (let x = 0; x < grid.size; x++) {
      const cell = grid.cells[z][x];
      if (cell.occupiedBy === id) {
        cell.occupiedBy = null;
        cell.walkable = cell.type !== 'water';
        cell.road = false; // clear the road mark left by occupy(isRoad)
      }
      if (cell.trap === id) cell.trap = null;
    }
  }
}

// Tile coords -> world coords (tile center). Map is centered on the origin.
export function tileToWorld(x, z) {
  return {
    x: (x - GRID_SIZE / 2 + 0.5) * TILE_SIZE,
    z: (z - GRID_SIZE / 2 + 0.5) * TILE_SIZE,
  };
}

// World coords -> tile coords (inverse of tileToWorld, floor + clamp).
export function worldToTile(wx, wz) {
  const toTile = (w) => {
    const t = Math.floor(w / TILE_SIZE + GRID_SIZE / 2);
    return Math.min(Math.max(t, 0), GRID_SIZE - 1);
  };
  return { x: toTile(wx), z: toTile(wz) };
}
