// Fullscreen overlay screens: title, defeat (endless mode: there is no
// victory screen, the run score is the number of nights survived) and small
// confirmation dialogs. Only one
// screen is visible at a time; the overlay sits above the rest of the UI
// (z-index) and re-enables pointer events. No DOM access at import time.

const TITLE = 'LAST REFUGE';

const INSTRUCTIONS = [
  ['WASD', 'move the camera'],
  ['Mouse wheel', 'zoom'],
  ['Q / E', 'rotate the camera'],
  ['Click', 'build'],
  ['R', 'rotate the building'],
  ['ESC', 'cancel'],
];

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Creates the screen manager inside `root` (the #ui overlay div).
 *
 * @param {HTMLElement} root
 * @returns {{
 *   showTitle: (onStart?: () => void, record?: number) => void,
 *   showDefeat: (stats?: object, onRestart?: () => void) => void,
 *   showConfirm: (opts?: object, onConfirm?: () => void, onCancel?: () => void) => void,
 *   hide: () => void,
 * }}
 * `stats` accepts English or Italian keys: days/giorni, kills/uccisioni,
 * survivors/sopravvissuti; an optional `record` (best nights survived) is
 * shown next to the run score. `record` in showTitle adds a best-run line
 * when greater than zero.
 */
export function createScreens(root) {
  let overlay = null;

  /** Removes the current screen, if any. */
  function hide() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  function open() {
    hide();
    overlay = h('div', 'screen-overlay');
    root.appendChild(overlay);
    return overlay;
  }

  // Button that hides the screen and then fires the handler.
  function makeButton(label, onClick) {
    const btn = h('button', 'screen-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      hide();
      onClick?.();
    });
    return btn;
  }

  function statsGrid(stats = {}) {
    const days = stats.days ?? stats.giorni ?? 0;
    const kills = stats.kills ?? stats.uccisioni ?? 0;
    const survivors = stats.survivors ?? stats.sopravvissuti ?? 0;
    const rows = [
      ['Days', days],
      ['Kills', kills],
      ['Survivors', survivors],
    ];
    if (stats.reputation != null) rows.push(['Reputation', stats.reputation]);
    const grid = h('div', 'screen-stats');
    for (const [label, value] of rows) {
      const stat = h('div', 'screen-stat');
      stat.append(
        h('span', 'screen-stat-label', label),
        h('span', 'screen-stat-value', String(value))
      );
      grid.appendChild(stat);
    }
    return grid;
  }

  /** Title screen: name, tagline, controls, objective and start button. */
  function showTitle(onStart, record = 0) {
    const o = open();
    const panel = h('div', 'screen-panel');
    panel.append(
      h('h1', 'screen-title', TITLE),
      h(
        'p',
        'screen-subtitle',
        'The city has fallen. The night belongs to the undead. Build your refuge and hold on.'
      )
    );
    const box = h('div', 'screen-instructions');
    for (const [key, action] of INSTRUCTIONS) {
      const row = h('div', 'screen-instruction');
      row.append(h('span', 'screen-key', key), h('span', null, action));
      box.appendChild(row);
    }
    panel.appendChild(box);
    panel.appendChild(
      h('p', 'screen-goal', 'Objective: survive as long as possible.')
    );
    if (record > 0) {
      panel.appendChild(
        h('p', 'screen-record', `Record: ${record} ${record === 1 ? 'night' : 'nights'}`)
      );
    }
    panel.appendChild(makeButton('Start game', onStart));
    o.appendChild(panel);
  }

  function endScreen({ title, subtitle, titleClass }, stats, onRestart) {
    const o = open();
    const panel = h('div', 'screen-panel');
    panel.append(
      h('h1', `screen-title ${titleClass}`, title),
      h('p', 'screen-subtitle', subtitle),
      statsGrid(stats),
      makeButton('Play again', onRestart)
    );
    o.appendChild(panel);
  }

  /** Defeat screen: nights survived as the run score, plus a restart button. */
  function showDefeat(stats, onRestart) {
    const days = stats?.days ?? stats?.giorni ?? 1;
    const nights = Math.max(0, days - 1); // the night you die on is not survived
    const record = stats?.record ?? null;
    const score =
      record != null
        ? `Nights survived: ${nights} — Record: ${record}.`
        : `Nights survived: ${nights}.`;
    endScreen(
      {
        title: 'THE REFUGE HAS FALLEN',
        subtitle: `${score} The hordes have prevailed.`,
        titleClass: 'screen-title--defeat',
      },
      stats,
      onRestart
    );
  }

  /**
   * Confirmation dialog: title, message and confirm/cancel buttons. Both
   * buttons close the overlay and then fire their handler. `opts` accepts
   * title, message, confirmLabel and cancelLabel.
   */
  function showConfirm(
    { title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {},
    onConfirm,
    onCancel
  ) {
    const o = open();
    const panel = h('div', 'screen-panel');
    panel.append(
      h('h1', 'screen-title', title),
      h('p', 'screen-subtitle', message),
      makeButton(confirmLabel, onConfirm),
      makeButton(cancelLabel, onCancel)
    );
    o.appendChild(panel);
  }

  return { showTitle, showDefeat, showConfirm, hide };
}
