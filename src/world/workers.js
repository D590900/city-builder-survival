// Visible workers: up to two animated survivors strolling around each staffed
// building. Purely cosmetic — the sim never reads this module back. Workers
// are synced from the game state by a staffing diff (buildingId + worker
// count), pooled to avoid rebuild churn, and hidden during the night phase.
// three.js objects are created only inside the factory — no side effects at
// import time.

import * as THREE from 'three';
import { TILE_SIZE, tileToWorld } from './grid.js';
import { getModel, getAnimations, findClip, normalizeHeight } from '../assets/loader.js';

const WORKER_HEIGHT = 1.6; // world units
const PER_BUILDING = 2; // max visible workers per building
const MAX_WORKERS = 24; // global cap; fullest rosters get priority
const WALK_SPEED = 0.6; // world units per second (slow stroll)
const WANDER_RADIUS = 1.5 * TILE_SIZE; // wander targets stay within 1.5 tiles
const IDLE_MIN = 1; // seconds of idle pause between walks
const IDLE_MAX = 3;
const FIRST_IDLE_MAX = 1.2; // desynchronizes freshly spawned workers
const CROSSFADE_SECONDS = 0.2;
const TURN_RATE = 8; // exponential approach rate toward the facing direction
const EPSILON = 1e-6;

// Slot 0 is the plain survivor, slot 1 the knight (alternating models).
const MODEL_FOR_SLOT = ['survivor', 'survivor-knight'];

// Diagonal corners of the footprint for the first two slots.
const CORNER_SIGNS = [
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

/**
 * @param {THREE.Scene} scene
 * @param {{ models: Map<string, THREE.Object3D>, animations: Map<string, THREE.AnimationClip[]> }} assets result of loadAll()
 * @param {object} grid reserved for future walkability-aware wandering
 * @returns {{
 *   update: (state: object, phase: string, dt: number) => void,
 *   count: () => number,
 * }}
 */
export function createWorkers(scene, assets, grid) {
  const active = new Map(); // buildingId -> worker object[]
  const pools = { survivor: [], 'survivor-knight': [] }; // model -> inactive workers
  let activeCount = 0;
  let hidden = false;
  let lastSig = null; // staffing signature of the last sync

  // Crossfades between the idle/walk actions (either may be missing when the
  // GLB has no usable clips — the worker then just slides/stands).
  function play(w, name) {
    const next = w.actions[name] ?? null;
    if (next === w.current) return;
    if (w.current) w.current.fadeOut(CROSSFADE_SECONDS);
    if (next) {
      next.reset();
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.fadeIn(CROSSFADE_SECONDS).play();
    }
    w.current = next;
  }

  // Smoothly rotates the mesh toward the (dx, dz) direction.
  function faceToward(w, dx, dz, dt) {
    if (Math.abs(dx) < EPSILON && Math.abs(dz) < EPSILON) return;
    const yaw = Math.atan2(dx, dz);
    let delta = yaw - w.mesh.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    w.mesh.rotation.y += delta * Math.min(1, dt * TURN_RATE);
  }

  function makeWorker(model) {
    const mesh = getModel(assets, model);
    normalizeHeight(mesh, WORKER_HEIGHT);
    const clips = getAnimations(assets, model);
    const mixer = new THREE.AnimationMixer(mesh);
    const actions = {};
    const idle = findClip(clips, 'idle');
    const walk = findClip(clips, 'walk', 'walking');
    if (idle) actions.idle = mixer.clipAction(idle);
    if (walk) actions.walk = mixer.clipAction(walk);
    return {
      model,
      mesh,
      mixer,
      actions,
      current: null,
      baseY: mesh.position.y,
      buildingId: 0,
      ax: 0, // anchor (footprint corner) the wander targets orbit
      az: 0,
      wx: 0,
      wz: 0,
      tx: 0, // current wander target
      tz: 0,
      state: 'idle', // 'idle' | 'walk'
      idleT: 0,
    };
  }

  // (Re)binds a pooled worker to a building slot: parks it on the matching
  // footprint corner and adds it to the scene.
  function configure(w, building, slot) {
    const signs = CORNER_SIGNS[slot % CORNER_SIGNS.length];
    const center = tileToWorld(
      building.x + ((building.w ?? 1) - 1) / 2,
      building.z + ((building.h ?? 1) - 1) / 2
    );
    w.buildingId = building.id;
    w.ax = center.x + (signs[0] * (building.w ?? 1) * TILE_SIZE) / 2;
    w.az = center.z + (signs[1] * (building.h ?? 1) * TILE_SIZE) / 2;
    w.wx = w.ax;
    w.wz = w.az;
    w.tx = w.ax;
    w.tz = w.az;
    w.state = 'idle';
    w.idleT = Math.random() * FIRST_IDLE_MAX;
    w.current = null; // actions survive pooling; restart cleanly
    w.mesh.rotation.y = 0;
    w.mesh.position.set(w.wx, w.baseY, w.wz);
    w.mesh.visible = !hidden;
    scene.add(w.mesh);
    play(w, 'idle');
  }

  function obtainWorker(slot) {
    const model = MODEL_FOR_SLOT[slot % MODEL_FOR_SLOT.length];
    const pool = pools[model];
    return pool.length > 0 ? pool.pop() : makeWorker(model);
  }

  function releaseWorker(w) {
    scene.remove(w.mesh);
    pools[w.model].push(w);
  }

  // Diff-syncs the visible set against the sim: up to PER_BUILDING workers
  // for every staffed building, fullest rosters first, capped at MAX_WORKERS
  // overall. Buildings that vanished or lost their staff are released back
  // to the pool. Runs only when the staffing signature changes.
  function sync(buildings) {
    const staffed = [];
    for (const b of buildings) {
      if (b.workers.length > 0) staffed.push(b);
    }
    staffed.sort((a, b) => b.workers.length - a.workers.length || a.id - b.id);

    let budget = MAX_WORKERS;
    const desired = new Map(); // buildingId -> visible worker count
    for (const b of staffed) {
      if (budget <= 0) break;
      const n = Math.min(PER_BUILDING, b.workers.length, budget);
      desired.set(b.id, n);
      budget -= n;
    }

    // Shrink or drop rosters that are no longer desired.
    for (const [id, list] of active) {
      const want = desired.get(id) ?? 0;
      while (list.length > want) {
        releaseWorker(list.pop());
        activeCount--;
      }
      if (list.length === 0) active.delete(id);
    }

    // Grow rosters that appeared or gained workers.
    for (const b of staffed) {
      const want = desired.get(b.id) ?? 0;
      if (want === 0) continue;
      let list = active.get(b.id);
      if (!list) {
        list = [];
        active.set(b.id, list);
      }
      while (list.length < want) {
        const w = obtainWorker(list.length);
        configure(w, b, list.length);
        list.push(w);
        activeCount++;
      }
    }
  }

  // Idle/walk cycle: pauses, picks a random target within WANDER_RADIUS of
  // the anchor, strolls there facing the motion, then pauses again.
  function updateWorker(w, dt) {
    w.mixer.update(dt);
    if (w.state === 'walk') {
      const dx = w.tx - w.wx;
      const dz = w.tz - w.wz;
      const dist = Math.hypot(dx, dz);
      const travel = WALK_SPEED * dt;
      if (dist <= travel || dist < EPSILON) {
        w.wx = w.tx;
        w.wz = w.tz;
        w.state = 'idle';
        w.idleT = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
        play(w, 'idle');
      } else {
        w.wx += (dx / dist) * travel;
        w.wz += (dz / dist) * travel;
        faceToward(w, dx, dz, dt);
      }
      w.mesh.position.set(w.wx, w.baseY, w.wz);
    } else {
      w.idleT -= dt;
      if (w.idleT <= 0) {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * WANDER_RADIUS;
        w.tx = w.ax + Math.cos(angle) * r;
        w.tz = w.az + Math.sin(angle) * r;
        w.state = 'walk';
        play(w, 'walk');
      }
    }
  }

  function update(state, phase, dt) {
    const night = phase === 'night';
    if (night !== hidden) {
      hidden = night;
      for (const list of active.values()) {
        for (const w of list) w.mesh.visible = !hidden;
      }
    }

    // Staffing signature: re-sync only when some roster actually changed.
    let sig = '';
    for (const b of state.buildings) {
      if (b.workers.length > 0) sig += b.id + ':' + b.workers.length + ';';
    }
    if (sig !== lastSig) {
      lastSig = sig;
      sync(state.buildings);
    }

    if (hidden) return; // everyone indoors for the night
    for (const list of active.values()) {
      for (const w of list) updateWorker(w, dt);
    }
  }

  function count() {
    return hidden ? 0 : activeCount;
  }

  return { update, count };
}
