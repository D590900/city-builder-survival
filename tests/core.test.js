import { describe, it, expect } from 'vitest';

// Minimal browser-global stub. The core factories only touch window when
// called (never at import time); these tests exercise the DOM-free parts.
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  _listeners: new Map(),
  addEventListener(type, cb) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(cb);
  },
  removeEventListener(type, cb) {
    this._listeners.get(type)?.delete(cb);
  },
  dispatch(type, event) {
    for (const cb of this._listeners.get(type) ?? []) cb(event);
  },
};

import * as THREE from 'three';
import { createEngine } from '../src/core/engine.js';
import { createIsoCamera } from '../src/core/camera.js';
import { createInput } from '../src/core/input.js';
import { createDayNight } from '../src/core/daynight.js';

describe('core/engine', () => {
  it('imports without DOM/WebGL and exports the createEngine factory', () => {
    // Not instantiated here: WebGLRenderer requires a real GL context.
    expect(typeof createEngine).toBe('function');
  });
});

describe('core/camera', () => {
  it('creates an orthographic camera centered on the origin', () => {
    const iso = createIsoCamera(16 / 9);
    expect(iso.camera.isOrthographicCamera).toBe(true);
    const g = iso.screenToGround(640, 360);
    expect(g.x).toBeCloseTo(0, 4);
    expect(g.z).toBeCloseTo(0, 4);
  });

  it('clamps zoom to the [15, 80] frustum half-size range', () => {
    const iso = createIsoCamera(1);
    iso.zoom(1000);
    expect(iso.camera.top).toBe(80);
    iso.zoom(-1000);
    expect(iso.camera.top).toBe(15);
  });

  it('focus jumps the view to a world point', () => {
    const iso = createIsoCamera(16 / 9);
    iso.focus(12, -8);
    const g = iso.screenToGround(640, 360);
    expect(g.x).toBeCloseTo(12, 4);
    expect(g.z).toBeCloseTo(-8, 4);
  });

  it('pans on the ground plane relative to the screen', () => {
    const iso = createIsoCamera(16 / 9);
    iso.focus(0, 0);
    iso.pan(10, 0); // screen-right at 45° yaw → (+x, -z)
    const g = iso.screenToGround(640, 360);
    expect(g.x).toBeCloseTo(10 * Math.cos(Math.PI / 4), 4);
    expect(g.z).toBeCloseTo(-10 * Math.sin(Math.PI / 4), 4);
  });

  it('rotates in smooth 90° steps', () => {
    const iso = createIsoCamera(1);
    // Initial yaw 45°: camera sits on the +x/+z diagonal.
    expect(iso.camera.position.x).toBeCloseTo(iso.camera.position.z, 4);
    iso.rotate(Math.PI / 2);
    for (let i = 0; i < 600; i++) iso.update(1 / 60);
    // Settled yaw 135°: camera sits on the +x/-z diagonal.
    expect(iso.camera.position.x).toBeCloseTo(-iso.camera.position.z, 2);
    expect(iso.camera.position.x).toBeGreaterThan(0);
  });

  it('pans and rotates from the keyboard state passed to update()', () => {
    const iso = createIsoCamera(16 / 9);
    iso.focus(0, 0);
    iso.update(0.5, new Set(['w']));
    const g = iso.screenToGround(640, 360);
    // Forward (up-screen) at 45° yaw moves toward (-x, -z).
    expect(g.x).toBeLessThan(0);
    expect(g.z).toBeLessThan(0);

    // Q is edge-triggered: holding it rotates exactly one 90° step.
    iso.focus(0, 0);
    const held = new Set(['q']);
    for (let i = 0; i < 600; i++) iso.update(1 / 60, held);
    expect(iso.camera.position.x).toBeCloseTo(-iso.camera.position.z, 2);
  });
});

describe('core/input', () => {
  function makeDom() {
    const listeners = new Map();
    return {
      addEventListener(type, cb) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(cb);
      },
      removeEventListener(type, cb) {
        listeners.get(type)?.delete(cb);
      },
      dispatch(type, event) {
        for (const cb of listeners.get(type) ?? []) cb(event);
      },
    };
  }

  // 10 px per world unit, shifted so tile math is easy to follow:
  // tileX = floor((x + 64) / 2) = floor(clientX / 20).
  const fakeIsoCamera = {
    screenToGround: (cx, cy) => ({ x: cx / 10 - 64, z: cy / 10 - 64 }),
  };

  it('exposes keys/mouse/ground and emits hover on tile change', () => {
    const dom = makeDom();
    const input = createInput(dom, fakeIsoCamera);
    const hovers = [];
    input.on('hover', (p) => hovers.push(p));

    dom.dispatch('mousemove', { clientX: 100, clientY: 100 });
    expect(input.mouse).toEqual({ x: 100, y: 100 });
    expect(input.ground).toEqual({ x: -54, z: -54 });
    expect(hovers).toHaveLength(1);
    expect(hovers[0]).toMatchObject({ tileX: 5, tileZ: 5, inBounds: true });

    dom.dispatch('mousemove', { clientX: 119, clientY: 100 }); // same tile
    expect(hovers).toHaveLength(1);

    dom.dispatch('mousemove', { clientX: 120, clientY: 100 }); // next tile
    expect(hovers).toHaveLength(2);
    expect(hovers[1].tileX).toBe(6);
    input.destroy();
  });

  it('emits click and rightclick with the ground payload', () => {
    const dom = makeDom();
    const input = createInput(dom, fakeIsoCamera);
    const clicks = [];
    const rights = [];
    input.on('click', (p) => clicks.push(p));
    input.on('rightclick', (p) => rights.push(p));

    dom.dispatch('click', { clientX: 100, clientY: 100, button: 0 });
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ x: -54, z: -54, tileX: 5 });

    let prevented = false;
    dom.dispatch('contextmenu', {
      clientX: 100,
      clientY: 100,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(rights).toHaveLength(1);
    input.destroy();
  });

  it('tracks keys, emits keydown/keyup and clears keys on blur', () => {
    const dom = makeDom();
    const input = createInput(dom, fakeIsoCamera);
    const downs = [];
    input.on('keydown', (k) => downs.push(k));

    window.dispatch('keydown', { key: 'W', preventDefault() {} });
    expect(input.keys.has('w')).toBe(true);
    expect(downs).toEqual(['w']);

    window.dispatch('keyup', { key: 'w', preventDefault() {} });
    expect(input.keys.has('w')).toBe(false);

    window.dispatch('keydown', { key: 'q', preventDefault() {} });
    window.dispatch('blur', {});
    expect(input.keys.size).toBe(0);
    input.destroy();
  });

  it('stops emitting after destroy()', () => {
    const dom = makeDom();
    const input = createInput(dom, fakeIsoCamera);
    const hovers = [];
    input.on('hover', (p) => hovers.push(p));
    input.destroy();

    dom.dispatch('mousemove', { clientX: 100, clientY: 100 });
    window.dispatch('keydown', { key: 'w', preventDefault() {} });
    expect(hovers).toHaveLength(0);
    expect(input.keys.size).toBe(0);
  });
});

describe('core/daynight', () => {
  it('sets up fog, background, sun and hemisphere lights on the scene', () => {
    const scene = new THREE.Scene();
    const dn = createDayNight(scene);
    expect(scene.fog.isFogExp2).toBe(true);
    expect(scene.background.isColor).toBe(true);
    expect(dn.sunLight.isDirectionalLight).toBe(true);
    expect(dn.sunLight.castShadow).toBe(true);
    expect(dn.sunLight.shadow.mapSize.x).toBe(2048);
    expect(dn.sunLight.shadow.camera.right).toBe(70);
    expect(dn.hemiLight.isHemisphereLight).toBe(true);
  });

  it('interpolates between day and night keyframes', () => {
    const scene = new THREE.Scene();
    const dn = createDayNight(scene);

    dn.update('day', 0.5);
    const dayIntensity = dn.sunLight.intensity;
    const dayFog = scene.fog.density;

    dn.update('night', 0.5);
    const nightIntensity = dn.sunLight.intensity;
    const nightFog = scene.fog.density;

    expect(dayIntensity).toBeGreaterThan(nightIntensity);
    expect(nightFog).toBeGreaterThan(dayFog);

    dn.update('dawn', 0.5); // halfway night → day
    expect(dn.sunLight.intensity).toBeLessThan(dayIntensity);
    expect(dn.sunLight.intensity).toBeGreaterThan(nightIntensity);

    dn.update('dusk', 0); // dusk start = full day
    expect(dn.sunLight.intensity).toBeCloseTo(dayIntensity, 5);
  });

  it('keeps the sun high by day and the moon low by night', () => {
    const scene = new THREE.Scene();
    const dn = createDayNight(scene);
    dn.update('day', 0.5);
    expect(dn.sunLight.position.y).toBeGreaterThan(100);
    dn.update('night', 0.5);
    expect(dn.sunLight.position.y).toBeGreaterThan(0);
    expect(dn.sunLight.position.y).toBeLessThan(60);
  });

  it('ends the night on the near-black background color', () => {
    const scene = new THREE.Scene();
    const dn = createDayNight(scene);
    dn.update('night', 1);
    expect(scene.background.getHexString()).toBe('05070d');
  });
});
