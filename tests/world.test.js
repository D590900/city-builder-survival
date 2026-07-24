import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  TILE_SIZE,
  GRID_SIZE,
  createGrid,
  isFree,
  occupy,
  release,
  getCell,
  inBounds,
  tileToWorld,
  worldToTile,
} from '../src/world/grid.js';
import { generateMap } from '../src/world/mapgen.js';
import { buildTerrain } from '../src/world/terrain.js';

const CELL_TYPES = new Set(['grass', 'road', 'trail', 'water', 'forest', 'ruins', 'wasteland', 'ore', 'wildlife']);

describe('grid', () => {
  it('createGrid returns a full grass grid with empty metadata', () => {
    const grid = createGrid();
    expect(grid.size).toBe(GRID_SIZE);
    expect(grid.cells.length).toBe(GRID_SIZE);
    expect(grid.cells[0].length).toBe(GRID_SIZE);
    expect(grid.cells[0][0]).toEqual({ type: 'grass', occupiedBy: null, walkable: true });
    expect(grid.spawnPoints).toEqual([]);
    expect(grid.hqTile).toBeNull();
  });

  it('occupy marks cells not free and not walkable, release restores them', () => {
    const grid = createGrid();
    expect(isFree(grid, 10, 10, 2, 2)).toBe(true);
    occupy(grid, 10, 10, 2, 2, 'b1');
    expect(isFree(grid, 10, 10, 2, 2)).toBe(false);
    expect(isFree(grid, 11, 11)).toBe(false);
    expect(getCell(grid, 11, 11).occupiedBy).toBe('b1');
    expect(getCell(grid, 11, 11).walkable).toBe(false);
    expect(isFree(grid, 12, 12)).toBe(true); // just outside the footprint
    release(grid, 'b1');
    expect(isFree(grid, 10, 10, 2, 2)).toBe(true);
    expect(getCell(grid, 10, 10).occupiedBy).toBeNull();
    expect(getCell(grid, 10, 10).walkable).toBe(true);
  });

  it('isFree rejects out-of-bounds areas', () => {
    const grid = createGrid();
    expect(isFree(grid, -1, 0)).toBe(false);
    expect(isFree(grid, GRID_SIZE - 1, GRID_SIZE - 1, 2, 2)).toBe(false);
    expect(inBounds(grid, 0, 0)).toBe(true);
    expect(inBounds(grid, GRID_SIZE, 0)).toBe(false);
    expect(getCell(grid, -5, 0)).toBeNull();
  });

  it('ore tiles are walkable but not buildable (extraction nodes)', () => {
    const grid = createGrid();
    grid.cells[8][8] = { type: 'ore', occupiedBy: null, walkable: true };
    expect(isFree(grid, 8, 8)).toBe(false);
    expect(getCell(grid, 8, 8).walkable).toBe(true);
    // release() must keep ore walkable, like every non-water type
    grid.cells[8][8].occupiedBy = 'b1';
    grid.cells[8][8].walkable = false;
    release(grid, 'b1');
    expect(getCell(grid, 8, 8).walkable).toBe(true);
  });

  it('tileToWorld centers the map on the origin', () => {
    expect(TILE_SIZE).toBe(2);
    expect(tileToWorld(0, 0)).toEqual({ x: -63, z: -63 });
    expect(tileToWorld(GRID_SIZE - 1, GRID_SIZE - 1)).toEqual({ x: 63, z: 63 });
    expect(tileToWorld(GRID_SIZE / 2, GRID_SIZE / 2)).toEqual({ x: 1, z: 1 });
  });

  it('worldToTile is the inverse of tileToWorld (roundtrip)', () => {
    for (const [x, z] of [[0, 0], [1, 1], [17, 42], [31, 32], [63, 63]]) {
      const w = tileToWorld(x, z);
      expect(worldToTile(w.x, w.z)).toEqual({ x, z });
    }
    // clamping outside the map
    expect(worldToTile(-1000, 1000)).toEqual({ x: 0, z: GRID_SIZE - 1 });
  });
});

describe('mapgen', () => {
  it('fills the whole grid with valid cell types', () => {
    const grid = generateMap(createGrid(), 42);
    for (let z = 0; z < grid.size; z++) {
      for (let x = 0; x < grid.size; x++) {
        const cell = grid.cells[z][x];
        expect(CELL_TYPES.has(cell.type)).toBe(true);
      }
    }
  });

  it('places hqTile at the center on clean grass', () => {
    const grid = generateMap(createGrid(), 7);
    expect(grid.hqTile).toBeTruthy();
    expect(Math.abs(grid.hqTile.x - GRID_SIZE / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(grid.hqTile.z - GRID_SIZE / 2)).toBeLessThanOrEqual(1);
    expect(getCell(grid, grid.hqTile.x, grid.hqTile.z).type).toBe('grass');
  });

  it('creates at least 4 walkable spawn points', () => {
    for (const seed of [1, 2, 3, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      expect(grid.spawnPoints.length).toBeGreaterThanOrEqual(4);
      for (const p of grid.spawnPoints) {
        expect(getCell(grid, p.x, p.z).walkable).toBe(true);
      }
    }
  });

  it('water is not walkable and non-grass/road types are not buildable', () => {
    const grid = generateMap(createGrid(), 42);
    let sawWater = 0;
    let sawWasteland = 0;
    for (let z = 0; z < grid.size; z++) {
      for (let x = 0; x < grid.size; x++) {
        const cell = grid.cells[z][x];
        if (cell.type === 'water') {
          sawWater++;
          expect(cell.walkable).toBe(false);
        }
        if (cell.type === 'wasteland') sawWasteland++;
        if (cell.type !== 'grass' && cell.type !== 'road') {
          expect(isFree(grid, x, z)).toBe(false);
        }
      }
    }
    expect(sawWater).toBeGreaterThan(0);
    expect(sawWasteland).toBeGreaterThan(0);
  });

  it('marks the outer border as wasteland (except river water and road mouths)', () => {
    const grid = generateMap(createGrid(), 5);
    for (let i = 0; i < grid.size; i++) {
      for (const [x, z] of [[i, 0], [i, GRID_SIZE - 1], [0, i], [GRID_SIZE - 1, i]]) {
        expect(['wasteland', 'water', 'road']).toContain(getCell(grid, x, z).type);
      }
    }
  });

  it('is deterministic for the same seed and differs across seeds', () => {
    const typesOf = (seed) =>
      generateMap(createGrid(), seed).cells.map((row) => row.map((c) => c.type).join('')).join('\n');
    expect(typesOf(42)).toBe(typesOf(42));
    expect(typesOf(1)).not.toBe(typesOf(2));
  });

  it('places ponds: interior water tiles beyond the edge river', () => {
    // The river hugs one edge (tiles within 4 of a border); a water tile far
    // from every border must come from a pond.
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      let interiorWater = 0;
      for (let z = 5; z < grid.size - 5; z++) {
        for (let x = 5; x < grid.size - 5; x++) {
          const cell = grid.cells[z][x];
          if (cell.type === 'water') {
            interiorWater++;
            expect(cell.walkable).toBe(false);
            expect(isFree(grid, x, z)).toBe(false); // not buildable
          }
        }
      }
      expect(interiorWater).toBeGreaterThan(0);
    }
  });

  it('keeps ponds out of the center clearing', () => {
    // Any water tile inside the clearing radius must belong to the river,
    // i.e. lie within 4 tiles of some border; ponds stay out of the clearing.
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      for (let z = 0; z < grid.size; z++) {
        for (let x = 0; x < grid.size; x++) {
          if (grid.cells[z][x].type !== 'water') continue;
          if (Math.hypot(x - grid.hqTile.x, z - grid.hqTile.z) > 8) continue;
          const d = Math.min(x, z, grid.size - 1 - x, grid.size - 1 - z);
          expect(d).toBeLessThanOrEqual(4);
        }
      }
    }
  });
});

describe('mapgen ore veins', () => {
  const oreTiles = (grid) => {
    const tiles = [];
    for (let z = 0; z < grid.size; z++) {
      for (let x = 0; x < grid.size; x++) {
        if (grid.cells[z][x].type === 'ore') tiles.push({ x, z });
      }
    }
    return tiles;
  };

  it('generates clustered ore veins across many seeds', () => {
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      const tiles = oreTiles(grid);
      // 3-5 clusters, each placing at least one tile.
      expect(tiles.length).toBeGreaterThanOrEqual(3);
      // Clustered, not isolated specks: some pair of ore tiles is adjacent.
      let clustered = false;
      for (let a = 0; a < tiles.length && !clustered; a++) {
        for (let b = a + 1; b < tiles.length; b++) {
          if (Math.hypot(tiles[a].x - tiles[b].x, tiles[a].z - tiles[b].z) <= 2.1) {
            clustered = true;
            break;
          }
        }
      }
      expect(clustered).toBe(true);
    }
  });

  it('keeps every ore tile far from the HQ, walkable and not buildable', () => {
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      for (const { x, z } of oreTiles(grid)) {
        expect(Math.hypot(x - grid.hqTile.x, z - grid.hqTile.z)).toBeGreaterThan(12);
        expect(getCell(grid, x, z).walkable).toBe(true);
        expect(isFree(grid, x, z)).toBe(false);
      }
    }
  });
});

describe('mapgen wildlife herds', () => {
  const wildlifeTiles = (grid) => {
    const tiles = [];
    for (let z = 0; z < grid.size; z++) {
      for (let x = 0; x < grid.size; x++) {
        if (grid.cells[z][x].type === 'wildlife') tiles.push({ x, z });
      }
    }
    return tiles;
  };

  it('places 3-4 herd tiles on every seed', () => {
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      const tiles = wildlifeTiles(grid);
      expect(tiles.length).toBeGreaterThanOrEqual(3);
      expect(tiles.length).toBeLessThanOrEqual(4);
    }
  });

  it('keeps every herd out of the center clearing, walkable and not buildable', () => {
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      for (const { x, z } of wildlifeTiles(grid)) {
        expect(Math.hypot(x - grid.hqTile.x, z - grid.hqTile.z)).toBeGreaterThan(8);
        expect(getCell(grid, x, z).walkable).toBe(true); // zombies pass over
        expect(isFree(grid, x, z)).toBe(false); // not buildable
      }
    }
  });
});

describe('mapgen roads', () => {
  const roadTiles = (grid) => {
    const tiles = [];
    for (let z = 0; z < grid.size; z++) {
      for (let x = 0; x < grid.size; x++) {
        if (grid.cells[z][x].type === 'road') tiles.push({ x, z });
      }
    }
    return tiles;
  };

  it('draws roads as 4-connected paths (no corner-only or isolated tiles)', () => {
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      const grid = generateMap(createGrid(), seed);
      const isRoad = (x, z) =>
        x >= 0 && z >= 0 && x < grid.size && z < grid.size &&
        grid.cells[z][x].type === 'road';
      for (const { x, z } of roadTiles(grid)) {
        const neighbours =
          (isRoad(x + 1, z) ? 1 : 0) +
          (isRoad(x - 1, z) ? 1 : 0) +
          (isRoad(x, z + 1) ? 1 : 0) +
          (isRoad(x, z - 1) ? 1 : 0);
        expect(neighbours).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('places at least one road on every seed', () => {
    for (const seed of [1, 2, 3, 42, 99, 123456]) {
      expect(roadTiles(generateMap(createGrid(), seed)).length).toBeGreaterThan(0);
    }
  });
});

describe('terrain', () => {
  // Simple CPU-only prop template: one box mesh in a group (no WebGL needed).
  const fakeProp = (height = 1) => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, height, 1),
      new THREE.MeshBasicMaterial(),
    );
    mesh.position.y = height / 2;
    group.add(mesh);
    return group;
  };

  const totalDecorationInstances = (decorations) => {
    let total = 0;
    for (const group of decorations.children) {
      for (const mesh of group.children) total += mesh.count ?? 0;
    }
    return total;
  };

  it('builds ground/water/decorations and exposes the per-tile mutators', () => {
    const grid = generateMap(createGrid(), 42);
    const scene = new THREE.Scene();
    const t = buildTerrain(scene, grid, {});
    expect(t.ground.isInstancedMesh).toBe(true);
    expect(t.water.isInstancedMesh).toBe(true);
    expect(t.decorations.isGroup).toBe(true);
    expect(typeof t.setGroundTile).toBe('function');
    expect(typeof t.clearDecorationsAt).toBe('function');
    expect(typeof t.addDecorationAt).toBe('function');
  });

  it('setGroundTile recolors only the ground instance at z*size+x', () => {
    const grid = createGrid(); // all grass
    const scene = new THREE.Scene();
    const t = buildTerrain(scene, grid, {});
    const index = 7 * grid.size + 5;
    const before = new THREE.Color();
    const neighborBefore = new THREE.Color();
    t.ground.getColorAt(index, before);
    t.ground.getColorAt(index + 1, neighborBefore);

    t.setGroundTile(5, 7, 'ore');
    const after = new THREE.Color();
    const neighborAfter = new THREE.Color();
    t.ground.getColorAt(index, after);
    t.ground.getColorAt(index + 1, neighborAfter);

    expect(after.equals(before)).toBe(false);
    // ore base color 0x565a60 times the brightness jitter, stored in the
    // linear working color space (setHex converts from sRGB).
    expect(after.b).toBeGreaterThan(after.r); // 0x60 > 0x56
    expect(after.r).toBeGreaterThan(0.06);
    expect(after.r).toBeLessThan(0.13);
    expect(neighborAfter.equals(neighborBefore)).toBe(true);

    // Out-of-bounds and unknown types are safe no-ops / grass fallback.
    t.setGroundTile(-1, 0, 'ore');
    t.setGroundTile(5, 7, 'not-a-type');
    const fallback = new THREE.Color();
    t.ground.getColorAt(index, fallback);
    expect(fallback.g).toBeGreaterThan(fallback.b); // grass 0x6d744f: g > b
  });

  it('scatters dense rocks on ore tiles and clearDecorationsAt strips one tile only', () => {
    const grid = createGrid();
    grid.cells[20][20] = { type: 'ore', occupiedBy: null, walkable: true };
    grid.cells[20][21] = { type: 'ore', occupiedBy: null, walkable: true };
    const scene = new THREE.Scene();
    const t = buildTerrain(scene, grid, { rocks: fakeProp(1.5) });

    const before = totalDecorationInstances(t.decorations);
    expect(before).toBeGreaterThanOrEqual(2); // at least 1 rock per ore tile
    expect(before).toBeLessThanOrEqual(4); // at most 2 per tile

    t.clearDecorationsAt(20, 20);
    const mid = totalDecorationInstances(t.decorations);
    expect(mid).toBeLessThan(before);
    expect(mid).toBeGreaterThanOrEqual(1); // the other vein tile keeps its rocks

    t.clearDecorationsAt(21, 20);
    expect(totalDecorationInstances(t.decorations)).toBe(0);
    t.clearDecorationsAt(0, 0); // clearing an empty tile is a harmless no-op
    expect(totalDecorationInstances(t.decorations)).toBe(0);
  });

  it('scatters 1-2 deer on wildlife tiles, tracked per tile', () => {
    const grid = createGrid();
    grid.cells[20][20] = { type: 'wildlife', occupiedBy: null, walkable: true };
    grid.cells[20][21] = { type: 'wildlife', occupiedBy: null, walkable: true };
    const scene = new THREE.Scene();
    const t = buildTerrain(scene, grid, { deer: fakeProp(1) });

    const before = totalDecorationInstances(t.decorations);
    expect(before).toBeGreaterThanOrEqual(2); // at least 1 deer per herd tile
    expect(before).toBeLessThanOrEqual(4); // at most 2 per tile

    t.clearDecorationsAt(20, 20);
    expect(totalDecorationInstances(t.decorations)).toBeLessThan(before);
    t.clearDecorationsAt(21, 20);
    expect(totalDecorationInstances(t.decorations)).toBe(0);
  });

  it('addDecorationAt plants a prop on a tile with tracking, clearDecorationsAt removes it', () => {
    const grid = createGrid();
    const scene = new THREE.Scene();
    const t = buildTerrain(scene, grid, { 'tree-1': fakeProp(2) });
    expect(totalDecorationInstances(t.decorations)).toBe(0);

    // Unknown props and out-of-bounds tiles are ignored.
    t.addDecorationAt(4, 4, 'not-a-prop', 2);
    t.addDecorationAt(-1, 0, 'tree-1', 2);
    expect(totalDecorationInstances(t.decorations)).toBe(0);

    // Forester-style planting: two trees on one tile, one on the next.
    t.addDecorationAt(10, 10, 'tree-1', 1.8);
    t.addDecorationAt(10, 10, 'tree-1', 2.4);
    t.addDecorationAt(10, 11, 'tree-1', 2);
    expect(totalDecorationInstances(t.decorations)).toBe(3);

    t.clearDecorationsAt(10, 10);
    expect(totalDecorationInstances(t.decorations)).toBe(1);
    t.clearDecorationsAt(10, 11);
    expect(totalDecorationInstances(t.decorations)).toBe(0);
  });
});
