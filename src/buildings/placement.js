// Building placement: ghost preview, footprint validation, construction and
// demolition. Walls (def.isWall) and roads (def.isRoad) also support
// drag-placement: dragstart begins a line preview along the dominant axis
// (wallLineTiles), dragend builds it in order while funds and free tiles
// last. Tower ghosts show their firing range via the world overlay ring.
// Driven by core/input.js events; update() runs once per frame.
// No side effects at import time: listeners attach inside createPlacement().

import * as THREE from 'three';
import {
  TILE_SIZE,
  GRID_SIZE,
  isFree,
  occupy,
  occupyTrap,
  release,
  getCell,
  worldToTile,
  tileToWorld,
} from '../world/grid.js';
import {
  addBuilding,
  removeBuilding,
  findBuilding,
  pushEvent,
} from '../sim/state.js';
import { canAfford, payCost } from '../sim/economy.js';
import { isUnlocked, TECHS } from '../sim/research.js';
import { countNodesInRange } from '../sim/extraction.js';
import { getDef } from './definitions.js';
import { getModel } from '../assets/loader.js';
import { scaleForFootprint } from './visuals.js';

const GHOST_OPACITY = 0.6;
const VALID_COLOR = 0x3aff6a; // green: footprint free and affordable
const INVALID_COLOR = 0xff3a3a; // red: blocked or too expensive
const NEUTRAL_COLOR = 0x555555; // demolish hover on an empty tile
const EXTRACTOR_EMPTY_COLOR = 0xffa53a; // orange: placeable, but no nodes in range
const DEMOLISH_REFUND = 0.5;

// Ghost tints for defs with a `proximity` rule, per tile type: full output
// vs reduced output (blue/yellow on water, green/yellow on forest,
// olive/yellow on wildlife herds).
const PROXIMITY_COLORS = {
  water: { rich: 0x4ac3ff, poor: 0xffd24a }, // rich aquifer / deep aquifer
  forest: { rich: 0x53e06a, poor: 0xffd24a }, // rich grounds / poor grounds
  wildlife: { rich: 0x9ad94a, poor: 0xffd24a }, // herd nearby / herd far away
};

// Iterates over every material of a mesh (handles material arrays).
function forEachMaterial(mesh, cb) {
  if (Array.isArray(mesh.material)) mesh.material.forEach(cb);
  else if (mesh.material) cb(mesh.material);
}

// Clones materials and makes the whole subtree semi-transparent, so the
// ghost never alters the shared templates and never occludes the scene.
function ghostify(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    const makeGhostMat = (m) => {
      const c = m.clone();
      c.transparent = true;
      c.opacity = GHOST_OPACITY;
      c.depthWrite = false;
      return c;
    };
    if (Array.isArray(child.material)) child.material = child.material.map(makeGhostMat);
    else if (child.material) child.material = makeGhostMat(child.material);
  });
}

function tint(root, hex) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    forEachMaterial(child, (m) => {
      if (m.color) m.color.set(hex);
    });
  });
}

// Disposes the ghost's cloned materials. Geometry is shared with the asset
// templates (SkeletonUtils.clone) and must not be disposed; only the
// fallback box owns its geometry (tracked via userData.ownGeometry).
function disposeGhostMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    forEachMaterial(child, (m) => m.dispose());
    if (child.userData.ownGeometry) child.geometry.dispose();
  });
}

// True when at least one tile of the given type lies within Chebyshev
// distance `range` of the footprint { x, z, w, h }, clipped to grid bounds.
function hasTileTypeInRange(grid, footprint, type, range) {
  const minX = Math.max(0, footprint.x - range);
  const maxX = Math.min(grid.size - 1, footprint.x + footprint.w - 1 + range);
  const minZ = Math.max(0, footprint.z - range);
  const maxZ = Math.min(grid.size - 1, footprint.z + footprint.h - 1 + range);
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      if (grid.cells[z][x].type === type) return true;
    }
  }
  return false;
}

/**
 * Output multiplier for a definition with a `proximity` rule
 * ({ tile, range, poor }): 1 when a tile of the required type lies within
 * `range` of the footprint edge, `poor` otherwise. Returns 1 for defs
 * without the rule. Pure function, safe to import in tests.
 * @param {object} grid grid from world/grid.js createGrid()
 * @param {object} def building definition (maybe without `proximity`)
 * @param {{ x: number, z: number, w: number, h: number }} footprint
 * @returns {number}
 */
export function proximityEfficiencyAt(grid, def, footprint) {
  const rule = def?.proximity;
  if (!rule) return 1;
  return hasTileTypeInRange(grid, footprint, rule.tile, rule.range) ? 1 : rule.poor;
}

/**
 * Tiles of a wall line between two tiles: straight along the dominant axis
 * (|dx| ≥ |dz| → horizontal row on start.z, vertical column on start.x
 * otherwise), both ends clamped to the grid. Pure function, safe to import
 * in tests.
 * @param {{ x: number, z: number }} start
 * @param {{ x: number, z: number }} end
 * @returns {Array<{ x: number, z: number }>}
 */
export function wallLineTiles(start, end) {
  const clamp = (v) => Math.min(Math.max(Math.round(v), 0), GRID_SIZE - 1);
  const sx = clamp(start.x);
  const sz = clamp(start.z);
  const ex = clamp(end.x);
  const ez = clamp(end.z);
  const tiles = [];
  if (Math.abs(ex - sx) >= Math.abs(ez - sz)) {
    const step = ex >= sx ? 1 : -1;
    for (let x = sx; x !== ex + step; x += step) tiles.push({ x, z: sz });
  } else {
    const step = ez >= sz ? 1 : -1;
    for (let z = sz; z !== ez + step; z += step) tiles.push({ x: sx, z });
  }
  return tiles;
}

/**
 * Interactive building placement and demolition controller.
 *
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {object} deps.grid grid from world/grid.js createGrid()
 * @param {object} deps.state game state from sim/state.js createGameState()
 * @param {object} [deps.isoCamera] accepted for wiring symmetry (unused:
 *   ground picking already happens inside core/input.js)
 * @param {object} deps.input input from core/input.js createInput()
 * @param {object} deps.visuals visuals from buildings/visuals.js
 * @param {object} deps.assets assets from assets/loader.js loadAll()
 * @param {object} [deps.overlay] world/overlay.js overlay: the tower-range
 *   ring follows the ghost while placing a tower (optional, headless tests
 *   may omit it)
 * @returns {{
 *   startPlacing: (defId: string) => void,
 *   startDemolish: () => void,
 *   cancel: () => void,
 *   mode: () => 'idle' | 'placing' | 'demolish',
 *   rotateGhost: () => void,
 *   update: () => void,
 *   demolishBuilding: (building: object) => void,
 * }}
 */
export function createPlacement({ scene, grid, state, input, visuals, assets, overlay }) {
  let currentMode = 'idle'; // 'idle' | 'placing' | 'demolish'
  let def = null;
  let defId = null;
  let ghost = null;
  let rotationSteps = 0; // 0..3 quarter turns; odd steps swap w/h
  let cursorTile = null; // last snapped anchor tile { x, z } | null
  let valid = false;
  let wallDrag = null; // { start: {x, z} } while dragging a wall line
  let ringOwnedByGhost = false; // tower-range ring currently driven by us

  // Wall-line drag preview: a pool of per-tile highlight planes, grown on
  // demand and reused across drags (one per tile of wallLineTiles).
  const lineGroup = new THREE.Group();
  lineGroup.visible = false;
  scene.add(lineGroup);
  const linePool = [];

  function lineHighlightAt(i) {
    if (!linePool[i]) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      linePool[i] = mesh;
      lineGroup.add(mesh);
    }
    return linePool[i];
  }

  // Footprint highlighter: a flat plane scaled to the footprint, tinted
  // green/red while placing, red/gray while demolishing.
  const highlight = new THREE.Mesh(
    new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE),
    new THREE.MeshBasicMaterial({
      color: VALID_COLOR,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })
  );
  highlight.rotation.x = -Math.PI / 2;
  highlight.visible = false;
  scene.add(highlight);

  // Effective footprint size after rotation (odd steps swap w and h).
  function effSize() {
    return rotationSteps % 2 === 0
      ? { w: def.w, h: def.h }
      : { w: def.h, h: def.w };
  }

  function footprintCenter(tileX, tileZ, w, h) {
    const base = tileToWorld(tileX, tileZ);
    return {
      x: base.x + ((w - 1) * TILE_SIZE) / 2,
      z: base.z + ((h - 1) * TILE_SIZE) / 2,
    };
  }

  function createGhost(buildingDef) {
    let obj;
    try {
      obj = getModel(assets, buildingDef.model);
      // Same scaling as visuals.add(): the preview matches the placed result.
      scaleForFootprint(obj, buildingDef, buildingDef.w, buildingDef.h);
    } catch {
      // Fallback: plain box matching the footprint when the model is missing.
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(
          buildingDef.w * TILE_SIZE * 0.8,
          1.5,
          buildingDef.h * TILE_SIZE * 0.8
        ),
        new THREE.MeshStandardMaterial({ color: 0x888888 })
      );
      mesh.userData.ownGeometry = true;
      mesh.position.y = 0.75;
      obj = mesh;
    }
    ghostify(obj);
    scene.add(obj);
    return obj;
  }

  function disposeGhost() {
    if (!ghost) return;
    scene.remove(ghost);
    disposeGhostMaterials(ghost);
    ghost = null;
  }

  // Enters placing mode for the given definition id. Unknown ids are
  // ignored; tech-locked buildings are refused with an error event and the
  // current mode is left untouched.
  function startPlacing(id) {
    const d = getDef(id);
    if (!d) return;
    if (!isUnlocked(state, d)) {
      const techName = TECHS[d.requiresTech]?.name ?? d.requiresTech;
      pushEvent(state, 'error', `Requires research: ${techName}.`);
      return;
    }
    cancel();
    defId = id;
    def = d;
    rotationSteps = 0;
    ghost = createGhost(def);
    currentMode = 'placing';
  }

  function startDemolish() {
    cancel();
    currentMode = 'demolish';
  }

  function cancel() {
    disposeGhost();
    highlight.visible = false;
    hideWallLine();
    wallDrag = null;
    updateGhostRing(null);
    currentMode = 'idle';
    def = null;
    defId = null;
    cursorTile = null;
    valid = false;
  }

  function mode() {
    return currentMode;
  }

  // Rotates the ghost by 90 degrees; validation uses the swapped footprint.
  function rotateGhost() {
    if (currentMode !== 'placing' || !ghost) return;
    rotationSteps = (rotationSteps + 1) % 4;
    ghost.rotation.y += Math.PI / 2;
  }

  // Highlight tint while placing: red when blocked; rich/poor proximity
  // colors for defs with a site-efficiency rule (blue/yellow on water,
  // green/yellow on forest, olive/yellow on wildlife); orange for
  // extractors with no node in range (placement stays allowed); green
  // otherwise.
  function ghostColor(tile, w, h) {
    if (!valid) return INVALID_COLOR;
    if (def.proximity) {
      const footprint = { x: tile.x, z: tile.z, w, h };
      const colors = PROXIMITY_COLORS[def.proximity.tile];
      return proximityEfficiencyAt(grid, def, footprint) === 1
        ? (colors?.rich ?? VALID_COLOR)
        : (colors?.poor ?? VALID_COLOR);
    }
    if (def.extracts) {
      const footprint = { x: tile.x, z: tile.z, w, h };
      return countNodesInRange(grid, footprint, def.extracts) > 0
        ? VALID_COLOR
        : EXTRACTOR_EMPTY_COLOR;
    }
    return VALID_COLOR;
  }

  // Tower-range ring while placing: follows the ghost for tower defs,
  // otherwise leaves the ring alone (main.js drives it for the selection).
  function updateGhostRing(center) {
    if (!overlay) return;
    if (center && def?.isTower) {
      overlay.setTowerRing(center, def.range);
      ringOwnedByGhost = true;
    } else if (ringOwnedByGhost) {
      overlay.setTowerRing(null);
      ringOwnedByGhost = false;
    }
  }

  // Snaps the ghost to the hovered tile and refreshes validity + tint.
  function refreshGhost() {
    const ground = input.ground;
    if (!ground) {
      cursorTile = null;
      valid = false;
      if (ghost) ghost.visible = false;
      highlight.visible = false;
      updateGhostRing(null);
      return;
    }
    const tile = worldToTile(ground.x, ground.z);
    cursorTile = tile;
    const { w, h } = effSize();
    const center = footprintCenter(tile.x, tile.z, w, h);

    valid = isFree(grid, tile.x, tile.z, w, h) && canAfford(state, def);
    const color = ghostColor(tile, w, h);

    if (ghost) {
      ghost.visible = true;
      ghost.position.x = center.x;
      ghost.position.z = center.z;
      tint(ghost, valid ? VALID_COLOR : INVALID_COLOR);
    }
    highlight.visible = true;
    highlight.scale.set(w, h, 1);
    highlight.position.set(center.x, 0.05, center.z);
    highlight.material.color.set(color);
    updateGhostRing(center);
  }

  // How many walls of the current def the resources can still pay for
  // (Infinity when the wall is free): tiles beyond this count preview red.
  function affordableWallCount() {
    let n = Infinity;
    for (const [resource, amount] of Object.entries(def?.cost ?? {})) {
      if (amount > 0) {
        n = Math.min(n, Math.floor((state.resources[resource] ?? 0) / amount));
      }
    }
    return n;
  }

  // Per-tile preview of the wall line being dragged: green where the wall
  // can actually go (free tile within budget), red elsewhere. The regular
  // ghost stays hidden for the whole drag.
  function refreshWallLine(endTile) {
    const tiles = wallLineTiles(wallDrag.start, endTile);
    if (ghost) ghost.visible = false;
    highlight.visible = false;
    const affordable = affordableWallCount();
    for (let i = 0; i < tiles.length; i++) {
      const mesh = lineHighlightAt(i);
      const c = tileToWorld(tiles[i].x, tiles[i].z);
      mesh.position.set(c.x, 0.05, c.z);
      const ok =
        i < affordable && isFree(grid, tiles[i].x, tiles[i].z, 1, 1);
      mesh.material.color.set(ok ? VALID_COLOR : INVALID_COLOR);
      mesh.visible = true;
    }
    for (let i = tiles.length; i < linePool.length; i++) {
      linePool[i].visible = false;
    }
    lineGroup.visible = true;
  }

  function hideWallLine() {
    lineGroup.visible = false;
  }

  // Demolish hover: red on tiles occupied by a building (or holding a trap),
  // gray elsewhere.
  function refreshDemolishHighlight() {
    const ground = input.ground;
    if (!ground) {
      highlight.visible = false;
      return;
    }
    const tile = worldToTile(ground.x, ground.z);
    const cell = getCell(grid, tile.x, tile.z);
    const center = footprintCenter(tile.x, tile.z, 1, 1);
    highlight.visible = true;
    highlight.scale.set(1, 1, 1);
    highlight.position.set(center.x, 0.05, center.z);
    highlight.material.color.set(
      cell && (cell.occupiedBy !== null || cell.trap) ? INVALID_COLOR : NEUTRAL_COLOR
    );
  }

  // Shared construction step: pays the cost, registers the building on the
  // state and the grid and spawns the model. The caller must have validated
  // the footprint first. Returns the new building, or null when the cost
  // cannot be paid.
  function buildAt(tile, w, h) {
    if (!payCost(state, def)) return null;
    const building = addBuilding(state, defId, def, tile.x, tile.z);
    if (def.proximity) {
      building.efficiency = proximityEfficiencyAt(grid, def, {
        x: tile.x,
        z: tile.z,
        w,
        h,
      });
    }
    if (def.isTrap) {
      // Traps never block the pathing: mark the tile instead of occupying it.
      occupyTrap(grid, tile.x, tile.z, building.id);
    } else {
      // Roads occupy their tiles but stay traversable for zombies (the
      // isRoad flag marks the grid cells; see zombies/pathfinding.js).
      occupy(grid, tile.x, tile.z, w, h, building.id, def.isRoad === true);
    }
    visuals.add(building, def);
    return building;
  }

  function placeBuilding() {
    if (!cursorTile || !valid) return;
    const { w, h } = effSize();
    if (!buildAt(cursorTile, w, h)) return;
    pushEvent(state, 'build', `${def.name} built.`);
    // Stay in placing mode for consecutive placements.
  }

  // Wall drag release: builds the line in order, stopping at the first tile
  // that is blocked or no longer affordable. One summary event per line.
  function placeWallLine(tiles) {
    let placed = 0;
    for (const tile of tiles) {
      if (!isFree(grid, tile.x, tile.z, 1, 1) || !canAfford(state, def)) break;
      if (!buildAt(tile, 1, 1)) break;
      placed++;
    }
    if (placed > 0) {
      pushEvent(
        state,
        'build',
        placed === 1 ? `${def.name} built.` : `${def.name} ×${placed} built.`
      );
    }
    // Stay in placing mode, like single-click placement.
  }

  // Demolishes a placed building: refunds half of each build-cost resource
  // (floored, clamped to that resource's cap), frees the footprint, removes
  // the model and logs the event. No-op on null/unknown buildings.
  function demolishBuilding(building) {
    if (!building) return;
    const d = getDef(building.defId);
    for (const [resource, amount] of Object.entries(d?.cost ?? {})) {
      const refund = Math.floor(amount * DEMOLISH_REFUND);
      if (refund <= 0) continue;
      const cap = state.caps?.[resource] ?? Infinity;
      state.resources[resource] = Math.min(
        cap,
        (state.resources[resource] ?? 0) + refund
      );
    }
    release(grid, building.id);
    removeBuilding(state, building.id);
    visuals.remove(building.id);
    pushEvent(state, 'demolish', `${d?.name ?? 'Building'} demolished.`);
  }

  function demolishAt(payload) {
    if (!payload || !payload.inBounds) return;
    const cell = getCell(grid, payload.tileX, payload.tileZ);
    if (!cell) return;
    // Traps mark the tile via cell.trap instead of occupiedBy (see grid.js).
    const id = cell.occupiedBy ?? cell.trap ?? null;
    if (id === null) return;
    const building = findBuilding(state, id);
    if (!building) return;
    demolishBuilding(building);
    // Stay in demolish mode for consecutive demolitions.
  }

  function handleClick(payload) {
    if (currentMode === 'placing') {
      // Re-sync with the fresh ground point from the click event itself.
      refreshGhost();
      placeBuilding();
    } else if (currentMode === 'demolish') {
      demolishAt(payload);
    }
  }

  function handleKeydown(key) {
    if (key === 'escape' && currentMode !== 'idle') {
      cancel();
    } else if (key === 'r' && currentMode === 'placing') {
      rotateGhost();
    }
  }

  function handleRightclick() {
    if (currentMode !== 'idle') cancel();
  }

  // Line drag: only in placing mode with a wall or road def (both build in
  // series along a row). The preview itself is refreshed by update() every
  // frame, so camera pans mid-drag are caught.
  function handleDragstart(payload) {
    if (currentMode !== 'placing' || !(def?.isWall || def?.isRoad)) return;
    if (!payload || !payload.inBounds) return;
    wallDrag = { start: { x: payload.tileX, z: payload.tileZ } };
  }

  function handleDragend(payload) {
    if (!wallDrag) return;
    const start = wallDrag.start;
    wallDrag = null;
    hideWallLine();
    if (!payload) return;
    placeWallLine(wallLineTiles(start, { x: payload.tileX, z: payload.tileZ }));
  }

  // Called every frame from the main loop.
  function update() {
    if (currentMode === 'placing') {
      if (wallDrag) {
        const ground = input.ground;
        if (ground) refreshWallLine(worldToTile(ground.x, ground.z));
      } else {
        refreshGhost();
      }
    } else if (currentMode === 'demolish') {
      refreshDemolishHighlight();
    }
  }

  input.on('click', handleClick);
  input.on('keydown', handleKeydown);
  input.on('rightclick', handleRightclick);
  input.on('dragstart', handleDragstart);
  input.on('dragend', handleDragend);

  return {
    startPlacing,
    startDemolish,
    cancel,
    mode,
    rotateGhost,
    update,
    demolishBuilding,
  };
}
