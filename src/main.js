// Entry point: boots the engine, loads the GLB assets, then wires together
// world, simulation, zombies, buildings and UI. Owns the main loop, the
// day/night phase machine, save/load (localStorage, v4) and the endless
// defeat flow (no victory: the score is the number of nights survived).
// v2 systems wired here: weather, research, node extraction/planting,
// gameplay modifiers (getModifiers) threaded through every sim tick.
// v3 adds: visible workers, the labor panel and generator smoke.
// Later additions: building repair (tickRepairs), the on/off switch, worker
// priorities and building upgrade levels.

import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { createIsoCamera } from './core/camera.js';
import { createInput } from './core/input.js';
import { createDayNight } from './core/daynight.js';
import { createGrid, occupy, occupyTrap, getCell, tileToWorld } from './world/grid.js';
import { generateMap } from './world/mapgen.js';
import { buildTerrain } from './world/terrain.js';
import { createWorkers } from './world/workers.js';
import {
  CONFIG,
  MAX_LEVEL,
  createGameState,
  addBuilding,
  addSurvivor,
  findBuilding,
  pushEvent,
} from './sim/state.js';
import { tickEconomy, levelMultiplier } from './sim/economy.js';
import { tickRepairs } from './sim/repair.js';
import {
  tickSurvivors,
  assignJobs,
  tryRecruit,
  housingCapacity,
  idleCount,
  tickReputation,
  recruitCount,
} from './sim/survivors.js';
import { tickExtraction } from './sim/extraction.js';
import { tickTrails } from './sim/trails.js';
import { tickResearch, research } from './sim/research.js';
import { advanceWeather, WEATHERS } from './sim/weather.js';
import { getModifiers } from './sim/modifiers.js';
import { waveForNight, spawnPlan } from './sim/waves.js';
import { createZombieManager } from './zombies/zombie.js';
import { createCombat, buildingCenterWorld } from './zombies/combat.js';
import { BUILDING_DEFS, getDef } from './buildings/definitions.js';
import { createPlacement } from './buildings/placement.js';
import { createBuildingVisuals } from './buildings/visuals.js';
import { createOverlay } from './world/overlay.js';
import { loadAll } from './assets/loader.js';
import { createFx } from './core/fx.js';
import { createAudio } from './core/audio.js';
import { createHud } from './ui/hud.js';
import { createBuildMenu } from './ui/buildmenu.js';
import { createInspector } from './ui/inspector.js';
import { createResearchPanel } from './ui/researchpanel.js';
import { createLaborPanel } from './ui/laborpanel.js';
import { createScreens } from './ui/screens.js';
import { createTutorial, tutorialSeen } from './ui/tutorial.js';

const SAVE_KEY = 'cbs-save';
const SAVE_VERSION = 4;
const RECORD_KEY = 'cbs-record'; // best nights survived, across runs
const JOB_INTERVAL = 2; // seconds between job reassignments
const MENU_INTERVAL = 0.25; // seconds between build-menu/research refreshes
const TWILIGHT_FRACTION = 0.1; // first 10% of day is dawn, of night is dusk
const MAX_DT = 0.1; // seconds of simulation per frame at speed 1
const SMOKE_INTERVAL = 3.5; // seconds between smoke puffs on a damaged building
const DAMAGE_SMOKE_RATIO = 0.5; // buildings below this hp ratio smoke
const GEN_SMOKE_INTERVAL = 2.5; // seconds between smoke puffs on a running generator
const RESOURCE_KEYS = ['food', 'water', 'wood', 'metal', 'energy', 'fuel'];
// Keys that drive the camera (WASD/arrows pan, Q/E rotate): the tutorial's
// first step closes on the first camera input, wheel zoom included.
const CAMERA_KEYS = new Set([
  'w', 'a', 's', 'd', 'q', 'e',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

const params = new URLSearchParams(window.location.search);

// Seed from ?seed=N or #N, or null when a random one should be rolled.
function parseSeed() {
  const raw =
    params.get('seed') ??
    (window.location.hash ? window.location.hash.slice(1) : null);
  if (raw === null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

// Best run (nights survived), persisted apart from the save so it survives
// restarts; 0 when no record exists or storage is unavailable.
function readRecord() {
  try {
    const n = Number.parseInt(localStorage.getItem(RECORD_KEY), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeRecord(n) {
  try {
    localStorage.setItem(RECORD_KEY, String(n));
  } catch {
    // Storage unavailable: the record just won't persist.
  }
}

// Small centered status line used while assets load (and for load errors).
function showMessage(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#cfd8e3;font:16px/1.4 system-ui,sans-serif;pointer-events:none;z-index:200;';
  document.body.appendChild(el);
  return el;
}

function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Only v4 saves load; older versions silently start a fresh game.
    if (!data || data.version !== SAVE_VERSION) return null;
    if (typeof data.seed !== 'number' || !Array.isArray(data.buildings)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// Rebuilds grid + state from a v4 save. Throws on inconsistent data; the
// caller falls back to a fresh game. Changed tiles are replayed onto the
// freshly generated grid, so buildTerrain (which runs after this) renders
// them natively.
function restoreSave(data) {
  const grid = generateMap(createGrid(), data.seed);
  const state = createGameState();
  state.mapSeed = data.seed;

  if (typeof data.day === 'number' && data.day >= 1) {
    state.day = Math.floor(data.day);
  }
  if (data.resources && typeof data.resources === 'object') {
    for (const key of RESOURCE_KEYS) {
      if (typeof data.resources[key] === 'number') {
        state.resources[key] = Math.min(
          state.caps[key] ?? Infinity,
          Math.max(0, data.resources[key])
        );
      }
    }
  }
  if (typeof data.researchPoints === 'number') {
    state.researchPoints = Math.max(0, data.researchPoints);
  }
  if (Array.isArray(data.researched)) {
    state.researched = data.researched.filter((id) => typeof id === 'string');
  }
  if (typeof data.kills === 'number' && data.kills >= 0) {
    state.kills = Math.floor(data.kills);
  }
  // deathsToday non è persistito: riparte da 0 (createGameState).
  if (typeof data.reputation === 'number') {
    state.reputation = Math.min(100, Math.max(0, data.reputation));
  }

  // Tiles changed by extraction/planting since mapgen.
  const changedTiles = [];
  if (Array.isArray(data.changedTiles)) {
    for (const t of data.changedTiles) {
      if (!Number.isInteger(t?.x) || !Number.isInteger(t?.z)) continue;
      if (t.toType !== 'grass' && t.toType !== 'forest' && t.toType !== 'trail') continue;
      const cell = getCell(grid, t.x, t.z);
      if (!cell) continue;
      cell.type = t.toType;
      cell.walkable = true; // grass, (planted) forest and trails are all walkable
      changedTiles.push({ x: t.x, z: t.z, toType: t.toType });
    }
  }

  // Buildings keep their saved ids so the survivor ↔ workplace links (and
  // the worker rosters rebuilt below) stay valid across the reload.
  let maxBuildingId = 0;
  for (const b of data.buildings) {
    const def = getDef(b?.defId);
    if (!def || !Number.isInteger(b.x) || !Number.isInteger(b.z)) continue;
    const building = addBuilding(state, b.defId, def, b.x, b.z);
    if (Number.isInteger(b.id) && b.id > 0) {
      building.id = b.id;
      maxBuildingId = Math.max(maxBuildingId, b.id);
    }
    building.autoAssign = b.autoAssign !== false;
    // v4 fields added later: default to on / not repairing / normal
    // priority / level 1 on old saves.
    building.enabled = b.enabled !== false;
    building.repairing = b.repairing === true;
    if (Number.isInteger(b.priority)) {
      building.priority = Math.min(Math.max(b.priority, 0), 2);
    }
    if (Number.isInteger(b.level)) {
      building.level = Math.min(Math.max(b.level, 1), MAX_LEVEL);
    }
    // maxHp follows the level (hp saved as-is: niente cura all'upgrade qui).
    building.maxHp = def.hp * levelMultiplier(building.level);
    building.hp = building.maxHp;
    if (typeof b.hp === 'number' && b.hp > 0) {
      building.hp = Math.min(b.hp, building.maxHp);
    }
    if (typeof b.extracted === 'number') building.extracted = b.extracted;
    if (typeof b.efficiency === 'number') building.efficiency = b.efficiency;
    if (def.isTrap) {
      // Traps keep the tile walkable: restore the trap mark, not an occupation.
      occupyTrap(grid, b.x, b.z, building.id);
    } else {
      occupy(grid, b.x, b.z, building.w, building.h, building.id, def.isRoad === true);
    }
  }
  state.nextBuildingId = Math.max(state.nextBuildingId, maxBuildingId + 1);
  if (!state.buildings.some((b) => b.defId === 'hq')) {
    throw new Error('Save without a Refuge');
  }

  // Survivors keep their saved ids and reconnect to their workplace via
  // the saved buildingId.
  const buildingIds = new Set(state.buildings.map((b) => b.id));
  const saved = Array.isArray(data.survivors) ? data.survivors : [];
  let maxSurvivorId = 0;
  for (const s of saved) {
    const survivor = addSurvivor(state);
    if (Number.isInteger(s?.id) && s.id > 0) {
      survivor.id = s.id;
      maxSurvivorId = Math.max(maxSurvivorId, s.id);
    }
    if (typeof s?.hunger === 'number') survivor.hunger = s.hunger;
    if (typeof s?.thirst === 'number') survivor.thirst = s.thirst;
    if (Number.isInteger(s?.buildingId) && buildingIds.has(s.buildingId)) {
      survivor.buildingId = s.buildingId;
    }
  }
  state.nextSurvivorId = Math.max(state.nextSurvivorId, maxSurvivorId + 1);
  if (state.survivors.length === 0) {
    for (let i = 0; i < CONFIG.startSurvivors; i++) addSurvivor(state);
  }

  // Worker rosters are rebuilt from the survivors' buildingId (single source
  // of truth), capped at the definition's job slots; the overflow goes idle.
  for (const b of state.buildings) {
    const def = getDef(b.defId);
    const slots = def?.jobs ?? 0;
    b.workers = [];
    for (const s of state.survivors) {
      if (s.buildingId !== b.id) continue;
      if (b.workers.length < slots) b.workers.push(s.id);
      else s.buildingId = null;
    }
  }

  return { grid, state, seed: data.seed, changedTiles };
}

function startGame({ engine, screens, assets }) {
  const uiRoot = document.getElementById('ui');

  // --- grid + state: from the save when present, otherwise a fresh game ---
  const forceNew = params.has('new') || params.has('autostart');
  let seed = parseSeed();
  let grid = null;
  let state = null;
  let changedTiles = []; // [{ x, z, toType }] — extraction/planting since mapgen
  let loadedSave = false; // true when state comes from a v4 save

  if (!forceNew) {
    const data = readSave();
    if (data) {
      try {
        ({ grid, state, seed, changedTiles } = restoreSave(data));
        loadedSave = true;
      } catch {
        grid = null;
        state = null;
        changedTiles = [];
      }
    }
  }
  if (!grid) {
    if (seed === null) seed = randomSeed();
    grid = generateMap(createGrid(), seed);
    state = createGameState();
    changedTiles = [];
    const hqDef = getDef('hq');
    const hq = addBuilding(state, 'hq', hqDef, grid.hqTile.x, grid.hqTile.z);
    occupy(grid, grid.hqTile.x, grid.hqTile.z, hqDef.w, hqDef.h, hq.id);
    for (let i = 0; i < CONFIG.startSurvivors; i++) addSurvivor(state);
  }
  state.mapSeed = seed;
  advanceWeather(state); // roll this day's forecast (deterministic per seed+day)

  // Records a tile type change for the save file; the latest state of a tile
  // wins, so deplete → plant → deplete cycles keep a single entry.
  function trackTileChange(x, z, toType) {
    const i = changedTiles.findIndex((t) => t.x === x && t.z === z);
    if (i !== -1) changedTiles.splice(i, 1);
    changedTiles.push({ x, z, toType });
  }

  function saveGame() {
    try {
      const data = {
        version: SAVE_VERSION,
        seed,
        day: state.day,
        resources: { ...state.resources },
        survivors: state.survivors.map((s) => ({
          id: s.id,
          hunger: s.hunger,
          thirst: s.thirst,
          buildingId: s.buildingId,
        })),
        buildings: state.buildings.map((b) => ({
          id: b.id,
          defId: b.defId,
          x: b.x,
          z: b.z,
          hp: Math.round(b.hp),
          workers: [...b.workers],
          autoAssign: b.autoAssign,
          extracted: b.extracted,
          efficiency: b.efficiency,
          enabled: b.enabled !== false,
          repairing: b.repairing === true,
          priority: b.priority ?? 1,
          level: b.level ?? 1,
        })),
        changedTiles: changedTiles.map((t) => ({ ...t })),
        researchPoints: state.researchPoints,
        researched: [...state.researched],
        kills: state.kills,
        reputation: state.reputation ?? 0,
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      // Storage unavailable: keep playing without saves.
    }
  }

  // --- camera, input, lighting, terrain ---
  const iso = createIsoCamera(window.innerWidth / window.innerHeight);
  engine.setCamera(iso.camera);
  const input = createInput(engine.renderer.domElement, iso);
  let cameraTouched = false; // first camera input closes the tutorial's step 1
  // Wheel zoom: iso.zoom() expects a scaled delta (see core/camera.js).
  engine.renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    cameraTouched = true;
    iso.zoom(e.deltaY * 0.02);
  }, { passive: false });
  const daynight = createDayNight(engine.scene);

  const props = {};
  for (const name of Object.keys(assets.manifest.props ?? {})) {
    const model = assets.models.get(name);
    if (model) props[name] = model;
  }
  const terrain = buildTerrain(engine.scene, grid, props);
  // Loaded games: buildTerrain already renders the replayed tile types
  // (ground colors and forest scatter); strip the random grass scatter
  // (fences, gravestones) from tiles extraction had turned to grass,
  // matching what clearDecorationsAt did live. Trails keep their scatter:
  // tickTrails does not clear it when the tile is trampled.
  for (const t of changedTiles) {
    if (t.toType === 'grass') terrain.clearDecorationsAt(t.x, t.z);
  }

  // Debug handle, also used by the headless smoke tests.
  window.__game = {
    state,
    grid,
    defs: BUILDING_DEFS,
    mods: () => getModifiers(state, grid),
    terrain,
  };

  // --- buildings, zombies, combat ---
  const visuals = createBuildingVisuals(engine.scene, assets);
  for (const b of state.buildings) {
    visuals.add(b, getDef(b.defId));
    if (b.enabled === false) visuals.setEnabled(b.id, false); // save caricato
  }
  // Site-efficiency discs (🔍 toggle) + the shared tower-range ring.
  const overlay = createOverlay({ scene: engine.scene, state, defs: BUILDING_DEFS });
  const placement = createPlacement({
    scene: engine.scene,
    grid,
    state,
    isoCamera: iso,
    input,
    visuals,
    assets,
    overlay,
  });
  const zombies = createZombieManager({ scene: engine.scene, grid, state, assets });
  const workers = createWorkers(engine.scene, assets, grid);

  // --- atmosphere: particles/lights + synthesized audio ---
  const fx = createFx(engine.scene);
  const audio = createAudio();
  // Browsers unlock WebAudio only inside a user gesture.
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
  uiRoot.addEventListener('click', (e) => {
    if (e.target.closest('button')) audio.play('click');
  });

  const combat = createCombat({
    scene: engine.scene,
    state,
    grid,
    visuals,
    onShot: (target) => {
      fx.burst(target.wx, 1, target.wz, 0xffb347, 8);
      audio.play('shot');
    },
    onDestroyed: (b, center) => {
      fx.burst(center.x, 1, center.z, 0xff7a3c, 30);
      fx.smoke(center.x, 1, center.z);
    },
  });

  // --- UI ---
  const hud = createHud(uiRoot);
  let currentBuildDefId = null;
  const buildMenu = createBuildMenu(uiRoot, {
    onSelect: (defId) => {
      currentBuildDefId = defId;
      placement.startPlacing(defId);
    },
    onDemolish: () => placement.startDemolish(),
    onCancel: () => placement.cancel(),
  });
  const researchPanel = createResearchPanel(uiRoot, {
    onResearch: (id) => research(state, id),
  });
  hud.onResearchToggle(() => researchPanel.toggle());
  const laborPanel = createLaborPanel(uiRoot);
  hud.onLaborToggle(() => laborPanel.toggle());
  hud.onOverlayToggle((on) => overlay.setVisible(on));

  // Seed label (bottom right): one click copies the shareable map link.
  const seedEl = document.createElement('button');
  seedEl.type = 'button';
  seedEl.className = 'seed-label';
  seedEl.textContent = `seed #${seed}`;
  seedEl.title = 'Copy the link to this map';
  seedEl.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?seed=${seed}`;
    navigator.clipboard?.writeText(url).then(
      () => hud.toast('Link copied to the clipboard', 'success'),
      () => hud.toast('Could not copy the link', 'error')
    );
  });
  uiRoot.appendChild(seedEl);
  const inspector = createInspector(uiRoot, {
    state,
    grid,
    input,
    placement,
    visuals,
    defs: BUILDING_DEFS,
  });

  // First-run tutorial (non-blocking hint card above the build menu): only
  // on the very first fresh game — never on a loaded save, and never again
  // once completed or skipped, so a ?new=1 restart does not bring it back.
  const tutorial = !loadedSave && !tutorialSeen() ? createTutorial(uiRoot) : null;

  // v3 handles on the debug object (used by the headless smoke tests).
  window.__game.workers = workers;
  window.__game.laborPanel = laborPanel;

  // The camera starts on the HQ (or the first building, for odd saves).
  const hq = state.buildings.find((b) => b.defId === 'hq') ?? state.buildings[0];
  if (hq) {
    const c = tileToWorld(hq.x + (hq.w - 1) / 2, hq.z + (hq.h - 1) / 2);
    iso.focus(c.x, c.z);
  }

  // --- run state ---
  let speed = 1; // 1 | 2 | 3; pause is tracked separately (timeScale 0)
  let paused = false;
  let jobTimer = JOB_INTERVAL; // staff the buildings on the first frame
  let menuTimer = 0;
  let currentWave = null;
  let spawnSchedule = [];
  let gameOverHandled = false;
  let prevKills = state.kills; // kill-count delta drives the zombie-die sound
  let prevPhase = state.phase; // phase changes drive the ambience
  let prevBuildingCount = state.buildings.length; // drives overlay refreshes
  const smokeTimers = new Map(); // buildingId -> seconds until next smoke puff
  const genSmokeTimers = new Map(); // buildingId -> seconds until next generator puff
  audio.setAmbience(state.phase);

  // Damaged buildings (< 50% hp) emit a smoke puff every SMOKE_INTERVAL
  // seconds; entries are pruned once the building is gone or repaired.
  function updateDamageSmoke(dt) {
    for (const b of state.buildings) {
      const ratio = b.maxHp > 0 ? b.hp / b.maxHp : 0;
      if (ratio >= DAMAGE_SMOKE_RATIO) {
        smokeTimers.delete(b.id);
        continue;
      }
      const t = (smokeTimers.get(b.id) ?? 0) - dt;
      if (t <= 0) {
        const c = buildingCenterWorld(b);
        fx.smoke(c.x, 1, c.z);
        smokeTimers.set(b.id, SMOKE_INTERVAL);
      } else {
        smokeTimers.set(b.id, t);
      }
    }
    for (const id of smokeTimers.keys()) {
      if (!state.buildings.some((b) => b.id === id)) smokeTimers.delete(id);
    }
  }

  // A running generator (staffed, wood available) puffs smoke from the top
  // of its stack every GEN_SMOKE_INTERVAL seconds. Mirrors the damage smoke;
  // purely cosmetic, so it runs on real (unscaled) time.
  function updateGeneratorSmoke(dt) {
    for (const b of state.buildings) {
      if (b.defId !== 'generator') continue;
      const running = b.workers.length > 0 && (state.resources.wood ?? 0) > 0;
      if (!running) {
        genSmokeTimers.delete(b.id);
        continue;
      }
      const t = (genSmokeTimers.get(b.id) ?? 0) - dt;
      if (t <= 0) {
        const mesh = visuals.meshes.get(b.id);
        if (mesh) {
          // Top of the building from the mesh's bounding box (+2.5u fallback).
          const box = new THREE.Box3().setFromObject(mesh);
          const topY = Number.isFinite(box.max.y) ? box.max.y : 2.5;
          fx.smoke(mesh.position.x, topY, mesh.position.z);
        }
        genSmokeTimers.set(b.id, GEN_SMOKE_INTERVAL);
      } else {
        genSmokeTimers.set(b.id, t);
      }
    }
    for (const id of genSmokeTimers.keys()) {
      if (!state.buildings.some((b) => b.id === id)) genSmokeTimers.delete(id);
    }
  }

  hud.onSpeed((s) => {
    speed = s;
    paused = false;
  });
  hud.onPause((p) => {
    paused = p;
  });
  hud.onRestart(() => {
    if (state.gameOver) return;
    const wasPaused = paused;
    paused = true;
    screens.showConfirm(
      {
        title: 'Restart the game?',
        message: 'Current progress will be lost and the colony will start over from scratch.',
        confirmLabel: 'Restart',
        cancelLabel: 'Cancel',
      },
      restartRun,
      () => {
        paused = wasPaused;
      }
    );
  });
  input.on('keydown', (key, event) => {
    if (key === ' ') {
      event.preventDefault();
      paused = !paused;
    } else if (key === '1' || key === '2' || key === '3') {
      speed = Number(key);
      paused = false;
    }
  });

  const phaseDuration = () =>
    state.phase === 'day' ? CONFIG.dayLength : CONFIG.nightLength;

  function updateLighting(mods) {
    const weatherFx = { fogMul: mods.fogMul, darkenMul: mods.darkenMul };
    const t = Math.min(state.timeInPhase / phaseDuration(), 1);
    if (state.phase === 'day') {
      if (t < TWILIGHT_FRACTION) daynight.update('dawn', t / TWILIGHT_FRACTION, weatherFx);
      else daynight.update('day', (t - TWILIGHT_FRACTION) / (1 - TWILIGHT_FRACTION), weatherFx);
    } else if (t < TWILIGHT_FRACTION) {
      daynight.update('dusk', t / TWILIGHT_FRACTION, weatherFx);
    } else {
      daynight.update('night', (t - TWILIGHT_FRACTION) / (1 - TWILIGHT_FRACTION), weatherFx);
    }
  }

  function startNight() {
    state.phase = 'night';
    state.timeInPhase = 0;
    currentWave = waveForNight(state.day);
    spawnSchedule = spawnPlan(state.day, CONFIG.nightLength);
    hud.toast(`☾ Night ${state.day} — they're coming!`, 'warn');
  }

  function startDay() {
    zombies.clearAll();
    state.day += 1;
    state.phase = 'day';
    state.timeInPhase = 0;
    const weather = WEATHERS[advanceWeather(state)] ?? WEATHERS.clear;
    tickReputation(state); // notte superata, Radio e morti muovono la reputazione
    const mods = getModifiers(state, grid); // staffed radios add extra recruits
    tryRecruit(state, BUILDING_DEFS, recruitCount(state, mods));
    saveGame();
    hud.toast(`☀ Day ${state.day} — ${weather.icon} ${weather.name}`, 'info');
  }

  // Wipes the save and starts a fresh run on a new random seed.
  function restartRun() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // ignore
    }
    window.location.href = window.location.pathname + '?new=1';
  }

  function handleGameOver() {
    gameOverHandled = true;
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // ignore
    }
    // Endless mode: the only ending is defeat, scored by nights survived.
    const record = Math.max(readRecord(), state.day - 1);
    writeRecord(record);
    const stats = {
      days: state.day,
      kills: state.kills,
      survivors: state.survivors.length,
      reputation: Math.floor(state.reputation ?? 0),
      record,
    };
    screens.showDefeat(stats, restartRun);
  }

  function simulate(dt, mods) {
    state.timeInPhase += dt;
    tickEconomy(state, dt, BUILDING_DEFS, mods);
    tickSurvivors(state, dt, mods);
    tickResearch(state, dt, BUILDING_DEFS);

    // Riparazioni attive: gli hp risalgono gradualmente e la tinta danno
    // li segue (il fumo danni si ferma da solo sopra la soglia).
    for (const id of tickRepairs(state, dt)) {
      const b = findBuilding(state, id);
      if (b) visuals.setDamaged(id, b.maxHp > 0 ? Math.max(0, b.hp) / b.maxHp : 1);
    }

    // Extraction: depleted nodes turn to grass, foresters plant new forest;
    // the terrain and the save's changed-tile log follow the grid.
    const { depleted, planted } = tickExtraction(state, grid, dt, BUILDING_DEFS, mods);
    for (const t of depleted) {
      terrain.setGroundTile(t.x, t.z, 'grass');
      terrain.clearDecorationsAt(t.x, t.z);
      trackTileChange(t.x, t.z, 'grass');
      pushEvent(state, 'depleted', 'Node depleted.');
    }
    for (const t of planted) {
      terrain.setGroundTile(t.x, t.z, 'forest');
      terrain.addDecorationAt(
        t.x,
        t.z,
        Math.random() < 0.5 ? 'tree-1' : 'tree-2',
        1.5 + Math.random()
      );
      trackTileChange(t.x, t.z, 'forest');
      pushEvent(state, 'planted', `The ${getDef('forester')?.name ?? 'Forester'} planted a tree.`);
    }

    // Sentieri sterrati: i sopravvissuti inattivi tracciano da soli un
    // percorso dal Rifugio agli edifici (una tile ogni 10 s). La sim decide
    // la tile; qui ne cambiamo il tipo — resta calpestabile e NON
    // edificabile (BUILDABLE_TYPES in grid.js è solo grass/road) — e la
    // ricoloriamo, registrandola nel log tile del salvataggio.
    const trail = tickTrails(state, grid, dt);
    if (trail) {
      const cell = getCell(grid, trail.x, trail.z);
      if (cell) cell.type = 'trail';
      terrain.setGroundTile(trail.x, trail.z, 'trail');
      trackTileChange(trail.x, trail.z, 'trail');
    }

    jobTimer += dt;
    if (jobTimer >= JOB_INTERVAL) {
      jobTimer = 0;
      assignJobs(state, BUILDING_DEFS);
    }

    while (
      state.phase === 'night' &&
      spawnSchedule.length > 0 &&
      state.timeInPhase >= spawnSchedule[0].t
    ) {
      const batch = spawnSchedule.shift();
      for (let i = 0; i < batch.count; i++) {
        const sp =
          grid.spawnPoints[Math.floor(Math.random() * grid.spawnPoints.length)];
        if (sp) zombies.spawn(sp.x, sp.z, currentWave);
      }
    }

    zombies.update(dt, mods);
    combat.update(dt, zombies, mods);

    if (state.timeInPhase >= phaseDuration()) {
      if (state.phase === 'day') startNight();
      else startDay();
    }

    if (!state.gameOver && state.survivors.length === 0) {
      state.gameOver = 'defeat';
    }
  }

  function drainEvents() {
    const drained = state.events.splice(0);
    for (const e of drained) {
      const type =
        e.type === 'death' || e.type === 'destroyed' || e.type === 'defeat'
          ? 'error'
          : e.type === 'recruit' ||
              e.type === 'build' ||
              e.type === 'research' ||
              e.type === 'planted'
            ? 'success'
            : e.type === 'fuel' || e.type === 'depleted'
              ? 'warn'
              : 'info';
      hud.toast(e.msg, type);
      if (e.type === 'build') audio.play('place');
      else if (e.type === 'demolish' || e.type === 'destroyed') audio.play('demolish');
      else if (e.type === 'death' || e.type === 'defeat') audio.play('error');
    }
    // The tutorial advances by observing the same events (read-only).
    tutorial?.onEvents(drained);
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const rawDt = Math.min((now - last) / 1000, MAX_DT);
    last = now;

    // Weather + research folded into one modifier set, refreshed per frame.
    // The grid lets getModifiers count the dirt-trail tiles (logistics bonus).
    const mods = getModifiers(state, grid);

    iso.update(rawDt, input.keys);
    placement.update();
    visuals.update(rawDt, state.phase);
    // Cosmetic workers stroll on real time: they must not speed up with the
    // game speed (and keep moving while paused, like the other ambient fx).
    workers.update(state, state.phase, rawDt);

    if (!state.gameOver && !paused) {
      const dt = rawDt * speed;
      if (dt > 0) simulate(dt, mods);
    }

    drainEvents();

    // Tutorial: watches state deltas (phase, buildings, staffing) and the
    // first camera input; runs on real time, never pauses the game.
    tutorial?.update(
      rawDt,
      state,
      cameraTouched || [...input.keys].some((k) => CAMERA_KEYS.has(k))
    );

    // --- atmosphere hooks: sounds and particles from game-state deltas ---
    if (state.kills > prevKills) audio.play('zombie-die');
    prevKills = state.kills;
    if (state.phase !== prevPhase) {
      prevPhase = state.phase;
      audio.setAmbience(state.phase);
    }
    updateDamageSmoke(rawDt);
    updateGeneratorSmoke(rawDt);
    fx.setWeather(state.weather?.current ?? 'clear', mods); // idempotent
    fx.update(rawDt, state.phase);
    fx.setNightLights(state.buildings, visuals.meshes, state.phase);

    menuTimer += rawDt;
    if (menuTimer >= MENU_INTERVAL) {
      menuTimer = 0;
      buildMenu.update(state);
      researchPanel.update(state);
      laborPanel.update(state);
    }
    const mode = placement.mode();
    buildMenu.setMode(
      mode === 'placing' ? 'build' : mode,
      mode === 'placing' ? currentBuildDefId : null,
    );

    inspector.update();

    // Anello di gittata sulla torre selezionata; durante il piazzamento lo
    // pilota il ghost (placement.js), qui resta muto per non interferire.
    if (placement.mode() === 'idle') {
      const sel = inspector.selected();
      const selDef = sel ? getDef(sel.defId) : null;
      if (selDef?.isTower) {
        const c = tileToWorld(sel.x + (sel.w - 1) / 2, sel.z + (sel.h - 1) / 2);
        overlay.setTowerRing(c, selDef.range);
      } else {
        overlay.setTowerRing(null);
      }
    }
    // Dischi efficienza riallineati solo quando cambia il parco edifici.
    if (state.buildings.length !== prevBuildingCount) {
      prevBuildingCount = state.buildings.length;
      if (overlay.isVisible()) overlay.refresh();
    }

    updateLighting(mods);

    hud.update(state, BUILDING_DEFS, {
      phaseTimeLeft: Math.max(0, phaseDuration() - state.timeInPhase),
      phaseDuration: phaseDuration(),
      housing: housingCapacity(state, BUILDING_DEFS),
      idle: idleCount(state),
      speed,
      paused,
      grid,
    });

    if (state.gameOver && !gameOverHandled) handleGameOver();

    engine.render(rawDt);
  }

  const bootWeather = WEATHERS[state.weather.current] ?? WEATHERS.clear;
  hud.toast(`☀ Day ${state.day} — ${bootWeather.icon} ${bootWeather.name}`, 'info');
  saveGame(); // autosave at the start of day 1 (or refresh the loaded save)
  updateLighting(getModifiers(state, grid));
  requestAnimationFrame(frame);
}

function boot() {
  const engine = createEngine(document.getElementById('game'));
  const screens = createScreens(document.getElementById('ui'));

  const assetsPromise = loadAll();

  const begin = () => {
    const loading = showMessage('Loading assets…');
    assetsPromise
      .then((assets) => {
        loading.remove();
        startGame({ engine, screens, assets });
      })
      .catch((err) => {
        loading.textContent = `Failed to load the assets: ${err.message}`;
      });
  };

  // ?autostart=1 skips the title screen (headless tests); the title screen
  // lets the assets finish loading in the background meanwhile.
  if (params.has('autostart')) begin();
  else screens.showTitle(begin, readRecord());
}

boot();
