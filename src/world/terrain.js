// Terrain rendering: builds ground, water and decoration meshes from a grid.
// No side effects on import; everything happens inside buildTerrain().
//
// buildTerrain(scene, grid, props) returns { ground, water, decorations }
// plus three targeted mutators used when the simulation edits the map:
// setGroundTile(x, z, type) recolors one ground instance,
// clearDecorationsAt(x, z) strips one tile's props (depleted nodes),
// addDecorationAt(x, z, propName, targetH) plants a prop (Forester trees).

import * as THREE from 'three';
import { TILE_SIZE, tileToWorld } from './grid.js';

// One ground color per cell type. Post-apocalyptic palette: greens are
// desaturated toward grey-brown (dead olive grass, muddy forest floor).
const TILE_COLORS = {
  grass: 0x6d744f,
  road: 0x6f6f6a,
  trail: 0x9a8a6a, // sandy dirt of the trampled paths
  ruins: 0x7d6b57,
  forest: 0x3f5538,
  wasteland: 0x8a7f5c,
  water: 0x24435f,
  ore: 0x565a60, // dark rock of the mineable veins
  wildlife: 0x75784a, // trampled olive grass of the herd tiles
};

const WATER_COLOR = 0x1d3f5e;
const MAP_SPAN = TILE_SIZE * 64; // world units covered by the grid (128)

// mulberry32: small fast seeded PRNG (kept local so imports stay side-effect free).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Low-frequency ground patches -------------------------------------------
// Value noise on an 8-tile lattice: each lattice point gets a value from
// mulberry32 seeded by its coordinates, tiles interpolate bilinearly with
// smoothstep. Pure function of the tile coords (same fixed-seed philosophy
// as the decoration scatter), so build-time coloring and later setGroundTile
// recolors always agree on a tile's patch brightness.
const PATCH_TILES = 8; // lattice spacing: one noise cell every ~8 tiles

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function latticeValue(ix, iz) {
  const h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) ^ 0x5bf03635;
  return mulberry32(h)();
}

// Brightness multiplier in [0.9, 1.1] for tile (x, z): ±10% patches.
function patchMultiplier(x, z) {
  const fx = x / PATCH_TILES;
  const fz = z / PATCH_TILES;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smoothstep(fx - ix);
  const tz = smoothstep(fz - iz);
  const v00 = latticeValue(ix, iz);
  const v10 = latticeValue(ix + 1, iz);
  const v01 = latticeValue(ix, iz + 1);
  const v11 = latticeValue(ix + 1, iz + 1);
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return 0.9 + 0.2 * (top + (bottom - top) * tz);
}

// Uniform scale that makes the template approximately `targetHeight` world units tall.
function scaleForHeight(template, targetHeight, cache) {
  let height = cache.get(template);
  if (height === undefined) {
    const box = new THREE.Box3().setFromObject(template);
    height = Math.max(box.max.y - box.min.y, 0.001);
    cache.set(template, height);
  }
  return targetHeight / height;
}

// Shifts every material color of a template toward its own luminance and
// darkens it slightly: the bright cartoon-green foliage of the living trees
// becomes a duller, post-apocalyptic olive. Materials shared between
// sub-meshes are processed once. The templates are owned by the terrain
// (props are not cloned), so the change applies to every instance.
function desaturateTemplate(template, amount = 0.25, darken = 0.85) {
  const seen = new Set();
  template.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m || !m.color || seen.has(m)) continue;
      seen.add(m);
      const lum = (m.color.r + m.color.g + m.color.b) / 3;
      m.color.r += (lum - m.color.r) * amount;
      m.color.g += (lum - m.color.g) * amount;
      m.color.b += (lum - m.color.b) * amount;
      m.color.multiplyScalar(darken);
    }
  });
}

// Builds one InstancedMesh per sub-mesh of the template, applying each
// instance transform on top of the sub-mesh's own transform.
function instantiateTemplate(template, transforms) {
  const group = new THREE.Group();
  if (transforms.length === 0) return group;
  template.updateMatrixWorld(true);
  const inst = new THREE.Matrix4();
  const composed = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  template.traverse((child) => {
    if (!child.isMesh) return;
    const mesh = new THREE.InstancedMesh(child.geometry, child.material, transforms.length);
    for (let i = 0; i < transforms.length; i++) {
      const t = transforms[i];
      pos.set(t.x, t.y || 0, t.z);
      euler.set(0, t.ry || 0, 0);
      quat.setFromEuler(euler);
      scl.set(t.s, t.s, t.s);
      inst.compose(pos, quat, scl);
      composed.multiplyMatrices(inst, child.matrixWorld);
      mesh.setMatrixAt(i, composed);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    group.add(mesh);
  });
  return group;
}

export function buildTerrain(scene, grid, props) {
  const rng = mulberry32(1337); // fixed seed: stable decoration scatter per map
  const size = grid.size;
  const heightCache = new Map();

  // Mute the bright green foliage of the living trees (dead trees, rubble
  // and the rest are already drab).
  if (props) {
    if (props['tree-1']) desaturateTemplate(props['tree-1'], 0.4, 0.8);
    if (props['tree-2']) desaturateTemplate(props['tree-2'], 0.4, 0.8);
  }

  // --- Ground: one thin box per tile, per-instance color by cell type ---
  const groundGeo = new THREE.BoxGeometry(TILE_SIZE, 0.2, TILE_SIZE);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const ground = new THREE.InstancedMesh(groundGeo, groundMat, size * size);
  const m = new THREE.Matrix4();
  const baseColor = new THREE.Color();
  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const cell = grid.cells[z][x];
      const w = tileToWorld(x, z);
      m.makeTranslation(w.x, -0.1, w.z);
      ground.setMatrixAt(i, m);
      baseColor.setHex(TILE_COLORS[cell.type] ?? TILE_COLORS.grass);
      baseColor.multiplyScalar(0.92 + rng() * 0.16); // subtle variation
      baseColor.multiplyScalar(patchMultiplier(x, z)); // low-frequency patches
      ground.setColorAt(i, baseColor);
      i++;
    }
  }
  ground.instanceMatrix.needsUpdate = true;
  if (ground.instanceColor) ground.instanceColor.needsUpdate = true;
  ground.receiveShadow = true;
  scene.add(ground);

  // --- Water: flat semitransparent planes slightly above the ground ---
  let water = null;
  const waterCells = [];
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      if (grid.cells[z][x].type === 'water') waterCells.push(tileToWorld(x, z));
    }
  }
  if (waterCells.length > 0) {
    const waterGeo = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshLambertMaterial({
      color: WATER_COLOR,
      transparent: true,
      opacity: 0.78,
    });
    water = new THREE.InstancedMesh(waterGeo, waterMat, waterCells.length);
    for (let j = 0; j < waterCells.length; j++) {
      m.makeTranslation(waterCells[j].x, 0.03, waterCells[j].z);
      water.setMatrixAt(j, m);
    }
    water.instanceMatrix.needsUpdate = true;
    scene.add(water);
  }

  // --- Decorations: props scattered by cell type ---
  // Every transform records the tile it belongs to (tx/tz) so single tiles
  // can later be cleared (depleted nodes) or planted (Forester trees)
  // without rebuilding the whole scatter. Off-map decorations use -1, -1.
  const placements = new Map(); // prop name -> transforms[]
  const place = (name, x, z, minH, maxH, tx = -1, tz = -1) => {
    const template = props && props[name];
    if (!template) return;
    const s = scaleForHeight(template, minH + rng() * (maxH - minH), heightCache);
    if (!placements.has(name)) placements.set(name, []);
    placements.get(name).push({ x, z, ry: rng() * Math.PI * 2, s, tx, tz });
  };
  const jitter = () => (rng() - 0.5) * 1.2;

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const cell = grid.cells[z][x];
      const w = tileToWorld(x, z);
      const px = w.x + jitter();
      const pz = w.z + jitter();
      if (cell.type === 'forest') {
        if (rng() < 0.85) {
          const r = rng();
          const name = r < 0.4 ? 'tree-1' : r < 0.8 ? 'tree-2' : 'tree-dead';
          place(name, px, pz, 2, 3, x, z);
        }
      } else if (cell.type === 'ruins') {
        if (rng() < 0.7) {
          const r = rng();
          const name = r < 0.45 ? 'rubble' : r < 0.85 ? 'rocks' : 'wrecked-car';
          // The wrecked car model is long and low (aspect ~0.25): a height
          // target tuned for boxier props would leave it several tiles long.
          place(name, px, pz, name === 'wrecked-car' ? 0.5 : 1, name === 'wrecked-car' ? 0.9 : 2, x, z);
        }
      } else if (cell.type === 'ore') {
        // Dense rocky outcrops marking the minable vein: 1-2 rocks per tile.
        const rocks = 1 + (rng() < 0.6 ? 1 : 0);
        for (let k = 0; k < rocks; k++) {
          place('rocks', w.x + jitter(), w.z + jitter(), 1.5, 2.5, x, z);
        }
      } else if (cell.type === 'wildlife') {
        // Herd marker: 1-2 deer grazing on the tile. The tx/tz tracking lets
        // the decoration follow the per-tile rebuilds like every other prop.
        const deer = 1 + (rng() < 0.5 ? 1 : 0);
        for (let k = 0; k < deer; k++) {
          place('deer', w.x + jitter(), w.z + jitter(), 0.8, 1.2, x, z);
        }
      } else if (cell.type === 'grass') {
        const centerDist = grid.hqTile ? Math.hypot(x - grid.hqTile.x, z - grid.hqTile.z) : Infinity;
        if (centerDist > 6) {
          if (rng() < 0.004) place('gravestone', px, pz, 1, 1.5, x, z);
          else if (rng() < 0.004) place('fence', px, pz, 1, 1.5, x, z);
        }
      } else if (cell.type === 'wasteland') {
        if (rng() < 0.02) {
          const name = rng() < 0.6 ? 'tree-dead' : 'rubble';
          place(name, px, pz, 1.5, 2.5, x, z);
        }
      }
    }
  }

  // Atmosphere ring: dead trees and wrecks scattered outside the map borders.
  const half = MAP_SPAN / 2;
  for (let k = 0; k < 48; k++) {
    const angle = rng() * Math.PI * 2;
    const radius = half + 2 + rng() * 14;
    const r = rng();
    const name = r < 0.55 ? 'tree-dead' : r < 0.8 ? 'rubble' : 'wrecked-car';
    // Same low/long car fix as the ruins scatter: per-prop height targets.
    const isCar = name === 'wrecked-car';
    place(name, Math.cos(angle) * radius, Math.sin(angle) * radius, isCar ? 0.6 : 1.5, isCar ? 1 : 3);
  }

  const decorations = new THREE.Group();
  decorations.name = 'decorations';
  const groupsByProp = new Map(); // prop name -> Group of InstancedMeshes
  for (const [name, transforms] of placements) {
    const group = instantiateTemplate(props[name], transforms);
    groupsByProp.set(name, group);
    decorations.add(group);
  }
  scene.add(decorations);

  // Releases the per-instance GPU attributes of a retired prop group. The
  // geometry/material are shared with the prop templates and are NOT disposed.
  const disposeGroup = (group) => {
    for (const child of group.children) {
      if (child.isInstancedMesh) child.dispose();
    }
  };

  // Rebuilds the InstancedMesh group of one prop from its current transforms
  // and swaps it into the decorations parent (targeted update, no full
  // terrain rebuild). Used after per-tile clears/plants.
  const rebuildPropGroup = (name) => {
    const old = groupsByProp.get(name);
    const next = instantiateTemplate(props[name], placements.get(name) ?? []);
    groupsByProp.set(name, next);
    decorations.add(next);
    if (old) {
      decorations.remove(old);
      disposeGroup(old);
    }
  };

  /**
   * Recolors the ground instance of a single tile (index z*size+x) with the
   * base color of the new type plus the same brightness jitter and patch
   * noise used at build time (the patch value is a pure function of the
   * tile, so the recolor blends into the surrounding patchwork).
   * Does not touch grid data — the caller owns the game state.
   */
  const setGroundTile = (x, z, type) => {
    if (x < 0 || z < 0 || x >= size || z >= size) return;
    baseColor.setHex(TILE_COLORS[type] ?? TILE_COLORS.grass);
    baseColor.multiplyScalar(0.92 + rng() * 0.16);
    baseColor.multiplyScalar(patchMultiplier(x, z));
    ground.setColorAt(z * size + x, baseColor);
    if (ground.instanceColor) ground.instanceColor.needsUpdate = true;
  };

  /**
   * Removes every decoration belonging to tile (x, z) — e.g. the rocks of a
   * depleted ore vein — rebuilding only the InstancedMesh groups of the
   * props that actually lost instances.
   */
  const clearDecorationsAt = (x, z) => {
    const touched = [];
    for (const [name, transforms] of placements) {
      let removed = false;
      for (let k = transforms.length - 1; k >= 0; k--) {
        const t = transforms[k];
        if (t.tx === x && t.tz === z) {
          transforms.splice(k, 1);
          removed = true;
        }
      }
      if (removed) touched.push(name);
    }
    for (const name of touched) rebuildPropGroup(name);
  };

  /**
   * Plants one decoration of the given prop on tile (x, z) — e.g. a tree
   * grown by the Forester ('tree-1'/'tree-2', targetH 1.5-2.5) — with the
   * usual random yaw and in-tile position jitter, then rebuilds that
   * prop's group.
   */
  const addDecorationAt = (x, z, propName, targetH) => {
    const template = props && props[propName];
    if (!template) return;
    if (x < 0 || z < 0 || x >= size || z >= size) return;
    const w = tileToWorld(x, z);
    const s = scaleForHeight(template, targetH, heightCache);
    if (!placements.has(propName)) placements.set(propName, []);
    placements.get(propName).push({
      x: w.x + jitter(),
      z: w.z + jitter(),
      ry: rng() * Math.PI * 2,
      s,
      tx: x,
      tz: z,
    });
    rebuildPropGroup(propName);
  };

  return { ground, water, decorations, setGroundTile, clearDecorationsAt, addDecorationAt };
}
