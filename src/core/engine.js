import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPixelatedPass } from 'three/addons/postprocessing/RenderPixelatedPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Lato del "pixel" dell'effetto pixel-art, in pixel schermo (a pixelRatio 1).
// Da tarare a vista: valori più alti = blocchi più grossi e scena più leggibile.
export const PIXEL_SIZE = 4;

/**
 * Core renderer/scene wrapper.
 *
 * No side effects at import time: everything happens inside createEngine().
 *
 * Usage:
 *   const engine = createEngine(document.getElementById('game'));
 *   engine.setCamera(isoCamera.camera);
 *   // per frame: engine.render(dt);
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{
 *   renderer: THREE.WebGLRenderer,
 *   scene: THREE.Scene,
 *   camera: THREE.Camera,
 *   render: (dt: number) => void,
 *   onResize: () => void,
 *   setCamera: (cam: THREE.Camera) => void,
 * }}
 */
export function createEngine(canvas) {
  // antialias disattivo: sfocerebbe i bordi dei "pixel" dell'effetto pixel-art.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();

  // Placeholder camera, replaced via setCamera() once the real one exists.
  let camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  camera.position.set(20, 20, 20);
  camera.lookAt(0, 0, 0);

  // Pipeline di post-processing: RenderPixelatedPass renderizza la scena in un
  // target a bassa risoluzione e la riporta a schermo intero con campionamento
  // nearest (effetto pixel-art); OutputPass applica tone mapping e spazio colore
  // come avveniva prima sul canvas. Nessun RenderPass separato: il pass
  // pixelato renderizza già la scena, un RenderPass sarebbe un doppio render.
  // Il composer eredita il pixelRatio del renderer (quello pieno del device):
  // la pixelazione dipende solo da PIXEL_SIZE, non dal pixelRatio.
  const composer = new EffectComposer(renderer);
  const pixelatedPass = new RenderPixelatedPass(PIXEL_SIZE, scene, camera);
  composer.addPass(pixelatedPass);
  composer.addPass(new OutputPass());

  function setCamera(cam) {
    camera = cam;
    // Il pass tiene un proprio riferimento alla camera: va riallineato.
    pixelatedPass.camera = cam;
  }

  function render(dt) {
    composer.render();
  }

  function onResize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    // Orthographic cameras (e.g. the iso camera) manage their own frustum
    // on resize; only the perspective placeholder needs an aspect update.
    if (camera.isPerspectiveCamera) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
  }

  window.addEventListener('resize', onResize);

  return {
    renderer,
    scene,
    // Live getter so `engine.camera` stays current after setCamera().
    get camera() {
      return camera;
    },
    render,
    onResize,
    setCamera,
  };
}
