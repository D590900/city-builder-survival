import * as THREE from 'three';

// Classic isometric elevation: atan(1 / sqrt(2)) ≈ 35.26°.
const ELEVATION = Math.atan(1 / Math.SQRT2);
const INITIAL_YAW = Math.PI / 4; // 45°
const MIN_VIEW_SIZE = 15; // ortho frustum half-height, fully zoomed in
const MAX_VIEW_SIZE = 80; // ... fully zoomed out
const DEFAULT_VIEW_SIZE = 40;
const CAMERA_DISTANCE = 200;
const ROTATE_STEP = Math.PI / 2; // rotation snaps to 90° steps
const ROTATE_DAMPING = 8; // higher = snappier yaw interpolation
const PAN_SPEED = 1.4; // frustum half-heights per second while key-panning

/**
 * Isometric orthographic camera.
 *
 * No side effects at import time: everything happens inside createIsoCamera().
 *
 * @param {number} aspect viewport width / height
 * @returns {{
 *   camera: THREE.OrthographicCamera,
 *   update: (dt: number, keys?: Set<string>) => void,
 *   pan: (dx: number, dz: number) => void,
 *   zoom: (delta: number) => void,
 *   rotate: (deltaAngle: number) => void,
 *   screenToGround: (clientX: number, clientY: number) => ({x: number, z: number} | null),
 *   focus: (wx: number, wz: number) => void,
 * }}
 */
export function createIsoCamera(aspect = 1) {
  let aspectRatio = aspect;
  let viewSize = DEFAULT_VIEW_SIZE;
  let yaw = INITIAL_YAW; // interpolated (visual) yaw
  let targetYaw = INITIAL_YAW; // snapped goal yaw (always a multiple of 90°)
  const target = new THREE.Vector3(0, 0, 0); // look-at point on the ground

  const camera = new THREE.OrthographicCamera(
    -viewSize * aspectRatio,
    viewSize * aspectRatio,
    viewSize,
    -viewSize,
    0.1,
    1000,
  );

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();

  // Edge-trigger state for Q/E rotation from keyboard.
  let prevQ = false;
  let prevE = false;

  function applyFrustum() {
    camera.left = -viewSize * aspectRatio;
    camera.right = viewSize * aspectRatio;
    camera.top = viewSize;
    camera.bottom = -viewSize;
    camera.updateProjectionMatrix();
  }

  function applyTransform() {
    const cosEl = Math.cos(ELEVATION);
    camera.position.set(
      target.x + Math.sin(yaw) * cosEl * CAMERA_DISTANCE,
      target.y + Math.sin(ELEVATION) * CAMERA_DISTANCE,
      target.z + Math.cos(yaw) * cosEl * CAMERA_DISTANCE,
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }

  /**
   * Pan on the XZ ground plane. dx/dz are screen-relative: +dx moves the view
   * right, +dz moves it up-screen; the vector is rotated by the current yaw.
   */
  function pan(dx, dz) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    target.x += dx * cos - dz * sin;
    target.z += -dx * sin - dz * cos;
    applyTransform();
  }

  /**
   * Zoom by changing the frustum half-size: +delta zooms out, -delta zooms
   * in. Clamped to [15, 80]. Callers scale raw input themselves
   * (e.g. wheel deltaY * 0.02).
   */
  function zoom(delta) {
    viewSize = Math.min(MAX_VIEW_SIZE, Math.max(MIN_VIEW_SIZE, viewSize + delta));
    applyFrustum();
  }

  /**
   * Queue a rotation: deltaAngle is quantized to whole 90° steps and added
   * to the goal yaw, so the view always settles on an isometric diagonal
   * (initial 45° ± n·90°). Call with ±Math.PI/2 for one step. The visual
   * yaw is smoothly interpolated toward the goal in update().
   */
  function rotate(deltaAngle) {
    const steps = Math.round(deltaAngle / ROTATE_STEP);
    targetYaw += steps * ROTATE_STEP;
  }

  /**
   * Raycast client (mouse) coordinates onto the ground plane y = 0.
   * The #game canvas is fullscreen, so window.innerWidth/innerHeight match
   * the canvas size and are used for NDC conversion.
   *
   * @returns {{x: number, z: number} | null} world point, or null if the ray
   *          misses the plane.
   */
  function screenToGround(clientX, clientY) {
    ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const point = raycaster.ray.intersectPlane(groundPlane, hit);
    return point ? { x: point.x, z: point.z } : null;
  }

  /** Jump the view instantly to a world ground point. */
  function focus(wx, wz) {
    target.set(wx, 0, wz);
    applyTransform();
  }

  /**
   * Advance the camera (yaw interpolation) and optionally drive it from a
   * keyboard state.
   *
   * @param {number} dt seconds since last frame
   * @param {Set<string>} [keys] optional set of lowercased key names (e.g.
   *   input.keys from core/input.js): WASD/arrows pan (speed scales with
   *   zoom), Q/E rotate one 90° step per press (edge-triggered).
   */
  function update(dt, keys) {
    if (keys) {
      let dx = 0;
      let dz = 0;
      if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
      if (keys.has('d') || keys.has('arrowright')) dx += 1;
      if (keys.has('w') || keys.has('arrowup')) dz += 1;
      if (keys.has('s') || keys.has('arrowdown')) dz -= 1;
      if (dx !== 0 || dz !== 0) {
        const len = Math.hypot(dx, dz);
        const speed = viewSize * PAN_SPEED * dt;
        pan((dx / len) * speed, (dz / len) * speed);
      }

      const q = keys.has('q');
      const e = keys.has('e');
      if (q && !prevQ) rotate(ROTATE_STEP);
      if (e && !prevE) rotate(-ROTATE_STEP);
      prevQ = q;
      prevE = e;
    }

    // Smoothly interpolate the visual yaw toward the snapped goal yaw.
    const blend = 1 - Math.exp(-ROTATE_DAMPING * dt);
    yaw += (targetYaw - yaw) * blend;
    if (Math.abs(targetYaw - yaw) < 1e-4) yaw = targetYaw;
    applyTransform();
  }

  function handleResize() {
    aspectRatio = window.innerWidth / window.innerHeight;
    applyFrustum();
  }

  applyFrustum();
  applyTransform();

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', handleResize);
  }

  return { camera, update, pan, zoom, rotate, screenToGround, focus };
}
