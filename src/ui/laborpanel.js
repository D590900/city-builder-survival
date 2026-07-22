// Labor panel: right-side overlay listing every standing building with job
// slots. Each row shows icon, name, current workers x/y and +/− buttons
// (manual assignment via survivors.js, which switches the building out of
// auto-assign); a building under manual management gets an 'Auto' button
// that hands it back to the automatic job assignment. The trailing ▲/●/▼
// button cycles the per-building priority used by the automatic assignment.
// No DOM access at import time — everything is built inside
// createLaborPanel().

import { BUILDING_DEFS } from '../buildings/definitions.js';
import { assignWorker, unassignWorker, idleCount } from '../sim/survivors.js';
import { ICONS } from './buildmenu.js';

// Priorità lavoratori per edificio (b.priority): il bottone di riga cicla
// normale → alta → bassa. Indicizzato sul valore 0/1/2.
const PRIORITIES = [
  { icon: '▼', label: 'bassa' },
  { icon: '●', label: 'normale' },
  { icon: '▲', label: 'alta' },
];

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Creates the labor panel inside `root` (the #ui overlay div).
 *
 * @param {HTMLElement} root
 * @returns {{
 *   update: (state: object) => void,
 *   toggle: () => void,
 *   isOpen: () => boolean,
 *   open: () => void,
 *   close: () => void,
 *   el: HTMLElement,
 * }}
 * update(state) is meant to be called on the same cadence as the other UI
 * panels (~4/s); while hidden it only stores the state and refreshes on the
 * next open().
 */
export function createLaborPanel(root) {
  let visible = false;
  let lastState = null;
  let listSig = null; // signature of the rendered rows (building ids)
  const rows = new Map(); // buildingId -> { workersEl, plusBtn, minusBtn, autoBadge, autoBtn }

  const rootEl = h('div', 'labor-panel');

  const head = h('div', 'labor-head');
  head.appendChild(h('span', 'labor-title', '👷 Lavoratori'));
  const idleEl = h('span', 'labor-idle');
  head.appendChild(idleEl);
  const closeBtn = h('button', 'labor-close', '✖');
  closeBtn.type = 'button';
  closeBtn.title = 'Chiudi';
  closeBtn.addEventListener('click', close);
  head.appendChild(closeBtn);

  const list = h('div', 'labor-list');

  rootEl.append(head, list);
  root.appendChild(rootEl);

  // Rebuilds the row set from scratch; called only when the roster of
  // job-having buildings changes (construction/demolition), so the buttons
  // keep their hover/focus state across routine refreshes.
  function rebuild(state, jobBuildings) {
    rows.clear();
    list.textContent = '';
    for (const b of jobBuildings) {
      const def = BUILDING_DEFS[b.defId];
      const row = h('div', 'labor-row');
      row.appendChild(h('span', 'labor-name', `${ICONS[b.defId] ?? '🏗'} ${def.name}`));

      const controls = h('div', 'labor-controls');
      const minusBtn = h('button', 'labor-btn', '−');
      minusBtn.type = 'button';
      minusBtn.title = 'Rimuovi un lavoratore';
      minusBtn.addEventListener('click', () => {
        if (unassignWorker(state, b.id)) update(state);
      });
      const workersEl = h('span', 'labor-workers');
      const plusBtn = h('button', 'labor-btn', '+');
      plusBtn.type = 'button';
      plusBtn.title = 'Assegna un lavoratore';
      plusBtn.addEventListener('click', () => {
        if (assignWorker(state, b.id, BUILDING_DEFS)) update(state);
      });
      const autoBadge = h('span', 'labor-auto', 'auto');
      autoBadge.title = 'Assegnazione automatica dei lavoratori attiva';
      const autoBtn = h('button', 'labor-btn labor-auto-btn', 'Auto');
      autoBtn.type = 'button';
      autoBtn.title = 'Torna alla assegnazione automatica';
      autoBtn.addEventListener('click', () => {
        b.autoAssign = true;
        update(state);
      });
      const offBadge = h('span', 'labor-off', 'spento');
      offBadge.title = 'Edificio spento: inerte, senza lavoratori';
      // Ciclo di priorità: funziona anche da spento (vale alla riattivazione).
      const priorityBtn = h('button', 'labor-btn labor-priority');
      priorityBtn.type = 'button';
      priorityBtn.addEventListener('click', () => {
        b.priority = ((b.priority ?? 1) + 1) % 3;
        update(state);
      });
      controls.append(minusBtn, workersEl, plusBtn, autoBadge, autoBtn, offBadge, priorityBtn);
      row.appendChild(controls);
      rows.set(b.id, { rowEl: row, workersEl, plusBtn, minusBtn, autoBadge, autoBtn, offBadge, priorityBtn });
      list.appendChild(row);
    }
    if (jobBuildings.length === 0) {
      list.appendChild(h('div', 'labor-empty', 'Nessun edificio con posti di lavoro.'));
    }
  }

  /** Refreshes the header and every row against the current game state. */
  function update(state) {
    lastState = state;
    if (!visible) return;
    const idle = idleCount(state);
    idleEl.textContent = `— ${idle} ${idle === 1 ? 'libero' : 'liberi'}`;

    const jobBuildings = state.buildings.filter(
      (b) => (BUILDING_DEFS[b.defId]?.jobs ?? 0) > 0
    );
    const sig = jobBuildings.map((b) => b.id).join(',');
    if (sig !== listSig) {
      listSig = sig;
      rebuild(state, jobBuildings);
    }
    for (const b of jobBuildings) {
      const def = BUILDING_DEFS[b.defId];
      const row = rows.get(b.id);
      if (!row) continue;
      const off = b.enabled === false;
      row.rowEl.classList.toggle('labor-row--off', off);
      row.offBadge.style.display = off ? '' : 'none';
      row.workersEl.textContent = `${b.workers.length}/${def.jobs}`;
      row.plusBtn.disabled = off || idle === 0 || b.workers.length >= def.jobs;
      row.minusBtn.disabled = off || b.workers.length === 0;
      const isAuto = b.autoAssign !== false;
      row.autoBadge.style.display = !off && isAuto ? '' : 'none';
      row.autoBtn.style.display = !off && !isAuto ? '' : 'none';
      const pri = PRIORITIES[b.priority ?? 1] ?? PRIORITIES[1];
      row.priorityBtn.textContent = pri.icon;
      row.priorityBtn.title = `Priorità lavoratori: ${pri.label} (click per cambiare)`;
    }
  }

  function open() {
    visible = true;
    rootEl.classList.add('open');
    listSig = null; // force a rebuild: rows may be stale after a hidden stretch
    if (lastState) update(lastState);
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
