import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  createGrid,
  GRID_SIZE,
  isFree,
  occupy,
  occupyTrap,
  release,
  getCell,
} from '../src/world/grid.js';
import { findPath } from '../src/zombies/pathfinding.js';
import { createZombieManager } from '../src/zombies/zombie.js';
import { createCombat } from '../src/zombies/combat.js';
import { createGameState, addBuilding } from '../src/sim/state.js';
import { getDef } from '../src/buildings/definitions.js';
import { waveForNight } from '../src/sim/waves.js';

// The trap definition lives in definitions.js (rewritten in parallel); when
// it is missing, fall back to the v3 contract fixture so these tests stay
// hermetic either way. The real def is preferred once it lands.
vi.mock('../src/buildings/definitions.js', async (importOriginal) => {
  const actual = await importOriginal();
  const trapFixture = {
    id: 'trap',
    name: 'Trappola',
    desc: 'Ferisce gli zombie che la calpestano, usurandosi.',
    cost: { wood: 10, metal: 5 },
    w: 1,
    h: 1,
    hp: 100,
    produces: {},
    consumes: {},
    jobs: 0,
    houses: 0,
    requiresEnergy: 0,
    energyDayOnly: false,
    energyCap: 0,
    extracts: null,
    extractRate: 0,
    plants: null,
    researchRate: 0,
    requiresTech: null,
    isWall: false,
    isTower: false,
    isTrap: true,
    trapDamage: 6,
    damage: 0,
    range: 0,
    fireRate: 0,
    model: 'trap',
  };
  return {
    ...actual,
    getDef: (id) => actual.getDef(id) ?? (id === 'trap' ? trapFixture : undefined),
  };
});

// --- helpers ---------------------------------------------------------------

function makeTemplate() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshBasicMaterial());
  group.add(mesh);
  return group;
}

// Same fake asset shape as tests/zombies.test.js: clonable templates plus
// animation clips resolvable by findClip.
function makeAssets() {
  const clips = [
    new THREE.AnimationClip('walk', 0.6, []),
    new THREE.AnimationClip('attack', 0.5, []),
    new THREE.AnimationClip('die', 0.4, []),
    new THREE.AnimationClip('idle', 1, []),
  ];
  return {
    models: new Map([
      ['zombie', makeTemplate()],
      ['zombie-crawler', makeTemplate()],
    ]),
    animations: new Map([
      ['zombie', clips],
      ['zombie-crawler', clips],
    ]),
  };
}

function setupWorld() {
  const scene = new THREE.Scene();
  const grid = createGrid();
  const state = createGameState();
  const manager = createZombieManager({ scene, grid, state, assets: makeAssets() });
  return { scene, grid, state, manager };
}

function placeTrap(grid, state, x, z) {
  const b = addBuilding(state, 'trap', getDef('trap'), x, z);
  occupyTrap(grid, x, z, b.id);
  return b;
}

function placeBuilding(grid, state, defId, x, z) {
  const b = addBuilding(state, defId, getDef(defId), x, z);
  occupy(grid, x, z, b.w, b.h, b.id);
  return b;
}

function makeVisuals() {
  return {
    meshes: new Map(),
    removed: [],
    damaged: [],
    remove(id) {
      this.removed.push(id);
    },
    setDamaged(id, ratio) {
      this.damaged.push({ id, ratio });
    },
  };
}

function stubZombieManager(zombies) {
  return {
    zombies,
    damageZombie(z, dmg) {
      z.hp -= dmg;
    },
  };
}

// --- grid ------------------------------------------------------------------

describe('grid traps', () => {
  it('occupyTrap marks the cell without blocking movement; release clears it', () => {
    const grid = createGrid();
    expect(isFree(grid, 10, 10)).toBe(true);

    expect(occupyTrap(grid, 10, 10, 42)).toBe(true);
    const cell = getCell(grid, 10, 10);
    expect(cell.trap).toBe(42);
    expect(cell.walkable).toBe(true); // pathing unaffected
    expect(cell.occupiedBy).toBeNull(); // not a building footprint
    expect(isFree(grid, 10, 10)).toBe(false); // but nothing else builds here

    release(grid, 42);
    expect(cell.trap).toBeNull();
    expect(isFree(grid, 10, 10)).toBe(true);
  });

  it('occupyTrap rejects out-of-bounds tiles', () => {
    const grid = createGrid();
    expect(occupyTrap(grid, -1, 0, 1)).toBe(false);
    expect(occupyTrap(grid, 0, GRID_SIZE, 1)).toBe(false);
    expect(getCell(grid, 0, 0).trap).toBeUndefined(); // untouched fresh cell
  });

  it('release only clears the matching trap id', () => {
    const grid = createGrid();
    occupyTrap(grid, 5, 5, 1);
    occupyTrap(grid, 6, 6, 2);
    release(grid, 1);
    expect(getCell(grid, 5, 5).trap).toBeNull();
    expect(getCell(grid, 6, 6).trap).toBe(2);
  });
});

// --- pathfinding -----------------------------------------------------------

describe('pathfinding with traps', () => {
  it('findPath walks straight through a trapped tile', () => {
    const grid = createGrid();
    // Full vertical wall at x = 32; the only gap is the trapped tile.
    for (let z = 0; z < GRID_SIZE; z++) {
      if (z === 20) continue;
      occupy(grid, 32, z, 1, 1, `wall-${z}`);
    }
    occupyTrap(grid, 32, 20, 99);

    const path = findPath(grid, 10, 20, 50, 20);
    expect(path).not.toBeNull();
    expect(path[0]).toEqual({ x: 10, z: 20 });
    expect(path[path.length - 1]).toEqual({ x: 50, z: 20 });
    // The only way across the wall is the trapped tile.
    expect(path.some((t) => t.x === 32 && t.z === 20)).toBe(true);
    for (let i = 1; i < path.length; i++) {
      const d = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].z - path[i - 1].z);
      expect(d).toBe(1);
    }
  });
});

// --- zombie/trap interaction -----------------------------------------------

describe('zombies on traps', () => {
  it('damages a zombie standing on the trap tile and wears the trap down', () => {
    const { grid, state, manager } = setupWorld();
    const trap = placeTrap(grid, state, 20, 20);
    // No targetable buildings: the zombie shambles in place on the trap.
    const z = manager.spawn(20, 20, { hp: 100, damage: 1, speed: 1.5 });

    for (let i = 0; i < 10; i++) manager.update(0.1); // 1 second on the trap
    expect(z.hp).toBeCloseTo(100 - 6 * 1, 5); // trapDamage 6 dps
    expect(trap.hp).toBeCloseTo(100 - 2 * 1, 5); // 2 hp/s while damaging
  });

  it('wears the trap down once per tick even with several zombies on it', () => {
    const { grid, state, manager } = setupWorld();
    const trap = placeTrap(grid, state, 20, 20);
    const z1 = manager.spawn(20, 20, { hp: 100, damage: 1, speed: 1.5 });
    const z2 = manager.spawn(20, 20, { hp: 100, damage: 1, speed: 1.5 });

    for (let i = 0; i < 10; i++) manager.update(0.1);
    expect(z1.hp).toBeCloseTo(100 - 6, 5); // both zombies get hurt
    expect(z2.hp).toBeCloseTo(100 - 6, 5);
    expect(trap.hp).toBeCloseTo(100 - 2, 5); // but the trap degrades at 2 hp/s
  });

  it('does not wear the trap down when nobody stands on it', () => {
    const { grid, state, manager } = setupWorld();
    const trap = placeTrap(grid, state, 20, 20);
    const z = manager.spawn(30, 30, { hp: 100, damage: 1, speed: 1.5 });

    for (let i = 0; i < 10; i++) manager.update(0.1);
    expect(z.hp).toBe(100);
    expect(trap.hp).toBe(100);
  });

  it('kills a zombie that stays on the trap', () => {
    const { grid, state, manager } = setupWorld();
    placeTrap(grid, state, 20, 20);
    const z = manager.spawn(20, 20, { hp: 5, damage: 1, speed: 1.5 });

    manager.update(1); // 6 dps over 1s kills 5 hp
    expect(z.state).toBe('dying');
    for (let i = 0; i < 20; i++) manager.update(0.1);
    expect(manager.count()).toBe(0);
    expect(state.kills).toBe(1);
  });
});

// --- targeting ---------------------------------------------------------------

describe('zombie targeting with traps', () => {
  it('never targets a trap, even when it is the only building', () => {
    const { grid, state, manager } = setupWorld();
    placeTrap(grid, state, 24, 32);
    const z = manager.spawn(20, 32, waveForNight(1));

    for (let i = 0; i < 30; i++) manager.update(0.1);
    expect(z.target).toBeNull();
    expect(z.state).toBe('walking');
  });

  it('walks past the trap and attacks the real building behind it', () => {
    const { grid, state, manager } = setupWorld();
    const trap = placeTrap(grid, state, 24, 32); // nearer to the zombie...
    const tent = placeBuilding(grid, state, 'tent', 32, 32); // ...than the tent
    const z = manager.spawn(20, 32, waveForNight(1));

    let steps = 0;
    while (z.state === 'walking' && steps < 600) {
      manager.update(0.1);
      steps++;
    }
    expect(z.state).toBe('attacking');
    expect(z.target?.id).toBe(tent.id); // the trap was never the target
    expect(Math.abs(z.tileX - 32) + Math.abs(z.tileZ - 32)).toBe(1);
    // Crossing the trapped tile hurt the zombie and wore the trap down.
    expect(z.hp).toBeLessThan(z.maxHp);
    expect(trap.hp).toBeLessThan(100);
  });
});

// --- destruction -----------------------------------------------------------

describe('trap destruction', () => {
  it('combat removes a destroyed trap from state, grid and visuals', () => {
    const scene = new THREE.Scene();
    const grid = createGrid();
    const state = createGameState();
    const visuals = makeVisuals();
    const combat = createCombat({ scene, state, grid, visuals });
    const trap = placeTrap(grid, state, 12, 12);
    trap.hp = 0;

    combat.update(0.016, stubZombieManager([]));
    expect(state.buildings.length).toBe(0);
    const cell = getCell(grid, 12, 12);
    expect(cell.trap).toBeNull();
    expect(cell.occupiedBy).toBeNull();
    expect(cell.walkable).toBe(true);
    expect(isFree(grid, 12, 12)).toBe(true);
    expect(visuals.removed).toEqual([trap.id]);
    expect(state.events.some((e) => e.type === 'destroyed')).toBe(true);
  });

  it('a trap worn down by zombie damage is removed by the combat loop', () => {
    const scene = new THREE.Scene();
    const grid = createGrid();
    const state = createGameState();
    const visuals = makeVisuals();
    const manager = createZombieManager({ scene, grid, state, assets: makeAssets() });
    const combat = createCombat({ scene, state, grid, visuals });
    const trap = placeTrap(grid, state, 20, 20);
    manager.spawn(20, 20, { hp: 500, damage: 1, speed: 1.5 });

    for (let i = 0; i < 60; i++) {
      manager.update(1); // trap: 2 hp/s while damaging -> dead after ~50s
      combat.update(1, manager);
    }
    expect(state.buildings.length).toBe(0);
    expect(getCell(grid, 20, 20).trap).toBeNull();
    expect(visuals.removed).toEqual([trap.id]);
  });
});
