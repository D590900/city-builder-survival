import { describe, it, expect } from 'vitest';
import { tickTrails, TRAIL_INTERVAL, MAX_TRAILS } from '../src/sim/trails.js';

// Griglia fittizia size×size di erba libera (stessa forma di world/grid.js).
function mkGrid(size = 8) {
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

// Marca l'impronta di un edificio come occupata (come occupy() in grid.js).
function occupyFootprint(grid, b, id) {
  for (let z = b.z; z < b.z + b.h; z++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      grid.cells[z][x].occupiedBy = id;
      grid.cells[z][x].walkable = false;
    }
  }
}

// Setup tipico: Rifugio 3×3 in (1,1) e fattoria 1×1 in (6,2), entrambi
// occupati sulla griglia; il primo passo greedy è (4,2).
function mkWorld() {
  const grid = mkGrid(8);
  const hq = { defId: 'hq', x: 1, z: 1, w: 3, h: 3 };
  const farm = { defId: 'farm', x: 6, z: 2, w: 1, h: 1 };
  occupyFootprint(grid, hq, 1);
  occupyFootprint(grid, farm, 2);
  const state = {
    buildings: [hq, farm],
    survivors: [{ id: 1, buildingId: null }], // un sopravvissuto inattivo
  };
  return { grid, state };
}

describe('tickTrails', () => {
  it('waits TRAIL_INTERVAL before the first placement', () => {
    const { grid, state } = mkWorld();
    expect(tickTrails(state, grid, TRAIL_INTERVAL - 0.1)).toBeNull();
    expect(tickTrails(state, grid, 0.2)).toEqual({ x: 4, z: 2 });
    // Il timer è stato consumato: riparte da zero.
    expect(tickTrails(state, grid, TRAIL_INTERVAL - 0.1)).toBeNull();
  });

  it('expands one greedy step from the Refuge footprint, x axis first', () => {
    const { grid, state } = mkWorld();
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toEqual({ x: 4, z: 2 });
  });

  it('only decides the tile: the grid is never mutated', () => {
    const { grid, state } = mkWorld();
    tickTrails(state, grid, TRAIL_INTERVAL);
    expect(grid.cells[2][4].type).toBe('grass');
  });

  it('places nothing without idle survivors', () => {
    const { grid, state } = mkWorld();
    state.survivors = [{ id: 1, buildingId: 2 }];
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toBeNull();
  });

  it('grows from the placed trail until the building is served, then stops', () => {
    const { grid, state } = mkWorld();
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toEqual({ x: 4, z: 2 });
    grid.cells[2][4].type = 'trail'; // main.js applica la tile decisa
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toEqual({ x: 5, z: 2 });
    grid.cells[2][5].type = 'trail';
    // La fattoria ha ora un sentiero adiacente: niente più piazzamenti.
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toBeNull();
  });

  it('skips occupied tiles and steps around them from the next source', () => {
    const { grid, state } = mkWorld();
    grid.cells[2][4].occupiedBy = 99; // il passo sull'asse x è bloccato
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toEqual({ x: 4, z: 1 });
  });

  it('skips water tiles', () => {
    const { grid, state } = mkWorld();
    grid.cells[2][4].type = 'water';
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toEqual({ x: 4, z: 1 });
  });

  it('skips trap tiles', () => {
    const { grid, state } = mkWorld();
    grid.cells[2][4].trap = 7;
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toEqual({ x: 4, z: 1 });
  });

  it('stops at MAX_TRAILS trail tiles', () => {
    const grid = mkGrid(16);
    const hq = { defId: 'hq', x: 1, z: 9, w: 3, h: 3 };
    const farm = { defId: 'farm', x: 14, z: 9, w: 1, h: 1 };
    occupyFootprint(grid, hq, 1);
    occupyFootprint(grid, farm, 2);
    const state = { buildings: [hq, farm], survivors: [{ id: 1, buildingId: null }] };
    // Esattamente MAX_TRAILS tile sterrate in alto, lontane dagli edifici.
    for (let i = 0; i < MAX_TRAILS; i++) {
      grid.cells[Math.floor(i / 16)][i % 16].type = 'trail';
    }
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toBeNull();
    // Una tile sotto il tetto: la rete riparte dalla tile sterrata più
    // vicina alla fattoria — (14,5), un passo sull'asse z.
    grid.cells[0][0].type = 'grass';
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toEqual({ x: 14, z: 6 });
  });

  it('never targets the Refuge itself or the roads', () => {
    const grid = mkGrid(8);
    const hq = { defId: 'hq', x: 1, z: 1, w: 3, h: 3 };
    const road = { defId: 'road', x: 5, z: 2, w: 1, h: 1 };
    occupyFootprint(grid, hq, 1);
    occupyFootprint(grid, road, 2);
    const state = { buildings: [hq, road], survivors: [{ id: 1, buildingId: null }] };
    expect(tickTrails(state, grid, TRAIL_INTERVAL)).toBeNull();
  });
});
