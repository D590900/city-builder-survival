// Combat module: tower auto-fire, building garrisons and HQ militia (tracer +
// hit flash effects) and building destruction handling. three.js objects are
// created only inside the factory — no DOM access, no side effects at import.

import * as THREE from 'three';
import { TILE_SIZE, tileToWorld, release } from '../world/grid.js';
import { removeBuilding, pushEvent } from '../sim/state.js';
import { levelMultiplier } from '../sim/economy.js';
import { idleCount, killBuildingWorkers } from '../sim/survivors.js';
import { getDef } from '../buildings/definitions.js';

// hp/maxHp ratios below which visuals.setDamaged is (re)issued.
export const DAMAGE_THRESHOLDS = [0.75, 0.5, 0.25];

const TRACER_SECONDS = 0.1; // tracer + flash fade out in 100 ms
const TRACER_COLOR = 0xffe08a;
const GARRISON_TRACER_COLOR = 0xff9a5c; // garrison/militia rifles: orange
const FLASH_COLOR = 0xffb347;
const FLASH_RADIUS = 0.18;
const FALLBACK_TOWER_TOP_Y = 3; // used when the tower mesh is not available
const ZOMBIE_HIT_Y = 1; // aim at the zombie's chest

// Garrisons: staffed non-tower buildings fire rifles at nearby zombies on
// their own — no energy required (personal defense, always on). The HQ is
// instead manned by the colony's idle survivors (militia).
export const GARRISON_RANGE_TILES = 4; // 8 world units
export const GARRISON_DAMAGE = 3; // damage per shot per gun
export const GARRISON_FIRE_INTERVAL = 1.0; // seconds between building shots
export const GARRISON_MAX_GUNS = 4;
export const MILITIA_RANGE_TILES = 5; // 10 world units
export const MILITIA_MAX_GUNS = 6;
// Secondi minimi tra due avvisi "lavoratori in pericolo" per lo stesso edificio.
export const ATTACK_WARN_INTERVAL = 8;

/**
 * World position of the center of a building footprint.
 * Pure helper, exported for tests.
 */
export function buildingCenterWorld(b) {
  return tileToWorld(b.x + ((b.w ?? 1) - 1) / 2, b.z + ((b.h ?? 1) - 1) / 2);
}

/**
 * Nearest non-dying zombie within maxDist (world units) of (wx, wz),
 * or null. Pure helper, exported for tests.
 */
export function findNearestZombie(wx, wz, zombies, maxDist) {
  let best = null;
  let bestSq = maxDist * maxDist;
  for (const z of zombies) {
    if (!z || z.state === 'dying') continue;
    const dx = z.wx - wx;
    const dz = z.wz - wz;
    const distSq = dx * dx + dz * dz;
    if (distSq <= bestSq) {
      bestSq = distSq;
      best = z;
    }
  }
  return best;
}

/**
 * Damage thresholds crossed when the hp ratio drops from prevRatio to ratio.
 * Pure helper, exported for tests.
 */
export function crossedThresholds(prevRatio, ratio) {
  return DAMAGE_THRESHOLDS.filter((t) => prevRatio >= t && ratio < t);
}

/**
 * Number of rifles a building defends itself with: its own workers (capped)
 * for garrisoned non-tower buildings, the colony's idle survivors (militia,
 * capped) for the HQ. Pure helper, exported for tests.
 */
export function garrisonGuns(b, def, idle) {
  if (!def || def.isTower) return 0;
  if (b.defId === 'hq') return Math.min(Math.max(0, idle), MILITIA_MAX_GUNS);
  return Math.min(b.workers?.length ?? 0, GARRISON_MAX_GUNS);
}

/**
 * @param {{ scene: THREE.Scene, state: object, grid: object, visuals: object,
 *   onShot?: (target: object) => void,
 *   onDestroyed?: (building: object, center: {x: number, z: number}) => void }} deps
 *   visuals: { meshes: Map<number, THREE.Object3D>, remove(id), setDamaged(id, ratio) }
 *   onShot: optional hook fired when a tower, a garrison or the militia
 *   shoots (target is the zombie hit).
 *   onDestroyed: optional hook fired just before a destroyed building is
 *   removed; center is its footprint center in world coords.
 * @returns {{ update(dt: number, zombieManager: object, mods?: object): void }}
 *   mods: optional gameplay modifiers ({ towerDamage, towerRangeMul,
 *   garrisonDamage }) from sim/modifiers.js; every multiplier defaults to 1
 *   when omitted.
 */
export function createCombat({ scene, state, grid, visuals, onShot, onDestroyed }) {
  const cooldowns = new Map(); // buildingId -> seconds until the tower can fire again
  const lastRatios = new Map(); // buildingId -> hp ratio seen on the previous update
  const warnCooldowns = new Map(); // buildingId -> secondi al prossimo avviso possibile
  const effects = []; // live tracers/flashes: { obj, material, ttl, disposeGeo }
  const flashGeometry = new THREE.SphereGeometry(FLASH_RADIUS, 8, 6);

  // Brief line from the tower top to the zombie plus a small flash at the
  // impact point; both fade out over TRACER_SECONDS.
  function spawnShotEffect(from, to, color = TRACER_COLOR) {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
    });
    const tracer = new THREE.Line(geometry, material);
    scene.add(tracer);
    effects.push({ obj: tracer, material, ttl: TRACER_SECONDS, disposeGeo: true });

    const flashMaterial = new THREE.MeshBasicMaterial({
      color: FLASH_COLOR,
      transparent: true,
      opacity: 1,
    });
    const flash = new THREE.Mesh(flashGeometry, flashMaterial);
    flash.position.copy(to);
    scene.add(flash);
    effects.push({ obj: flash, material: flashMaterial, ttl: TRACER_SECONDS, disposeGeo: false });
  }

  // Muzzle point: top of the tower mesh when available, else a fixed height
  // above the building center.
  function towerMuzzle(b) {
    const center = buildingCenterWorld(b);
    let y = FALLBACK_TOWER_TOP_Y;
    const mesh = visuals?.meshes?.get(b.id);
    if (mesh) {
      const box = new THREE.Box3().setFromObject(mesh);
      if (Number.isFinite(box.max.y)) y = box.max.y;
    }
    return new THREE.Vector3(center.x, y, center.z);
  }

  function updateTowers(dt, zombieManager, mods) {
    const damageMul = mods?.towerDamage ?? 1;
    const rangeMul = mods?.towerRangeMul ?? 1;
    for (const b of state.buildings) {
      const def = getDef(b.defId);
      if (!def || !def.isTower || b.enabled === false || !b.powered || b.workers.length === 0)
        continue;

      let cooldown = (cooldowns.get(b.id) ?? 0) - dt;
      if (cooldown <= 0) {
        const center = buildingCenterWorld(b);
        const target = findNearestZombie(
          center.x,
          center.z,
          zombieManager.zombies,
          def.range * rangeMul * TILE_SIZE
        );
        if (target) {
          spawnShotEffect(towerMuzzle(b), new THREE.Vector3(target.wx, ZOMBIE_HIT_Y, target.wz));
          // Il danno scala col livello della torre (potenziamento).
          zombieManager.damageZombie(target, def.damage * damageMul * levelMultiplier(b.level));
          onShot?.(target);
          cooldown = 1 / def.fireRate;
        } else {
          cooldown = 0; // stay ready: fire as soon as a zombie enters range
        }
      }
      cooldowns.set(b.id, cooldown);
    }
  }

  // Garrisons: every staffed non-tower building fires at the nearest zombie
  // in short range — no energy required (personal defense). The HQ is manned
  // by the colony's idle survivors (militia), its last line of defense.
  // mods.garrisonDamage (Lampione) scales every rifle shot.
  function updateGarrisons(dt, zombieManager, mods) {
    const damageMul = mods?.garrisonDamage ?? 1;
    const idle = idleCount(state);
    for (const b of state.buildings) {
      const def = getDef(b.defId);
      const guns = garrisonGuns(b, def, idle);
      if (guns <= 0) continue;

      let cooldown = (cooldowns.get(b.id) ?? 0) - dt;
      if (cooldown <= 0) {
        const center = buildingCenterWorld(b);
        const rangeTiles =
          b.defId === 'hq' ? MILITIA_RANGE_TILES : GARRISON_RANGE_TILES;
        const target = findNearestZombie(
          center.x,
          center.z,
          zombieManager.zombies,
          rangeTiles * TILE_SIZE
        );
        if (target) {
          spawnShotEffect(
            towerMuzzle(b),
            new THREE.Vector3(target.wx, ZOMBIE_HIT_Y, target.wz),
            GARRISON_TRACER_COLOR
          );
          zombieManager.damageZombie(target, GARRISON_DAMAGE * guns * damageMul);
          onShot?.(target);
          cooldown = GARRISON_FIRE_INTERVAL;
        } else {
          cooldown = 0; // stay ready: fire as soon as a zombie enters range
        }
      }
      cooldowns.set(b.id, cooldown);
    }
  }

  // Avviso tempestivo: di notte, un edificio con lavoratori che perde hp
  // (confronto col ratio del giro prima, già tracciato in lastRatios) genera
  // un avviso — al più uno ogni ATTACK_WARN_INTERVAL secondi per edificio.
  // Spegnere l'edificio o sganciare i lavoratori li mette in salvo (milizia
  // al Rifugio). Tipo 'fuel': riusa la mappatura 'warn' dei toast in main.js
  // (stesso pattern di warnNoFuel in sim/economy.js).
  function warnWorkersInDanger(b, ratio, prevRatio, dt) {
    const remaining = (warnCooldowns.get(b.id) ?? 0) - dt;
    if (remaining > 0) {
      warnCooldowns.set(b.id, remaining);
      return;
    }
    warnCooldowns.delete(b.id);
    if (state.phase !== 'night') return;
    if (ratio >= prevRatio) return; // non sta perdendo hp
    if (b.workers.length === 0) return;
    warnCooldowns.set(b.id, ATTACK_WARN_INTERVAL);
    const def = getDef(b.defId);
    const inPericolo =
      b.workers.length === 1
        ? '1 worker in danger'
        : `${b.workers.length} workers in danger`;
    pushEvent(
      state,
      'fuel',
      `⚠ ${def?.name ?? b.defId} under attack — ${inPericolo}! Switch it off or unassign the workers to save them.`
    );
  }

  // Applies damage visuals and removes destroyed buildings from state, grid
  // and scene. Losing the hq ends the run.
  function updateDestruction(dt) {
    for (const b of [...state.buildings]) {
      const ratio = b.maxHp > 0 ? b.hp / b.maxHp : 0;
      const prevRatio = lastRatios.get(b.id) ?? 1;
      if (crossedThresholds(prevRatio, ratio).length > 0) {
        visuals.setDamaged(b.id, Math.max(0, ratio));
      }
      lastRatios.set(b.id, ratio);
      if (b.hp > 0) {
        warnWorkersInDanger(b, ratio, prevRatio, dt);
        continue;
      }

      const def = getDef(b.defId);
      // Chi lavorava nell'edificio muore con lui (il Rifugio è game over:
      // niente conteggio, ci pensa l'evento di sconfitta).
      const dead =
        b.defId !== 'hq' && b.workers.length > 0 ? killBuildingWorkers(state, b) : 0;
      const casualties =
        dead === 1 ? ' 1 worker died.' : dead > 1 ? ` ${dead} workers died.` : '';
      pushEvent(state, 'destroyed', `Destroyed: ${def?.name ?? b.defId}!${casualties}`);
      onDestroyed?.(b, buildingCenterWorld(b));
      removeBuilding(state, b.id);
      release(grid, b.id);
      visuals.remove(b.id);
      cooldowns.delete(b.id);
      lastRatios.delete(b.id);
      warnCooldowns.delete(b.id);
      if (b.defId === 'hq') {
        state.gameOver = 'defeat';
        pushEvent(state, 'defeat', 'The Refuge has fallen. The colony is lost.');
      }
    }
  }

  function updateEffects(dt) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.ttl -= dt;
      e.material.opacity = Math.max(0, e.ttl / TRACER_SECONDS);
      if (e.ttl <= 0) {
        scene.remove(e.obj);
        if (e.disposeGeo) e.obj.geometry.dispose();
        e.material.dispose();
        effects.splice(i, 1);
      }
    }
  }

  function update(dt, zombieManager, mods) {
    updateTowers(dt, zombieManager, mods);
    updateGarrisons(dt, zombieManager, mods);
    updateDestruction(dt);
    updateEffects(dt);
  }

  return { update };
}
