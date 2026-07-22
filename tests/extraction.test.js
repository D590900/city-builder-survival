import { describe, it, expect } from 'vitest';
import {
  TILE_YIELDS,
  tickExtraction,
  countNodesInRange,
  nearestNode,
  hasFreeGrassInRange,
} from '../src/sim/extraction.js';

const DAY_LENGTH = 90; // mirrors state.js CONFIG.dayLength

// --- Inline v2-shaped fixtures (no imports from state.js/definitions.js) ---

function mkState() {
  return {
    day: 1,
    phase: 'day',
    resources: { food: 50, water: 50, wood: 0, metal: 0, energy: 0 },
    caps: { food: 150, water: 100, wood: 150, metal: 150, energy: 60 },
    survivors: [],
    buildings: [],
    nextSurvivorId: 1,
    nextBuildingId: 1,
    events: [],
    weather: { current: 'clear' },
  };
}

function mkBuilding(state, defId, def, x, z, workers = 0) {
  const b = {
    id: state.nextBuildingId++,
    defId,
    x,
    z,
    w: def.w ?? 1,
    h: def.h ?? 1,
    hp: 100,
    maxHp: 100,
    powered: true,
    workers: [],
    autoAssign: true,
    extracted: 0,
    efficiency: 1,
  };
  for (let i = 0; i < workers; i++) b.workers.push(1000 + i); // fake survivor ids
  state.buildings.push(b);
  return b;
}

function mkGrid(size = 9) {
  const cells = [];
  for (let z = 0; z < size; z++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      row.push({ type: 'grass', occupiedBy: null, walkable: true });
    }
    cells.push(row);
  }
  return { size, cells };
}

const DEFS = {
  sawmill: { name: 'Segheria', extracts: 'forest', extractRate: 10, jobs: 2, w: 1, h: 1 },
  forester: { name: 'Guardaboschi', plants: 'forest', jobs: 1, w: 1, h: 1 },
  house: { name: 'Casa', houses: 3, jobs: 0, w: 1, h: 1 },
};

describe('TILE_YIELDS', () => {
  it('matches the v2 contract', () => {
    expect(TILE_YIELDS).toEqual({
      forest: { resource: 'wood', amount: 20 },
      ruins: { resource: 'metal', amount: 25 },
      ore: { resource: 'metal', amount: 60 },
    });
  });
});

describe('extractors', () => {
  it('produce continuously at extractRate * staffing per day', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 2); // full staff

    tickExtraction(state, grid, DAY_LENGTH, DEFS);
    expect(state.resources.wood).toBeCloseTo(10);
  });

  it('scale production with the staffing ratio', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 1); // 1 of 2 jobs

    tickExtraction(state, grid, DAY_LENGTH, DEFS);
    expect(state.resources.wood).toBeCloseTo(5);
  });

  it('scale production with mods.extractProd', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 2);

    tickExtraction(state, grid, DAY_LENGTH, DEFS, { extractProd: 1.25 });
    expect(state.resources.wood).toBeCloseTo(12.5);
  });

  it('scale production with the building level (potenziamento)', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    const b = mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 2);
    b.level = 2; // ×1.5

    tickExtraction(state, grid, DAY_LENGTH, DEFS);
    expect(state.resources.wood).toBeCloseTo(15); // 10 × 1.5
  });

  it('produce nothing without workers or without nodes in range', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 0); // no workers
    const b2 = mkBuilding(state, 'sawmill', DEFS.sawmill, 0, 0, 2); // no forest near

    const out = tickExtraction(state, grid, DAY_LENGTH, DEFS);
    expect(state.resources.wood).toBe(0);
    expect(out.depleted).toHaveLength(0);
    expect(b2.extracted).toBe(0);
  });

  it('ignore buildings without extracts/plants and unknown defIds', () => {
    const state = mkState();
    const grid = mkGrid();
    mkBuilding(state, 'house', DEFS.house, 4, 4);
    const ghost = mkBuilding(state, 'ghost', {}, 0, 0);
    ghost.defId = 'missing';

    expect(() => tickExtraction(state, grid, DAY_LENGTH, DEFS)).not.toThrow();
  });

  it('deplete the nearest node once a full tile yield is extracted', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest'; // distance 1
    grid.cells[4][6].type = 'forest'; // distance 2
    const b = mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 2);

    const out = tickExtraction(state, grid, 2 * DAY_LENGTH, DEFS); // 20 wood = 1 yield
    expect(state.resources.wood).toBeCloseTo(20);
    expect(grid.cells[4][5].type).toBe('grass');
    expect(grid.cells[4][5].walkable).toBe(true);
    expect(grid.cells[4][6].type).toBe('forest'); // farther node untouched
    expect(b.extracted).toBeCloseTo(0);
    expect(out.depleted).toEqual([{ x: 5, z: 4, fromType: 'forest' }]);
  });

  it('stop producing when the last node is gone, even with leftover progress', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    const b = mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 2);
    b.extracted = 15; // carried over from earlier ticks

    tickExtraction(state, grid, DAY_LENGTH, DEFS); // +10 -> 25 >= 20: depletes
    expect(grid.cells[4][5].type).toBe('grass');
    expect(b.extracted).toBeCloseTo(5);

    const before = state.resources.wood;
    tickExtraction(state, grid, DAY_LENGTH, DEFS); // no nodes left: idle
    expect(state.resources.wood).toBe(before);
    expect(b.extracted).toBeCloseTo(5);
  });

  it('respect the resource cap and do not waste nodes while full', () => {
    const state = mkState();
    state.resources.wood = 145; // cap 150
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    const b = mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 2);

    const out = tickExtraction(state, grid, DAY_LENGTH, DEFS); // only +5 fits
    expect(state.resources.wood).toBe(150);
    expect(b.extracted).toBeCloseTo(5);
    expect(out.depleted).toHaveLength(0);
    expect(grid.cells[4][5].type).toBe('forest');
  });

  it('extract metal from ruins and ore with their own yields', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'ore';
    const defs = { mine: { extracts: 'ore', extractRate: 60, jobs: 1, w: 1, h: 1 } };
    const b = mkBuilding(state, 'mine', defs.mine, 4, 4, 1);

    const out = tickExtraction(state, grid, DAY_LENGTH, defs); // 60 metal = ore yield
    expect(state.resources.metal).toBeCloseTo(60);
    expect(grid.cells[4][5].type).toBe('grass');
    expect(b.extracted).toBeCloseTo(0);
    expect(out.depleted).toEqual([{ x: 5, z: 4, fromType: 'ore' }]);
  });

  it('extract nothing while switched off (enabled === false)', () => {
    const state = mkState();
    const grid = mkGrid();
    grid.cells[4][5].type = 'forest';
    const b = mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 4, 2);
    b.enabled = false;

    const out = tickExtraction(state, grid, DAY_LENGTH, DEFS);
    expect(state.resources.wood).toBe(0);
    expect(b.extracted).toBe(0);
    expect(grid.cells[4][5].type).toBe('forest');
    expect(out.depleted).toHaveLength(0);
  });
});

describe('foresters', () => {
  it('plant a forest on free grass after 20 worker-seconds and 2 water', () => {
    const state = mkState();
    const grid = mkGrid();
    const b = mkBuilding(state, 'forester', DEFS.forester, 4, 4, 1);

    const out = tickExtraction(state, grid, 20, DEFS); // 20s * staffing 1
    expect(state.resources.water).toBe(48);
    expect(b.extracted).toBe(0);
    expect(out.planted).toHaveLength(1);
    const { x, z } = out.planted[0];
    expect(grid.cells[z][x].type).toBe('forest');
  });

  it('accumulate progress across ticks', () => {
    const state = mkState();
    const grid = mkGrid();
    const b = mkBuilding(state, 'forester', DEFS.forester, 4, 4, 1);

    let out = tickExtraction(state, grid, 15, DEFS);
    expect(out.planted).toHaveLength(0);
    expect(b.extracted).toBeCloseTo(15);
    out = tickExtraction(state, grid, 5, DEFS);
    expect(out.planted).toHaveLength(1);
  });

  it('do not progress without at least 2 water', () => {
    const state = mkState();
    state.resources.water = 1;
    const grid = mkGrid();
    const b = mkBuilding(state, 'forester', DEFS.forester, 4, 4, 1);

    const out = tickExtraction(state, grid, 30, DEFS);
    expect(b.extracted).toBe(0);
    expect(out.planted).toHaveLength(0);
  });

  it('do not progress without free grass in range', () => {
    const state = mkState();
    const grid = mkGrid();
    // Occupy every grass tile within range 3 of the 1x1 building at (4,4).
    for (let z = 1; z <= 7; z++) {
      for (let x = 1; x <= 7; x++) grid.cells[z][x].occupiedBy = 'blocked';
    }
    const b = mkBuilding(state, 'forester', DEFS.forester, 4, 4, 1);

    const out = tickExtraction(state, grid, 30, DEFS);
    expect(b.extracted).toBe(0);
    expect(out.planted).toHaveLength(0);
  });

  it('scale planting speed with the staffing ratio', () => {
    const state = mkState();
    const grid = mkGrid();
    const defs = { nursery: { plants: 'forest', jobs: 2, w: 1, h: 1 } };
    const b = mkBuilding(state, 'nursery', defs.nursery, 4, 4, 1); // half staff

    tickExtraction(state, grid, 20, defs); // 20s * 0.5 = 10 < 20
    expect(b.extracted).toBeCloseTo(10);
  });

  it('plant nothing while switched off (enabled === false)', () => {
    const state = mkState();
    const grid = mkGrid();
    const b = mkBuilding(state, 'forester', DEFS.forester, 4, 4, 1);
    b.enabled = false;

    const out = tickExtraction(state, grid, 30, DEFS);
    expect(b.extracted).toBe(0);
    expect(out.planted).toHaveLength(0);
    expect(state.resources.water).toBe(50);
  });
});

describe('range helpers', () => {
  it('countNodesInRange uses Chebyshev distance 2 from the footprint edge', () => {
    const grid = mkGrid(12);
    const b = { x: 4, z: 4, w: 2, h: 2 }; // footprint covers (4..5, 4..5)
    grid.cells[6][6].type = 'forest'; // distance 1 from edge -> in range
    grid.cells[7][7].type = 'forest'; // distance 2 from edge -> in range
    grid.cells[8][8].type = 'forest'; // distance 3 -> out of range
    grid.cells[6][6].occupiedBy = 'x'; // occupied nodes still count as nodes
    expect(countNodesInRange(grid, b, 'forest')).toBe(2);
  });

  it('nearestNode returns the closest matching tile or null', () => {
    const grid = mkGrid();
    const b = { x: 4, z: 4, w: 1, h: 1 };
    expect(nearestNode(grid, b, 'forest')).toBeNull();
    grid.cells[4][6].type = 'forest'; // distance 2
    grid.cells[5][5].type = 'forest'; // distance 1
    const node = nearestNode(grid, b, 'forest');
    expect(node.x).toBe(5);
    expect(node.z).toBe(5);
    expect(node.cell).toBe(grid.cells[5][5]);
  });

  it('nearestNode clips the search to the grid bounds', () => {
    const grid = mkGrid(5);
    const b = { x: 0, z: 0, w: 1, h: 1 };
    grid.cells[0][2].type = 'forest';
    expect(nearestNode(grid, b, 'forest')).not.toBeNull();
    expect(countNodesInRange(grid, b, 'forest')).toBe(1);
  });

  it('hasFreeGrassInRange ignores occupied and non-grass tiles', () => {
    const grid = mkGrid(7);
    const b = { x: 3, z: 3, w: 1, h: 1 };
    expect(hasFreeGrassInRange(grid, b, 3)).toBe(true);
    for (let z = 0; z < 7; z++) {
      for (let x = 0; x < 7; x++) grid.cells[z][x].occupiedBy = 'blocked';
    }
    expect(hasFreeGrassInRange(grid, b, 3)).toBe(false);
  });
});
