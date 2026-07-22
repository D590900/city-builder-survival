import { describe, it, expect } from 'vitest';
import { createGameState, addSurvivor } from '../src/sim/state.js';
import {
  tickSurvivors,
  killBuildingWorkers,
  tickReputation,
  recruitCount,
} from '../src/sim/survivors.js';

const DAY_LENGTH = 90; // mirrors state.js CONFIG.dayLength

// Radio accesa e staffata (o varianti) per tickReputation.
function mkRadio(state, { workers = [1], enabled = true } = {}) {
  const b = { id: state.nextBuildingId++, defId: 'radio', workers, enabled };
  state.buildings.push(b);
  return b;
}

describe('reputation initial state', () => {
  it('starts at 0 with no deaths counted', () => {
    const state = createGameState();
    expect(state.reputation).toBe(0);
    expect(state.deathsToday).toBe(0);
  });
});

describe('tickReputation', () => {
  it('gains +4 for the survived night', () => {
    const state = createGameState();
    expect(tickReputation(state)).toBe(4);
    expect(state.reputation).toBe(4);
  });

  it('gains +2 extra per staffed switched-on radio', () => {
    const state = createGameState();
    mkRadio(state);
    mkRadio(state);
    expect(tickReputation(state)).toBe(4 + 2 * 2);
  });

  it('ignores radios without workers or switched off', () => {
    const state = createGameState();
    mkRadio(state, { workers: [] });
    mkRadio(state, { enabled: false });
    expect(tickReputation(state)).toBe(4);
  });

  it('loses 10 per death of the day and then resets deathsToday', () => {
    const state = createGameState();
    state.reputation = 50;
    state.deathsToday = 2;
    expect(tickReputation(state)).toBe(50 + 4 - 20);
    expect(state.deathsToday).toBe(0);
  });

  it('clamps the result to 0-100', () => {
    const state = createGameState();
    state.reputation = 15;
    state.deathsToday = 5; // 15 + 4 − 50 < 0
    expect(tickReputation(state)).toBe(0);

    state.reputation = 99; // 99 + 4 > 100
    expect(tickReputation(state)).toBe(100);
  });
});

describe('deathsToday counting', () => {
  it('counts starvation and thirst deaths from tickSurvivors', () => {
    const state = createGameState();
    state.resources.food = 0;
    state.resources.water = 0;
    addSurvivor(state);
    addSurvivor(state);

    tickSurvivors(state, 1.5 * DAY_LENGTH);
    expect(state.survivors).toHaveLength(0);
    expect(state.deathsToday).toBe(2);
  });

  it('counts the workers killed with their building', () => {
    const state = createGameState();
    const b = { id: state.nextBuildingId++, defId: 'farm', workers: [] };
    state.buildings.push(b);
    const s1 = addSurvivor(state);
    const s2 = addSurvivor(state);
    b.workers.push(s1.id, s2.id);

    expect(killBuildingWorkers(state, b)).toBe(2);
    expect(state.deathsToday).toBe(2);
  });
});

describe('recruitCount', () => {
  it('is 1 by default', () => {
    expect(recruitCount(createGameState())).toBe(1);
  });

  it('adds the radio recruitBonus', () => {
    expect(recruitCount(createGameState(), { recruitBonus: 2 })).toBe(3);
  });

  it('adds one recruit per 25 reputation points', () => {
    for (const [rep, extra] of [
      [0, 0],
      [24, 0],
      [25, 1],
      [50, 2],
      [75, 3],
      [100, 4],
    ]) {
      const state = createGameState();
      state.reputation = rep;
      expect(recruitCount(state), `rep ${rep}`).toBe(1 + extra);
    }
  });

  it('combines radio bonus and reputation', () => {
    const state = createGameState();
    state.reputation = 75;
    expect(recruitCount(state, { recruitBonus: 1 })).toBe(1 + 1 + 3);
  });
});
