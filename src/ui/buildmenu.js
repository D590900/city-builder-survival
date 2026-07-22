// Bottom build bar: a category tab row (from CATEGORIES) plus one button per
// buildable definition of the active category, with icon, name,
// multi-resource cost and a rich hover tooltip, plus Demolish / Cancel side
// buttons (always visible, regardless of the active tab). Tech-locked
// buildings get a 🔒 badge, are greyed out and ignore clicks until the
// required research is done. Tooltips are positioned in JS (fixed
// coordinates, clamped to the viewport, flipped below the button when there
// is no room above). No DOM access at import time — everything is built
// inside createBuildMenu().

import { BUILDING_DEFS, BUILD_MENU_ORDER, CATEGORIES } from '../buildings/definitions.js';
import { canAfford } from '../sim/economy.js';
import { isUnlocked, TECHS } from '../sim/research.js';
import { TILE_YIELDS } from '../sim/extraction.js';

// Exported so sibling panels (laborpanel.js) can reuse the same icons.
export const ICONS = {
  tent: '⛺',
  shack: '🛖',
  house: '🏠',
  farm: '🌾',
  garden: '🥕',
  greenhouse: '🌿',
  rain: '💧',
  well: '🪣',
  cistern: '🛢️',
  hunt: '🏹',
  fish: '🎣',
  ranch: '🐄',
  lumber: '🪓',
  forester: '🌱',
  scavenger: '♻️',
  mine: '⛏️',
  smelter: '🏭',
  distillery: '🛢️',
  garage: '🚗',
  warehouse: '📦',
  lab: '🔬',
  clinic: '🏥',
  radio: '📻',
  road: '🛣️',
  solar: '☀️',
  'solar-plant': '🔆',
  wind: '🌬️',
  generator: '⛽',
  battery: '🔋',
  palisade: '🚧',
  'scrap-wall': '🔩',
  'brick-wall': '🧱',
  'concrete-wall': '🪨',
  tower: '🗼',
  sniper: '🎯',
  spotlight: '🔦',
  streetlamp: '💡',
  motor: '🔌',
  trap: '🪤',
};

// Active build-menu tab. Module-level so the choice survives a menu rebuild
// (new game); defaults to the first category.
let activeCategoryId = CATEGORIES[0]?.id ?? 'abitazioni';

const RESOURCE_ICONS = {
  food: '🥫',
  water: '💧',
  wood: '🪵',
  metal: '⚙️',
  energy: '⚡',
  fuel: '⛽',
  research: '🔬',
};

const icon = (resource) => RESOURCE_ICONS[resource] ?? resource;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Multi-resource cost line: '🪵20 ⚙️10' (or 'Gratis' when free).
function formatCost(def) {
  const parts = Object.entries(def.cost ?? {}).map(
    ([resource, amount]) => `${icon(resource)}${amount}`
  );
  return parts.length > 0 ? parts.join(' ') : 'Gratis';
}

// Name of the tech that unlocks the given building id, or null when the
// building is not tech-gated.
function techNameFor(defId) {
  for (const tech of Object.values(TECHS)) {
    if (tech.unlocks?.includes(defId)) return tech.name;
  }
  const req = BUILDING_DEFS[defId]?.requiresTech;
  return req ? (TECHS[req]?.name ?? req) : null;
}

// capBonus tooltip lines, grouped by bonus amount so a warehouse reads
// 'Accumulo: +100 🥫🪵⚙️ capacità' instead of three separate lines.
function capBonusLines(def) {
  const groups = new Map(); // amount -> [resource icons]
  for (const [resource, bonus] of Object.entries(def.capBonus ?? {})) {
    const group = groups.get(bonus) ?? [];
    group.push(icon(resource));
    groups.set(bonus, group);
  }
  return [...groups.entries()].map(
    ([bonus, icons]) => `Accumulo: +${bonus} ${icons.join('')} capacità`
  );
}

// Hover tooltip: description plus the stats relevant to the building type
// (production, fuel, extraction, research, storage, jobs, beds, tower/trap
// damage). The trailing lock line is shown only while the building is
// tech-locked; buildTooltip returns it so refresh() can toggle it.
function buildTooltip(def) {
  const tip = h('span', 'build-tooltip');
  tip.appendChild(h('span', 'build-tooltip-desc', def.desc));
  const stats = [];
  for (const [resource, amount] of Object.entries(def.produces ?? {})) {
    const suffix = resource === 'energy' && def.energyDayOnly ? ' (solo di giorno)' : '';
    stats.push(`Produce: ${icon(resource)} ${amount}/giorno${suffix}`);
  }
  for (const [resource, amount] of Object.entries(def.consumes ?? {})) {
    stats.push(`Consuma: ${icon(resource)} ${amount}/giorno`);
  }
  if (def.extracts) {
    stats.push(`Estrae: ${icon(TILE_YIELDS[def.extracts]?.resource)} ${def.extractRate}/giorno`);
  }
  if (def.researchRate) stats.push(`Ricerca: 🔬 ${def.researchRate}/giorno`);
  stats.push(...capBonusLines(def));
  if (def.requiresEnergy) stats.push(`Richiede: ⚡ ${def.requiresEnergy}/giorno`);
  if (def.jobs) stats.push(`Lavoratori: ${def.jobs}`);
  if (def.houses) stats.push(`Posti letto: ${def.houses}`);
  if (def.isTower) stats.push(`Danno: ${def.damage} · Portata: ${def.range}`);
  if (def.isTrap) stats.push(`Danno trappola: ${def.trapDamage} al passaggio`);
  for (const line of stats) {
    tip.appendChild(h('span', 'build-tooltip-stat', line));
  }
  const lockTip = h('span', 'build-tooltip-stat build-tooltip-lock');
  lockTip.style.display = 'none';
  tip.appendChild(lockTip);
  return { tip, lockTip };
}

/**
 * Creates the build menu inside `root` (the #ui overlay div).
 *
 * @param {HTMLElement} root
 * @param {object} handlers
 * @param {(defId: string) => void} [handlers.onSelect] building button clicked
 * @param {() => void} [handlers.onDemolish] demolish button clicked
 * @param {() => void} [handlers.onCancel] cancel button clicked
 * @returns {{
 *   update: (state: object) => void,
 *   setMode: (mode: string, defId?: string | null) => void,
 *   el: HTMLElement,
 * }}
 * Modes: 'idle' (nothing highlighted), 'build' (defId highlighted),
 * 'demolish' (demolish button highlighted).
 */
export function createBuildMenu(root, { onSelect, onDemolish, onCancel } = {}) {
  let mode = 'idle';
  let activeDefId = null;
  let lastState = null;
  let openTip = null; // tooltip element currently shown, if any

  const rootEl = h('div', 'build-menu');

  // --- category tabs ---------------------------------------------------------
  const tabs = h('div', 'build-tabs');
  const tabBtns = new Map(); // category id -> button

  // --- building buttons ------------------------------------------------------
  const body = h('div', 'build-body');
  const list = h('div', 'build-list');
  const buttons = new Map(); // defId -> { btn, lockTip }

  function hideTooltip() {
    if (openTip) {
      openTip.style.display = 'none';
      openTip = null;
    }
  }

  // Fixed-position tooltip: horizontally centered on the button and clamped
  // to [8px, vw - width - 8px]; shown below the button when the space above
  // is too small. The tooltip is measured while visibility:hidden so it never
  // flashes at the wrong spot.
  function showTooltip(btn, tip) {
    hideTooltip();
    tip.style.visibility = 'hidden';
    tip.style.display = 'flex';
    const rect = btn.getBoundingClientRect();
    const tipWidth = tip.offsetWidth;
    const tipHeight = tip.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth;
    let left = rect.left + rect.width / 2 - tipWidth / 2;
    left = Math.max(8, Math.min(left, viewportWidth - tipWidth - 8));
    const top =
      rect.top >= tipHeight + 12 ? rect.top - tipHeight - 8 : rect.bottom + 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.visibility = '';
    openTip = tip;
  }

  for (const defId of BUILD_MENU_ORDER) {
    const def = BUILDING_DEFS[defId];
    const { tip, lockTip } = buildTooltip(def);
    const btn = h('button', 'build-btn');
    btn.type = 'button';
    btn.append(
      h('span', 'build-btn-icon', ICONS[defId] ?? '🏗'),
      h('span', 'build-btn-name', def.name),
      h('span', 'build-btn-cost', formatCost(def)),
      tip,
      h('span', 'build-btn-lock', '🔒')
    );
    btn.addEventListener('mouseenter', () => showTooltip(btn, tip));
    btn.addEventListener('mouseleave', hideTooltip);
    btn.addEventListener('click', () => {
      hideTooltip();
      if (btn.classList.contains('disabled')) return;
      onSelect?.(defId);
    });
    buttons.set(defId, { btn, lockTip });
    list.appendChild(btn);
  }

  // Any scroll (page or panel) invalidates the fixed coordinates.
  window.addEventListener('scroll', hideTooltip, true);

  // Shows only the active category's buttons; every tab stays visible even
  // when all its buildings are still locked.
  function refreshTabs() {
    for (const [catId, tab] of tabBtns) {
      tab.classList.toggle('active', catId === activeCategoryId);
    }
    for (const [defId, { btn }] of buttons) {
      btn.style.display = BUILDING_DEFS[defId].category === activeCategoryId ? '' : 'none';
    }
  }

  for (const cat of CATEGORIES) {
    const tab = h('button', 'build-tab', `${cat.icon} ${cat.name}`);
    tab.type = 'button';
    tab.title = cat.name;
    tab.addEventListener('click', () => {
      if (activeCategoryId === cat.id) return;
      activeCategoryId = cat.id;
      hideTooltip();
      refreshTabs();
    });
    tabBtns.set(cat.id, tab);
    tabs.appendChild(tab);
  }

  const side = h('div', 'build-side');
  const demolishBtn = h('button', 'build-btn build-btn--side');
  demolishBtn.type = 'button';
  demolishBtn.title = 'Demolisci un edificio';
  demolishBtn.append(
    h('span', 'build-btn-icon', '🔨'),
    h('span', 'build-btn-name', 'Demolisci')
  );
  demolishBtn.addEventListener('click', () => onDemolish?.());

  const cancelBtn = h('button', 'build-btn build-btn--side');
  cancelBtn.type = 'button';
  cancelBtn.title = 'Annulla (ESC)';
  cancelBtn.append(
    h('span', 'build-btn-icon', '✖'),
    h('span', 'build-btn-name', 'Annulla')
  );
  cancelBtn.addEventListener('click', () => onCancel?.());
  side.append(demolishBtn, cancelBtn);

  body.append(list, side);
  rootEl.append(tabs, body);
  root.appendChild(rootEl);

  // Recomputes disabled (affordability/tech lock) and active (mode)
  // highlighting.
  function refresh() {
    for (const [defId, { btn, lockTip }] of buttons) {
      const def = BUILDING_DEFS[defId];
      const affordable = lastState ? canAfford(lastState, def) : true;
      const locked = lastState ? !isUnlocked(lastState, def) : false;
      const enabled = affordable && !locked;
      // Class-based disabling (not the disabled attribute) keeps the hover
      // tooltip working on unavailable buildings.
      btn.classList.toggle('disabled', !enabled);
      btn.classList.toggle('locked', locked);
      btn.setAttribute('aria-disabled', String(!enabled));
      btn.classList.toggle('active', mode === 'build' && defId === activeDefId);
      lockTip.style.display = locked ? '' : 'none';
      if (locked) {
        lockTip.textContent = `🔒 Richiede ricerca: ${techNameFor(defId) ?? 'sconosciuta'}`;
      }
    }
    demolishBtn.classList.toggle('active', mode === 'demolish');
  }

  /** Re-evaluates affordability and tech locks against the current state. */
  function update(state) {
    lastState = state;
    refresh();
  }

  /**
   * Sets the interaction mode and highlights the relevant button.
   * @param {string} nextMode 'idle' | 'build' | 'demolish'
   * @param {string | null} [defId] building being placed when mode is 'build'
   */
  function setMode(nextMode, defId = null) {
    mode = nextMode;
    activeDefId = defId;
    refresh();
  }

  refreshTabs();
  refresh();

  return { update, setMode, el: rootEl };
}
