import * as THREE from 'three';

// Day keyframe: warm high sun, light fog, desaturated blue-grey sky.
// NOTE: fog densities are tuned for the fixed ~200-unit camera distance of
// core/camera.js (FogExp2 factor at the look-at point: ~6% by day, ~12% by
// night) — anything denser washes the whole map out.
const DAY = {
  sunColor: new THREE.Color('#fff2d8'),
  sunIntensity: 1.6,
  hemiSky: new THREE.Color('#bcd8ff'),
  hemiGround: new THREE.Color('#8a7f6a'),
  hemiIntensity: 0.9,
  fogColor: new THREE.Color('#b6c3cd'),
  fogDensity: 0.0012,
  bgColor: new THREE.Color('#9fb2c0'),
};

// Night keyframe: blue moon, dark fog, near-black sky. Dark and atmospheric
// but fully playable: terrain, forests, ruins and zombies stay readable.
// bgColor stays near-black (tests pin it); readability comes from the lights.
const NIGHT = {
  sunColor: new THREE.Color('#6b7ec0'),
  sunIntensity: 1.3,
  hemiSky: new THREE.Color('#3d547e'),
  hemiGround: new THREE.Color('#141c2a'),
  hemiIntensity: 1.1,
  fogColor: new THREE.Color('#101a2a'),
  fogDensity: 0.0018,
  bgColor: new THREE.Color('#05070d'),
};

const LIGHT_DISTANCE = 150;
const SHADOW_EXTENT = 70; // shadow ortho camera covers ~±70 world units

const lerp = (a, b, t) => a + (b - a) * t;

function smooth01(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Day/night lighting rig: directional sun/moon (with shadows) + hemisphere
 * ambient, driving scene.fog (FogExp2) and scene.background (Color).
 *
 * No side effects at import time: the rig is built inside createDayNight().
 *
 * @param {THREE.Scene} scene
 * @returns {{
 *   update: (phase: string, t01: number, weather?: { fogMul?: number, darkenMul?: number }) => void,
 *   sunLight: THREE.DirectionalLight,
 *   hemiLight: THREE.HemisphereLight,
 * }}
 */
export function createDayNight(scene) {
  const sunLight = new THREE.DirectionalLight(0xffffff, 1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -SHADOW_EXTENT;
  sunLight.shadow.camera.right = SHADOW_EXTENT;
  sunLight.shadow.camera.top = SHADOW_EXTENT;
  sunLight.shadow.camera.bottom = -SHADOW_EXTENT;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = LIGHT_DISTANCE * 3;
  sunLight.shadow.bias = -0.0005;
  scene.add(sunLight);
  scene.add(sunLight.target); // target stays at the origin

  const hemiLight = new THREE.HemisphereLight(
    DAY.hemiSky.getHex(),
    DAY.hemiGround.getHex(),
    DAY.hemiIntensity,
  );
  scene.add(hemiLight);

  scene.fog = new THREE.FogExp2(DAY.fogColor.getHex(), DAY.fogDensity);
  scene.background = new THREE.Color(DAY.bgColor.getHex());

  /**
   * Interpolate lighting/atmosphere for the current cycle phase.
   *
   * @param {string} phase 'dawn' | 'day' | 'dusk' | 'night'
   *   (unknown values fall back to 'day'); dawn blends night → day,
   *   dusk blends day → night.
   * @param {number} t01 progress within the phase, in [0, 1]
   * @param {{ fogMul?: number, darkenMul?: number }} [weather] optional
   *   weather modifiers: fogMul scales the fog density (thicker rain),
   *   darkenMul dims sun/hemisphere intensity (overcast sky). Both default
   *   to 1, so omitting the argument keeps the plain day/night behavior.
   */
  function update(phase, t01 = 0, weather = null) {
    const t = smooth01(t01);
    const fogMul = weather && typeof weather.fogMul === 'number' ? weather.fogMul : 1;
    const darkenMul =
      weather && typeof weather.darkenMul === 'number' ? Math.max(weather.darkenMul, 0.05) : 1;

    // Blend factor between the night (0) and day (1) keyframes.
    let k;
    switch (phase) {
      case 'night':
        k = 0;
        break;
      case 'dawn':
        k = t;
        break;
      case 'dusk':
        k = 1 - t;
        break;
      case 'day':
      default:
        k = 1;
        break;
    }

    sunLight.color.lerpColors(NIGHT.sunColor, DAY.sunColor, k);
    sunLight.intensity = lerp(NIGHT.sunIntensity, DAY.sunIntensity, k) / darkenMul;
    hemiLight.color.lerpColors(NIGHT.hemiSky, DAY.hemiSky, k);
    hemiLight.groundColor.lerpColors(NIGHT.hemiGround, DAY.hemiGround, k);
    hemiLight.intensity = lerp(NIGHT.hemiIntensity, DAY.hemiIntensity, k) / darkenMul;
    scene.fog.color.lerpColors(NIGHT.fogColor, DAY.fogColor, k);
    scene.fog.density = lerp(NIGHT.fogDensity, DAY.fogDensity, k) * fogMul;
    scene.background.lerpColors(NIGHT.bgColor, DAY.bgColor, k);

    // Sun/moon orbit. The azimuth sweeps continuously east → west across the
    // whole cycle (dawn starts at 90°, night ends at 450° ≡ 90°), and the
    // elevation stays high by day / low by night, so nothing jumps at phase
    // boundaries.
    let azDeg;
    let elDeg;
    switch (phase) {
      case 'dawn':
        azDeg = lerp(90, 110, t);
        elDeg = lerp(5, 20, t);
        break;
      case 'day':
        azDeg = lerp(110, 250, t);
        elDeg = 20 + 45 * Math.sin(Math.PI * t);
        break;
      case 'dusk':
        azDeg = lerp(250, 270, t);
        elDeg = lerp(20, 5, t);
        break;
      case 'night':
        azDeg = lerp(270, 450, t);
        elDeg = 5 + 15 * Math.sin(Math.PI * t);
        break;
      default:
        azDeg = 180;
        elDeg = 65;
        break;
    }
    const az = THREE.MathUtils.degToRad(azDeg);
    const el = THREE.MathUtils.degToRad(elDeg);
    sunLight.position.set(
      Math.cos(el) * Math.cos(az) * LIGHT_DISTANCE,
      Math.sin(el) * LIGHT_DISTANCE,
      Math.cos(el) * Math.sin(az) * LIGHT_DISTANCE,
    );
  }

  return { update, sunLight, hemiLight };
}
