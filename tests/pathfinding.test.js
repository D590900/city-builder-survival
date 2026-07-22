import { describe, it, expect } from 'vitest';
import { findPath, findNearestTarget, nextStep } from '../src/zombies/pathfinding.js';

function makeGrid(size = 8) {
  const cells = [];
  for (let z = 0; z < size; z++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      row.push({ type: 'ground', occupiedBy: null, walkable: true });
    }
    cells.push(row);
  }
  return { size, cells };
}

function wallOff(grid, x, z) {
  grid.cells[z][x].walkable = false;
}

function expectContiguous(path) {
  for (let i = 1; i < path.length; i++) {
    const d = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].z - path[i - 1].z);
    expect(d).toBe(1);
  }
}

describe('findPath', () => {
  it('finds a straight path on an open grid', () => {
    const grid = makeGrid(8);
    const path = findPath(grid, 0, 0, 5, 0);
    expect(path).not.toBeNull();
    expect(path.length).toBe(6); // 5 steps + start tile
    expect(path[0]).toEqual({ x: 0, z: 0 });
    expect(path[path.length - 1]).toEqual({ x: 5, z: 0 });
    expectContiguous(path);
    // Straight line along z = 0.
    expect(path.every((t) => t.z === 0)).toBe(true);
  });

  it('walks around a wall through the only gap', () => {
    const grid = makeGrid(8);
    // Vertical wall at x = 3, open only at z = 7.
    for (let z = 0; z < 7; z++) wallOff(grid, 3, z);

    const path = findPath(grid, 0, 0, 7, 0);
    expect(path).not.toBeNull();
    expect(path[0]).toEqual({ x: 0, z: 0 });
    expect(path[path.length - 1]).toEqual({ x: 7, z: 0 });
    expectContiguous(path);
    // Must detour through the gap tile...
    expect(path.some((t) => t.x === 3 && t.z === 7)).toBe(true);
    // ...and never step on a wall tile.
    expect(path.some((t) => t.x === 3 && t.z < 7)).toBe(false);
    // Shortest detour: 21 steps = 22 tiles (manhattan would be 7 steps).
    expect(path.length).toBe(22);
  });

  it('returns null when the goal is unreachable', () => {
    const grid = makeGrid(8);
    for (let z = 0; z < 8; z++) wallOff(grid, 3, z); // full vertical wall
    expect(findPath(grid, 0, 0, 7, 0)).toBeNull();
  });

  it('returns null when the start tile is not valid', () => {
    const grid = makeGrid(8);
    expect(findPath(grid, -1, 0, 5, 5)).toBeNull(); // out of bounds
    expect(findPath(grid, 0, 8, 5, 5)).toBeNull(); // out of bounds

    wallOff(grid, 1, 1);
    expect(findPath(grid, 1, 1, 5, 5)).toBeNull(); // not walkable

    grid.cells[2][2].occupiedBy = 'building-1';
    expect(findPath(grid, 2, 2, 5, 5)).toBeNull(); // occupied
  });

  it('returns the single tile when start equals goal', () => {
    const grid = makeGrid(8);
    expect(findPath(grid, 2, 2, 2, 2)).toEqual([{ x: 2, z: 2 }]);
  });

  it('reaches a goal tile even when it is occupied and not walkable', () => {
    const grid = makeGrid(8);
    // The goal is a building tile: occupied and not walkable.
    grid.cells[0][5].occupiedBy = 'building-1';
    grid.cells[0][5].walkable = false;

    const path = findPath(grid, 0, 0, 5, 0);
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ x: 5, z: 0 });
    expectContiguous(path);
  });
});

describe('findNearestTarget', () => {
  it('picks the nearest reachable building, not the walled one', () => {
    const grid = makeGrid(10);
    const walled = { x: 2, z: 2, w: 1, h: 1 };
    const open = { x: 8, z: 8, w: 1, h: 1 };

    // Both are occupied building tiles...
    grid.cells[2][2].occupiedBy = 'walled';
    grid.cells[8][8].occupiedBy = 'open';
    // ...but the nearer one is sealed off by walls on all 4 sides.
    wallOff(grid, 1, 2);
    wallOff(grid, 3, 2);
    wallOff(grid, 2, 1);
    wallOff(grid, 2, 3);

    const result = findNearestTarget(grid, 0, 0, [walled, open]);
    expect(result).not.toBeNull();
    expect(result.building).toBe(open);
    const path = result.path;
    expect(path[0]).toEqual({ x: 0, z: 0 });
    expect(path[path.length - 1]).toEqual({ x: 8, z: 8 });
    expectContiguous(path);
  });

  it('targets the footprint tile closest to the zombie', () => {
    const grid = makeGrid(10);
    const big = { x: 4, z: 4, w: 2, h: 2 };
    for (let z = 4; z < 6; z++) {
      for (let x = 4; x < 6; x++) {
        grid.cells[z][x].occupiedBy = 'big';
        grid.cells[z][x].walkable = false;
      }
    }

    // Zombie west of the building, aligned with its top row: nearest edge
    // tile is (4, 4).
    const result = findNearestTarget(grid, 0, 4, [big]);
    expect(result).not.toBeNull();
    expect(result.building).toBe(big);
    expect(result.path[result.path.length - 1]).toEqual({ x: 4, z: 4 });
  });

  it('returns null when nothing is reachable', () => {
    const grid = makeGrid(10);
    const walled = { x: 2, z: 2, w: 1, h: 1 };
    wallOff(grid, 1, 2);
    wallOff(grid, 3, 2);
    wallOff(grid, 2, 1);
    wallOff(grid, 2, 3);

    expect(findNearestTarget(grid, 0, 0, [walled])).toBeNull();
    expect(findNearestTarget(grid, 0, 0, [])).toBeNull();
  });

  it('prefers a farther high-interest target over a closer dull one', () => {
    const grid = makeGrid(20);
    // Weighted like zombie.js does: an unstaffed well (×4.0) at distSq 9
    // scores 36, a staffed farm (×0.3) at distSq 64 scores 19.2 and wins.
    const well = { x: 3, z: 0, w: 1, h: 1 };
    const farm = { x: 8, z: 0, w: 1, h: 1 };
    grid.cells[0][3].occupiedBy = 'well';
    grid.cells[0][8].occupiedBy = 'farm';

    const result = findNearestTarget(grid, 0, 0, [
      { building: well, weight: 4.0 },
      { building: farm, weight: 0.3 },
    ]);
    expect(result).not.toBeNull();
    expect(result.building).toBe(farm);
    expect(result.path[result.path.length - 1]).toEqual({ x: 8, z: 0 });
  });

  it('treats bare buildings as weight 1 (backward compatible)', () => {
    const grid = makeGrid(10);
    const near = { x: 2, z: 0, w: 1, h: 1 };
    const far = { x: 7, z: 0, w: 1, h: 1 };
    grid.cells[0][2].occupiedBy = 'near';
    grid.cells[0][7].occupiedBy = 'far';

    // Old format (plain building array): nearest wins, like before.
    const result = findNearestTarget(grid, 0, 0, [far, near]);
    expect(result).not.toBeNull();
    expect(result.building).toBe(near);
  });

  it('falls back to a wall when everything interesting is sealed off', () => {
    const grid = makeGrid(10);
    const farm = { x: 2, z: 2, w: 1, h: 1 };
    const wall = { x: 5, z: 0, w: 1, h: 1 };
    grid.cells[2][2].occupiedBy = 'farm';
    grid.cells[0][5].occupiedBy = 'wall';
    // The farm scores better (8 × 0.3 = 2.4 vs 25 × 1.0 = 25) but its four
    // neighbors are sealed: the wall stays the barrier to chew through.
    wallOff(grid, 1, 2);
    wallOff(grid, 3, 2);
    wallOff(grid, 2, 1);
    wallOff(grid, 2, 3);

    const result = findNearestTarget(grid, 0, 0, [
      { building: farm, weight: 0.3 },
      { building: wall, weight: 1.0 },
    ]);
    expect(result).not.toBeNull();
    expect(result.building).toBe(wall);
  });
});

describe('roads', () => {
  // A tile holding a road building: occupied and not walkable (occupy()
  // marks every building that way), but flagged as a road.
  function makeRoad(grid, x, z) {
    const cell = grid.cells[z][x];
    cell.occupiedBy = 'road-1';
    cell.walkable = false;
    cell.road = true;
  }

  it('crosses an occupied road tile to reach the other side', () => {
    const grid = makeGrid(8);
    for (let z = 0; z < 8; z++) wallOff(grid, 3, z); // full vertical wall…
    makeRoad(grid, 3, 4); // …with a road tile as the only way through

    const path = findPath(grid, 0, 0, 7, 0);
    expect(path).not.toBeNull();
    expect(path.some((t) => t.x === 3 && t.z === 4)).toBe(true);
    expectContiguous(path);
  });

  it('still blocks the path on an occupied tile without the road flag', () => {
    const grid = makeGrid(8);
    for (let z = 0; z < 8; z++) wallOff(grid, 3, z);
    const cell = grid.cells[4][3];
    cell.occupiedBy = 'building-1'; // occupied by a normal building, not a road
    cell.walkable = false;
    expect(findPath(grid, 0, 0, 7, 0)).toBeNull();
  });

  it('plans a path starting from a road tile', () => {
    const grid = makeGrid(8);
    makeRoad(grid, 0, 0); // a zombie standing on a road can re-plan
    const path = findPath(grid, 0, 0, 4, 0);
    expect(path).not.toBeNull();
    expect(path[0]).toEqual({ x: 0, z: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, z: 0 });
    expectContiguous(path);
  });

  it('targets a building behind a road, crossing the road tiles', () => {
    const grid = makeGrid(10);
    makeRoad(grid, 2, 0);
    makeRoad(grid, 3, 0);
    const farm = { x: 5, z: 0, w: 1, h: 1 };
    grid.cells[0][5].occupiedBy = 'farm';

    const result = findNearestTarget(grid, 0, 0, [{ building: farm, weight: 0.3 }]);
    expect(result).not.toBeNull();
    expect(result.building).toBe(farm);
    expect(result.path.some((t) => t.x === 2 && t.z === 0)).toBe(true);
    expect(result.path.some((t) => t.x === 3 && t.z === 0)).toBe(true);
  });
});

describe('nextStep', () => {
  it('returns the next tile of a path', () => {
    const path = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 2, z: 0 },
    ];
    expect(nextStep(path)).toEqual({ x: 1, z: 0 });
  });

  it('returns null when there is no next tile', () => {
    expect(nextStep(null)).toBeNull();
    expect(nextStep([])).toBeNull();
    expect(nextStep([{ x: 0, z: 0 }])).toBeNull();
  });
});
