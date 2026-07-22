/**
 * Zombie pathfinding on the tile grid. Pure logic only: no three.js, no DOM,
 * no side effects at import time.
 *
 * Grid contract (owned by src/world/grid.js):
 *   grid = { size, cells }
 *   grid.cells[z][x] = { type, occupiedBy, walkable }
 *
 * Rules:
 * - A tile is traversable when `walkable && !occupiedBy`, with two
 *   exceptions:
 *   - the goal tile, which is always enterable (the goal is usually the
 *     building the zombie wants to attack);
 *   - road tiles (`cell.road === true`, set by grid.js occupy): zombies
 *     walk over roads even while the road building occupies the tile.
 * - Coordinates are integer tile indices; fractional inputs are truncated.
 */

const DIRS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

const UNSEEN = 0;
const OPEN = 1;
const CLOSED = 2;

function manhattan(ax, az, bx, bz) {
  return Math.abs(ax - bx) + Math.abs(az - bz);
}

// A tile is traversable when walkable and unoccupied — or when it holds a
// road (`cell.road === true`): the road building occupies the tile but
// zombies simply walk over it, they never attack it.
function traversable(cell) {
  if (cell.road === true) return true;
  return cell.walkable && !cell.occupiedBy;
}

/* Binary min-heap over node indices, ordered by fScore. Ties are broken by
 * lower hScore, which prefers nodes closer to the goal and produces
 * straighter paths on open ground. */

function heapLess(a, b, fScore, hScore) {
  return fScore[a] < fScore[b] || (fScore[a] === fScore[b] && hScore[a] < hScore[b]);
}

function heapPush(heap, fScore, hScore, node) {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!heapLess(heap[i], heap[parent], fScore, hScore)) break;
    const tmp = heap[i];
    heap[i] = heap[parent];
    heap[parent] = tmp;
    i = parent;
  }
}

function heapPop(heap, fScore, hScore) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && heapLess(heap[left], heap[smallest], fScore, hScore)) smallest = left;
      if (right < heap.length && heapLess(heap[right], heap[smallest], fScore, hScore)) smallest = right;
      if (smallest === i) break;
      const tmp = heap[i];
      heap[i] = heap[smallest];
      heap[smallest] = tmp;
      i = smallest;
    }
  }
  return top;
}

function reconstructPath(cameFrom, goalIdx, size) {
  const path = [];
  let cur = goalIdx;
  while (cur !== -1) {
    path.push({ x: cur % size, z: Math.floor(cur / size) });
    cur = cameFrom[cur];
  }
  path.reverse();
  return path;
}

/**
 * A* search (4 directions, Manhattan heuristic) from (sx, sz) to (tx, tz).
 *
 * @param {{size: number, cells: Array<Array<{walkable: boolean, occupiedBy: *}>>}} grid
 * @returns {Array<{x: number, z: number}> | null} tiles from start to goal,
 *   both included, or null when the start tile is not valid (out of bounds,
 *   missing or not traversable) or the goal cannot be reached.
 *   The goal tile itself ignores walkable/occupiedBy.
 */
export function findPath(grid, sx, sz, tx, tz) {
  if (!grid || !grid.cells || !Number.isInteger(grid.size) || grid.size <= 0) return null;

  sx = Math.trunc(sx);
  sz = Math.trunc(sz);
  tx = Math.trunc(tx);
  tz = Math.trunc(tz);

  const { size, cells } = grid;
  const inBounds = (x, z) => x >= 0 && x < size && z >= 0 && z < size;
  if (!inBounds(sx, sz) || !inBounds(tx, tz)) return null;

  // Already standing on the goal.
  if (sx === tx && sz === tz) return [{ x: sx, z: sz }];

  // The start tile must be a valid walkable tile (a road tile still counts:
  // a zombie standing on a road must be able to re-plan); the goal is exempt
  // from walkability checks because it is the target to reach (e.g. a
  // building).
  const startCell = cells[sz] && cells[sz][sx];
  if (!startCell || !traversable(startCell)) return null;

  const count = size * size;
  const startIdx = sz * size + sx;
  const goalIdx = tz * size + tx;

  // Flat typed-array scratch, indexed by z * size + x: cheap to allocate and
  // no per-node object churn even on a 64x64 grid.
  const state = new Uint8Array(count); // UNSEEN | OPEN | CLOSED
  const gScore = new Int32Array(count);
  const fScore = new Int32Array(count);
  const hScore = new Int32Array(count);
  const cameFrom = new Int32Array(count);

  const heap = [];
  state[startIdx] = OPEN;
  gScore[startIdx] = 0;
  hScore[startIdx] = manhattan(sx, sz, tx, tz);
  fScore[startIdx] = hScore[startIdx];
  cameFrom[startIdx] = -1;
  heapPush(heap, fScore, hScore, startIdx);

  while (heap.length > 0) {
    const cur = heapPop(heap, fScore, hScore);
    if (state[cur] === CLOSED) continue; // stale heap entry
    if (cur === goalIdx) return reconstructPath(cameFrom, goalIdx, size);
    state[cur] = CLOSED;

    const cx = cur % size;
    const cz = Math.floor(cur / size);

    for (let d = 0; d < DIRS.length; d++) {
      const nx = cx + DIRS[d].x;
      const nz = cz + DIRS[d].z;
      if (!inBounds(nx, nz)) continue;
      const cell = cells[nz] && cells[nz][nx];
      if (!cell) continue;
      const nIdx = nz * size + nx;
      if (state[nIdx] === CLOSED) continue;
      // The goal tile is always enterable; every other tile must be
      // traversable (walkable and unoccupied, or a road).
      if (nIdx !== goalIdx && !traversable(cell)) continue;

      const g = gScore[cur] + 1;
      if (state[nIdx] === OPEN && g >= gScore[nIdx]) continue;

      state[nIdx] = OPEN;
      gScore[nIdx] = g;
      const h = manhattan(nx, nz, tx, tz);
      hScore[nIdx] = h;
      fScore[nIdx] = g + h;
      cameFrom[nIdx] = cur;
      heapPush(heap, fScore, hScore, nIdx);
    }
  }

  return null;
}

/**
 * Finds the most attractive reachable building and a path to it.
 *
 * Buildings are axis-aligned footprints `{ x, z, w, h }` in tile coordinates
 * (w/h default to 1). Each candidate may be either a bare building or a
 * weighted entry `{ building, weight }` (backward compatible: a bare
 * building counts as weight 1). Candidates are tried in ascending
 * `distSq × weight` order — lower weights make a building more attractive,
 * so a slightly farther interesting target beats a closer dull one. For
 * each candidate the path targets the footprint tile closest to (sx, sz),
 * which lies on the footprint edge unless the zombie is inside the
 * footprint. The weights themselves are computed by the caller (zombie.js);
 * this module stays free of building-definition knowledge.
 *
 * @returns {{building: object, path: Array<{x: number, z: number}>} | null}
 *   the first reachable candidate (best score first) with its path, or null.
 */
export function findNearestTarget(grid, sx, sz, buildings) {
  if (!Array.isArray(buildings) || buildings.length === 0) return null;

  sx = Math.trunc(sx);
  sz = Math.trunc(sz);

  const candidates = [];
  for (const entry of buildings) {
    // Backward compatible: a bare building means weight 1.
    const isWrapped = entry != null && typeof entry === 'object' && entry.building != null;
    const building = isWrapped ? entry.building : entry;
    if (!building || !Number.isFinite(building.x) || !Number.isFinite(building.z)) continue;
    const weight = isWrapped && Number.isFinite(entry.weight) ? entry.weight : 1;
    const w = Math.max(1, Math.trunc(building.w ?? 1));
    const h = Math.max(1, Math.trunc(building.h ?? 1));
    // Footprint tile closest to the zombie: clamp into [x, x+w-1] x [z, z+h-1].
    const nx = Math.min(Math.max(sx, building.x), building.x + w - 1);
    const nz = Math.min(Math.max(sz, building.z), building.z + h - 1);
    const dx = nx - sx;
    const dz = nz - sz;
    candidates.push({ building, nx, nz, score: (dx * dx + dz * dz) * weight });
  }

  // Squared distance preserves the euclidean ordering and avoids sqrt.
  candidates.sort((a, b) => a.score - b.score);

  for (const { building, nx, nz } of candidates) {
    const path = findPath(grid, sx, sz, nx, nz);
    if (path) return { building, path };
  }
  return null;
}

/**
 * Returns the tile to walk to next from a path produced by findPath
 * (path[0] is the current tile). Returns null when there is no next tile
 * (missing path or already at the goal).
 */
export function nextStep(path) {
  if (!path || path.length < 2) return null;
  return path[1];
}
