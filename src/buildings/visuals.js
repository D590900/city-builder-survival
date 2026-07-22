// Building visuals: instantiates, positions and tints 3D models for placed
// buildings. New buildings pop in with an elastic scale animation processed
// by update(). Three.js only, no DOM. No side effects at import time.

import * as THREE from 'three';
import { getModel, normalizeHeight } from '../assets/loader.js';
import { tileToWorld, TILE_SIZE } from '../world/grid.js';

const DAMAGE_THRESHOLD = 0.5; // hp ratio below which the smoky tint kicks in
const SMOKE_TINT = new THREE.Color(0x2b2b2b);
const OFF_DARKEN = 0.45; // multiplier applied to a switched-off building
const MAX_HEIGHT = 4;
const HEIGHT_PER_TILE = 1.6;
const FOOTPRINT_FIT = 0.95; // max horizontal extent, as a share of the footprint span
const POP_IN_SECONDS = 0.35; // elastic grow-in duration on add()
const POP_IN_MIN_SCALE = 0.01; // starting scale factor of a fresh building
const POP_IN_OVERSHOOT = 1.7; // ease-out-back overshoot amount

/**
 * Scales a building model for its footprint: ~1.6 world units per footprint
 * row (capped at MAX_HEIGHT), shrunk further when its horizontal extent would
 * overflow the footprint — the cap is FOOTPRINT_FIT of the span by default,
 * def.modelWidthFrac when set (thin structures like the road) — then any
 * optional def.modelScaleMul for extra presence. Shared by add() and the
 * placement ghost so the preview always matches the placed result. w/h are
 * the footprint span in tiles.
 */
export function scaleForFootprint(obj, def, w, h) {
  const fit = def.modelWidthFrac > 0 ? def.modelWidthFrac : FOOTPRINT_FIT;
  normalizeHeight(
    obj,
    Math.min(def.h * HEIGHT_PER_TILE, MAX_HEIGHT),
    Math.max(w, h) * TILE_SIZE * fit
  );
  if (def.modelScaleMul > 0 && def.modelScaleMul !== 1) {
    obj.scale.multiplyScalar(def.modelScaleMul);
  }
}

// ease-out-back easing: fast approach that overshoots the target, then
// settles on it. f(0) = 0, f(1) = 1, peak > 1 for t in between.
function easeOutBack(t) {
  const u = t - 1;
  return 1 + (POP_IN_OVERSHOOT + 1) * u * u * u + POP_IN_OVERSHOOT * u * u;
}

// Iterates over every material of a mesh (handles material arrays).
function forEachMaterial(mesh, cb) {
  if (Array.isArray(mesh.material)) mesh.material.forEach(cb);
  else if (mesh.material) cb(mesh.material);
}

// Clones all materials of the subtree so tinting one instance never affects
// the shared templates or other clones of the same model.
function makeMaterialsUnique(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    if (Array.isArray(child.material)) {
      child.material = child.material.map((m) => m.clone());
    } else if (child.material) {
      child.material = child.material.clone();
    }
  });
}

// Disposes the per-instance materials cloned in add(). Geometry is shared
// with the asset templates and must not be disposed.
function disposeMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    forEachMaterial(child, (m) => m.dispose());
  });
}

/**
 * Manages the 3D representation of placed buildings.
 *
 * @param {THREE.Scene} scene
 * @param {{ models: Map<string, THREE.Object3D> }} assets result of loadAll()
 * @returns {{
 *   add: (building: object, def: object) => THREE.Object3D,
 *   remove: (buildingId: number) => void,
 *   meshes: Map<number, THREE.Object3D>,
 *   setDamaged: (buildingId: number, ratio: number) => void,
 *   setEnabled: (buildingId: number, enabled: boolean) => void,
 *   update: (dt: number, phase: string) => void,
 * }}
 */
export function createBuildingVisuals(scene, assets) {
  const meshes = new Map(); // buildingId -> Object3D
  const damaged = new Set(); // ids currently below the damage threshold
  const states = new Map(); // buildingId -> { ratio, enabled } (tint inputs)
  const popIns = new Map(); // buildingId -> { obj, t, sx, sy, sz } (grow-in queue)
  let time = 0;

  // Instantiates the model, scales it for its footprint (scaleForFootprint,
  // shared with the placement ghost) and centers it. The model starts
  // near-zero in scale; update() grows it back elastically (pop-in).
  function add(building, def) {
    const obj = getModel(assets, def.model);
    scaleForFootprint(obj, def, building.w, building.h);
    makeMaterialsUnique(obj);

    // Footprint center: world coords of the first tile plus half the
    // remaining footprint span.
    const base = tileToWorld(building.x, building.z);
    obj.position.x = base.x + ((building.w - 1) * TILE_SIZE) / 2;
    obj.position.z = base.z + ((building.h - 1) * TILE_SIZE) / 2;

    // Random 90-degree step for visual variety.
    obj.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);

    // Pop-in: remember the final scale and start tiny.
    popIns.set(building.id, { obj, t: 0, sx: obj.scale.x, sy: obj.scale.y, sz: obj.scale.z });
    obj.scale.set(
      obj.scale.x * POP_IN_MIN_SCALE,
      obj.scale.y * POP_IN_MIN_SCALE,
      obj.scale.z * POP_IN_MIN_SCALE
    );

    scene.add(obj);
    meshes.set(building.id, obj);
    return obj;
  }

  function remove(buildingId) {
    const obj = meshes.get(buildingId);
    if (!obj) return;
    scene.remove(obj);
    disposeMaterials(obj);
    meshes.delete(buildingId);
    damaged.delete(buildingId);
    states.delete(buildingId);
    popIns.delete(buildingId);
  }

  function stateFor(buildingId) {
    let st = states.get(buildingId);
    if (!st) {
      st = { ratio: 1, enabled: true };
      states.set(buildingId, st);
    }
    return st;
  }

  // Recomputes the tint from the recorded inputs. Precedence: the damage
  // tint goes over the base color first, then the switched-off multiplier
  // darkens the whole result; re-enabling reapplies the current damage
  // state (the last ratio passed to setDamaged).
  function applyTint(buildingId) {
    const obj = meshes.get(buildingId);
    if (!obj) return;
    const st = stateFor(buildingId);
    const isDamaged = st.ratio < DAMAGE_THRESHOLD;
    if (isDamaged) damaged.add(buildingId);
    else damaged.delete(buildingId);

    obj.traverse((child) => {
      if (!child.isMesh) return;
      forEachMaterial(child, (mat) => {
        if (!mat.color) return;
        if (!mat.userData.baseColor) {
          mat.userData.baseColor = mat.color.clone();
          if (mat.emissive) mat.userData.baseEmissive = mat.emissive.clone();
        }
        if (isDamaged) {
          // Darker and smokier as hp drops toward zero.
          const t = Math.min(Math.max(st.ratio / DAMAGE_THRESHOLD, 0), 1);
          mat.color.copy(mat.userData.baseColor).lerp(SMOKE_TINT, 0.8 * (1 - t));
          if (mat.emissive && mat.userData.baseEmissive) {
            mat.emissive.copy(mat.userData.baseEmissive).lerp(SMOKE_TINT, 0.6);
          }
        } else {
          mat.color.copy(mat.userData.baseColor);
          if (mat.emissive && mat.userData.baseEmissive) {
            mat.emissive.copy(mat.userData.baseEmissive);
            mat.emissiveIntensity = 1;
          }
        }
        if (!st.enabled) {
          // Spento: tutto scurisce, sopra l'eventuale tinta danno.
          mat.color.multiplyScalar(OFF_DARKEN);
          if (mat.emissive) mat.emissive.multiplyScalar(OFF_DARKEN);
        }
      });
    });
  }

  // Applies (or restores) a dark, smoky tint based on the hp ratio.
  function setDamaged(buildingId, ratio) {
    if (!meshes.get(buildingId)) return;
    stateFor(buildingId).ratio = ratio;
    applyTint(buildingId);
  }

  // Switched-off buildings get a uniform dark grey tint; switching back on
  // restores the base/damage look.
  function setEnabled(buildingId, enabled) {
    if (!meshes.get(buildingId)) return;
    stateFor(buildingId).enabled = enabled !== false;
    applyTint(buildingId);
  }

  // Processes the pop-in queue, then the smoldering pulse on damaged
  // buildings (which glows a bit more at night).
  function update(dt, phase) {
    time += dt;

    // Elastic grow-in of freshly added buildings; entries settle exactly on
    // their final scale and leave the queue.
    if (popIns.size > 0) {
      for (const [id, p] of popIns) {
        p.t += dt / POP_IN_SECONDS;
        if (p.t >= 1) {
          p.obj.scale.set(p.sx, p.sy, p.sz);
          popIns.delete(id);
        } else {
          const k = POP_IN_MIN_SCALE + (1 - POP_IN_MIN_SCALE) * easeOutBack(p.t);
          p.obj.scale.set(p.sx * k, p.sy * k, p.sz * k);
        }
      }
    }

    if (damaged.size === 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(time * 6);
    const base = phase === 'night' ? 0.35 : 0.15;
    for (const id of damaged) {
      if (states.get(id)?.enabled === false) continue; // spento: niente brace
      const obj = meshes.get(id);
      if (!obj) continue;
      obj.traverse((child) => {
        if (!child.isMesh) return;
        forEachMaterial(child, (mat) => {
          if (mat.emissive && mat.userData.baseEmissive) {
            mat.emissiveIntensity = base + 0.3 * pulse;
          }
        });
      });
    }
  }

  return { add, remove, meshes, setDamaged, setEnabled, update };
}
