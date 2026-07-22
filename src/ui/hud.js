// DOM-based heads-up display: top bar with day/phase countdown, current
// weather, the resources (each shows the effective capacity and the
// per-day net; hovering one opens a production/consumption breakdown),
// population, kills, speed controls, the research and labor panel toggles,
// plus a toast area. No DOM access at import time — all elements are built
// inside createHud().

import './ui.css';
import { WEATHERS } from '../sim/weather.js';
import { BUILDING_DEFS } from '../buildings/definitions.js';
import { effectiveCaps, computeResourceBalance } from '../sim/economy.js';
import { getModifiers } from '../sim/modifiers.js';

const MAX_TOASTS = 4;
const TOAST_TTL_MS = 4000;
// The resource balance is recomputed at most this often (ms); hud.update()
// runs once per frame, far too often for a full projection.
const BALANCE_CACHE_MS = 500;

const SPEEDS = [
  { speed: 1, icon: '▶', label: 'Velocità 1x' },
  { speed: 2, icon: '⏩', label: 'Velocità 2x' },
  { speed: 3, icon: '⏭', label: 'Velocità 3x' },
];

// Resources with a daily balance readout, in display order.
const BALANCE_RESOURCES = [
  { key: 'food', icon: '🥫', label: 'Cibo' },
  { key: 'water', icon: '💧', label: 'Acqua' },
  { key: 'wood', icon: '🪵', label: 'Legno' },
  { key: 'metal', icon: '⚙️', label: 'Metallo' },
  { key: 'energy', icon: '⚡', label: 'Energia' },
  { key: 'fuel', icon: '⛽', label: 'Carburante' },
];

// One-line effect summary per weather type, shown in the HUD weather
// tooltip (mirrors the mods table in sim/weather.js).
const WEATHER_EFFECTS = {
  clear: 'nessun effetto',
  rain: 'raccoglitori ×2, fattorie e turbine ×1.25, zombie rallentati',
  storm: 'raccoglitori ×3, turbine ×2, solare ×0.5, torri −25% raggio',
  fog: 'torri −30% raggio',
  heat: 'sete ×1.5, raccoglitori ×0.25, fattorie ×0.75, solare ×1.25',
};

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const fmt = (n) => Math.floor(n ?? 0);

// Rates are projected per day and often fractional (survivor upkeep):
// one decimal when needed, plain integer otherwise.
const fmtRate = (rate) => {
  const rounded = Math.round(rate * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

// Signed per-day string: '+4/g' / '−2/g'.
const fmtNet = (net) =>
  net >= 0 ? `+${fmtRate(net)}/g` : `−${fmtRate(Math.abs(net))}/g`;

/**
 * Creates the HUD inside `root` (the #ui overlay div).
 *
 * @param {HTMLElement} root
 * @returns {{
 *   update: (state: object, defs: object, extra?: object) => void,
 *   toast: (msg: string, type?: string) => void,
 *   onSpeed: (cb: (speed: number) => void) => void,
 *   onPause: (cb: (paused: boolean) => void) => void,
 *   onResearchToggle: (cb: () => void) => void,
 *   onLaborToggle: (cb: () => void) => void,
 *   onRestart: (cb: () => void) => void,
 *   onOverlayToggle: (cb: (visible: boolean) => void) => void,
 *   el: HTMLElement,
 * }}
 * `extra` may carry: phaseTimeLeft, phaseDuration, housing (total beds),
 * idle (survivors without a job), speed and paused (echoed back to keep the
 * buttons in sync). Every resource net is derived from computeResourceBalance.
 */
export function createHud(root) {
  let currentSpeed = 1;
  let isPaused = false;
  const speedCbs = [];
  const pauseCbs = [];
  const researchCbs = [];
  const laborCbs = [];
  const restartCbs = [];
  const overlayCbs = [];
  let overlayOn = false;

  const rootEl = h('div', 'hud');

  // --- top bar: day / phase ------------------------------------------------
  const top = h('div', 'hud-top');

  const left = h('div', 'hud-section');
  const dayEl = h('span', 'hud-day');
  const phaseWrap = h('span', 'hud-phase');
  const phaseIcon = h('span', 'hud-phase-icon');
  const phaseLabel = h('span', 'hud-phase-label');
  const phaseCount = h('span', 'hud-phase-count');
  const phaseBar = h('span', 'hud-phase-bar');
  const phaseFill = h('span', 'hud-phase-fill');
  phaseBar.appendChild(phaseFill);
  phaseWrap.append(phaseIcon, phaseLabel, phaseCount, phaseBar);
  // Weather of the day, always visible: icon + name, effects in the tooltip.
  const weatherEl = h('span', 'hud-stat hud-weather');
  left.append(dayEl, phaseWrap, weatherEl);

  // --- top bar: resources ----------------------------------------------------
  // Each balance resource is a stat with a net span; hovering it opens the
  // breakdown panel below the bar (pointer-events: none, pure readout).
  let balanceCache = null;
  let balanceCacheAt = 0;
  let hoveredResource = null;

  const center = h('div', 'hud-section hud-resources');
  const resourceEls = new Map(); // key -> { el, textEl, netEl, label, icon }
  for (const { key, icon, label } of BALANCE_RESOURCES) {
    const el = h('span', 'hud-stat hud-res');
    const textEl = h('span');
    const netEl = h('span', 'hud-net');
    el.append(textEl, netEl);
    el.addEventListener('mouseenter', () => {
      hoveredResource = key;
      balancePanel.classList.add('open');
      renderBalance();
    });
    el.addEventListener('mouseleave', () => {
      hoveredResource = null;
      balancePanel.classList.remove('open');
    });
    resourceEls.set(key, { el, textEl, netEl, label, icon });
    center.appendChild(el);
  }

  const researchEl = h('span', 'hud-stat');
  researchEl.title = 'Punti ricerca';
  const survivorsEl = h('span', 'hud-stat');
  survivorsEl.title = 'Sopravvissuti (liberi) / posti letto';
  const killsEl = h('span', 'hud-stat');
  killsEl.title = 'Zombie eliminati';
  const reputationEl = h('span', 'hud-stat');
  center.append(researchEl, survivorsEl, killsEl, reputationEl);

  // --- resource balance breakdown (fixed under the top bar) -----------------
  const balancePanel = h('div', 'hud-balance');

  function currentBalance(state, defs) {
    const now = Date.now();
    if (!balanceCache || now - balanceCacheAt >= BALANCE_CACHE_MS) {
      balanceCache = computeResourceBalance(state, defs ?? BUILDING_DEFS, getModifiers(state, lastGrid));
      balanceCacheAt = now;
    }
    return balanceCache;
  }
  let lastGrid = null; // grid from update()'s extra: feeds the trail bonus

  // One breakdown column ('Produce' / 'Consuma') with signed rate rows.
  function balanceColumn(title, entries, sign) {
    const col = h('div', 'hud-balance-col');
    col.appendChild(h('span', 'hud-balance-col-title', title));
    if (entries.length === 0) {
      col.appendChild(h('span', 'hud-balance-empty', '—'));
    }
    for (const { label, rate } of entries) {
      const row = h('span', 'hud-balance-row');
      row.append(
        h('span', 'hud-balance-label', label),
        h('span', `hud-balance-rate ${sign === '+' ? 'hud-net--pos' : 'hud-net--neg'}`, `${sign}${fmtRate(rate)}/g`)
      );
      col.appendChild(row);
    }
    return col;
  }

  function renderBalance() {
    balancePanel.textContent = '';
    if (!hoveredResource || !balanceCache) return;
    const meta = resourceEls.get(hoveredResource);
    const data = balanceCache[hoveredResource];
    if (!meta || !data) return;
    balancePanel.appendChild(
      h('span', 'hud-balance-title', `${meta.icon} ${meta.label} — bilancio al giorno`)
    );
    const cols = h('div', 'hud-balance-cols');
    cols.append(
      balanceColumn('Produce', data.produced, '+'),
      balanceColumn('Consuma', data.consumed, '−')
    );
    balancePanel.appendChild(cols);
    const net = Math.round(data.net * 10) / 10;
    const netEl = h('span', `hud-balance-net ${net >= 0 ? 'hud-net--pos' : 'hud-net--neg'}`, `Netto: ${fmtNet(net)}`);
    balancePanel.appendChild(netEl);
  }

  // --- top bar: panel toggles + speed controls ------------------------------
  const right = h('div', 'hud-section hud-speed');
  const laborBtn = h('button', 'hud-btn', '👷');
  laborBtn.type = 'button';
  laborBtn.title = 'Pannello lavoratori';
  laborBtn.addEventListener('click', () => {
    for (const cb of laborCbs) cb();
  });
  right.appendChild(laborBtn);

  const researchBtn = h('button', 'hud-btn', '🔬');
  researchBtn.type = 'button';
  researchBtn.title = 'Pannello ricerca';
  researchBtn.addEventListener('click', () => {
    for (const cb of researchCbs) cb();
  });
  right.appendChild(researchBtn);

  const overlayBtn = h('button', 'hud-btn', '🔍');
  overlayBtn.type = 'button';
  overlayBtn.title = 'Resa del sito (pozzi, caccia, pesca, allevamenti)';
  overlayBtn.addEventListener('click', () => {
    overlayOn = !overlayOn;
    overlayBtn.classList.toggle('active', overlayOn);
    for (const cb of overlayCbs) cb(overlayOn);
  });
  right.appendChild(overlayBtn);

  const pauseBtn = h('button', 'hud-btn', '⏸');
  pauseBtn.type = 'button';
  pauseBtn.title = 'Pausa';
  pauseBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    refreshSpeedButtons();
    for (const cb of pauseCbs) cb(isPaused);
  });
  right.appendChild(pauseBtn);

  const restartBtn = h('button', 'hud-btn', '🔄');
  restartBtn.type = 'button';
  restartBtn.title = 'Riavvia partita';
  restartBtn.addEventListener('click', () => {
    for (const cb of restartCbs) cb();
  });
  right.appendChild(restartBtn);

  const speedBtns = new Map();
  for (const { speed, icon, label } of SPEEDS) {
    const btn = h('button', 'hud-btn', icon);
    btn.type = 'button';
    btn.title = label;
    btn.addEventListener('click', () => {
      currentSpeed = speed;
      refreshSpeedButtons();
      for (const cb of speedCbs) cb(speed);
    });
    speedBtns.set(speed, btn);
    right.appendChild(btn);
  }

  top.append(left, center, right);

  // --- toast area ------------------------------------------------------------
  const toastArea = h('div', 'toast-area');

  rootEl.append(top, balancePanel, toastArea);
  root.appendChild(rootEl);

  function refreshSpeedButtons() {
    pauseBtn.classList.toggle('active', isPaused);
    for (const [speed, btn] of speedBtns) {
      btn.classList.toggle('active', !isPaused && speed === currentSpeed);
    }
  }

  /**
   * Refreshes every HUD readout from the game state.
   * @param {object} state game state (day, phase, resources, caps, survivors,
   *   kills, researchPoints, weather, buildings)
   * @param {object} defs building definitions (capBonus sums into the
   *   effective storage caps via effectiveCaps)
   * @param {object} [extra] { phaseTimeLeft, phaseDuration, housing, idle,
   *   speed, paused, grid }
   */
  function update(state, defs, extra = {}) {
    if (extra.grid) lastGrid = extra.grid;
    dayEl.textContent = `Giorno ${state.day}`;

    const night = state.phase === 'night';
    phaseIcon.textContent = night ? '☾' : '☀';
    phaseLabel.textContent = night ? 'Notte' : 'Giorno';
    phaseWrap.classList.toggle('hud-phase--night', night);

    if (typeof extra.phaseTimeLeft === 'number') {
      phaseCount.textContent = `${Math.max(0, Math.ceil(extra.phaseTimeLeft))}s`;
    }
    if (
      typeof extra.phaseTimeLeft === 'number' &&
      typeof extra.phaseDuration === 'number' &&
      extra.phaseDuration > 0
    ) {
      const f = Math.min(1, Math.max(0, extra.phaseTimeLeft / extra.phaseDuration));
      phaseFill.style.width = `${f * 100}%`;
    }

    const res = state.resources ?? {};
    const caps = effectiveCaps(state, defs ?? BUILDING_DEFS);
    const balance = currentBalance(state, defs);
    for (const [key, { textEl, netEl, icon }] of resourceEls) {
      textEl.textContent = `${icon} ${fmt(res[key])}/${fmt(caps[key])}`;
      const net = Math.round((balance[key]?.net ?? 0) * 10) / 10;
      netEl.textContent = fmtNet(net);
      netEl.classList.toggle('hud-net--pos', net >= 0);
      netEl.classList.toggle('hud-net--neg', net < 0);
    }
    if (hoveredResource) renderBalance(); // keeps the open breakdown live

    researchEl.textContent = `🔬 ${fmt(state.researchPoints)}`;

    const survivorCount = state.survivors?.length ?? 0;
    survivorsEl.textContent =
      typeof extra.idle === 'number'
        ? `👥 ${survivorCount} (${extra.idle} liberi)/${extra.housing ?? 0}`
        : `👥 ${survivorCount}/${extra.housing ?? 0}`;
    killsEl.textContent = `💀 ${state.kills ?? 0}`;

    const reputation = Math.floor(state.reputation ?? 0);
    reputationEl.textContent = `⭐ ${reputation}`;
    reputationEl.title = `Reputazione: attira sopravvissuti (+${Math.floor(reputation / 25)} reclute a ogni alba), cresce sopravvivendo e con le Radio, cala con le morti`;

    const weatherId = state.weather?.current ?? 'clear';
    const weather = WEATHERS[weatherId] ?? WEATHERS.clear;
    weatherEl.textContent = `${weather.icon} ${weather.name}`;
    weatherEl.title = `Meteo: ${weather.name} — ${WEATHER_EFFECTS[weatherId] ?? WEATHER_EFFECTS.clear}`;

    if (typeof extra.speed === 'number') currentSpeed = extra.speed;
    if (typeof extra.paused === 'boolean') isPaused = extra.paused;
    refreshSpeedButtons();
  }

  /**
   * Shows a toast under the top bar. At most MAX_TOASTS are kept; each one
   * fades out (CSS animation) and is removed after TOAST_TTL_MS.
   * @param {string} msg
   * @param {string} [type] 'info' | 'warn' | 'error' | 'success'
   */
  function toast(msg, type = 'info') {
    const node = h('div', `toast toast--${type}`, msg);
    toastArea.appendChild(node);
    while (toastArea.children.length > MAX_TOASTS) {
      toastArea.firstElementChild.remove();
    }
    setTimeout(() => node.remove(), TOAST_TTL_MS);
  }

  /** Registers a callback fired with the chosen speed (1, 2 or 3). */
  function onSpeed(cb) {
    speedCbs.push(cb);
  }

  /** Registers a callback fired with the new paused state. */
  function onPause(cb) {
    pauseCbs.push(cb);
  }

  /** Registers a callback fired when the 🔬 research button is clicked. */
  function onResearchToggle(cb) {
    researchCbs.push(cb);
  }

  /** Registers a callback fired when the 👷 labor button is clicked. */
  function onLaborToggle(cb) {
    laborCbs.push(cb);
  }

  /** Registers a callback fired when the 🔄 restart button is clicked. */
  function onRestart(cb) {
    restartCbs.push(cb);
  }

  /** Registers a callback fired with the new 🔍 overlay visibility. */
  function onOverlayToggle(cb) {
    overlayCbs.push(cb);
  }

  refreshSpeedButtons();

  return { update, toast, onSpeed, onPause, onResearchToggle, onLaborToggle, onRestart, onOverlayToggle, el: rootEl };
}
