// Boot flow: reads the URL params (?seed=N / #N, ?new=1, ?autostart=1),
// creates the engine and the screens, loads the GLB assets behind the title
// screen, then hands everything to startGame. main.js is the thin entry that
// imports boot() and calls it with its startGame. Nothing runs at import
// time here, so the module stays importable outside the browser.

import { createEngine } from './core/engine.js';
import { loadAll } from './assets/loader.js';
import { createScreens } from './ui/screens.js';
import { readRecord } from './persistence.js';

// Seed from ?seed=N or #N, or null when a random one should be rolled.
export function parseSeed(params) {
  const raw =
    params.get('seed') ??
    (window.location.hash ? window.location.hash.slice(1) : null);
  if (raw === null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

// Small centered status line used while assets load (and for load errors).
export function showMessage(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#cfd8e3;font:16px/1.4 system-ui,sans-serif;pointer-events:none;z-index:200;';
  document.body.appendChild(el);
  return el;
}

export function boot({ startGame }) {
  const params = new URLSearchParams(window.location.search);
  const engine = createEngine(document.getElementById('game'));
  const screens = createScreens(document.getElementById('ui'));

  const assetsPromise = loadAll();

  const begin = () => {
    const loading = showMessage('Loading assets…');
    assetsPromise
      .then((assets) => {
        loading.remove();
        startGame({ engine, screens, assets, params });
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
