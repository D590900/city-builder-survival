// Entry point: hands boot() (bootstrap.js: URL params, engine, asset load)
// the startGame below, which wires together world, simulation, zombies,
// buildings and UI. Owns the main loop, the UI wiring and the endless defeat
// flow (no victory: the score is the number of nights survived). Save/load
// (localStorage, v4) lives in persistence.js, the day/night transitions in
// game/phase-controller.js.
// v2 systems wired here: weather, research, node extraction/planting,
// gameplay modifiers (getModifiers) threaded through every sim tick.
// v3 adds: visible workers, the labor panel and generator smoke.
// Later additions: building repair (tickRepairs), the on/off switch, worker
// priorities and building upgrade levels.

import * as THREE from 'three';
import { createIsoCamera } from './core/camera.js';
import { createInput } from './core/input.js';
import { createDayNight } from './core/daynight.js';
import { createGrid, occupy, getCell, tileToWorld } from './world/grid.js';
import { generateMap } from './world/mapgen.js';
import { buildTerrain } from './world/terrain.js';
import { createWorkers } from './world/workers.js';
import {
  CONFIG,
  createGameState,
  addBuilding,
  addSurvivor,
  findBuilding,
  pushEvent,
} from './sim/state.js';
import { tickEconomy } from './sim/economy.js';
import { tickRepairs } from './sim/repair.js';
import {
  tickSurvivors,
  assignJobs,
  housingCapacity,
  idleCount,
} from './sim/survivors.js';
import { tickExtraction } from './sim/extraction.js';
import { tickTrails } from './sim/trails.js';
import { tickResearch, research } from './sim/research.js';
import { advanceWeather, WEATHERS } from './sim/weather.js';
import { getModifiers } from './sim/modifiers.js';
import { createZombieManager } from './zombies/zombie.js';
import { createCombat, buildingCenterWorld } from './zombies/combat.js';
import { BUILDING_DEFS, getDef } from './buildings/definitions.js';
import { createPlacement } from './buildings/placement.js';
import { createBuildingVisuals } from './buildings/visuals.js';
import { createOverlay } from './world/overlay.js';
import { createFx } from './core/fx.js';
import { createAudio } from './core/audio.js';
import { createHud } from './ui/hud.js';
import { createBuildMenu } from './ui/buildmenu.js';
import { createInspector } from './ui/inspector.js';
import { createResearchPanel } from './ui/researchpanel.js';
import { createLaborPanel } from './ui/laborpanel.js';
import { createTutorial, tutorialSeen } from './ui/tutorial.js';
import {
  readRecord,
  writeRecord,
  clearSave,
  readSave,
  restoreSave,
  saveGame,
} from './persistence.js';
import { boot, parseSeed, randomSeed } from './bootstrap.js';
import { createPhaseController } from './game/phase-controller.js';

const JOB_INTERVAL = 2; // seconds between job reassignments
const MENU_INTERVAL = 0.25; // seconds between build-menu/research refreshes
const TWILIGHT_FRACTION = 0.1; // first 10% of day is dawn, of night is dusk
const MAX_DT = 0.1; // seconds of simulation per frame at speed 1
const SMOKE_INTERVAL = 3.5; // seconds between smoke puffs on a damaged building
const DAMAGE_SMOKE_RATIO = 0.5; // buildings below this hp ratio smoke
const GEN_SMOKE_INTERVAL = 2.5; // seconds between smoke puffs on a running generator
// Keys that drive the camera (WASD/arrows pan, Q/E rotate): the tutorial's
// first step closes on the first camera input, wheel zoom included.
const CAMERA_KEYS = new Set([
  'w', 'a', 's', 'd', 'q', 'e',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

function startGame({ engine, screens, assets, params }) {
  const uiRoot = document.getElementById('ui');

  // --- grid + state: from the save when present, otherwise a fresh game ---
  const forceNew = params.has('new') || params.has('autostart');
  let seed = parseSeed(params);
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

  // Autosave with the current run's data (see persistence.js).
  const persist = () => saveGame(state, seed, changedTiles);

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
  // Day/night transitions and the wave plan (currentWave + spawnSchedule).
  const phases = createPhaseController({ state, grid, hud, zombies, saveGame: persist });
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

  function updateLighting(mods) {
    const weatherFx = { fogMul: mods.fogMul, darkenMul: mods.darkenMul };
    const t = Math.min(state.timeInPhase / phases.phaseDuration(), 1);
    if (state.phase === 'day') {
      if (t < TWILIGHT_FRACTION) daynight.update('dawn', t / TWILIGHT_FRACTION, weatherFx);
      else daynight.update('day', (t - TWILIGHT_FRACTION) / (1 - TWILIGHT_FRACTION), weatherFx);
    } else if (t < TWILIGHT_FRACTION) {
      daynight.update('dusk', t / TWILIGHT_FRACTION, weatherFx);
    } else {
      daynight.update('night', (t - TWILIGHT_FRACTION) / (1 - TWILIGHT_FRACTION), weatherFx);
    }
  }

  // Wipes the save and starts a fresh run on a new random seed.
  function restartRun() {
    clearSave();
    window.location.href = window.location.pathname + '?new=1';
  }

  function handleGameOver() {
    gameOverHandled = true;
    clearSave();
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
      phases.spawnSchedule.length > 0 &&
      state.timeInPhase >= phases.spawnSchedule[0].t
    ) {
      const batch = phases.spawnSchedule.shift();
      for (let i = 0; i < batch.count; i++) {
        const sp =
          grid.spawnPoints[Math.floor(Math.random() * grid.spawnPoints.length)];
        if (sp) zombies.spawn(sp.x, sp.z, phases.currentWave);
      }
    }

    zombies.update(dt, mods);
    combat.update(dt, zombies, mods);

    if (state.timeInPhase >= phases.phaseDuration()) {
      if (state.phase === 'day') phases.startNight();
      else phases.startDay();
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
      phaseTimeLeft: Math.max(0, phases.phaseDuration() - state.timeInPhase),
      phaseDuration: phases.phaseDuration(),
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
  persist(); // autosave at the start of day 1 (or refresh the loaded save)
  updateLighting(getModifiers(state, grid));
  requestAnimationFrame(frame);
}

boot({ startGame });
