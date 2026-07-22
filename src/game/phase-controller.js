// Day/night phase machine: the startDay/startNight transitions plus the
// shared phase timing, extracted from main.js. The controller owns the night
// wave plan (currentWave + spawnSchedule); the main loop reads them back
// through the returned handle to feed the spawns during simulate().
// saveGame is the autosave callback wired by the caller (persistence.js).

import { CONFIG } from '../sim/state.js';
import { tickReputation, tryRecruit, recruitCount } from '../sim/survivors.js';
import { advanceWeather, WEATHERS } from '../sim/weather.js';
import { getModifiers } from '../sim/modifiers.js';
import { waveForNight, spawnPlan } from '../sim/waves.js';
import { BUILDING_DEFS } from '../buildings/definitions.js';

export function createPhaseController({ state, grid, hud, zombies, saveGame }) {
  let currentWave = null;
  let spawnSchedule = [];

  const phaseDuration = () =>
    state.phase === 'day' ? CONFIG.dayLength : CONFIG.nightLength;

  function startNight() {
    state.phase = 'night';
    state.timeInPhase = 0;
    currentWave = waveForNight(state.day);
    spawnSchedule = spawnPlan(state.day, CONFIG.nightLength);
    hud.toast(`☾ Night ${state.day} — they're coming!`, 'warn');
  }

  function startDay() {
    zombies.clearAll();
    state.day += 1;
    state.phase = 'day';
    state.timeInPhase = 0;
    const weather = WEATHERS[advanceWeather(state)] ?? WEATHERS.clear;
    tickReputation(state); // notte superata, Radio e morti muovono la reputazione
    const mods = getModifiers(state, grid); // staffed radios add extra recruits
    tryRecruit(state, BUILDING_DEFS, recruitCount(state, mods));
    saveGame();
    hud.toast(`☀ Day ${state.day} — ${weather.icon} ${weather.name}`, 'info');
  }

  return {
    phaseDuration,
    startNight,
    startDay,
    // Live reads: startNight replaces both bindings, so the main loop must
    // always go through these getters (spawnSchedule is drained via shift()).
    get currentWave() {
      return currentWave;
    },
    get spawnSchedule() {
      return spawnSchedule;
    },
  };
}
