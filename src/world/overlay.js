// Site-efficiency and tower-range overlay: colored discs under every
// building with a `proximity` rule (green at full output, yellow when
// reduced — the same tints as the placement ghost) and one reusable ring
// showing a tower's firing range. The discs are toggled from the HUD 🔍
// button; the ring is independent and driven by placement (tower ghost) and
// main.js (selected tower). No side effects at import time: meshes are
// created inside createOverlay().

import * as THREE from 'three';
import { TILE_SIZE, tileToWorld } from './grid.js';

// Ground sits at y≈0.2, water at 0.03: 0.25 floats just above without
// z-fighting.
const DISC_Y = 0.25;
const RING_Y = 0.25;
const FULL_COLOR = 0x3aff6a; // green: full site output (ghost VALID_COLOR)
const POOR_COLOR = 0xffd24a; // yellow: reduced output (ghost "poor" tint)
const RING_COLOR = 0xffb347; // amber, like the tower muzzle flashes
const FULL_EFFICIENCY = 0.95; // at/above this the site counts as rich

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {object} deps.state game state (live reference, mutated by the sim)
 * @param {object} deps.defs building definitions map (BUILDING_DEFS)
 * @returns {{
 *   setVisible: (visible: boolean) => void,
 *   isVisible: () => boolean,
 *   refresh: () => void,
 *   setTowerRing: (center: ({x: number, z: number} | null), radiusTiles?: number) => void,
 * }}
 */
export function createOverlay({ scene, state, defs }) {
  // Discs live in a group so the 🔍 toggle is a single visibility flip.
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const discs = new Map(); // buildingId -> mesh

  // Unit ring scaled to the requested radius: no geometry churn when the
  // selection hops between tower types.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.93, 1, 96),
    new THREE.MeshBasicMaterial({
      color: RING_COLOR,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = RING_Y;
  ring.visible = false;
  scene.add(ring); // outside the group: the ring ignores the 🔍 toggle

  function makeDisc(b) {
    const radius = (Math.max(b.w, b.h) * TILE_SIZE) / 2 + 0.4;
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 32),
      new THREE.MeshBasicMaterial({
        color: FULL_COLOR,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    const base = tileToWorld(b.x, b.z);
    mesh.position.set(
      base.x + ((b.w - 1) * TILE_SIZE) / 2,
      DISC_Y,
      base.z + ((b.h - 1) * TILE_SIZE) / 2
    );
    return mesh;
  }

  // Syncs the disc set with state.buildings: adds discs for new proximity
  // buildings, drops those of demolished ones, repaints the rest. Cheap
  // enough to call whenever the building count changes.
  function refresh() {
    const seen = new Set();
    for (const b of state.buildings) {
      const def = defs[b.defId];
      if (!def?.proximity) continue;
      seen.add(b.id);
      let disc = discs.get(b.id);
      if (!disc) {
        disc = makeDisc(b);
        discs.set(b.id, disc);
        group.add(disc);
      }
      disc.material.color.set(
        (b.efficiency ?? 1) >= FULL_EFFICIENCY ? FULL_COLOR : POOR_COLOR
      );
    }
    for (const [id, disc] of discs) {
      if (seen.has(id)) continue;
      group.remove(disc);
      disc.geometry.dispose();
      disc.material.dispose();
      discs.delete(id);
    }
  }

  /** Shows/hides the efficiency discs; a show always re-syncs first. */
  function setVisible(visible) {
    group.visible = visible;
    if (visible) refresh();
  }

  function isVisible() {
    return group.visible;
  }

  // Shows the range ring centered on a world point { x, z } with the given
  // radius in tiles (def.range); null center hides it.
  function setTowerRing(center, radiusTiles) {
    if (!center || !radiusTiles) {
      ring.visible = false;
      return;
    }
    const r = radiusTiles * TILE_SIZE;
    ring.position.set(center.x, RING_Y, center.z);
    ring.scale.set(r, r, 1);
    ring.visible = true;
  }

  return { setVisible, isVisible, refresh, setTowerRing };
}
