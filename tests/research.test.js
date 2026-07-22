import { describe, it, expect } from 'vitest';
import { TECHS, tickResearch, canResearch, research, isUnlocked } from '../src/sim/research.js';

const DAY_LENGTH = 90; // mirrors state.js CONFIG.dayLength

// --- Inline v2-shaped fixtures (no imports from state.js/definitions.js) ---

function mkState() {
  return {
    day: 1,
    phase: 'day',
    resources: { food: 50, water: 50, wood: 0, metal: 0, energy: 0 },
    caps: { food: 150, water: 100, wood: 150, metal: 150, energy: 60 },
    survivors: [],
    buildings: [],
    nextSurvivorId: 1,
    nextBuildingId: 1,
    events: [],
    weather: { current: 'clear' },
    researchPoints: 0,
    researched: [],
  };
}

function mkBuilding(state, defId, def, workers = 0) {
  const b = {
    id: state.nextBuildingId++,
    defId,
    x: 0,
    z: 0,
    w: def.w ?? 1,
    h: def.h ?? 1,
    hp: 100,
    maxHp: 100,
    powered: true,
    workers: [],
    autoAssign: true,
    extracted: 0,
    efficiency: 1,
  };
  for (let i = 0; i < workers; i++) b.workers.push(1000 + i); // fake survivor ids
  state.buildings.push(b);
  return b;
}

const DEFS = {
  lab: { name: 'Laboratorio', researchRate: 10, jobs: 2, w: 2, h: 2 },
  biglab: { name: 'Centro ricerche', researchRate: 20, jobs: 1, w: 2, h: 2 },
  house: { name: 'Casa', houses: 3, jobs: 0, w: 2, h: 2 },
};

describe('TECHS tree', () => {
  it('matches the v3 contract (costs, effects, unlocks)', () => {
    expect(Object.keys(TECHS).sort()).toEqual(
      ['ballistics', 'batteries', 'concrete', 'efficiency', 'forestry', 'medicine', 'mining', 'solar2'].sort()
    );
    expect(TECHS.forestry).toMatchObject({ cost: 10, effects: {}, unlocks: ['forester'] });
    expect(TECHS.batteries).toMatchObject({ cost: 15, effects: {}, unlocks: ['battery'] });
    expect(TECHS.solar2).toMatchObject({ cost: 15, effects: {}, unlocks: ['solar-plant'] });
    expect(TECHS.mining).toMatchObject({ cost: 20, effects: {}, unlocks: ['mine'] });
    expect(TECHS.efficiency).toMatchObject({ cost: 20, effects: { extractProd: 1.25 }, unlocks: [] });
    expect(TECHS.medicine).toMatchObject({
      cost: 25,
      effects: { hungerRate: 0.7, thirstRate: 0.7 },
      unlocks: [],
    });
    expect(TECHS.ballistics).toMatchObject({
      cost: 25,
      effects: { towerDamage: 1.5, towerRangeMul: 1.17 },
      unlocks: ['sniper'],
    });
    expect(TECHS.concrete).toMatchObject({ cost: 25, effects: {}, unlocks: ['concrete-wall'] });
    for (const tech of Object.values(TECHS)) {
      expect(tech.name.length).toBeGreaterThan(0);
      expect(tech.desc.length).toBeGreaterThan(0);
    }
  });

  it('every unlocked building id exists only once across the tree', () => {
    const unlocks = Object.values(TECHS).flatMap((t) => t.unlocks);
    expect(new Set(unlocks).size).toBe(unlocks.length);
  });
});

describe('tickResearch', () => {
  it('generates researchRate points per day at full staffing', () => {
    const state = mkState();
    mkBuilding(state, 'lab', DEFS.lab, 2);
    tickResearch(state, DAY_LENGTH, DEFS);
    expect(state.researchPoints).toBeCloseTo(10);
  });

  it('scales with the staffing ratio and accumulates over ticks', () => {
    const state = mkState();
    mkBuilding(state, 'lab', DEFS.lab, 1); // 1 of 2 jobs
    tickResearch(state, DAY_LENGTH, DEFS);
    expect(state.researchPoints).toBeCloseTo(5);
    tickResearch(state, DAY_LENGTH / 2, DEFS);
    expect(state.researchPoints).toBeCloseTo(7.5);
  });

  it('sums over multiple labs and ignores non-lab buildings', () => {
    const state = mkState();
    mkBuilding(state, 'lab', DEFS.lab, 2);
    mkBuilding(state, 'biglab', DEFS.biglab, 1);
    mkBuilding(state, 'house', DEFS.house);
    tickResearch(state, DAY_LENGTH, DEFS);
    expect(state.researchPoints).toBeCloseTo(30);
  });

  it('generates nothing without workers', () => {
    const state = mkState();
    mkBuilding(state, 'lab', DEFS.lab, 0);
    tickResearch(state, DAY_LENGTH, DEFS);
    expect(state.researchPoints).toBe(0);
  });

  it('does not require power', () => {
    const state = mkState();
    const lab = mkBuilding(state, 'lab', DEFS.lab, 2);
    lab.powered = false;
    tickResearch(state, DAY_LENGTH, DEFS);
    expect(state.researchPoints).toBeCloseTo(10);
  });
});

describe('research', () => {
  it('canResearch checks existence, points and duplicates', () => {
    const state = mkState();
    expect(canResearch(state, 'forestry')).toBe(false); // 0 points
    expect(canResearch(state, 'nope')).toBe(false); // unknown tech
    state.researchPoints = 10;
    expect(canResearch(state, 'forestry')).toBe(true);
    expect(canResearch(state, 'batteries')).toBe(false); // costs 15
    state.researched.push('forestry');
    expect(canResearch(state, 'forestry')).toBe(false); // already researched
  });

  it('research spends the points, records the tech and fires an event', () => {
    const state = mkState();
    state.researchPoints = 30;
    expect(research(state, 'mining')).toBe(true);
    expect(state.researchPoints).toBe(10);
    expect(state.researched).toEqual(['mining']);
    const evt = state.events.find((e) => e.type === 'research');
    expect(evt).toBeDefined();
    expect(evt.msg).toContain(TECHS.mining.name);
  });

  it('research fails and leaves the state untouched when not allowed', () => {
    const state = mkState();
    state.researchPoints = 5;
    expect(research(state, 'mining')).toBe(false);
    expect(state.researchPoints).toBe(5);
    expect(state.researched).toEqual([]);
    expect(state.events).toHaveLength(0);
  });

  it('isUnlocked gates building defs on their required tech', () => {
    const state = mkState();
    const mine = { name: 'Miniera', requiresTech: 'mining' };
    const farm = { name: 'Fattoria' };
    expect(isUnlocked(state, farm)).toBe(true);
    expect(isUnlocked(state, mine)).toBe(false);
    state.researchPoints = 20;
    research(state, 'mining');
    expect(isUnlocked(state, mine)).toBe(true);
  });

  it('concrete and ballistics unlock their v3 buildings', () => {
    const state = mkState();
    const concreteWall = { name: 'Muro in cemento armato', requiresTech: 'concrete' };
    const sniper = { name: 'Torretta automatica', requiresTech: 'ballistics' };
    expect(isUnlocked(state, concreteWall)).toBe(false);
    expect(isUnlocked(state, sniper)).toBe(false);
    state.researchPoints = 50;
    research(state, 'concrete');
    research(state, 'ballistics');
    expect(isUnlocked(state, concreteWall)).toBe(true);
    expect(isUnlocked(state, sniper)).toBe(true);
  });
});
