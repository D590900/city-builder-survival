import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { createZombieManager, pickZombieModel, ZOMBIE_BUILDING_DPS_MUL } from '../src/zombies/zombie.js';
import {
  createCombat,
  crossedThresholds,
  findNearestZombie,
  buildingCenterWorld,
  garrisonGuns,
  GARRISON_DAMAGE,
  DAMAGE_THRESHOLDS,
} from '../src/zombies/combat.js';
import { createGrid, occupy, release, getCell, tileToWorld } from '../src/world/grid.js';
import { createGameState, addBuilding, addSurvivor, removeBuilding } from '../src/sim/state.js';
import { getDef } from '../src/buildings/definitions.js';
import { waveForNight } from '../src/sim/waves.js';

// --- helpers ---------------------------------------------------------------

function makeTemplate() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshBasicMaterial());
  group.add(mesh);
  return group;
}

// Fake asset set with the same shape loadAll() returns: a clonable template
// per model plus animation clips resolvable by findClip.
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

function placeBuilding(grid, state, defId, x, z) {
  const b = addBuilding(state, defId, getDef(defId), x, z);
  occupy(grid, x, z, b.w, b.h, b.id, getDef(defId)?.isRoad === true);
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

// --- smoke -----------------------------------------------------------------

describe('module smoke', () => {
  it('exposes the documented factory API', () => {
    const { manager } = setupWorld();
    expect(Array.isArray(manager.zombies)).toBe(true);
    for (const fn of ['spawn', 'update', 'damageZombie', 'clearAll', 'count']) {
      expect(typeof manager[fn]).toBe('function');
    }
    const combat = createCombat({ scene: new THREE.Scene(), state: createGameState(), grid: createGrid(), visuals: makeVisuals() });
    expect(typeof combat.update).toBe('function');
  });
});

// --- pickZombieModel -------------------------------------------------------

describe('pickZombieModel', () => {
  it('picks zombie below 0.7 and zombie-crawler at/above it', () => {
    expect(pickZombieModel(0)).toBe('zombie');
    expect(pickZombieModel(0.69)).toBe('zombie');
    expect(pickZombieModel(0.7)).toBe('zombie-crawler');
    expect(pickZombieModel(0.999)).toBe('zombie-crawler');
  });
});

// --- zombie manager --------------------------------------------------------

describe('createZombieManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns a zombie with wave stats, clips and a mesh in the scene', () => {
    const { scene, manager } = setupWorld();
    const wave = waveForNight(1);
    const z = manager.spawn(5, 5, wave);

    expect(manager.count()).toBe(1);
    expect(scene.children).toContain(z.mesh);
    expect(z.hp).toBe(wave.hp);
    expect(z.maxHp).toBe(wave.hp);
    expect(z.damage).toBe(wave.damage);
    expect(z.speed).toBe(wave.speed);
    expect(z.state).toBe('walking');
    expect(z.actions.walk).toBeDefined();
    expect(z.actions.attack).toBeDefined();
    expect(z.actions.die).toBeDefined();
    // Spawned at the tile center.
    const world = tileToWorld(5, 5);
    expect(z.mesh.position.x).toBeCloseTo(world.x, 6);
    expect(z.mesh.position.z).toBeCloseTo(world.z, 6);
  });

  it('uses the crawler model when the roll says so', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { manager } = setupWorld();
    const z = manager.spawn(5, 5, waveForNight(1));
    expect(z.model).toBe('zombie-crawler');
  });

  it('walks to the nearest building and starts attacking it', () => {
    const { grid, state, manager } = setupWorld();
    const b = placeBuilding(grid, state, 'tent', 32, 32);
    const z = manager.spawn(20, 32, waveForNight(1));

    let steps = 0;
    while (z.state === 'walking' && steps < 600) {
      manager.update(0.1);
      steps++;
    }
    expect(z.state).toBe('attacking');
    // Stopped on the tile adjacent to the building, not on top of it.
    expect(Math.abs(z.tileX - 32) + Math.abs(z.tileZ - 32)).toBe(1);

    // One second of attacks: wave damage × ZOMBIE_BUILDING_DPS_MUL per
    // second (buildings last ~67% longer than the raw wave stats suggest).
    for (let i = 0; i < 10; i++) manager.update(0.1);
    expect(b.hp).toBeCloseTo(b.maxHp - z.damage * 1 * ZOMBIE_BUILDING_DPS_MUL, 5);
  });

  it('scales the attack damage on buildings by ZOMBIE_BUILDING_DPS_MUL', () => {
    expect(ZOMBIE_BUILDING_DPS_MUL).toBe(0.6);
    const { grid, state, manager } = setupWorld();
    const b = placeBuilding(grid, state, 'tent', 32, 32);
    const z = manager.spawn(31, 32, waveForNight(1)); // adjacent: attacks at once

    let steps = 0;
    while (z.state === 'walking' && steps < 10) {
      manager.update(0.1);
      steps++;
    }
    expect(z.state).toBe('attacking');

    manager.update(0.5);
    expect(b.hp).toBeCloseTo(b.maxHp - z.damage * 0.5 * 0.6, 5);
  });

  it('targets the staffed building, not the closer unstaffed one', () => {
    const { grid, state, manager } = setupWorld();
    const well = placeBuilding(grid, state, 'well', 34, 32); // 1 tile away, unstaffed (×4.0)
    const farm = placeBuilding(grid, state, 'farm', 30, 32); // 2 tiles away…
    farm.workers.push(1); // …but staffed (×0.3): zombies hunt people
    const z = manager.spawn(33, 32, waveForNight(1));

    manager.update(0.1); // the first repath picks the target
    expect(z.target).not.toBeNull();
    expect(z.target.id).toBe(farm.id);

    let steps = 0;
    while (z.state === 'walking' && steps < 200) {
      manager.update(0.1);
      steps++;
    }
    expect(z.state).toBe('attacking');
    expect(z.target.id).toBe(farm.id);
    expect(well.hp).toBe(well.maxHp); // the isolated well was ignored
  });

  it('walks over roads to reach a building, never attacking them', () => {
    const { grid, state, manager } = setupWorld();
    const r1 = placeBuilding(grid, state, 'road', 31, 32);
    const r2 = placeBuilding(grid, state, 'road', 32, 32);
    const farm = placeBuilding(grid, state, 'farm', 34, 32);
    farm.workers.push(1);
    const z = manager.spawn(29, 32, waveForNight(1));

    let steps = 0;
    while (z.state === 'walking' && steps < 300) {
      manager.update(0.1);
      steps++;
    }
    expect(z.state).toBe('attacking');
    expect(z.target.id).toBe(farm.id);
    expect(r1.hp).toBe(r1.maxHp); // crossed, not chewed
    expect(r2.hp).toBe(r2.maxHp);
  });

  it('finds no target when only roads exist', () => {
    const { grid, state, manager } = setupWorld();
    placeBuilding(grid, state, 'road', 31, 32);
    const z = manager.spawn(29, 32, waveForNight(1));

    for (let i = 0; i < 5; i++) manager.update(0.1);
    expect(z.target).toBeNull();
    expect(z.state).toBe('walking');
  });

  it('goes back to walking when its target is destroyed', () => {
    const { grid, state, manager } = setupWorld();
    const b = placeBuilding(grid, state, 'tent', 32, 32);
    const z = manager.spawn(21, 32, waveForNight(1)); // adjacent: attacks quickly

    let steps = 0;
    while (z.state === 'walking' && steps < 100) {
      manager.update(0.1);
      steps++;
    }
    expect(z.state).toBe('attacking');

    removeBuilding(state, b.id);
    release(grid, b.id);
    manager.update(0.1);
    expect(z.state).toBe('walking');
    expect(z.target).toBeNull();
  });

  it('kills a zombie: dying state, then removal and a kill counted', () => {
    const { scene, state, manager } = setupWorld();
    const z = manager.spawn(5, 5, waveForNight(1));

    manager.damageZombie(z, 9999);
    expect(z.state).toBe('dying');
    expect(z.hp).toBe(0);

    for (let i = 0; i < 20; i++) manager.update(0.1); // die clip lasts 0.4s
    expect(manager.count()).toBe(0);
    expect(scene.children).not.toContain(z.mesh);
    expect(state.kills).toBe(1);
  });

  it('ignores further damage on a dying zombie', () => {
    const { state, manager } = setupWorld();
    const z = manager.spawn(5, 5, waveForNight(1));
    manager.damageZombie(z, 9999);
    manager.damageZombie(z, 9999); // must not double-count or throw
    for (let i = 0; i < 20; i++) manager.update(0.1);
    expect(state.kills).toBe(1);
  });

  it('clearAll removes every zombie mesh from the scene', () => {
    const { scene, manager } = setupWorld();
    manager.spawn(5, 5, waveForNight(1));
    manager.spawn(6, 5, waveForNight(1));
    expect(manager.count()).toBe(2);

    manager.clearAll();
    expect(manager.count()).toBe(0);
    expect(scene.children.length).toBe(0);
  });
});

// --- combat pure helpers ---------------------------------------------------

describe('combat helpers', () => {
  it('crossedThresholds reports only newly crossed thresholds', () => {
    expect(crossedThresholds(1, 0.7)).toEqual([0.75]);
    expect(crossedThresholds(0.8, 0.2)).toEqual([0.75, 0.5, 0.25]);
    expect(crossedThresholds(0.6, 0.55)).toEqual([]);
    expect(crossedThresholds(0.2, 0.1)).toEqual([]); // already below all
    expect(DAMAGE_THRESHOLDS).toEqual([0.75, 0.5, 0.25]);
  });

  it('findNearestZombie picks the closest living zombie in range', () => {
    const near = { wx: 2, wz: 0, state: 'walking' };
    const far = { wx: 5, wz: 0, state: 'walking' };
    const dying = { wx: 1, wz: 0, state: 'dying' };
    expect(findNearestZombie(0, 0, [far, near, dying], 10)).toBe(near);
    expect(findNearestZombie(0, 0, [far], 4)).toBeNull(); // out of range
    expect(findNearestZombie(0, 0, [dying], 10)).toBeNull(); // dying ignored
  });

  it('buildingCenterWorld centers multi-tile footprints', () => {
    // 3x3 hq at (30, 30): center tile is (31, 31).
    const c = buildingCenterWorld({ x: 30, z: 30, w: 3, h: 3 });
    const expected = tileToWorld(31, 31);
    expect(c.x).toBeCloseTo(expected.x, 6);
    expect(c.z).toBeCloseTo(expected.z, 6);
  });
});

// --- combat: towers --------------------------------------------------------

describe('combat towers', () => {
  function setupCombat() {
    const scene = new THREE.Scene();
    const grid = createGrid();
    const state = createGameState();
    const visuals = makeVisuals();
    const combat = createCombat({ scene, state, grid, visuals });
    return { scene, grid, state, visuals, combat };
  }

  function addTower(grid, state, x = 32, z = 32) {
    const tower = placeBuilding(grid, state, 'tower', x, z);
    tower.workers.push(1);
    return tower;
  }

  it('fires at the nearest zombie in range, then respects the cooldown', () => {
    const { scene, grid, state, combat } = setupCombat();
    addTower(grid, state); // center of (32,32) is world (1,1)
    const z = { wx: 5, wz: 1, hp: 30, maxHp: 30, state: 'walking' }; // 4 units away, range is 12
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm);
    expect(z.hp).toBe(20); // tower def.damage = 10
    expect(scene.children.length).toBeGreaterThan(0); // tracer + flash

    combat.update(0.016, zm);
    expect(z.hp).toBe(20); // still cooling down (fireRate = 1/s)

    combat.update(1.0, zm);
    expect(z.hp).toBe(10); // second shot after the cooldown
  });

  it('does not fire without workers, power or a target in range', () => {
    const { grid, state, combat } = setupCombat();
    const tower = addTower(grid, state);
    const z = { wx: 5, wz: 1, hp: 30, maxHp: 30, state: 'walking' };
    const zm = stubZombieManager([z]);

    tower.workers.length = 0;
    combat.update(0.016, zm);
    expect(z.hp).toBe(30);

    tower.workers.push(1);
    tower.powered = false;
    combat.update(0.016, zm);
    expect(z.hp).toBe(30);

    tower.powered = true;
    z.wx = 100; // far out of range
    combat.update(0.016, zm);
    expect(z.hp).toBe(30);
  });

  it('does not fire while switched off, and fires again once re-enabled', () => {
    const { grid, state, combat } = setupCombat();
    const tower = addTower(grid, state);
    tower.enabled = false;
    const z = { wx: 5, wz: 1, hp: 30, maxHp: 30, state: 'walking' };
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm);
    expect(z.hp).toBe(30); // spenta: inerte anche con personale ed energia

    tower.enabled = true;
    combat.update(0.016, zm);
    expect(z.hp).toBe(20); // tower def.damage = 10
  });

  it('scales the damage with the tower level (potenziamento)', () => {
    const { grid, state, combat } = setupCombat();
    const tower = addTower(grid, state);
    tower.level = 2; // ×1.5
    const z = { wx: 5, wz: 1, hp: 30, maxHp: 30, state: 'walking' };
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm);
    expect(z.hp).toBe(15); // 30 − 10 × 1.5
  });

  it('removes expired tracers and flashes from the scene', () => {
    const { scene, grid, state, combat } = setupCombat();
    addTower(grid, state);
    const z = { wx: 5, wz: 1, hp: 300, maxHp: 300, state: 'walking' };
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm); // fires
    expect(scene.children.length).toBeGreaterThan(0);

    z.wx = 100; // no more targets: no new effects
    combat.update(0.5, zm);
    expect(scene.children.length).toBe(0);
  });
});

// --- combat: garrisons and militia -------------------------------------------

describe('combat garrisons', () => {
  function setupCombat() {
    const scene = new THREE.Scene();
    const grid = createGrid();
    const state = createGameState();
    const visuals = makeVisuals();
    const combat = createCombat({ scene, state, grid, visuals });
    return { scene, grid, state, visuals, combat };
  }

  it('garrisonGuns: workers capped for buildings, militia for hq, zero for towers', () => {
    expect(garrisonGuns({ defId: 'farm', workers: [1, 2, 3, 4, 5] }, getDef('farm'), 0)).toBe(4); // capped
    expect(garrisonGuns({ defId: 'farm', workers: [1] }, getDef('farm'), 0)).toBe(1);
    expect(garrisonGuns({ defId: 'farm', workers: [] }, getDef('farm'), 0)).toBe(0);
    expect(garrisonGuns({ defId: 'tower', workers: [1] }, getDef('tower'), 5)).toBe(0);
    expect(garrisonGuns({ defId: 'hq', workers: [] }, getDef('hq'), 2)).toBe(2);
    expect(garrisonGuns({ defId: 'hq', workers: [] }, getDef('hq'), 99)).toBe(6); // militia cap
    expect(garrisonGuns({ defId: 'farm', workers: [1] }, null, 0)).toBe(0);
  });

  it('a staffed building fires at zombies in short range, then cools down', () => {
    const { scene, grid, state, combat } = setupCombat();
    const farm = placeBuilding(grid, state, 'farm', 32, 32); // 2x2: center world (2,2)
    farm.workers.push(1, 2); // 2 guns
    const z = { wx: 6, wz: 2, hp: 30, maxHp: 30, state: 'walking' }; // 4 units away, range is 8
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm);
    expect(z.hp).toBe(30 - 2 * GARRISON_DAMAGE);
    expect(scene.children.length).toBeGreaterThan(0); // tracer + flash

    combat.update(0.5, zm);
    expect(z.hp).toBe(30 - 2 * GARRISON_DAMAGE); // still cooling down (1.0 s)

    combat.update(1.0, zm);
    expect(z.hp).toBe(30 - 4 * GARRISON_DAMAGE); // second shot after the cooldown
  });

  it('does not fire without workers or with the target out of range', () => {
    const { grid, state, combat } = setupCombat();
    const farm = placeBuilding(grid, state, 'farm', 32, 32);
    const z = { wx: 6, wz: 2, hp: 30, maxHp: 30, state: 'walking' };
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm); // no workers yet
    expect(z.hp).toBe(30);

    farm.workers.push(1);
    z.wx = 12; // 10 units away, range is 8
    combat.update(0.016, zm);
    expect(z.hp).toBe(30);
  });

  it('the hq militia fires with idle survivors', () => {
    const { grid, state, combat } = setupCombat();
    placeBuilding(grid, state, 'hq', 30, 30); // 3x3: center world (-1,-1)
    addSurvivor(state);
    addSurvivor(state);
    addSurvivor(state); // 3 idle survivors -> 3 militia guns
    const z = { wx: 5, wz: -1, hp: 40, maxHp: 40, state: 'walking' }; // 6 units away, militia range is 10
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm);
    expect(z.hp).toBe(40 - 3 * GARRISON_DAMAGE);
  });

  it('scales rifle damage with mods.garrisonDamage (Lampione aura)', () => {
    const { grid, state, combat } = setupCombat();
    const farm = placeBuilding(grid, state, 'farm', 32, 32); // 2x2: center world (2,2)
    farm.workers.push(1, 2); // 2 guns
    const z = { wx: 6, wz: 2, hp: 30, maxHp: 30, state: 'walking' };
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm, { garrisonDamage: 1.25 });
    expect(z.hp).toBeCloseTo(30 - 2 * GARRISON_DAMAGE * 1.25, 6);
  });

  it('the militia damage scales with mods.garrisonDamage too', () => {
    const { grid, state, combat } = setupCombat();
    placeBuilding(grid, state, 'hq', 30, 30);
    addSurvivor(state); // 1 idle survivor -> 1 militia gun
    const z = { wx: 5, wz: -1, hp: 40, maxHp: 40, state: 'walking' };
    const zm = stubZombieManager([z]);

    combat.update(0.016, zm, { garrisonDamage: 1.25 });
    expect(z.hp).toBeCloseTo(40 - GARRISON_DAMAGE * 1.25, 6);
  });
});

// --- combat: destruction ---------------------------------------------------

describe('combat destruction', () => {
  function setupCombat() {
    const scene = new THREE.Scene();
    const grid = createGrid();
    const state = createGameState();
    const visuals = makeVisuals();
    const combat = createCombat({ scene, state, grid, visuals });
    return { scene, grid, state, visuals, combat };
  }

  const zm = stubZombieManager([]);

  it('removes destroyed buildings from state, grid and visuals, logging an event', () => {
    const { grid, state, visuals, combat } = setupCombat();
    const b = placeBuilding(grid, state, 'tent', 10, 10);
    b.hp = 0;

    combat.update(0.016, zm);
    expect(state.buildings.length).toBe(0);
    expect(getCell(grid, 10, 10).occupiedBy).toBeNull();
    expect(getCell(grid, 10, 10).walkable).toBe(true);
    expect(visuals.removed).toEqual([b.id]);
    expect(state.events.some((e) => e.type === 'destroyed')).toBe(true);
  });

  it('sets gameOver to defeat when the hq falls', () => {
    const { grid, state, combat } = setupCombat();
    const hq = placeBuilding(grid, state, 'hq', 20, 20);
    hq.hp = 0;

    combat.update(0.016, zm);
    expect(state.gameOver).toBe('defeat');
  });

  it('calls setDamaged once per crossed threshold', () => {
    const { grid, state, visuals, combat } = setupCombat();
    const b = placeBuilding(grid, state, 'tent', 10, 10); // maxHp 100

    b.hp = 74;
    combat.update(0.016, zm);
    expect(visuals.damaged).toEqual([{ id: b.id, ratio: 0.74 }]);

    b.hp = 73; // no new threshold crossed
    combat.update(0.016, zm);
    expect(visuals.damaged.length).toBe(1);

    b.hp = 49; // crosses 0.5
    combat.update(0.016, zm);
    expect(visuals.damaged.length).toBe(2);
    expect(visuals.damaged[1].ratio).toBeCloseTo(0.49, 6);
  });

  it('kills the workers of a destroyed building, enriching the event', () => {
    const { grid, state, combat } = setupCombat();
    state.phase = 'night';
    const farm = placeBuilding(grid, state, 'farm', 10, 10);
    const s1 = addSurvivor(state);
    const s2 = addSurvivor(state);
    s1.buildingId = farm.id;
    s2.buildingId = farm.id;
    farm.workers.push(s1.id, s2.id);
    farm.hp = 0;

    combat.update(0.016, zm);
    expect(state.buildings.length).toBe(0);
    expect(state.survivors.length).toBe(0); // morti con la fattoria
    const destroyed = state.events.find((e) => e.type === 'destroyed');
    expect(destroyed.msg).toBe('Distruzione: Fattoria! 2 lavoratori sono morti.');
  });

  it('kills nobody when the destroyed building had no workers', () => {
    const { grid, state, combat } = setupCombat();
    state.phase = 'night';
    const farm = placeBuilding(grid, state, 'farm', 10, 10);
    addSurvivor(state); // inattivo: è al Rifugio, non nella fattoria
    farm.hp = 0;

    combat.update(0.016, zm);
    expect(state.survivors.length).toBe(1);
    const destroyed = state.events.find((e) => e.type === 'destroyed');
    expect(destroyed.msg).toBe('Distruzione: Fattoria!');
  });

  it('warns once per rate-limit when a staffed building loses hp at night', () => {
    const { grid, state, combat } = setupCombat();
    state.phase = 'night';
    const farm = placeBuilding(grid, state, 'farm', 10, 10); // maxHp 150
    const s = addSurvivor(state);
    s.buildingId = farm.id;
    farm.workers.push(s.id);
    const warns = () => state.events.filter((e) => e.msg.includes('sotto attacco'));

    farm.hp -= 10;
    combat.update(0.016, zm);
    expect(warns()).toHaveLength(1);
    expect(warns()[0].msg).toContain('⚠ Fattoria sotto attacco — 1 lavoratore in pericolo!');

    farm.hp -= 10; // altri danni dentro il cooldown: niente secondo avviso
    combat.update(1, zm);
    expect(warns()).toHaveLength(1);

    farm.hp -= 10; // cooldown (8 s) scaduto: avvisa di nuovo
    combat.update(9, zm);
    expect(warns()).toHaveLength(2);
  });

  it('does not warn during the day or without workers', () => {
    const { grid, state, combat } = setupCombat();
    const farm = placeBuilding(grid, state, 'farm', 10, 10);
    const s = addSurvivor(state);
    s.buildingId = farm.id;
    farm.workers.push(s.id);
    const warns = () => state.events.filter((e) => e.msg.includes('sotto attacco'));

    farm.hp -= 10; // di giorno (fase di default): niente avvisi
    combat.update(0.016, zm);
    expect(warns()).toHaveLength(0);

    state.phase = 'night';
    farm.workers.length = 0; // di notte ma senza lavoratori: niente avvisi
    farm.hp -= 10;
    combat.update(0.016, zm);
    expect(warns()).toHaveLength(0);
  });
});
