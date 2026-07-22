// Research panel: overlay listing the full tech tree. Each card shows the
// tech state (✓ researched / 🔬 available / 🔒 unaffordable), its cost and
// its unlocks/bonuses in Italian; clicking an available tech fires
// onResearch(id). No DOM access at import time: every element is built
// inside createResearchPanel().

import { TECHS, canResearch } from '../sim/research.js';
import { BUILDING_DEFS } from '../buildings/definitions.js';

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Formats an effect multiplier as a signed percentage: 1.25 -> '+25%',
// 0.7 -> '−30%'.
function pct(value) {
  const p = Math.round((value - 1) * 100);
  return p >= 0 ? `+${p}%` : `−${Math.abs(p)}%`;
}

const EFFECT_LABELS = {
  extractProd: (v) => `Produzione estrattori ${pct(v)}`,
  hungerRate: (v) => `Fame ${pct(v)}`,
  thirstRate: (v) => `Sete ${pct(v)}`,
  towerDamage: (v) => `Danno delle torri ${pct(v)}`,
  towerRangeMul: (v) => `Portata delle torri ${pct(v)}`,
};

// Italian effect lines for a tech: unlocked building names plus bonus list.
function effectLines(tech) {
  const lines = [];
  for (const buildingId of tech.unlocks ?? []) {
    lines.push(`Sblocca: ${BUILDING_DEFS[buildingId]?.name ?? buildingId}`);
  }
  for (const [key, value] of Object.entries(tech.effects ?? {})) {
    lines.push(EFFECT_LABELS[key] ? EFFECT_LABELS[key](value) : `${key} ${pct(value)}`);
  }
  return lines;
}

/**
 * Creates the research panel inside `root` (the #ui overlay div).
 *
 * @param {HTMLElement} root
 * @param {object} [handlers]
 * @param {(techId: string) => void} [handlers.onResearch] fired when an
 *   available tech card is clicked
 * @returns {{
 *   update: (state: object) => void,
 *   toggle: () => void,
 *   isOpen: () => boolean,
 *   open: () => void,
 *   close: () => void,
 *   el: HTMLElement,
 * }}
 */
export function createResearchPanel(root, { onResearch } = {}) {
  let visible = false;
  let lastState = null;
  const cards = new Map(); // techId -> { card, iconEl, costEl }

  const rootEl = h('div', 'research-panel');

  const head = h('div', 'research-head');
  head.appendChild(h('span', 'research-title', '🔬 Ricerca'));
  const pointsEl = h('span', 'research-points');
  head.appendChild(pointsEl);
  const closeBtn = h('button', 'research-close', '✖');
  closeBtn.type = 'button';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', close);
  head.appendChild(closeBtn);

  const list = h('div', 'research-list');

  // Cards are static (TECHS never changes), only their state is refreshed.
  for (const [id, tech] of Object.entries(TECHS)) {
    const card = h('div', 'research-tech');
    const iconEl = h('span', 'research-tech-icon');
    const body = h('div', 'research-tech-body');
    body.appendChild(h('span', 'research-tech-name', tech.name));
    body.appendChild(h('span', 'research-tech-desc', tech.desc));
    for (const line of effectLines(tech)) {
      body.appendChild(h('span', 'research-tech-effect', line));
    }
    const costEl = h('span', 'research-tech-cost');
    card.append(iconEl, body, costEl);
    card.addEventListener('click', () => {
      if (lastState && canResearch(lastState, id)) onResearch?.(id);
    });
    cards.set(id, { card, iconEl, costEl });
    list.appendChild(card);
  }

  rootEl.append(head, list);
  root.appendChild(rootEl);

  /** Re-evaluates every tech card against the current game state. */
  function update(state) {
    lastState = state;
    pointsEl.textContent = `🔬 ${Math.floor(state?.researchPoints ?? 0)}`;
    for (const [id, tech] of Object.entries(TECHS)) {
      const { card, iconEl, costEl } = cards.get(id);
      const done = state?.researched?.includes(id) ?? false;
      const available = state ? canResearch(state, id) : false;
      card.classList.toggle('research-tech--done', done);
      card.classList.toggle('research-tech--available', !done && available);
      card.classList.toggle('research-tech--locked', !done && !available);
      iconEl.textContent = done ? '✓' : available ? '🔬' : '🔒';
      costEl.textContent = done ? 'Completata' : `🔬 ${tech.cost}`;
    }
  }

  function open() {
    visible = true;
    rootEl.classList.add('open');
  }

  function close() {
    visible = false;
    rootEl.classList.remove('open');
  }

  function toggle() {
    if (visible) close();
    else open();
  }

  function isOpen() {
    return visible;
  }

  return { update, toggle, isOpen, open, close, el: rootEl };
}
