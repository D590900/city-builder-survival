// Zombie manager: spawning, animation and per-frame zombie behavior
// (walking toward buildings, attacking, dying). three.js objects are created
// only inside the factory — no DOM access, no side effects at import time.

import * as THREE from 'three';
import { TILE_SIZE, tileToWorld, getCell } from '../world/grid.js';
import { findBuilding } from '../sim/state.js';
import { findNearestTarget, nextStep } from './pathfinding.js';
import { getDef } from '../buildings/definitions.js';
import { getModel, getAnimations, findClip, normalizeHeight } from '../assets/loader.js';

const ZOMBIE_HEIGHT = 1.7; // world units
const REPATH_INTERVAL = 2; // seconds between A* re-rolls while walking
const DIE_FALLBACK_SECONDS = 1.2; // used when no die/idle clip is available
const CROSSFADE_SECONDS = 0.15;
const TURN_RATE = 8; // exponential approach rate toward the facing direction
const EPSILON = 1e-6;
const TRAP_SELF_DPS = 2; // hp/s a trap loses while damaging at least one zombie
const FALLBACK_TRAP_DPS = 6; // trapDamage fallback when the def is missing it

// Zombie damage to buildings is scaled down so that structures last ~67%
// longer for the same wave stats (the waveForNight formula stays untouched).
export const ZOMBIE_BUILDING_DPS_MUL = 0.6;

// Candidate clip names, most specific first (covers Kenney/KayKit/Quaternius).
const WALK_CLIPS = ['walk', 'walking', 'zombiewalk', 'run', 'sprint'];
const ATTACK_CLIPS = ['attack', 'bite', '1h_melee_attack'];
const DIE_CLIPS = ['die', 'death'];
const IDLE_CLIPS = ['idle'];

/**
 * Picks which GLB to use for a new zombie: 'zombie' 70% of the time,
 * 'zombie-crawler' 30%. Pure function — pass an explicit roll in tests.
 * @param {number} [roll] value in [0, 1), defaults to Math.random()
 */
export function pickZombieModel(roll = Math.random()) {
  return roll < 0.7 ? 'zombie' : 'zombie-crawler';
}

/**
 * @param {{ scene: THREE.Scene, grid: object, state: object, assets: object }} deps
 * @returns {{
 *   zombies: Array<object>,
 *   spawn(x: number, z: number, wave: object): object,
 *   update(dt: number, mods?: object): void,
 *   damageZombie(z: object, dmg: number): void,
 *   clearAll(): void,
 *   count(): number,
 * }}
 */
export function createZombieManager({ scene, grid, state, assets }) {
  /** @type {Array<object>} */
  const zombies = [];
  let nextId = 1;

  // Crossfades to the named action (falls back to idle). `once` plays a single
  // iteration and freezes on the last frame (used for the death animation).
  function playAction(z, name, { once = false } = {}) {
    const next = z.actions[name] ?? z.actions.idle ?? null;
    if (next === z.current) return;
    if (z.current) z.current.fadeOut(CROSSFADE_SECONDS);
    if (next) {
      next.reset();
      if (once) {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      } else {
        next.setLoop(THREE.LoopRepeat, Infinity);
      }
      next.fadeIn(CROSSFADE_SECONDS).play();
    }
    z.current = next;
  }

  // Smoothly rotates the mesh toward the (dx, dz) direction.
  function faceToward(z, dx, dz, dt) {
    if (Math.abs(dx) < EPSILON && Math.abs(dz) < EPSILON) return;
    const yaw = Math.atan2(dx, dz);
    let delta = yaw - z.mesh.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    z.mesh.rotation.y += delta * Math.min(1, dt * TURN_RATE);
  }

  function buildingCenter(b) {
    return tileToWorld(b.x + ((b.w ?? 1) - 1) / 2, b.z + ((b.h ?? 1) - 1) / 2);
  }

  function enterAttacking(z) {
    z.state = 'attacking';
    playAction(z, 'attack');
  }

  // Interest weights (lower = more attractive). First matching rule wins —
  // the rules are listed from the most attractive weight upward, so when
  // several conditions overlap the smallest applicable weight applies (the
  // HQ is also housing; a tower may be staffed):
  //   1. hq                    ×0.2  the colony's heart: top priority
  //   2. staffed building      ×0.3  zombies hunt people
  //   3. tower                 ×0.5  an armed threat
  //   4. housing (houses > 0)  ×0.6  people live here
  //   5. wall                  ×1.0  plain barrier: chewed when it seals the rest
  //   6. anything else         ×4.0  wells, panels, storage… only when much closer
  function targetWeight(b, def) {
    if (b.defId === 'hq') return 0.2;
    if ((b.workers?.length ?? 0) > 0) return 0.3;
    if (def.isTower) return 0.5;
    if ((def.houses ?? 0) > 0) return 0.6;
    if (def.isWall) return 1.0;
    return 4.0;
  }

  // Traps hurt zombies that walk over them but are never attacked, and
  // roads are simply walked over too: both are filtered out of the target
  // list handed to findNearestTarget. Everything else is a weighted
  // candidate `{ building, weight }` (see targetWeight).
  function targetableBuildings() {
    const candidates = [];
    for (const b of state.buildings) {
      const def = getDef(b.defId);
      if (def?.isTrap || def?.isRoad) continue;
      candidates.push({ building: b, weight: def ? targetWeight(b, def) : 4.0 });
    }
    return candidates;
  }

  // Re-rolls target + path when the current one is missing, stale or the
  // target building no longer exists. Movement speed scales with
  // mods.zombieSpeed (weather/research), defaulting to 1.
  function updateWalking(z, dt, mods) {
    z.repathT -= dt;
    const targetAlive = z.target !== null && findBuilding(state, z.target.id) !== null;
    if (!z.path || !targetAlive || z.repathT <= 0) {
      const result = findNearestTarget(grid, z.tileX, z.tileZ, targetableBuildings());
      z.repathT = REPATH_INTERVAL;
      z.target = result ? result.building : null;
      z.path = result ? result.path : null;
    }
    if (!z.path) return; // nothing reachable: shamble in place, retry later

    // Standing on the penultimate path tile means the next tile is the
    // building itself: close enough to attack.
    if (z.path.length <= 2) {
      enterAttacking(z);
      return;
    }

    const step = nextStep(z.path);
    if (!step) {
      enterAttacking(z);
      return;
    }
    const target = tileToWorld(step.x, step.z);
    const dx = target.x - z.wx;
    const dz = target.z - z.wz;
    const dist = Math.hypot(dx, dz);
    const travel = z.speed * (mods?.zombieSpeed ?? 1) * TILE_SIZE * dt;

    if (dist <= travel || dist < EPSILON) {
      // Reached the tile center: snap, advance the path, maybe start attacking.
      z.wx = target.x;
      z.wz = target.z;
      z.tileX = step.x;
      z.tileZ = step.z;
      z.path.shift();
      if (z.path.length <= 2) enterAttacking(z);
    } else {
      z.wx += (dx / dist) * travel;
      z.wz += (dz / dist) * travel;
      faceToward(z, dx, dz, dt);
    }
  }

  function updateAttacking(z, dt) {
    const target = z.target !== null ? findBuilding(state, z.target.id) : null;
    if (!target) {
      // Target destroyed under us: look for the next building.
      z.state = 'walking';
      z.target = null;
      z.path = null;
      z.repathT = 0;
      playAction(z, 'walk');
      return;
    }
    const center = buildingCenter(target);
    faceToward(z, center.x - z.wx, center.z - z.wz, dt);
    target.hp -= z.damage * dt * ZOMBIE_BUILDING_DPS_MUL;
  }

  function spawn(x, z, wave = {}) {
    const model = pickZombieModel();
    const mesh = getModel(assets, model);
    normalizeHeight(mesh, ZOMBIE_HEIGHT);
    const baseY = mesh.position.y;

    const clips = getAnimations(assets, model);
    const mixer = new THREE.AnimationMixer(mesh);
    const actions = {};
    const candidates = { walk: WALK_CLIPS, attack: ATTACK_CLIPS, die: DIE_CLIPS, idle: IDLE_CLIPS };
    for (const [key, names] of Object.entries(candidates)) {
      const clip = findClip(clips, ...names);
      if (clip) actions[key] = mixer.clipAction(clip);
    }

    const hp = wave.hp ?? 20;
    const world = tileToWorld(x, z);
    const zombie = {
      id: nextId++,
      model,
      mesh,
      mixer,
      actions,
      tileX: Math.trunc(x),
      tileZ: Math.trunc(z),
      wx: world.x,
      wz: world.z,
      hp,
      maxHp: hp,
      damage: wave.damage ?? 3,
      speed: wave.speed ?? 1.5, // tiles per second
      state: 'walking', // 'walking' | 'attacking' | 'dying'
      target: null,
      path: null,
      repathT: 0,
      // internals: current action, ground offset, death timer
      current: null,
      baseY,
      dieT: 0,
    };

    mesh.position.set(zombie.wx, baseY, zombie.wz);
    scene.add(mesh);
    playAction(zombie, 'walk');
    zombies.push(zombie);
    return zombie;
  }

  // A zombie standing on a trapped tile takes the trap's trapDamage dps
  // (defensive fallback when the def lacks it). Traps that damage at least
  // one zombie this tick are collected so each wears down only once.
  function applyTrapDamage(z, dt, activeTraps) {
    const cell = getCell(grid, z.tileX, z.tileZ);
    if (!cell || !cell.trap) return;
    const trap = findBuilding(state, cell.trap);
    if (!trap) return;
    const dps = getDef(trap.defId)?.trapDamage ?? FALLBACK_TRAP_DPS;
    damageZombie(z, dps * dt);
    activeTraps.add(trap);
  }

  function update(dt, mods) {
    const activeTraps = new Set(); // trap buildings damaging a zombie this tick
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      z.mixer.update(dt);

      if (z.state === 'dying') {
        z.dieT -= dt;
        if (z.dieT <= 0) {
          scene.remove(z.mesh);
          zombies.splice(i, 1);
          state.kills += 1;
        }
        continue;
      }

      if (z.state === 'attacking') {
        updateAttacking(z, dt);
      } else {
        updateWalking(z, dt, mods);
      }
      z.mesh.position.set(z.wx, z.baseY, z.wz);

      applyTrapDamage(z, dt, activeTraps);
    }
    // A trap wears down only while it is damaging at least one zombie.
    for (const trap of activeTraps) trap.hp -= TRAP_SELF_DPS * dt;
  }

  function damageZombie(z, dmg) {
    if (!z || z.state === 'dying') return;
    z.hp -= dmg;
    if (z.hp <= 0) {
      z.hp = 0;
      z.state = 'dying';
      z.target = null;
      z.path = null;
      const dieAction = z.actions.die ?? z.actions.idle ?? null;
      z.dieT = dieAction ? dieAction.getClip().duration || DIE_FALLBACK_SECONDS : DIE_FALLBACK_SECONDS;
      playAction(z, 'die', { once: true });
    }
  }

  function clearAll() {
    for (const z of zombies) scene.remove(z.mesh);
    zombies.length = 0;
  }

  function count() {
    return zombies.length;
  }

  return { zombies, spawn, update, damageZombie, clearAll, count };
}
