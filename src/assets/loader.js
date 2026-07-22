// Asset loader: fetches the GLB manifest and loads/caches all models.
// No side effects at import time — everything happens inside functions.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const MANIFEST_URL = 'assets/manifest.json';

/**
 * Fetches the manifest and loads every GLB listed in it.
 * @param {(loaded: number, total: number) => void} [onProgress] called after each model loads
 * @returns {Promise<{ manifest: object, models: Map<string, THREE.Object3D>, animations: Map<string, THREE.AnimationClip[]> }>}
 */
export async function loadAll(onProgress) {
  const response = await fetch(MANIFEST_URL);
  if (!response.ok) {
    throw new Error(`Impossibile caricare il manifest degli asset: ${response.status}`);
  }
  const manifest = await response.json();

  // Flatten all categories into a name -> url map.
  const entries = [];
  for (const category of Object.values(manifest)) {
    for (const [name, url] of Object.entries(category)) {
      entries.push([name, url]);
    }
  }

  const loader = new GLTFLoader();
  const models = new Map();
  const animations = new Map();
  const total = entries.length;
  let loaded = 0;

  await Promise.all(
    entries.map(async ([name, url]) => {
      const gltf = await loader.loadAsync(url);
      models.set(name, gltf.scene);
      animations.set(name, gltf.animations || []);
      loaded += 1;
      if (onProgress) onProgress(loaded, total);
    })
  );

  return { manifest, models, animations };
}

/**
 * Returns a deep, skinning-safe clone of the named model template.
 * All meshes in the clone have castShadow enabled.
 * @param {{ models: Map<string, THREE.Object3D> }} assets result of loadAll()
 * @param {string} name model key from the manifest
 * @returns {THREE.Object3D}
 */
export function getModel(assets, name) {
  const template = assets.models.get(name);
  if (!template) {
    throw new Error(`Modello non trovato: ${name}`);
  }
  const clone = SkeletonUtils.clone(template);
  clone.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
    }
  });
  return clone;
}

/**
 * Returns the animation clips of the named model (empty array if none).
 * @param {{ animations: Map<string, THREE.AnimationClip[]> }} assets result of loadAll()
 * @param {string} name model key from the manifest
 * @returns {THREE.AnimationClip[]}
 */
export function getAnimations(assets, name) {
  return assets.animations.get(name) || [];
}

/**
 * Finds the first clip matching any of the candidate names.
 * Matching is case-insensitive and also tries the clip name prefix
 * before '|' or '_' (covers Kenney, KayKit and Quaternius naming).
 * @param {THREE.AnimationClip[]} clips
 * @param {...string} candidates e.g. findClip(clips, 'walk', 'walking', 'run')
 * @returns {THREE.AnimationClip | null}
 */
export function findClip(clips, ...candidates) {
  if (!clips || clips.length === 0) return null;
  const wanted = candidates.map((c) => c.toLowerCase());
  for (const clip of clips) {
    const clipName = clip.name.toLowerCase();
    const prefix = clipName.split(/[|_]/)[0];
    for (const candidate of wanted) {
      if (clipName === candidate || prefix === candidate) {
        return clip;
      }
    }
  }
  return null;
}

/**
 * Uniformly scales the object so its bounding box height equals targetH,
 * then repositions it so the base sits on y = 0. When maxWidth is given, the
 * scale is further reduced (never increased) so the horizontal extent of the
 * bounding box fits within maxWidth.
 * @param {THREE.Object3D} obj
 * @param {number} targetH target height in world units
 * @param {number} [maxWidth] optional cap for the horizontal extent (world units)
 * @returns {THREE.Object3D} the same object, for chaining
 */
export function normalizeHeight(obj, targetH, maxWidth) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.y > 0) {
    let scale = targetH / size.y;
    const width = Math.max(size.x, size.z);
    if (maxWidth > 0 && width * scale > maxWidth) {
      scale = maxWidth / width;
    }
    obj.scale.multiplyScalar(scale);
  }
  // Recompute after scaling and drop the base to ground level.
  const scaledBox = new THREE.Box3().setFromObject(obj);
  obj.position.y -= scaledBox.min.y;
  return obj;
}
