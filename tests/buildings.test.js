import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBuildingVisuals, scaleForFootprint } from '../src/buildings/visuals.js';
import { createPlacement, proximityEfficiencyAt, wallLineTiles } from '../src/buildings/placement.js';

// Smoke test: modules must import cleanly in node (no WebGL/DOM side
// effects) and expose the documented factories. Instantiation is covered
// by the browser game, not here.
describe('buildings modules', () => {
  it('visuals.js exports the createBuildingVisuals factory', () => {
    expect(typeof createBuildingVisuals).toBe('function');
  });

  it('placement.js exports the createPlacement factory', () => {
    expect(typeof createPlacement).toBe('function');
  });
});

// Minimal grid shaped like world/grid.js output: all grass unless overridden
// by `types` ('x,z' -> cell type).
function mkGrid(types = {}, size = 9) {
  const cells = [];
  for (let z = 0; z < size; z++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push({ type: types[`${x},${z}`] ?? 'grass' });
    cells.push(row);
  }
  return { size, cells };
}

describe('proximityEfficiencyAt', () => {
  const well = { proximity: { tile: 'water', range: 3, poor: 0.4 } };
  const hunt = { proximity: { tile: 'forest', range: 3, poor: 0.5 } };
  const ranch = { proximity: { tile: 'wildlife', range: 3, poor: 0.5 } };

  it('returns 1 when the required tile is in range, poor otherwise', () => {
    const grid = mkGrid({ '4,4': 'water' });
    expect(proximityEfficiencyAt(grid, well, { x: 2, z: 2, w: 1, h: 1 })).toBe(1); // distance 2 ≤ 3
    expect(proximityEfficiencyAt(grid, well, { x: 0, z: 0, w: 1, h: 1 })).toBe(0.4); // distance 4 > 3
  });

  it('honours the wildlife tile type for the ranch', () => {
    const grid = mkGrid({ '4,4': 'wildlife' });
    expect(proximityEfficiencyAt(grid, ranch, { x: 2, z: 2, w: 2, h: 2 })).toBe(1); // mandria in raggio
    expect(proximityEfficiencyAt(grid, ranch, { x: 0, z: 0, w: 1, h: 1 })).toBe(0.5); // troppo lontana
    // Altri tipi di tile non valgono come mandria.
    const forestGrid = mkGrid({ '4,4': 'forest' });
    expect(proximityEfficiencyAt(forestGrid, ranch, { x: 2, z: 2, w: 2, h: 2 })).toBe(0.5);
  });

  it('returns 1 for defs without a proximity rule', () => {
    expect(proximityEfficiencyAt(mkGrid(), { id: 'farm' }, { x: 0, z: 0, w: 1, h: 1 })).toBe(1);
    expect(proximityEfficiencyAt(mkGrid(), {}, { x: 0, z: 0, w: 1, h: 1 })).toBe(1);
  });

  it('honours the required tile type (forest for hunting, not water)', () => {
    const grid = mkGrid({ '3,3': 'forest' });
    expect(proximityEfficiencyAt(grid, hunt, { x: 2, z: 2, w: 1, h: 1 })).toBe(1);
    expect(proximityEfficiencyAt(grid, well, { x: 2, z: 2, w: 1, h: 1 })).toBe(0.4);
  });

  it('measures the range from the footprint edge, not just the anchor', () => {
    const grid = mkGrid({ '4,4': 'water' });
    // 2×2 footprint at (0,0): its far corner reaches (1,1), distance 3 ≤ 3.
    expect(proximityEfficiencyAt(grid, well, { x: 0, z: 0, w: 2, h: 2 })).toBe(1);
  });

  it('clamps the search to the grid bounds', () => {
    const grid = mkGrid({ '0,0': 'water' });
    expect(proximityEfficiencyAt(grid, well, { x: 1, z: 1, w: 1, h: 1 })).toBe(1);
    expect(proximityEfficiencyAt(grid, well, { x: 8, z: 8, w: 1, h: 1 })).toBe(0.4);
  });
});

describe('wallLineTiles', () => {
  it('draws a horizontal row on start.z when |dx| >= |dz|', () => {
    expect(wallLineTiles({ x: 2, z: 5 }, { x: 6, z: 7 })).toEqual([
      { x: 2, z: 5 },
      { x: 3, z: 5 },
      { x: 4, z: 5 },
      { x: 5, z: 5 },
      { x: 6, z: 5 },
    ]);
  });

  it('draws a vertical column on start.x when |dz| > |dx|', () => {
    expect(wallLineTiles({ x: 3, z: 2 }, { x: 4, z: 6 })).toEqual([
      { x: 3, z: 2 },
      { x: 3, z: 3 },
      { x: 3, z: 4 },
      { x: 3, z: 5 },
      { x: 3, z: 6 },
    ]);
  });

  it('returns a single tile when start equals end', () => {
    expect(wallLineTiles({ x: 10, z: 10 }, { x: 10, z: 10 })).toEqual([{ x: 10, z: 10 }]);
  });

  it('walks backwards when the end precedes the start', () => {
    expect(wallLineTiles({ x: 5, z: 1 }, { x: 3, z: 1 })).toEqual([
      { x: 5, z: 1 },
      { x: 4, z: 1 },
      { x: 3, z: 1 },
    ]);
    expect(wallLineTiles({ x: 1, z: 5 }, { x: 1, z: 3 })).toEqual([
      { x: 1, z: 5 },
      { x: 1, z: 4 },
      { x: 1, z: 3 },
    ]);
  });

  it('clamps both ends to the grid (0..63)', () => {
    const low = wallLineTiles({ x: -4, z: 0 }, { x: 2, z: 0 });
    expect(low[0]).toEqual({ x: 0, z: 0 });
    expect(low.at(-1)).toEqual({ x: 2, z: 0 });
    const high = wallLineTiles({ x: 62, z: 0 }, { x: 70, z: 0 });
    expect(high[0]).toEqual({ x: 62, z: 0 });
    expect(high.at(-1)).toEqual({ x: 63, z: 0 });
    const col = wallLineTiles({ x: 0, z: -2 }, { x: 0, z: 99 });
    expect(col[0]).toEqual({ x: 0, z: 0 });
    expect(col.at(-1)).toEqual({ x: 0, z: 63 });
  });

  it('prefers the horizontal axis on a perfect diagonal (|dx| === |dz|)', () => {
    const tiles = wallLineTiles({ x: 4, z: 4 }, { x: 7, z: 7 });
    expect(tiles).toEqual([
      { x: 4, z: 4 },
      { x: 5, z: 4 },
      { x: 6, z: 4 },
      { x: 7, z: 4 },
    ]);
  });
});

// --- scaleForFootprint ------------------------------------------------------
// Shared by visuals.add() and the placement ghost: preview and placed result
// must always match.

function boxGroup(w, h, d) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial()));
  return g;
}

function sizeOf(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  return size;
}

describe('scaleForFootprint', () => {
  it('scales to 1.6 units per footprint row on a 1x1', () => {
    const g = boxGroup(1, 2, 1);
    scaleForFootprint(g, { h: 1 }, 1, 1);
    expect(sizeOf(g).y).toBeCloseTo(1.6, 6);
  });

  it('shrinks models whose width would overflow the footprint', () => {
    const g = boxGroup(10, 2, 10); // merge largo, es. il rottamatore
    scaleForFootprint(g, { h: 1 }, 1, 1); // cap orizzontale: 1 × 2 × 0.95 = 1.9
    const size = sizeOf(g);
    expect(size.x).toBeCloseTo(1.9, 6);
    expect(size.y).toBeCloseTo(0.38, 6); // scala uniforme 0.19, non quella d'altezza
  });

  it('applies the optional modelScaleMul after the footprint fit', () => {
    const g = boxGroup(1, 2, 1);
    scaleForFootprint(g, { h: 3, modelScaleMul: 0.5 }, 3, 3);
    expect(sizeOf(g).y).toBeCloseTo(4 * 0.5, 6); // cap altezza 4, poi ×0.5 (hq)
  });

  it('honours modelWidthFrac for thin structures (road: 1/4 of the tile)', () => {
    const g = boxGroup(1, 0.02, 1); // lastra piatta come il GLB road-straight
    scaleForFootprint(g, { h: 1, modelWidthFrac: 0.25 }, 1, 1);
    const size = sizeOf(g);
    expect(size.x).toBeCloseTo(0.5, 6); // 1 tile × 2 × 0.25, centrata
    expect(size.y).toBeCloseTo(0.01, 6); // scala uniforme 0.5: resta piatta
  });
});
