import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorkers } from '../src/world/workers.js';
import { createGrid, tileToWorld, TILE_SIZE } from '../src/world/grid.js';
import { createGameState, addBuilding, removeBuilding } from '../src/sim/state.js';
import { getDef } from '../src/buildings/definitions.js';

// --- helpers ---------------------------------------------------------------

function makeTemplate() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshBasicMaterial());
  group.add(mesh);
  return group;
}

// Fake asset set with the same shape loadAll() returns: clonable templates
// plus KayKit-style clips resolvable by findClip ('Idle', 'Walking_A', ...).
function makeAssets() {
  const clips = [
    new THREE.AnimationClip('Idle', 1, []),
    new THREE.AnimationClip('Walking_A', 0.8, []),
    new THREE.AnimationClip('Death_A', 0.6, []),
  ];
  return {
    models: new Map([
      ['survivor', makeTemplate()],
      ['survivor-knight', makeTemplate()],
    ]),
    animations: new Map([
      ['survivor', clips],
      ['survivor-knight', clips],
    ]),
  };
}

function setup() {
  const scene = new THREE.Scene();
  const grid = createGrid();
  const state = createGameState();
  const workers = createWorkers(scene, makeAssets(), grid);
  return { scene, grid, state, workers };
}

// Adds a building with the given fake worker roster (workers.js never reads
// the grid, so no occupy() needed here).
function place(state, defId, x, z, roster = []) {
  const b = addBuilding(state, defId, getDef(defId), x, z);
  b.workers.push(...roster);
  return b;
}

// Expected anchor (footprint corner) of a worker slot, mirroring the module.
function slotAnchor(b, slot) {
  const signs = [
    [1, 1],
    [-1, -1],
  ];
  const center = tileToWorld(b.x + (b.w - 1) / 2, b.z + (b.h - 1) / 2);
  return {
    x: center.x + (signs[slot][0] * b.w * TILE_SIZE) / 2,
    z: center.z + (signs[slot][1] * b.h * TILE_SIZE) / 2,
  };
}

const meshesNear = (scene, x, z, radius) =>
  scene.children.filter((c) => Math.hypot(c.position.x - x, c.position.z - z) <= radius);

// --- smoke -----------------------------------------------------------------

describe('module smoke', () => {
  it('exposes the documented factory API', () => {
    expect(typeof createWorkers).toBe('function');
    const { workers } = setup();
    expect(typeof workers.update).toBe('function');
    expect(typeof workers.count).toBe('function');
    expect(workers.count()).toBe(0);
  });
});

// --- sync -------------------------------------------------------------------

describe('workers sync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows up to two workers per staffed building, parked on footprint corners', () => {
    const { scene, state, workers } = setup();
    const b = place(state, 'tent', 10, 10, [1, 2, 3]); // 3 staff, 2 shown

    workers.update(state, 'day', 0.016);
    expect(workers.count()).toBe(2);
    expect(scene.children.length).toBe(2);

    const a0 = slotAnchor(b, 0);
    const a1 = slotAnchor(b, 1);
    expect(scene.children[0].position.x).toBeCloseTo(a0.x, 1);
    expect(scene.children[0].position.z).toBeCloseTo(a0.z, 1);
    expect(scene.children[1].position.x).toBeCloseTo(a1.x, 1);
    expect(scene.children[1].position.z).toBeCloseTo(a1.z, 1);

    // Unstaffed buildings get nobody.
    const { state: s2, workers: w2 } = setup();
    place(s2, 'tent', 10, 10, []);
    w2.update(s2, 'day', 0.016);
    expect(w2.count()).toBe(0);
  });

  it('shows a single worker when the roster has only one', () => {
    const { scene, state, workers } = setup();
    place(state, 'tent', 10, 10, [1]);
    workers.update(state, 'day', 0.016);
    expect(workers.count()).toBe(1);
    expect(scene.children.length).toBe(1);
  });

  it('caps the visible workers at 24 overall', () => {
    const { state, workers } = setup();
    for (let i = 0; i < 15; i++) {
      place(state, 'tent', 2 + i * 4, 2, [1, 2]); // 15 x 2 = 30 desired
    }
    workers.update(state, 'day', 0.016);
    expect(workers.count()).toBe(24);
  });

  it('prioritizes the fullest rosters when the cap bites', () => {
    const { scene, state, workers } = setup();
    const big = [];
    for (let i = 0; i < 12; i++) {
      big.push(place(state, 'tent', 2 + (i % 6) * 5, 2 + Math.floor(i / 6) * 5, [1, 2]));
    }
    const small = place(state, 'tent', 40, 40, [1]); // 12*2 + 1 = 25 > 24

    workers.update(state, 'day', 0); // dt 0: spawn-only, no wandering yet
    expect(workers.count()).toBe(24);
    const smallCenter = tileToWorld(small.x, small.z);
    expect(meshesNear(scene, smallCenter.x, smallCenter.z, 3).length).toBe(0);

    // Freeing budget (one big building gone) lets the small roster in.
    removeBuilding(state, big[0].id);
    workers.update(state, 'day', 0);
    expect(workers.count()).toBe(23); // 11*2 + 1
    expect(meshesNear(scene, smallCenter.x, smallCenter.z, 3).length).toBe(1);
  });

  it('hides everyone at night and brings them back by day', () => {
    const { scene, state, workers } = setup();
    place(state, 'tent', 10, 10, [1, 2]);
    workers.update(state, 'day', 0.016);
    const meshes = [...scene.children];
    expect(meshes.length).toBe(2);
    const before = meshes.map((m) => m.position.clone());

    workers.update(state, 'night', 0.016);
    expect(workers.count()).toBe(0);
    for (const m of meshes) expect(m.visible).toBe(false);

    // No wandering while hidden.
    workers.update(state, 'night', 1);
    for (let i = 0; i < meshes.length; i++) {
      expect(meshes[i].position.equals(before[i])).toBe(true);
    }

    workers.update(state, 'day', 0.016);
    expect(workers.count()).toBe(2);
    for (const m of meshes) expect(m.visible).toBe(true);
  });

  it('removes workers when the building disappears or its roster empties', () => {
    const { scene, state, workers } = setup();
    const b1 = place(state, 'tent', 10, 10, [1, 2]);
    const b2 = place(state, 'tent', 20, 20, [3]);
    workers.update(state, 'day', 0.016);
    expect(workers.count()).toBe(3);

    removeBuilding(state, b1.id);
    workers.update(state, 'day', 0.016);
    expect(workers.count()).toBe(1);
    expect(scene.children.length).toBe(1);

    b2.workers.length = 0;
    workers.update(state, 'day', 0.016);
    expect(workers.count()).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  it('does not rebuild workers when the staffing signature is unchanged', () => {
    const { scene, state, workers } = setup();
    place(state, 'tent', 10, 10, [1, 2]);
    workers.update(state, 'day', 0.016);
    const first = [...scene.children];

    for (let i = 0; i < 5; i++) workers.update(state, 'day', 0.016);
    expect(scene.children.length).toBe(2);
    for (let i = 0; i < first.length; i++) {
      expect(scene.children[i]).toBe(first[i]); // same instances, no churn
    }

    // A new staffed building appends without disturbing the existing ones.
    place(state, 'tent', 20, 20, [3]);
    workers.update(state, 'day', 0.016);
    expect(scene.children.length).toBe(3);
    expect(scene.children[0]).toBe(first[0]);
    expect(scene.children[1]).toBe(first[1]);
  });

  it('reuses pooled meshes after a building is removed and another staffed', () => {
    const { scene, state, workers } = setup();
    const b = place(state, 'tent', 10, 10, [1, 2]);
    workers.update(state, 'day', 0.016);
    const first = [...scene.children];

    removeBuilding(state, b.id);
    workers.update(state, 'day', 0.016);
    expect(scene.children.length).toBe(0);

    place(state, 'tent', 30, 30, [4, 5]);
    workers.update(state, 'day', 0.016);
    expect(scene.children.length).toBe(2);
    for (const m of scene.children) expect(first).toContain(m); // pool reuse
  });
});

// --- wander ------------------------------------------------------------------

describe('workers wander', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strolls slowly around the anchor, staying within 1.5 tiles of it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // deterministic pauses/targets
    const { scene, state, workers } = setup();
    const b = place(state, 'tent', 10, 10, [1]);
    workers.update(state, 'day', 0.016);

    const mesh = scene.children[0];
    const anchor = slotAnchor(b, 0);
    expect(mesh.position.x).toBeCloseTo(anchor.x, 6);
    expect(mesh.position.z).toBeCloseTo(anchor.z, 6);

    // 30 simulated seconds: idle pauses and walks alternate (0.5 random roll
    // targets anchor + (-1.5, 0) every time).
    for (let i = 0; i < 300; i++) workers.update(state, 'day', 0.1);

    const dist = Math.hypot(mesh.position.x - anchor.x, mesh.position.z - anchor.z);
    expect(dist).toBeGreaterThan(0.5); // it actually left the corner
    expect(dist).toBeLessThanOrEqual(1.5 * TILE_SIZE + 1e-6); // but not far
    expect(mesh.position.x).toBeLessThan(anchor.x); // toward the mocked target
  });
});
