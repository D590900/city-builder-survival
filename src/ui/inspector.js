// Building inspector: right-side detail panel for the selected building.
// A left click on an occupied tile (while placement is idle) selects the
// owning building — any footprint cell resolves to the whole building via
// the grid's occupiedBy id. No DOM access at import time: every element is
// built inside createInspector().

import { findBuilding, isUpgradeable, upgradeBuilding, upgradeCost, MAX_LEVEL, pushEvent } from '../sim/state.js';
import { assignWorker, unassignWorker, setBuildingEnabled, idleCount } from '../sim/survivors.js';
import { countNodesInRange, TILE_YIELDS } from '../sim/extraction.js';
import { effectiveCaps, buildingDailyOutput, canAfford } from '../sim/economy.js';
import { repairCost, startRepair } from '../sim/repair.js';
import { getModifiers } from '../sim/modifiers.js';
import { garrisonGuns, GARRISON_DAMAGE, GARRISON_FIRE_INTERVAL } from '../zombies/combat.js';
import { getCell } from '../world/grid.js';

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

// Multi-resource cost line: '🪵20 ⚙️10' (same format as the build menu).
function formatCost(cost) {
  const parts = Object.entries(cost).map(
    ([resource, amount]) => `${icon(resource)}${amount}`
  );
  return parts.length > 0 ? parts.join(' ') : 'Gratis';
}

// Rates are projected per day and often fractional (site efficiency):
// one decimal when needed, plain integer otherwise.
const fmtRate = (rate) => {
  const rounded = Math.round(rate * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

// Proximity-row wording for every def with a site-efficiency rule: row
// label plus the adjectives for full/reduced output. Future defs fall back
// to a generic wording.
const PROXIMITY_ROWS = {
  well: { label: 'Falda', rich: 'Ricca', poor: 'Profonda' },
  hunt: { label: 'Zona di caccia', rich: 'Ricca', poor: 'Povera' },
  fish: { label: 'Pescosità', rich: 'Alta', poor: 'Bassa' },
  ranch: { label: 'Mandrie vicine', rich: 'Presenti', poor: 'Lontane' },
};
const PROXIMITY_ROW_FALLBACK = { label: 'Resa zona', rich: 'Piena', poor: 'Ridotta' };

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Creates the inspector panel inside `root` (the #ui overlay div).
 *
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {object} deps.state game state (live reference, mutated by the sim)
 * @param {object} deps.grid grid from world/grid.js
 * @param {object} deps.input input from core/input.js createInput()
 * @param {object} deps.placement placement controller: mode() and
 *   demolishBuilding(building) (refund + removal handled there)
 * @param {object} deps.visuals building visuals: setEnabled() follows the
 *   on/off toggle (tinta grigia da spento)
 * @param {object} deps.defs building definitions map (BUILDING_DEFS)
 * @returns {{
 *   update: () => void,
 *   deselect: () => void,
 *   selected: () => (object | null),
 *   el: HTMLElement,
 * }}
 * update() is meant to run once per frame: it refreshes the live numbers and
 * closes the panel when the building is gone or placement leaves idle mode.
 */
export function createInspector(root, { state, grid, input, placement, visuals, defs }) {
  let selectedId = null;
  // References to the dynamic elements of the current selection; rebuilt by
  // select() together with the panel content.
  let dyn = {};

  const rootEl = h('div', 'inspector');
  root.appendChild(rootEl);

  // Appends a label/value info row and returns the value element (so dynamic
  // rows can be refreshed without rebuilding the panel).
  function addRow(rows, label, value) {
    const r = h('div', 'inspector-row');
    r.appendChild(h('span', 'inspector-row-label', label));
    const v = h('span', 'inspector-row-value', value);
    r.appendChild(v);
    rows.appendChild(r);
    return v;
  }

  // Rebuilds the whole panel for the newly selected building.
  function select(b) {
    selectedId = b.id;
    dyn = {};
    rootEl.textContent = '';
    const def = defs[b.defId] ?? {};

    const head = h('div', 'inspector-head');
    dyn.titleEl = h('span', 'inspector-title', def.name ?? b.defId);
    head.appendChild(dyn.titleEl);
    const closeBtn = h('button', 'inspector-close', '✖');
    closeBtn.type = 'button';
    closeBtn.title = 'Chiudi';
    closeBtn.addEventListener('click', deselect);
    head.appendChild(closeBtn);
    rootEl.appendChild(head);

    if (def.desc) rootEl.appendChild(h('div', 'inspector-desc', def.desc));

    // HP bar.
    const hpRow = h('div', 'inspector-hp');
    const hpBar = h('span', 'inspector-hp-bar');
    dyn.hpFill = h('span', 'inspector-hp-fill');
    hpBar.appendChild(dyn.hpFill);
    dyn.hpText = h('span', 'inspector-hp-text');
    hpRow.append(hpBar, dyn.hpText);
    rootEl.appendChild(hpRow);

    // Repair button: live prorated cost, refreshed by refreshDynamic().
    // Affordability is advisory (greyed, never disabled): every click either
    // starts the repair or explains what's missing, no silent dead clicks.
    dyn.repairBtn = h('button', 'inspector-repair');
    dyn.repairBtn.type = 'button';
    dyn.repairBtn.addEventListener('click', () => {
      const cur = findBuilding(state, selectedId);
      if (!cur) return;
      const cost = repairCost(cur, defs[cur.defId]);
      if (!canAfford(state, { cost })) {
        pushEvent(state, 'fuel', `Risorse insufficienti: servono ${formatCost(cost)} per riparare.`);
      } else {
        startRepair(state, cur, defs[cur.defId]);
      }
      update();
    });
    rootEl.appendChild(dyn.repairBtn);

    // Conditional info rows, driven by the definition. Production rows are
    // dynamic: they show the effective per-day rate (staffing, modifiers and
    // site efficiency folded in), refreshed by refreshDynamic().
    const rows = h('div', 'inspector-rows');
    dyn.produceRows = [];
    for (const [resource, amount] of Object.entries(def.produces ?? {})) {
      const suffix = resource === 'energy' && def.energyDayOnly ? ' (solo di giorno)' : '';
      const valueEl = addRow(rows, 'Produce', '');
      dyn.produceRows.push({ valueEl, resource, base: amount, suffix });
    }
    for (const [resource, amount] of Object.entries(def.consumes ?? {})) {
      addRow(rows, 'Consuma', `${icon(resource)} ${amount}/giorno`);
    }
    if (def.requiresEnergy) addRow(rows, 'Richiede', `⚡ ${def.requiresEnergy}/giorno`);
    if (def.extracts) {
      addRow(rows, 'Estrae', `${icon(TILE_YIELDS[def.extracts]?.resource)} ${def.extractRate}/giorno`);
      dyn.nodesValue = addRow(rows, 'Nodi residui in raggio', '');
    }
    if (def.researchRate) addRow(rows, 'Ricerca', `🔬 ${def.researchRate}/giorno`);
    if (def.proximity) {
      dyn.proxRow = PROXIMITY_ROWS[b.defId] ?? PROXIMITY_ROW_FALLBACK;
      dyn.effValue = addRow(rows, dyn.proxRow.label, '');
    }
    if (Object.keys(def.capBonus ?? {}).length > 0) {
      dyn.capValue = addRow(rows, 'Capacità rete', '');
    }
    if (def.isTrap) addRow(rows, 'Danno trappola', `${def.trapDamage} al passaggio`);
    if (b.defId === 'clinic') addRow(rows, 'Effetto', 'Fame e sete −15% (con personale)');
    if (b.defId === 'radio') addRow(rows, 'Effetto', '+1 sopravvissuto a ogni alba (con personale)');
    if (b.defId === 'spotlight') addRow(rows, 'Effetto', 'Torri +20% danno (rete attiva)');
    if (b.defId === 'streetlamp') addRow(rows, 'Effetto', 'Guarnigione e milizia +25% danno (rete attiva)');
    if (b.defId === 'motor') addRow(rows, 'Effetto', 'Estrazione +25% (rete attiva)');
    if (b.defId === 'road') addRow(rows, 'Effetto', 'Estrazione +2% per strada (max +40%)');
    if (b.defId === 'garage') addRow(rows, 'Effetto', 'Estrazione +50% (con personale)');
    if (b.defId === 'ranch') addRow(rows, 'Effetto', 'Fattorie +15% ed estrazione +10% (con personale)');
    // Self-defense row: garrison for staffed buildings, militia for the HQ.
    if (!def.isTower && (def.jobs > 0 || b.defId === 'hq')) {
      dyn.garrisonValue = addRow(rows, b.defId === 'hq' ? 'Milizia' : 'Guarnigione', '');
    }
    if (rows.children.length > 0) rootEl.appendChild(rows);

    // Worker management (manual assignment switches the building out of
    // auto-assign inside survivors.js).
    if (def.jobs > 0) {
      const wrap = h('div', 'inspector-workers');
      dyn.minusBtn = h('button', 'inspector-worker-btn', '−');
      dyn.minusBtn.type = 'button';
      dyn.minusBtn.title = 'Rimuovi un lavoratore';
      dyn.minusBtn.addEventListener('click', () => {
        const cur = findBuilding(state, selectedId);
        if (cur && unassignWorker(state, cur.id)) update();
      });
      dyn.workersText = h('span', 'inspector-workers-text');
      dyn.plusBtn = h('button', 'inspector-worker-btn', '+');
      dyn.plusBtn.type = 'button';
      dyn.plusBtn.title = 'Assegna un lavoratore';
      dyn.plusBtn.addEventListener('click', () => {
        const cur = findBuilding(state, selectedId);
        if (cur && assignWorker(state, cur.id, defs)) update();
      });
      dyn.autoBadge = h('span', 'inspector-auto', 'auto');
      dyn.autoBadge.title = 'Assegnazione automatica dei lavoratori attiva';
      wrap.append(dyn.minusBtn, dyn.workersText, dyn.plusBtn, dyn.autoBadge);
      rootEl.appendChild(wrap);
    }

    const demolishBtn = h('button', 'inspector-demolish', '🔨 Demolisci');
    demolishBtn.type = 'button';
    demolishBtn.title = 'Demolisci questo edificio (rimborso parziale)';
    demolishBtn.addEventListener('click', () => {
      const cur = findBuilding(state, selectedId);
      if (!cur) {
        deselect();
        return;
      }
      placement.demolishBuilding(cur); // refund + grid/visuals removal
      deselect();
    });

    // On/off toggle next to Demolisci: switching off frees the workers and
    // greys out the model via visuals.setEnabled.
    dyn.toggleBtn = h('button', 'inspector-toggle');
    dyn.toggleBtn.type = 'button';
    dyn.toggleBtn.addEventListener('click', () => {
      const cur = findBuilding(state, selectedId);
      if (!cur) return;
      const on = cur.enabled === false;
      setBuildingEnabled(state, cur, on);
      visuals?.setEnabled(cur.id, on);
      update();
    });

    // Potenziamento: solo per edifici che producono, estraggono o torri.
    // Funziona anche da spento: il livello resta alla riattivazione.
    // Affordability advisory come per la riparazione (niente click morti).
    if (isUpgradeable(def)) {
      dyn.upgradeBtn = h('button', 'inspector-upgrade');
      dyn.upgradeBtn.type = 'button';
      dyn.upgradeBtn.addEventListener('click', () => {
        const cur = findBuilding(state, selectedId);
        if (!cur) return;
        const cost = upgradeCost(cur, defs[cur.defId]);
        if (!canAfford(state, { cost })) {
          pushEvent(state, 'fuel', `Risorse insufficienti: servono ${formatCost(cost)} per potenziare.`);
        } else if (upgradeBuilding(state, cur, defs[cur.defId])) {
          // maxHp è cresciuto: rinfresca la tinta danno col nuovo rapporto.
          visuals?.setDamaged(cur.id, cur.maxHp > 0 ? Math.max(0, cur.hp) / cur.maxHp : 1);
        }
        update();
      });
    }

    const actions = h('div', 'inspector-actions');
    actions.append(dyn.toggleBtn);
    if (dyn.upgradeBtn) actions.append(dyn.upgradeBtn);
    actions.append(demolishBtn);
    rootEl.appendChild(actions);

    rootEl.classList.add('open');
    refreshDynamic(b);
  }

  // Refreshes the live numbers (hp, workers, nodes, caps) in place.
  function refreshDynamic(b) {
    const def = defs[b.defId] ?? {};
    const off = b.enabled === false;
    if (dyn.titleEl) {
      // Badge livello: ★2/★3 accanto al nome per gli edifici potenziati.
      const level = b.level ?? 1;
      dyn.titleEl.textContent =
        isUpgradeable(def) && level > 1 ? `${def.name ?? b.defId} ★${level}` : def.name ?? b.defId;
    }
    if (dyn.hpFill) {
      const ratio = b.maxHp > 0 ? Math.max(0, b.hp) / b.maxHp : 0;
      dyn.hpFill.style.width = `${ratio * 100}%`;
      dyn.hpFill.classList.toggle('inspector-hp-fill--low', ratio < 0.5);
    }
    if (dyn.hpText) dyn.hpText.textContent = `${Math.max(0, Math.ceil(b.hp))}/${b.maxHp}`;
    if (dyn.repairBtn) {
      const cost = repairCost(b, def);
      dyn.repairBtn.textContent = b.repairing
        ? '🔧 Riparazione in corso…'
        : b.hp < b.maxHp
          ? `🔧 Ripara (${formatCost(cost)})`
          : '🔧 Ripara';
      dyn.repairBtn.title = 'Ripara gli hp man mano: costo proporzionale al danno';
      dyn.repairBtn.disabled = b.repairing || b.hp >= b.maxHp;
      dyn.repairBtn.setAttribute(
        'aria-disabled',
        String(!dyn.repairBtn.disabled && !canAfford(state, { cost }))
      );
    }
    if (dyn.toggleBtn) {
      dyn.toggleBtn.textContent = off ? '⏻ Riattiva' : '⏻ Spegni';
      dyn.toggleBtn.title = off
        ? 'Riattiva questo edificio'
        : 'Spegni questo edificio: niente produzione né consumi, i lavoratori vengono liberati';
      dyn.toggleBtn.classList.toggle('inspector-toggle--off', off);
    }
    if (dyn.upgradeBtn) {
      const level = b.level ?? 1;
      const maxed = level >= MAX_LEVEL;
      const cost = upgradeCost(b, def);
      dyn.upgradeBtn.textContent = maxed
        ? '⬆ Livello massimo'
        : `⬆ Potenzia (${formatCost(cost)})`;
      dyn.upgradeBtn.title = maxed
        ? `L'edificio è al livello massimo (★${MAX_LEVEL})`
        : `Porta l'edificio a ★${level + 1}: +50% produzione/estrazione/danno e più hp`;
      dyn.upgradeBtn.disabled = maxed;
      dyn.upgradeBtn.setAttribute('aria-disabled', String(!maxed && !canAfford(state, { cost })));
    }
    if (dyn.workersText) dyn.workersText.textContent = `👷 ${b.workers.length}/${def.jobs}`;
    if (dyn.plusBtn) {
      dyn.plusBtn.disabled = off || idleCount(state) === 0 || b.workers.length >= def.jobs;
    }
    if (dyn.minusBtn) dyn.minusBtn.disabled = off || b.workers.length === 0;
    if (dyn.autoBadge) dyn.autoBadge.style.display = b.autoAssign ? '' : 'none';
    if (dyn.produceRows) {
      const output = buildingDailyOutput(b, def, getModifiers(state, grid));
      for (const row of dyn.produceRows) {
        const rate = output[row.resource] ?? 0;
        row.valueEl.textContent =
          Math.abs(rate - row.base) < 0.05
            ? `${icon(row.resource)} ${fmtRate(rate)}/giorno${row.suffix}`
            : `${icon(row.resource)} ${fmtRate(rate)}/giorno (base ${row.base})${row.suffix}`;
      }
    }
    if (dyn.nodesValue) {
      dyn.nodesValue.textContent = String(countNodesInRange(grid, b, def.extracts));
    }
    if (dyn.effValue) {
      const eff = b.efficiency ?? 1;
      const word = eff >= 1 ? dyn.proxRow.rich : dyn.proxRow.poor;
      dyn.effValue.textContent = `${word} ×${eff.toFixed(1)}`;
    }
    if (dyn.capValue) {
      // Effective caps (base + every capBonus on the map), one readout per
      // resource this building boosts: '⚡ 150' for a battery.
      const caps = effectiveCaps(state, defs);
      dyn.capValue.textContent = Object.keys(def.capBonus ?? {})
        .map((resource) => `${icon(resource)} ${Math.floor(caps[resource] ?? 0)}`)
        .join(' · ');
    }
    if (dyn.garrisonValue) {
      const guns = garrisonGuns(b, def, idleCount(state));
      const dps = (GARRISON_DAMAGE * guns) / GARRISON_FIRE_INTERVAL;
      dyn.garrisonValue.textContent =
        guns > 0
          ? `${guns} ${guns === 1 ? 'fucile' : 'fucili'} · ${fmtRate(dps)} DPS`
          : b.defId === 'hq'
            ? 'nessun inattivo a presidio'
            : 'indifeso senza personale';
    }
  }

  /** Closes the panel and drops the selection. */
  function deselect() {
    selectedId = null;
    dyn = {};
    rootEl.classList.remove('open');
  }

  /** The currently selected building object, or null. */
  function selected() {
    return selectedId == null ? null : findBuilding(state, selectedId);
  }

  /** Per-frame refresh; auto-closes when the selection becomes invalid. */
  function update() {
    if (selectedId == null) return;
    if (placement.mode() !== 'idle') {
      deselect(); // placement/demolish started: the panel gets out of the way
      return;
    }
    const b = findBuilding(state, selectedId);
    if (!b) {
      deselect(); // destroyed or demolished elsewhere
      return;
    }
    refreshDynamic(b);
  }

  // Click selection: only while placement is idle. An occupied tile selects
  // its building (occupiedBy or trap — for traps, which don't block the tile —
  // is the building id, so any footprint cell works); anything else (empty
  // tile, off-map click, active placement) deselects.
  function handleClick(payload) {
    if (placement.mode() !== 'idle') {
      deselect();
      return;
    }
    const cell = payload?.inBounds ? getCell(grid, payload.tileX, payload.tileZ) : null;
    const buildingId = cell?.occupiedBy ?? cell?.trap ?? null;
    const b = buildingId != null ? findBuilding(state, buildingId) : null;
    if (b) select(b);
    else deselect();
  }

  input.on('click', handleClick);

  return { update, deselect, selected, el: rootEl };
}
