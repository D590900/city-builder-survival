// World grid: 64x64 tiles of 2 world units, centered on the origin
// (world extent: -64 .. +64 on both axes).
const TILE_SIZE = 2;
const GRID_TILES = 64;
const HALF_WORLD = (GRID_TILES * TILE_SIZE) / 2;

/**
 * Pointer/keyboard state plus a tiny event bus for the game.
 *
 * No side effects at import time: listeners are attached inside createInput().
 *
 * Events (callback arguments):
 *   'hover'      (payload)          - fired when the hovered ground tile
 *                                     changes; payload is null off the plane
 *   'click'      (payload, event)   - left mouse button
 *   'rightclick' (payload, event)   - contextmenu (preventDefault()ed)
 *   'dragstart'  (payload)          - left button dragged past a few screen
 *                                     pixels; payload is the drag-start tile
 *   'dragmove'   (payload, startPayload, event)
 *   'dragend'    (payload, startPayload, event)
 *   'keydown'    (key, event)       - key is e.key.toLowerCase(); repeats
 *   'keyup'      (key, event)         included (check event.repeat)
 *
 * The 'click' that would normally follow a real drag is suppressed, so a
 * drag never also places/selects.
 *
 * payload = { x, z, tileX, tileZ, inBounds } | null
 *   x/z: world point on the ground plane; tileX/tileZ: grid indices (may be
 *   outside 0..63 when hovering beyond the map); inBounds: tile is on the map.
 *
 * @param {HTMLElement} dom element receiving pointer events (the #game canvas)
 * @param {{screenToGround: (x: number, y: number) => ({x: number, z: number} | null)}} isoCamera
 * @returns {{
 *   keys: Set<string>,
 *   mouse: {x: number, y: number},
 *   ground: {x: number, z: number} | null,
 *   on: (event: string, cb: Function) => () => void,
 *   destroy: () => void,
 * }}
 */
export function createInput(dom, isoCamera) {
  // Lowercased key names currently held down (WASD/arrows/QE feed
  // isoCamera.update(dt, keys)).
  const keys = new Set();
  const mouse = { x: 0, y: 0 };
  let ground = null;
  let lastTile = null;

  const subscribers = new Map();

  // Left-button drag state: a press becomes a drag only after
  // DRAG_THRESHOLD_PX screen pixels, so plain clicks are untouched.
  const DRAG_THRESHOLD_PX = 6;
  let mouseDown = false; // left button currently held (pressed on the canvas)
  let dragging = false; // threshold crossed: this press is a drag
  let downPos = { x: 0, y: 0 };
  let downPayload = null;
  let suppressClick = false; // swallow the click fired right after a drag

  /** Subscribe to an event; returns an unsubscribe function. */
  function on(event, cb) {
    if (!subscribers.has(event)) subscribers.set(event, new Set());
    subscribers.get(event).add(cb);
    return () => subscribers.get(event)?.delete(cb);
  }

  function emit(event, ...args) {
    const subs = subscribers.get(event);
    if (!subs) return;
    for (const cb of subs) cb(...args);
  }

  function groundToTile(g) {
    return {
      tileX: Math.floor((g.x + HALF_WORLD) / TILE_SIZE),
      tileZ: Math.floor((g.z + HALF_WORLD) / TILE_SIZE),
    };
  }

  function buildPayload() {
    if (!ground) return null;
    const { tileX, tileZ } = groundToTile(ground);
    return {
      x: ground.x,
      z: ground.z,
      tileX,
      tileZ,
      inBounds:
        tileX >= 0 && tileX < GRID_TILES && tileZ >= 0 && tileZ < GRID_TILES,
    };
  }

  function updateGround(clientX, clientY) {
    mouse.x = clientX;
    mouse.y = clientY;
    ground = isoCamera.screenToGround(clientX, clientY);
    const tile = ground ? groundToTile(ground) : null;
    const changed =
      tile === null
        ? lastTile !== null
        : lastTile === null ||
          tile.tileX !== lastTile.tileX ||
          tile.tileZ !== lastTile.tileZ;
    if (changed) {
      lastTile = tile;
      emit('hover', buildPayload());
    }
  }

  function handleMouseMove(e) {
    updateGround(e.clientX, e.clientY);
    if (!mouseDown) return;
    if (!(e.buttons & 1)) {
      // Button lost without a mouseup (released outside the window).
      mouseDown = false;
      dragging = false;
      return;
    }
    if (!dragging) {
      const dx = e.clientX - downPos.x;
      const dy = e.clientY - downPos.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      emit('dragstart', downPayload);
    }
    emit('dragmove', buildPayload(), downPayload, e);
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return;
    updateGround(e.clientX, e.clientY);
    mouseDown = true;
    dragging = false;
    suppressClick = false;
    downPos = { x: e.clientX, y: e.clientY };
    downPayload = buildPayload();
  }

  // On window: the button can be released anywhere, even off the canvas.
  function handleMouseUp(e) {
    if (e.button !== 0 || !mouseDown) return;
    mouseDown = false;
    if (!dragging) return;
    dragging = false;
    updateGround(e.clientX, e.clientY);
    suppressClick = true; // swallow the click that follows a real drag
    emit('dragend', buildPayload(), downPayload, e);
  }

  function handleClick(e) {
    if (e.button !== 0) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    updateGround(e.clientX, e.clientY);
    emit('click', buildPayload(), e);
  }

  function handleContextMenu(e) {
    e.preventDefault();
    updateGround(e.clientX, e.clientY);
    emit('rightclick', buildPayload(), e);
  }

  function handleKeyDown(e) {
    const key = e.key.toLowerCase();
    if (key.startsWith('arrow')) e.preventDefault(); // avoid page scroll
    keys.add(key);
    emit('keydown', key, e);
  }

  function handleKeyUp(e) {
    const key = e.key.toLowerCase();
    keys.delete(key);
    emit('keyup', key, e);
  }

  function handleBlur() {
    keys.clear();
    mouseDown = false;
    dragging = false;
  }

  dom.addEventListener('mousemove', handleMouseMove);
  dom.addEventListener('mousedown', handleMouseDown);
  dom.addEventListener('click', handleClick);
  dom.addEventListener('contextmenu', handleContextMenu);
  window.addEventListener('mouseup', handleMouseUp);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);

  /** Detach all DOM/window listeners and clear subscribers and key state. */
  function destroy() {
    dom.removeEventListener('mousemove', handleMouseMove);
    dom.removeEventListener('mousedown', handleMouseDown);
    dom.removeEventListener('click', handleClick);
    dom.removeEventListener('contextmenu', handleContextMenu);
    window.removeEventListener('mouseup', handleMouseUp);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', handleBlur);
    subscribers.clear();
    keys.clear();
  }

  return {
    keys,
    mouse,
    // Live getter: always the latest ground point under the cursor.
    get ground() {
      return ground;
    },
    on,
    destroy,
  };
}
