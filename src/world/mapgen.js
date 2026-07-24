// Map generation: fills a grid created by createGrid() with terrain features.
// Deterministic via a seeded RNG (mulberry32). Pure functions, no side effects.

const VALID_BORDER = 2; // tiles of wasteland along each edge
const CENTER_CLEAR_RADIUS = 8;

// mulberry32: small fast seeded PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateMap(grid, seed = Date.now()) {
  const rng = mulberry32(seed);
  const N = grid.size;
  const ri = (min, max) => min + Math.floor(rng() * (max - min + 1)); // inclusive

  const setCell = (x, z, type, walkable) => {
    if (x < 0 || z < 0 || x >= N || z >= N) return;
    const cell = grid.cells[z][x];
    cell.type = type;
    cell.walkable = walkable;
  };

  // 1) Wasteland border (2 tiles deep) on all edges: walkable, not buildable.
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < VALID_BORDER; d++) {
      setCell(i, d, 'wasteland', true);
      setCell(i, N - 1 - d, 'wasteland', true);
      setCell(d, i, 'wasteland', true);
      setCell(N - 1 - d, i, 'wasteland', true);
    }
  }

  // 2) River along a random edge: water band 2 tiles wide with a slight meander.
  const riverEdge = ri(0, 3); // 0=N, 1=S, 2=W, 3=E
  let depth = 2;
  for (let pos = 0; pos < N; pos++) {
    depth = Math.min(3, Math.max(1, depth + ri(-1, 1)));
    for (let w = 0; w < 2; w++) {
      const d = depth + w;
      if (riverEdge === 0) setCell(pos, d, 'water', false);
      else if (riverEdge === 1) setCell(pos, N - 1 - d, 'water', false);
      else if (riverEdge === 2) setCell(d, pos, 'water', false);
      else setCell(N - 1 - d, pos, 'water', false);
    }
  }

  // 3) Ponds: 2-3 small circular water clusters (radius 1-2) on grass, far
  // from the center clearing, so fishing does not depend on the edge river
  // alone. Reuses the 'water' type: rendering, non-walkability and
  // non-buildability come for free; the roads (step 4) already stop at
  // water, and the center clearing (step 5) never overwrites it. Retried
  // until each cluster lands at least one water tile (the attempt cap only
  // guards against pathological rng runs).
  const pondCount = ri(2, 3);
  for (let i = 0; i < pondCount; i++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const cx = ri(6, N - 7);
      const cz = ri(6, N - 7);
      const r = ri(1, 2);
      // Center far enough that every pond tile stays out of the clearing.
      if (Math.hypot(cx - N / 2, cz - N / 2) <= CENTER_CLEAR_RADIUS + r) continue;
      let placed = 0;
      for (let z = cz - r; z <= cz + r; z++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < VALID_BORDER || z < VALID_BORDER || x >= N - VALID_BORDER || z >= N - VALID_BORDER) continue;
          if (Math.hypot(x - cx, z - cz) > r) continue;
          if ((x !== cx || z !== cz) && rng() < 0.2) continue; // ragged edges
          if (grid.cells[z][x].type === 'grass') {
            setCell(x, z, 'water', false);
            placed++;
          }
        }
      }
      if (placed > 0) break;
    }
  }

  // 4) Forest and ruins clusters (walkable, not buildable), only on grass.
  const cluster = (type, count, minR, maxR) => {
    for (let i = 0; i < count; i++) {
      const cx = ri(6, N - 7);
      const cz = ri(6, N - 7);
      const r = ri(minR, maxR);
      for (let z = cz - r; z <= cz + r; z++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < VALID_BORDER || z < VALID_BORDER || x >= N - VALID_BORDER || z >= N - VALID_BORDER) continue;
          if (Math.hypot(x - cx, z - cz) > r) continue;
          if (rng() > 0.75) continue; // ragged edges
          if (grid.cells[z][x].type === 'grass') setCell(x, z, type, true);
        }
      }
    }
  };
  cluster('forest', ri(6, 10), 2, 4);
  cluster('ruins', ri(4, 8), 2, 3);

  // 5) Roads from the edges toward the center (buildable, walkable).
  // Structured layout: 2-4 roads, at most one per edge, each a chain of
  // long straight 4-connected segments with 1-2 deliberate bends (a lateral
  // shift of 2-4 tiles, then straight again). The path is planned in a
  // local list and committed only when it reaches at least 3 tiles, so
  // short stubs (e.g. a road that immediately hits the river) are
  // discarded and their border mouth stays plain walkable wasteland.
  // Roads stop at water and at the edge of the center clearing.
  const roadStarts = [];
  const roadCount = ri(2, 4);
  const edges = [0, 1, 2, 3];
  for (let i = edges.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = edges[i];
    edges[i] = edges[j];
    edges[j] = t;
  }
  const roadBlocked = (x, z) =>
    x < 0 || z < 0 || x >= N || z >= N ||
    grid.cells[z][x].type === 'water' ||
    Math.hypot(x - N / 2, z - N / 2) < CENTER_CLEAR_RADIUS + 1;
  for (let i = 0; i < roadCount; i++) {
    const edge = edges[i];
    const pos = ri(4, N - 5);
    let x, z, dx, dz;
    if (edge === 0) { x = pos; z = 0; dx = 0; dz = 1; }
    else if (edge === 1) { x = pos; z = N - 1; dx = 0; dz = -1; }
    else if (edge === 2) { x = 0; z = pos; dx = 1; dz = 0; }
    else { x = N - 1; z = pos; dx = -1; dz = 0; }
    roadStarts.push({ x, z });
    // Plan the path: alternate straight runs (6-14 tiles) with lateral
    // shifts (2-4 tiles) at 1-2 bends. Every move is axis-aligned, so the
    // road is always 4-connected.
    const path = [{ x, z }];
    let cx = x;
    let cz = z;
    let stop = roadBlocked(cx, cz);
    const bends = ri(1, 2);
    for (let seg = 0; seg <= bends && !stop; seg++) {
      const straight = ri(6, 14);
      for (let s = 0; s < straight && !stop; s++) {
        if (roadBlocked(cx + dx, cz + dz)) { stop = true; break; }
        cx += dx;
        cz += dz;
        path.push({ x: cx, z: cz });
      }
      if (stop || seg === bends) break;
      // Bend: shift sideways, orthogonal to the travel direction.
      const sign = rng() < 0.5 ? 1 : -1;
      const lx = dz !== 0 ? sign : 0;
      const lz = dx !== 0 ? sign : 0;
      const shift = ri(2, 4);
      for (let s = 0; s < shift && !stop; s++) {
        if (roadBlocked(cx + lx, cz + lz)) { stop = true; break; }
        cx += lx;
        cz += lz;
        path.push({ x: cx, z: cz });
      }
    }
    if (path.length >= 3) {
      for (const t of path) setCell(t.x, t.z, 'road', true);
    }
  }

  // 5b) Ore veins: 3-5 small rocky clusters (radius 1-2) on grass, far from
  // the center (every tile ends up > 12 away from hqTile). Walkable,
  // not buildable: they are exhaustible extraction nodes. Placed after the
  // roads so no road can overwrite them; the center clearing (radius 8)
  // cannot reach them either. Retried until each cluster lands at least one
  // ore tile (the attempt cap only guards against pathological rng runs).
  const c0 = N / 2;
  const oreClusterCount = ri(3, 5);
  for (let i = 0; i < oreClusterCount; i++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const cx = ri(6, N - 7);
      const cz = ri(6, N - 7);
      const r = ri(1, 2);
      // Center far enough that even the nearest tile stays > 12 from the HQ.
      if (Math.hypot(cx - c0, cz - c0) <= 12 + r) continue;
      let placed = 0;
      for (let z = cz - r; z <= cz + r; z++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < VALID_BORDER || z < VALID_BORDER || x >= N - VALID_BORDER || z >= N - VALID_BORDER) continue;
          if (Math.hypot(x - cx, z - cz) > r) continue;
          if ((x !== cx || z !== cz) && rng() < 0.2) continue; // ragged edges
          if (grid.cells[z][x].type === 'grass') {
            setCell(x, z, 'ore', true);
            placed++;
          }
        }
      }
      if (placed > 0) break;
    }
  }

  // 6) Clean grass clearing at the map center, HQ tile in the middle.
  const c = N / 2;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      if (Math.hypot(x - c, z - c) <= CENTER_CLEAR_RADIUS && grid.cells[z][x].type !== 'water') {
        setCell(x, z, 'grass', true);
      }
    }
  }
  grid.hqTile = { x: c, z: c };

  // 6b) Wildlife herds: 3-4 single 'wildlife' tiles on grass, far from the
  // center clearing and never on water or roads (the grass check covers
  // both). Walkable — zombies pass over them — but not buildable:
  // BUILDABLE_TYPES stays grass/road, so they work as renewable proximity
  // nodes for the ranch. Placed after the clearing so they can neither be
  // erased by it nor spawn inside it. Retried until each tile lands (the
  // attempt cap only guards against pathological rng runs).
  const wildlifeCount = ri(3, 4);
  for (let i = 0; i < wildlifeCount; i++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = ri(6, N - 7);
      const z = ri(6, N - 7);
      if (Math.hypot(x - c, z - c) <= CENTER_CLEAR_RADIUS + 1) continue;
      if (grid.cells[z][x].type !== 'grass') continue;
      setCell(x, z, 'wildlife', true);
      break;
    }
  }

  // 7) Spawn points: where roads touch the border + the 4 corners (walkable only).
  const seen = new Set();
  const spawnPoints = [];
  const addSpawn = (x, z) => {
    const key = `${x},${z}`;
    if (seen.has(key)) return;
    if (x < 0 || z < 0 || x >= N || z >= N) return;
    if (!grid.cells[z][x].walkable) return;
    seen.add(key);
    spawnPoints.push({ x, z });
  };
  for (const p of roadStarts) addSpawn(p.x, p.z);
  addSpawn(0, 0);
  addSpawn(N - 1, 0);
  addSpawn(0, N - 1);
  addSpawn(N - 1, N - 1);
  grid.spawnPoints = spawnPoints;

  return grid;
}
