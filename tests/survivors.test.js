import { describe, it, expect } from 'vitest';
import {
  tickSurvivors,
  assignJobs,
  assignWorker,
  unassignWorker,
  unassignAll,
  setBuildingEnabled,
  idleCount,
  housingCapacity,
  tryRecruit,
  killBuildingWorkers,
} from '../src/sim/survivors.js';

const DAY_LENGTH = 90; // mirrors state.js CONFIG.dayLength

// --- Inline v2-shaped fixtures (no imports from state.js/definitions.js) ---

function mkState() {
  return {
    day: 1,
    phase: 'day',
    timeInPhase: 0,
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
    gameOver: null,
  };
}

function mkSurvivor(state) {
  const s = { id: state.nextSurvivorId++, hunger: 0, thirst: 0, buildingId: null };
  state.survivors.push(s);
  return s;
}

function mkBuilding(state, defId, def, x = 0, z = 0) {
  const b = {
    id: state.nextBuildingId++,
    defId,
    x,
    z,
    w: def.w ?? 1,
    h: def.h ?? 1,
    hp: def.hp ?? 100,
    maxHp: def.hp ?? 100,
    powered: true,
    workers: [],
    autoAssign: true,
    extracted: 0,
    efficiency: 1,
  };
  state.buildings.push(b);
  return b;
}

const DEFS = {
  farm: { name: 'Fattoria', produces: { food: 12 }, jobs: 2, w: 2, h: 2 },
  well: { name: 'Pozzo', produces: { water: 10 }, jobs: 1, w: 1, h: 1 },
  sawmill: { name: 'Segheria', extracts: 'forest', extractRate: 10, jobs: 1, w: 2, h: 2 },
  lab: { name: 'Laboratorio', researchRate: 10, jobs: 1, w: 2, h: 2 },
  workshop: { name: 'Officina', produces: { wood: 8 }, jobs: 1, w: 2, h: 2 },
  house: { name: 'Casa', houses: 3, jobs: 0, w: 2, h: 2 },
};

describe('survivors hunger and thirst', () => {
  it('hunger grows toward starvation over 1.5 days without food', () => {
    const state = mkState();
    state.resources.food = 0;
    const s = mkSurvivor(state);
    tickSurvivors(state, 0.75 * DAY_LENGTH);
    expect(s.hunger).toBeCloseTo(50);
  });

  it('thirst grows toward dehydration over 1 day without water', () => {
    const state = mkState();
    state.resources.water = 0;
    const s = mkSurvivor(state);
    tickSurvivors(state, 0.5 * DAY_LENGTH);
    expect(s.thirst).toBeCloseTo(50);
  });

  it('eats 1 food when hunger passes 50', () => {
    const state = mkState();
    state.resources.food = 10;
    const s = mkSurvivor(state);
    tickSurvivors(state, 0.8 * DAY_LENGTH); // hunger ~53.3 before eating
    expect(state.resources.food).toBe(9);
    expect(s.hunger).toBeCloseTo(53.33 - 40, 1);
  });

  it('drinks 1 water when thirst passes 50', () => {
    const state = mkState();
    state.resources.food = 0; // isolate: no eating this tick
    state.resources.water = 10;
    const s = mkSurvivor(state);
    tickSurvivors(state, 0.8 * DAY_LENGTH); // thirst 80 before drinking
    expect(state.resources.water).toBe(9);
    expect(s.thirst).toBeCloseTo(40);
  });

  it('dies of starvation at hunger 100, with an event and job cleanup', () => {
    const state = mkState();
    state.resources.food = 0;
    const s = mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    s.buildingId = farm.id;
    farm.workers.push(s.id);

    tickSurvivors(state, 1.5 * DAY_LENGTH);
    expect(state.survivors).toHaveLength(0);
    expect(farm.workers).toHaveLength(0);
    const death = state.events.find((e) => e.type === 'death');
    expect(death).toBeDefined();
    expect(death.msg).toContain('fame');
  });

  it('dies of thirst at thirst 100, with a distinct death event', () => {
    const state = mkState();
    state.resources.water = 0;
    const s = mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    s.buildingId = farm.id;
    farm.workers.push(s.id);

    tickSurvivors(state, DAY_LENGTH);
    expect(state.survivors).toHaveLength(0);
    expect(farm.workers).toHaveLength(0);
    const death = state.events.find((e) => e.type === 'death');
    expect(death).toBeDefined();
    expect(death.msg).toContain('sete');
  });

  it('mods.hungerRate and mods.thirstRate scale the gains', () => {
    const state = mkState();
    state.resources.food = 0;
    state.resources.water = 0;
    const s = mkSurvivor(state);
    tickSurvivors(state, 0.75 * DAY_LENGTH, { hungerRate: 0.5, thirstRate: 0.5 });
    expect(s.hunger).toBeCloseTo(25);
    expect(s.thirst).toBeCloseTo(37.5);
  });

  it('a thirstRate above 1 speeds up dehydration (e.g. heat waves)', () => {
    const state = mkState();
    state.resources.food = 0;
    state.resources.water = 0;
    const s = mkSurvivor(state);
    tickSurvivors(state, 0.5 * DAY_LENGTH, { thirstRate: 1.5 });
    expect(s.thirst).toBeCloseTo(75);
  });

  it('works without mods (backward compatible)', () => {
    const state = mkState();
    state.resources.water = 0;
    const s = mkSurvivor(state);
    tickSurvivors(state, 0.75 * DAY_LENGTH);
    expect(s.hunger).toBeCloseTo(50);
    expect(s.thirst).toBeCloseTo(75);
  });
});

describe('assignJobs', () => {
  it('fills free job slots with idle survivors', () => {
    const state = mkState();
    mkSurvivor(state);
    mkSurvivor(state);
    mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    const workshop = mkBuilding(state, 'workshop', DEFS.workshop, 2, 0);

    assignJobs(state, DEFS);
    expect(farm.workers).toHaveLength(2);
    expect(workshop.workers).toHaveLength(1);
    expect(state.survivors.every((s) => s.buildingId !== null)).toBe(true);
  });

  it('prioritizes food > water > extractors > labs > the rest', () => {
    const state = mkState();
    const farm = mkBuilding(state, 'farm', DEFS.farm); // 2 jobs
    const well = mkBuilding(state, 'well', DEFS.well, 2, 0);
    const sawmill = mkBuilding(state, 'sawmill', DEFS.sawmill, 4, 0);
    const lab = mkBuilding(state, 'lab', DEFS.lab, 6, 0);
    const workshop = mkBuilding(state, 'workshop', DEFS.workshop, 8, 0);

    const hired = [];
    for (let i = 0; i < 6; i++) {
      hired.push(mkSurvivor(state));
      assignJobs(state, DEFS);
    }
    expect(hired[0].buildingId).toBe(farm.id);
    expect(hired[1].buildingId).toBe(farm.id); // farm has 2 slots
    expect(hired[2].buildingId).toBe(well.id);
    expect(hired[3].buildingId).toBe(sawmill.id);
    expect(hired[4].buildingId).toBe(lab.id);
    expect(hired[5].buildingId).toBe(workshop.id);
  });

  it('skips manually managed buildings (autoAssign === false)', () => {
    const state = mkState();
    mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    farm.autoAssign = false;

    assignJobs(state, DEFS);
    expect(farm.workers).toHaveLength(0);
    expect(state.survivors[0].buildingId).toBeNull();
  });

  it('skips switched-off buildings (enabled === false)', () => {
    const state = mkState();
    mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    farm.enabled = false;

    assignJobs(state, DEFS);
    expect(farm.workers).toHaveLength(0);
    expect(state.survivors[0].buildingId).toBeNull();
  });

  it('does not overfill jobs and leaves extra survivors idle', () => {
    const state = mkState();
    mkSurvivor(state);
    mkSurvivor(state);
    mkSurvivor(state);
    mkBuilding(state, 'farm', DEFS.farm); // 2 jobs

    assignJobs(state, DEFS);
    const assigned = state.survivors.filter((s) => s.buildingId !== null);
    expect(assigned).toHaveLength(2);
  });
});

describe('assignJobs building priority', () => {
  it('fills the high-priority building first within the same category', () => {
    const state = mkState();
    const normal = mkBuilding(state, 'well', DEFS.well);
    const high = mkBuilding(state, 'well', DEFS.well, 2, 0);
    high.priority = 2; // alta
    mkSurvivor(state);

    assignJobs(state, DEFS);
    expect(high.workers).toHaveLength(1);
    expect(normal.workers).toHaveLength(0);
  });

  it('treats a missing priority as normal (retrocompat)', () => {
    const state = mkState();
    const legacy = mkBuilding(state, 'well', DEFS.well); // nessun campo priority
    const normal = mkBuilding(state, 'well', DEFS.well, 2, 0);
    normal.priority = 1;
    const low = mkBuilding(state, 'well', DEFS.well, 4, 0);
    low.priority = 0; // bassa
    mkSurvivor(state);
    mkSurvivor(state);

    assignJobs(state, DEFS);
    // legacy e normal pareggiano (priorità 1): vince l'id più basso.
    expect(legacy.workers).toHaveLength(1);
    expect(normal.workers).toHaveLength(1);
    expect(low.workers).toHaveLength(0);
  });

  it('is deterministic at full ties: lowest building id first', () => {
    const state = mkState();
    const first = mkBuilding(state, 'well', DEFS.well);
    const second = mkBuilding(state, 'well', DEFS.well, 2, 0);
    first.priority = 2;
    second.priority = 2;
    mkSurvivor(state);

    assignJobs(state, DEFS);
    expect(first.workers).toHaveLength(1);
    expect(second.workers).toHaveLength(0);
  });

  it('lets a high-priority building jump the category order', () => {
    const state = mkState();
    const farm = mkBuilding(state, 'farm', DEFS.farm); // categoria cibo (prima)
    const workshop = mkBuilding(state, 'workshop', DEFS.workshop, 2, 0);
    workshop.priority = 2; // alta priorità: passa avanti
    mkSurvivor(state);

    assignJobs(state, DEFS);
    expect(workshop.workers).toHaveLength(1);
    expect(farm.workers).toHaveLength(0);
  });
});

describe('manual worker assignment', () => {
  it('assignWorker moves one idle survivor and disables autoAssign', () => {
    const state = mkState();
    const s = mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);

    expect(assignWorker(state, farm.id, DEFS)).toBe(true);
    expect(farm.autoAssign).toBe(false);
    expect(farm.workers).toEqual([s.id]);
    expect(s.buildingId).toBe(farm.id);
    expect(idleCount(state)).toBe(0);
  });

  it('assignWorker fails with no idle survivor or no free slot', () => {
    const state = mkState();
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    expect(assignWorker(state, farm.id, DEFS)).toBe(false); // no survivors

    const s1 = mkSurvivor(state);
    const s2 = mkSurvivor(state);
    assignWorker(state, farm.id, DEFS);
    assignWorker(state, farm.id, DEFS);
    expect(farm.workers).toEqual([s1.id, s2.id]); // full (2 jobs)
    mkSurvivor(state); // idle, but no free slot
    expect(assignWorker(state, farm.id, DEFS)).toBe(false);
  });

  it('assignWorker fails for buildings without jobs', () => {
    const state = mkState();
    mkSurvivor(state);
    const house = mkBuilding(state, 'house', DEFS.house);
    expect(assignWorker(state, house.id, DEFS)).toBe(false);
  });

  it('unassignWorker frees the last worker and disables autoAssign', () => {
    const state = mkState();
    const s1 = mkSurvivor(state);
    const s2 = mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    assignWorker(state, farm.id, DEFS);
    assignWorker(state, farm.id, DEFS);

    expect(unassignWorker(state, farm.id)).toBe(true);
    expect(farm.workers).toEqual([s1.id]);
    expect(s2.buildingId).toBeNull();
    expect(farm.autoAssign).toBe(false);
    expect(idleCount(state)).toBe(1);
  });

  it('unassignWorker fails on an empty building', () => {
    const state = mkState();
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    expect(unassignWorker(state, farm.id)).toBe(false);
  });

  it('assignJobs leaves manually staffed buildings alone', () => {
    const state = mkState();
    const manual = mkSurvivor(state);
    mkSurvivor(state); // stays idle: no other open slots
    const farm = mkBuilding(state, 'farm', DEFS.farm); // 2 jobs
    assignWorker(state, farm.id, DEFS);
    expect(manual.buildingId).toBe(farm.id);

    assignJobs(state, DEFS);
    expect(farm.workers).toEqual([manual.id]); // not topped up automatically
    expect(idleCount(state)).toBe(1);
  });

  it('assignWorker refuses a switched-off building', () => {
    const state = mkState();
    mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    farm.enabled = false;

    expect(assignWorker(state, farm.id, DEFS)).toBe(false);
    expect(farm.workers).toHaveLength(0);
    expect(state.survivors[0].buildingId).toBeNull();
  });
});

describe('unassignAll and setBuildingEnabled', () => {
  it('unassignAll frees every worker and returns the count', () => {
    const state = mkState();
    const s1 = mkSurvivor(state);
    const s2 = mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm); // 2 jobs
    assignWorker(state, farm.id, DEFS);
    assignWorker(state, farm.id, DEFS);

    expect(unassignAll(state, farm.id)).toBe(2);
    expect(farm.workers).toHaveLength(0);
    expect(s1.buildingId).toBeNull();
    expect(s2.buildingId).toBeNull();
    expect(idleCount(state)).toBe(2);
    // autoAssign resta com'era (assignWorker l'aveva spenta).
    expect(farm.autoAssign).toBe(false);
  });

  it('unassignAll is a no-op on unknown buildings', () => {
    const state = mkState();
    expect(unassignAll(state, 999)).toBe(0);
  });

  it('switching off frees the workers and assignJobs does not refill them', () => {
    const state = mkState();
    mkSurvivor(state);
    mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm); // autoAssign on
    assignJobs(state, DEFS);
    expect(farm.workers).toHaveLength(2);

    setBuildingEnabled(state, farm, false);
    expect(farm.enabled).toBe(false);
    expect(farm.workers).toHaveLength(0);
    expect(idleCount(state)).toBe(2);
    expect(farm.autoAssign).toBe(true); // la preferenza resta

    assignJobs(state, DEFS); // spento: nessuna riassegnazione
    expect(farm.workers).toHaveLength(0);
  });

  it('switching back on lets assignJobs staff the building again', () => {
    const state = mkState();
    mkSurvivor(state);
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    setBuildingEnabled(state, farm, false);
    setBuildingEnabled(state, farm, true);
    expect(farm.enabled).toBe(true);

    assignJobs(state, DEFS);
    expect(farm.workers).toHaveLength(1);
  });
});

describe('housing and recruitment', () => {
  it('housingCapacity sums houses over buildings', () => {
    const state = mkState();
    mkBuilding(state, 'house', DEFS.house);
    mkBuilding(state, 'house', DEFS.house, 2, 0);
    mkBuilding(state, 'farm', DEFS.farm, 4, 0);
    expect(housingCapacity(state, DEFS)).toBe(6);
  });

  it('recruits one survivor with food, water and a free bed, firing an event', () => {
    const state = mkState();
    mkBuilding(state, 'house', DEFS.house);
    const recruited = tryRecruit(state, DEFS);
    expect(recruited).toHaveLength(1);
    expect(state.survivors).toHaveLength(1);
    expect(state.events.some((e) => e.type === 'recruit')).toBe(true);
  });

  it('refuses recruitment without enough food', () => {
    const state = mkState();
    state.resources.food = 30; // needs strictly more than 30
    mkBuilding(state, 'house', DEFS.house);
    expect(tryRecruit(state, DEFS)).toEqual([]);
  });

  it('refuses recruitment without enough water', () => {
    const state = mkState();
    state.resources.water = 20; // needs strictly more than 20
    mkBuilding(state, 'house', DEFS.house);
    expect(tryRecruit(state, DEFS)).toEqual([]);
  });

  it('refuses recruitment when all beds are taken', () => {
    const state = mkState();
    mkBuilding(state, 'house', DEFS.house); // 3 beds
    mkSurvivor(state);
    mkSurvivor(state);
    mkSurvivor(state);
    expect(tryRecruit(state, DEFS)).toEqual([]);
  });

  it('recruits up to count survivors while the gates hold', () => {
    const state = mkState();
    mkBuilding(state, 'house', DEFS.house); // 3 beds
    mkBuilding(state, 'house', DEFS.house, 2, 0); // 3 more
    const recruited = tryRecruit(state, DEFS, 3);
    expect(recruited).toHaveLength(3);
    expect(state.survivors).toHaveLength(3);
    expect(state.events.filter((e) => e.type === 'recruit')).toHaveLength(3);
  });

  it('stops at the first failed gate: beds run out before count', () => {
    const state = mkState();
    mkBuilding(state, 'house', DEFS.house); // 3 beds
    mkSurvivor(state); // one bed already taken
    const recruited = tryRecruit(state, DEFS, 3);
    expect(recruited).toHaveLength(2);
    expect(state.survivors).toHaveLength(3);
  });

  it('recruits nobody with count > 1 when food is short', () => {
    const state = mkState();
    state.resources.food = 30;
    mkBuilding(state, 'house', DEFS.house);
    expect(tryRecruit(state, DEFS, 3)).toEqual([]);
  });
});

describe('killBuildingWorkers', () => {
  it('rimuove i lavoratori dell\'edificio e ritorna il conteggio', () => {
    const state = mkState();
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    const well = mkBuilding(state, 'well', DEFS.well, 2, 0);
    const s1 = mkSurvivor(state);
    const s2 = mkSurvivor(state);
    const s3 = mkSurvivor(state); // lavora altrove
    s1.buildingId = farm.id;
    farm.workers.push(s1.id);
    s2.buildingId = farm.id;
    farm.workers.push(s2.id);
    s3.buildingId = well.id;
    well.workers.push(s3.id);

    expect(killBuildingWorkers(state, farm)).toBe(2);
    expect(state.survivors).toEqual([s3]);
    expect(farm.workers).toHaveLength(0);
    expect(well.workers).toEqual([s3.id]); // gli altri edifici restano intatti
    // Nessun evento di morte singolo: le perdite le racconta il chiamante
    // (combat.js arricchisce l'evento di distruzione).
    expect(state.events).toHaveLength(0);
  });

  it('ritorna 0 e non tocca niente su un edificio senza lavoratori', () => {
    const state = mkState();
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    mkSurvivor(state); // inattivo
    expect(killBuildingWorkers(state, farm)).toBe(0);
    expect(state.survivors).toHaveLength(1);
    expect(farm.workers).toHaveLength(0);
  });

  it('conta solo i sopravvissuti esistenti (ignora ref pendenti)', () => {
    const state = mkState();
    const farm = mkBuilding(state, 'farm', DEFS.farm);
    farm.workers.push(999); // id senza sopravvissuto corrispondente
    expect(killBuildingWorkers(state, farm)).toBe(0);
    expect(farm.workers).toHaveLength(0);
    expect(state.survivors).toHaveLength(0);
  });
});
