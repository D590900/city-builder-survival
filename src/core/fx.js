// FX module: ambient ash/dust drifting over the map, one-shot impact
// bursts, smoke columns for damaged/destroyed buildings, a small pool of
// warm night lights, and weather: pooled rain streaks plus storm lightning.
// Three.js only (plus generated sprite textures).
// No side effects at import time: everything is built inside createFx().
//
// Performance: every particle system is a fixed-size pool backed by typed
// arrays; update() never allocates. Inactive particles are parked at
// DEAD_Y. Night lights are a shared pool of 3 PointLights (never one per
// building), re-targeted at ~1 Hz and only when the building list changes.

import * as THREE from 'three';
import { getDef } from '../buildings/definitions.js';

const DUST_COUNT = 200; // ambient ash particles recycled inside a volume
const DUST_HALF = 60; // half-extent of the dust volume on X/Z (map is ±64)
const DUST_HEIGHT = 16;
const DUST_MIN_Y = 0.4;
const DUST_OPACITY_DAY = 0.45;
const DUST_OPACITY_NIGHT = 0.12;

const BURST_MAX = 256; // pooled one-shot impact particles
const BURST_GRAVITY = 9;

const SMOKE_POOL = 30; // pooled smoke sprites
const SMOKE_PUFFS = 5; // sprites activated per smoke() call
const SMOKE_MAX_OPACITY = 0.45;

const LIGHT_POOL = 3; // shared warm point lights, lit at night only
const LIGHT_COLOR = 0xffb35c;
const LIGHT_INTENSITY = 30; // candela (physical falloff, decay 2)
const LIGHT_DISTANCE = 18;
const LIGHT_HEIGHT = 3; // above the building mesh origin
const LIGHT_REFRESH = 1; // seconds between night-light target re-picks

const RAIN_COUNT = 800; // pooled rain streaks (a storm uses all of them)
const RAIN_LIGHT_COUNT = 500; // active streaks with plain 'rain'
const RAIN_HALF = 70; // half-extent of the rain volume on X/Z (map is ±64)
const RAIN_TOP = 28; // spawn height of the streaks
const RAIN_SPEED = [0, 26, 38]; // fall speed by level: none / rain / storm
const RAIN_WIND = [0, 3, 7]; // lateral drift by level
const RAIN_OPACITY = [0, 0.5, 0.65];

const BOLT_COLOR = 0xcdd8ff;
const BOLT_MIN_GAP = 3; // seconds between lightning strikes (storm + night)
const BOLT_MAX_GAP = 8;

const DEAD_Y = -1000; // parked position for inactive pooled particles

// Soft radial sprite shared by dust, bursts and smoke (generated once).
function makeSoftTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// Thin vertical streak sprite for raindrops: points are always square, so
// the streak is a bright line down the middle of a transparent square.
// The line is deliberately thick (12/64 px): sampled onto a ~11 px point a
// thinner line falls below a pixel and the rain vanishes entirely.
function makeStreakTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(size / 2 - 6, 0, 12, size);
  return new THREE.CanvasTexture(canvas);
}

// Module-level comparator so the 1 Hz light re-pick allocates nothing.
function byDistanceSq(a, b) {
  return a.d2 - b.d2;
}

/**
 * @param {THREE.Scene} scene
 * @returns {{
 *   update: (dt: number, phase: string) => void,
 *   burst: (x: number, y: number, z: number, color?: number, n?: number) => void,
 *   smoke: (x: number, y: number, z: number) => void,
 *   setNightLights: (buildings: Array<object>, meshes: Map<number, THREE.Object3D>, phase: string) => void,
 *   setWeather: (weatherId: string, mods?: object) => void,
 * }}
 *   phase is 'day' | 'night' (anything non-'night' counts as day).
 */
export function createFx(scene) {
  const softTexture = makeSoftTexture();
  const streakTexture = makeStreakTexture();
  let time = 0;

  // -------------------------------------------------------------------------
  // Ambient dust/ash: one Points cloud, recycled inside a volume around the
  // map center. More visible by day, barely there at night.
  // -------------------------------------------------------------------------
  const dustPos = new Float32Array(DUST_COUNT * 3);
  const dustVel = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < DUST_COUNT; i++) {
    const j = i * 3;
    dustPos[j] = (Math.random() * 2 - 1) * DUST_HALF;
    dustPos[j + 1] = DUST_MIN_Y + Math.random() * DUST_HEIGHT;
    dustPos[j + 2] = (Math.random() * 2 - 1) * DUST_HALF;
    dustVel[j] = (Math.random() - 0.5) * 0.6;
    dustVel[j + 1] = (Math.random() - 0.5) * 0.25;
    dustVel[j + 2] = (Math.random() - 0.5) * 0.6;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.35,
    map: softTexture,
    color: 0xb5ac9c,
    transparent: true,
    opacity: DUST_OPACITY_DAY,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false; // positions change on the GPU attribute
  scene.add(dust);

  // -------------------------------------------------------------------------
  // Impact bursts: one Points cloud with per-particle color, round-robin
  // slots. Particles fly out/up, fall under gravity, then park at DEAD_Y.
  // -------------------------------------------------------------------------
  const burstPos = new Float32Array(BURST_MAX * 3);
  const burstVel = new Float32Array(BURST_MAX * 3);
  const burstCol = new Float32Array(BURST_MAX * 3);
  const burstTtl = new Float32Array(BURST_MAX); // <= 0 means the slot is dead
  for (let i = 0; i < BURST_MAX; i++) burstPos[i * 3 + 1] = DEAD_Y;
  const burstGeo = new THREE.BufferGeometry();
  burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
  burstGeo.setAttribute('color', new THREE.BufferAttribute(burstCol, 3));
  const burstMat = new THREE.PointsMaterial({
    size: 0.5,
    map: softTexture,
    transparent: true,
    opacity: 0.95,
    vertexColors: true,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const burstPoints = new THREE.Points(burstGeo, burstMat);
  burstPoints.frustumCulled = false;
  scene.add(burstPoints);
  let burstCursor = 0;
  let burstsActive = false;
  const scratchColor = new THREE.Color();

  // -------------------------------------------------------------------------
  // Smoke: small pool of sprites (per-sprite opacity gives the dissolve).
  // -------------------------------------------------------------------------
  const smokePool = [];
  let smokeCursor = 0;
  for (let i = 0; i < SMOKE_POOL; i++) {
    const mat = new THREE.SpriteMaterial({
      map: softTexture,
      color: 0x7d7d7d,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    smokePool.push({
      sprite,
      mat,
      active: false,
      age: 0,
      life: 1,
      rise: 1,
      driftX: 0,
      driftZ: 0,
      baseScale: 1,
    });
  }

  // -------------------------------------------------------------------------
  // Night lights: LIGHT_POOL shared PointLights over the HQ and the
  // inhabited buildings closest to the map center; gentle flicker, faded
  // in/out on phase changes. Always visible at intensity 0 by day so the
  // light count never changes (avoids shader recompiles mid-game).
  // -------------------------------------------------------------------------
  const lights = [];
  for (let i = 0; i < LIGHT_POOL; i++) {
    const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE, 2);
    light.position.set(0, LIGHT_HEIGHT, 0);
    scene.add(light);
    lights.push({ light, intensity: 0, seed: i * 2.13, hasTarget: false });
  }
  let lightTimer = LIGHT_REFRESH; // pick targets on the first update
  let lightsDirty = true;
  let lightsIdle = true; // all lights fully faded out (daytime fast path)
  let lastBuildingCount = -1;
  const candidates = []; // reused pool of { x, z, d2 } for the re-pick
  let candCount = 0;

  // -------------------------------------------------------------------------
  // Rain: one pooled Points cloud of fast vertical streaks over the whole
  // map. Hidden unless the weather is rain/storm; a storm activates the full
  // pool (plain rain uses fewer), falls faster and reads denser. Slots above
  // the active count are parked at DEAD_Y.
  // -------------------------------------------------------------------------
  const rainPos = new Float32Array(RAIN_COUNT * 3);
  for (let i = 0; i < RAIN_COUNT; i++) rainPos[i * 3 + 1] = DEAD_Y;
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  // NOTE: sizeAttenuation off + pixel size — with the orthographic camera at
  // a fixed ~200-unit distance, perspective size attenuation shrank every
  // streak to ~2px and the rain was invisible.
  const rainMat = new THREE.PointsMaterial({
    size: 11,
    map: streakTexture,
    color: 0xa8bdd0,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    sizeAttenuation: false,
  });
  const rainPoints = new THREE.Points(rainGeo, rainMat);
  rainPoints.frustumCulled = false; // positions change on the GPU attribute
  rainPoints.visible = false;
  scene.add(rainPoints);
  let weatherId = 'clear';
  let rainLevel = 0; // 0 none, 1 rain, 2 storm
  let rainActive = 0; // streaks currently falling (rest parked at DEAD_Y)

  // Lightning: one directional light kept in the scene at intensity 0 (a
  // constant light count avoids shader recompiles), flashed for 100-200 ms
  // every 3-8 s while a storm rages at night.
  const boltLight = new THREE.DirectionalLight(BOLT_COLOR, 0);
  boltLight.position.set(40, 80, 20);
  scene.add(boltLight);
  scene.add(boltLight.target);
  let boltTimer = 0; // > 0 while a flash is visible
  let nextBoltIn = BOLT_MIN_GAP; // countdown to the next strike

  // Random drop (re)spawn inside the rain volume. randomY fills the whole
  // volume at once (weather change); otherwise drops re-enter from the top.
  function respawnDrop(i, randomY) {
    const j = i * 3;
    rainPos[j] = (Math.random() * 2 - 1) * RAIN_HALF;
    rainPos[j + 1] = randomY ? Math.random() * RAIN_TOP : RAIN_TOP;
    rainPos[j + 2] = (Math.random() * 2 - 1) * RAIN_HALF;
  }

  /**
   * Switches the weather effects: 'rain'/'storm' show the rain pool (the
   * storm denser and faster) and arm the night lightning; anything else
   * clears both. mods is accepted for call-site symmetry with
   * daynight.update(phase, t01, weather) and reserved for future tuning.
   */
  function setWeather(id, mods = {}) {
    void mods;
    weatherId = id || 'clear';
    const level = weatherId === 'storm' ? 2 : weatherId === 'rain' ? 1 : 0;
    if (level === rainLevel) return;
    rainLevel = level;
    rainPoints.visible = level > 0;
    const target = level === 2 ? RAIN_COUNT : level === 1 ? RAIN_LIGHT_COUNT : 0;
    for (let i = rainActive; i < target; i++) respawnDrop(i, true);
    for (let i = target; i < rainActive; i++) rainPos[i * 3 + 1] = DEAD_Y;
    rainActive = target;
    rainMat.opacity = RAIN_OPACITY[level];
    rainGeo.attributes.position.needsUpdate = true;
    if (level < 2 && boltTimer > 0) {
      boltTimer = 0;
      boltLight.intensity = 0;
    }
  }

  function updateRain(dt) {
    if (rainActive === 0) return;
    const fall = RAIN_SPEED[rainLevel];
    const wind = RAIN_WIND[rainLevel];
    for (let i = 0; i < rainActive; i++) {
      const j = i * 3;
      rainPos[j] += wind * dt;
      rainPos[j + 1] -= fall * dt;
      if (rainPos[j + 1] < 0) respawnDrop(i, false);
      else if (rainPos[j] > RAIN_HALF) rainPos[j] = -RAIN_HALF;
    }
    rainGeo.attributes.position.needsUpdate = true;
  }

  function updateLightning(dt, phase) {
    if (weatherId !== 'storm' || phase !== 'night') {
      if (boltTimer > 0) {
        boltTimer = 0;
        boltLight.intensity = 0;
      }
      return;
    }
    if (boltTimer > 0) {
      boltTimer -= dt;
      if (boltTimer <= 0) {
        boltLight.intensity = 0;
        nextBoltIn = BOLT_MIN_GAP + Math.random() * (BOLT_MAX_GAP - BOLT_MIN_GAP);
      }
      return;
    }
    nextBoltIn -= dt;
    if (nextBoltIn <= 0) {
      boltTimer = 0.1 + Math.random() * 0.1; // 100-200 ms flash
      boltLight.intensity = 2.2 + Math.random() * 1.3;
    }
  }

  /**
   * One-shot spray of n particles from (x, y, z). Round-robin: heavy fire
   * overwrites the oldest slots instead of allocating.
   */
  function burst(x, y, z, color = 0xffb347, n = 12) {
    scratchColor.set(color);
    for (let k = 0; k < n; k++) {
      const i = burstCursor;
      burstCursor = (burstCursor + 1) % BURST_MAX;
      const j = i * 3;
      burstPos[j] = x;
      burstPos[j + 1] = y;
      burstPos[j + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 3.5;
      burstVel[j] = Math.cos(a) * speed;
      burstVel[j + 1] = 1.5 + Math.random() * 3;
      burstVel[j + 2] = Math.sin(a) * speed;
      burstCol[j] = scratchColor.r;
      burstCol[j + 1] = scratchColor.g;
      burstCol[j + 2] = scratchColor.b;
      burstTtl[i] = 0.35 + Math.random() * 0.35;
    }
    burstsActive = true;
    burstGeo.attributes.color.needsUpdate = true;
  }

  /** Grey smoke column: a staggered handful of rising, dissolving puffs. */
  function smoke(x, y, z) {
    for (let k = 0; k < SMOKE_PUFFS; k++) {
      const p = smokePool[smokeCursor];
      smokeCursor = (smokeCursor + 1) % SMOKE_POOL;
      p.active = true;
      p.age = -k * 0.18; // stagger the puffs
      p.life = 1.5 + Math.random() * 0.7;
      p.rise = 1.1 + Math.random() * 0.7;
      p.driftX = (Math.random() - 0.5) * 0.6;
      p.driftZ = (Math.random() - 0.5) * 0.6;
      p.baseScale = 1.2 + Math.random() * 0.8;
      p.sprite.position.set(
        x + (Math.random() - 0.5) * 0.8,
        y,
        z + (Math.random() - 0.5) * 0.8,
      );
      p.sprite.visible = false; // appears once age >= 0
      p.mat.opacity = 0;
    }
  }

  /**
   * Re-picks the night-light targets: HQ first (it has housing), then the
   * inhabited buildings closest to the map center. Runs at ~1 Hz and only
   * when the building list changed; a no-op otherwise.
   */
  function setNightLights(buildings, meshes, phase) {
    if (phase !== 'night' && lightsIdle) return; // nothing to aim by day
    if (!lightsDirty && buildings.length === lastBuildingCount) return;
    lightsDirty = false;
    lastBuildingCount = buildings.length;

    candCount = 0;
    for (const b of buildings) {
      const def = getDef(b.defId);
      if (!def || def.houses <= 0) continue;
      const mesh = meshes?.get(b.id);
      if (!mesh) continue;
      if (candidates.length <= candCount) candidates.push({ x: 0, z: 0, d2: 0 });
      const c = candidates[candCount++];
      c.x = mesh.position.x;
      c.z = mesh.position.z;
      c.d2 = c.x * c.x + c.z * c.z;
    }
    for (let i = candCount; i < candidates.length; i++) {
      candidates[i].d2 = Infinity; // keep stale entries out of the sort head
    }
    candidates.sort(byDistanceSq);
    for (let i = 0; i < LIGHT_POOL; i++) {
      const entry = lights[i];
      entry.hasTarget = i < candCount;
      if (entry.hasTarget) {
        entry.light.position.set(candidates[i].x, LIGHT_HEIGHT, candidates[i].z);
      }
    }
  }

  function updateDust(dt, phase) {
    const target = phase === 'night' ? DUST_OPACITY_NIGHT : DUST_OPACITY_DAY;
    dustMat.opacity += (target - dustMat.opacity) * Math.min(1, dt * 2);
    for (let i = 0; i < DUST_COUNT; i++) {
      const j = i * 3;
      // Slow drift plus a cheap per-particle sway.
      dustPos[j] += dustVel[j] * dt + Math.sin(time * 0.6 + i) * 0.08 * dt;
      dustPos[j + 1] += dustVel[j + 1] * dt;
      dustPos[j + 2] += dustVel[j + 2] * dt + Math.cos(time * 0.5 + i * 1.7) * 0.08 * dt;
      // Wrap inside the volume.
      if (dustPos[j] > DUST_HALF) dustPos[j] = -DUST_HALF;
      else if (dustPos[j] < -DUST_HALF) dustPos[j] = DUST_HALF;
      if (dustPos[j + 1] > DUST_HEIGHT) dustPos[j + 1] = DUST_MIN_Y;
      else if (dustPos[j + 1] < DUST_MIN_Y) dustPos[j + 1] = DUST_HEIGHT;
      if (dustPos[j + 2] > DUST_HALF) dustPos[j + 2] = -DUST_HALF;
      else if (dustPos[j + 2] < -DUST_HALF) dustPos[j + 2] = DUST_HALF;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  function updateBursts(dt) {
    if (!burstsActive) return;
    let alive = false;
    for (let i = 0; i < BURST_MAX; i++) {
      if (burstTtl[i] <= 0) continue;
      burstTtl[i] -= dt;
      const j = i * 3;
      burstVel[j + 1] -= BURST_GRAVITY * dt;
      burstPos[j] += burstVel[j] * dt;
      burstPos[j + 1] += burstVel[j + 1] * dt;
      burstPos[j + 2] += burstVel[j + 2] * dt;
      if (burstTtl[i] <= 0) burstPos[j + 1] = DEAD_Y;
      else alive = true;
    }
    burstsActive = alive;
    burstGeo.attributes.position.needsUpdate = true;
  }

  function updateSmoke(dt) {
    for (const p of smokePool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age < 0) continue;
      const t = p.age / p.life;
      if (t >= 1) {
        p.active = false;
        p.sprite.visible = false;
        p.mat.opacity = 0;
        continue;
      }
      p.sprite.visible = true;
      p.sprite.position.y += p.rise * dt;
      p.sprite.position.x += p.driftX * dt;
      p.sprite.position.z += p.driftZ * dt;
      const s = p.baseScale * (0.7 + 1.6 * t); // expand while rising
      p.sprite.scale.set(s, s, 1);
      const fadeIn = Math.min(1, t / 0.15);
      p.mat.opacity = SMOKE_MAX_OPACITY * fadeIn * (1 - t);
    }
  }

  function updateLights(dt, phase) {
    lightTimer += dt;
    if (lightTimer >= LIGHT_REFRESH) {
      lightTimer = 0;
      lightsDirty = true;
    }
    const on = phase === 'night';
    let anyOn = false;
    for (const entry of lights) {
      const target = on && entry.hasTarget ? LIGHT_INTENSITY : 0;
      entry.intensity += (target - entry.intensity) * Math.min(1, dt * 3);
      if (entry.intensity > 0.02) {
        anyOn = true;
        // Two slow sines per light make a soft, non-repeating flicker.
        const flicker =
          1 +
          0.1 * Math.sin(time * 11 + entry.seed * 7) +
          0.06 * Math.sin(time * 23 + entry.seed * 3);
        entry.light.intensity = entry.intensity * flicker;
      } else {
        entry.light.intensity = 0;
      }
    }
    lightsIdle = !anyOn;
  }

  /**
   * Advances every effect. dt is real (unscaled) seconds; phase is
   * 'day' | 'night'.
   */
  function update(dt, phase) {
    time += dt;
    updateDust(dt, phase);
    updateBursts(dt);
    updateSmoke(dt);
    updateLights(dt, phase);
    updateRain(dt);
    updateLightning(dt, phase);
  }

  return { update, burst, smoke, setNightLights, setWeather };
}
