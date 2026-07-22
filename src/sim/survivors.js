// Survivor lifecycle: hunger, thirst, eating, drinking, death, jobs,
// recruitment. Pure logic.

import { addSurvivor, pushEvent } from './state.js';

const DAY_LENGTH = 90; // seconds per game day (mirrors state.js CONFIG)
const STARVATION_DAYS = 1.5; // days from full to starved
const DEHYDRATION_DAYS = 1; // days from full to dead of thirst
const EAT_THRESHOLD = 50; // hunger above this triggers a meal
const DRINK_THRESHOLD = 50; // thirst above this triggers a drink
const EAT_AMOUNT = 40; // hunger restored per unit of food
const DRINK_AMOUNT = 40; // thirst restored per unit of water
const RECRUIT_MIN_FOOD = 30; // food stock required to attract a survivor
const RECRUIT_MIN_WATER = 20; // water stock required to attract a survivor

// Advances hunger/thirst and resolves eating, drinking and death for dt
// seconds. mods (optional) scales the hunger/thirst rates via
// mods.hungerRate / mods.thirstRate.
export function tickSurvivors(state, dt, mods) {
  const hungerGain = (100 * dt * (mods?.hungerRate ?? 1)) / (STARVATION_DAYS * DAY_LENGTH);
  const thirstGain = (100 * dt * (mods?.thirstRate ?? 1)) / (DEHYDRATION_DAYS * DAY_LENGTH);
  const starved = [];
  const dehydrated = [];
  for (const s of state.survivors) {
    s.hunger += hungerGain;
    s.thirst = (s.thirst ?? 0) + thirstGain;
    if (s.hunger > EAT_THRESHOLD && (state.resources.food ?? 0) >= 1) {
      state.resources.food -= 1;
      s.hunger = Math.max(0, s.hunger - EAT_AMOUNT);
    }
    if (s.thirst > DRINK_THRESHOLD && (state.resources.water ?? 0) >= 1) {
      state.resources.water -= 1;
      s.thirst = Math.max(0, s.thirst - DRINK_AMOUNT);
    }
    if (s.hunger >= 100) starved.push(s);
    else if (s.thirst >= 100) dehydrated.push(s);
  }
  bury(state, starved, (s) => `Il sopravvissuto #${s.id} è morto di fame.`);
  bury(state, dehydrated, (s) => `Il sopravvissuto #${s.id} è morto di sete.`);
}

// Removes dead survivors from the colony and from every job slot,
// emitting one death event each. Every death weighs on the colony's
// reputation (see tickReputation).
function bury(state, dead, message) {
  if (dead.length === 0) return;
  const deadIds = new Set(dead.map((s) => s.id));
  state.survivors = state.survivors.filter((s) => !deadIds.has(s.id));
  for (const b of state.buildings) {
    b.workers = b.workers.filter((id) => !deadIds.has(id));
  }
  for (const s of dead) {
    pushEvent(state, 'death', message(s));
  }
  state.deathsToday = (state.deathsToday ?? 0) + dead.length;
}

// Uccide tutti i sopravvissuti che lavorano nell'edificio b (muoiono con
// lui quando viene distrutto): stessa pulizia di bury() — gli id spariscono
// da state.survivors e da ogni workers — ma senza eventi di morte singoli:
// le perdite le racconta il chiamante (combat.js arricchisce l'evento di
// distruzione). Il buildingId dei morti non serve ripulirlo: l'edificio
// sparisce subito dopo. Le morti pesano sulla reputazione come le altre.
// Ritorna quanti sopravvissuti sono morti davvero.
export function killBuildingWorkers(state, b) {
  if (!b || b.workers.length === 0) return 0;
  const deadIds = new Set(b.workers);
  const before = state.survivors.length;
  state.survivors = state.survivors.filter((s) => !deadIds.has(s.id));
  for (const other of state.buildings) {
    other.workers = other.workers.filter((id) => !deadIds.has(id));
  }
  const dead = before - state.survivors.length;
  state.deathsToday = (state.deathsToday ?? 0) + dead;
  return dead;
}

// Lower number = assigned first: food, then water, then extractors, then
// research labs, then everything else.
function jobPriority(def) {
  if (def.produces?.food) return 0;
  if (def.produces?.water) return 1;
  if (def.extracts) return 2;
  if (def.researchRate > 0) return 3;
  return 4;
}

// Assigns idle survivors to buildings with free job slots, skipping
// manually managed buildings (autoAssign === false).
// Also reconciles stale references (dead workers, demolished buildings).
export function assignJobs(state, DEFS) {
  const survivorsById = new Map(state.survivors.map((s) => [s.id, s]));

  // Drop worker references that no longer point back to this building.
  for (const b of state.buildings) {
    b.workers = b.workers.filter((id) => survivorsById.get(id)?.buildingId === b.id);
  }

  // Survivors pointing at a gone/inconsistent building become idle.
  const buildingIds = new Set(state.buildings.map((b) => b.id));
  const idle = [];
  for (const s of state.survivors) {
    if (s.buildingId === null || !buildingIds.has(s.buildingId)) {
      s.buildingId = null;
      idle.push(s);
    }
  }

  // Ordine di assegnazione: prima la priorità per-edificio (alta → bassa;
  // assente = normale, retrocompatibile coi vecchi save), poi la categoria
  // (jobPriority), poi l'id — stabile e deterministico.
  const open = state.buildings
    .filter((b) => {
      if (b.autoAssign === false) return false; // manually managed
      if (b.enabled === false) return false; // spento: niente personale
      const def = DEFS[b.defId];
      return def && def.jobs > 0 && b.workers.length < def.jobs;
    })
    .sort((a, b) => {
      const byPriority = (b.priority ?? 1) - (a.priority ?? 1);
      if (byPriority !== 0) return byPriority;
      const byCategory = jobPriority(DEFS[a.defId]) - jobPriority(DEFS[b.defId]);
      if (byCategory !== 0) return byCategory;
      return a.id - b.id;
    });

  for (const b of open) {
    const def = DEFS[b.defId];
    while (b.workers.length < def.jobs && idle.length > 0) {
      const s = idle.shift();
      s.buildingId = b.id;
      b.workers.push(s.id);
    }
    if (idle.length === 0) break;
  }
}

// Manually assigns one idle survivor to a building with a free job slot and
// switches the building to manual management (autoAssign = false).
// Refuses switched-off buildings. Returns true on success.
export function assignWorker(state, buildingId, DEFS) {
  const b = state.buildings.find((x) => x.id === buildingId);
  const def = b && DEFS[b.defId];
  if (!def || !(def.jobs > 0) || b.workers.length >= def.jobs) return false;
  if (b.enabled === false) return false; // spento: niente personale
  const buildingIds = new Set(state.buildings.map((x) => x.id));
  const s = state.survivors.find(
    (x) => x.buildingId === null || !buildingIds.has(x.buildingId)
  );
  if (!s) return false;
  b.autoAssign = false;
  s.buildingId = b.id;
  b.workers.push(s.id);
  return true;
}

// Manually removes the most recently assigned worker from a building
// (making them idle) and switches it to manual management.
// Returns true on success.
export function unassignWorker(state, buildingId) {
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b || b.workers.length === 0) return false;
  b.autoAssign = false;
  const id = b.workers.pop();
  const s = state.survivors.find((x) => x.id === id);
  if (s) s.buildingId = null;
  return true;
}

// Removes every worker from a building (they all become idle). Used when a
// building is switched off; autoAssign is left untouched, so an automatic
// building staffs itself again once switched back on.
// Returns the number of freed workers.
export function unassignAll(state, buildingId) {
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b) return 0;
  const freed = b.workers.length;
  for (const id of b.workers) {
    const s = state.survivors.find((x) => x.id === id);
    if (s) s.buildingId = null;
  }
  b.workers = [];
  return freed;
}

// Switches a building on (on !== false) or off. Turning off frees every
// worker (they go idle and the automatic assignment redistributes them);
// a switched-off building is inert (no production, no fuel, no fire).
// Returns true on success.
export function setBuildingEnabled(state, b, on) {
  if (!b) return false;
  b.enabled = on !== false;
  if (!b.enabled) unassignAll(state, b.id);
  return true;
}

// Number of survivors without a job.
export function idleCount(state) {
  return state.survivors.filter((s) => s.buildingId === null).length;
}

// Total beds provided by all standing buildings.
export function housingCapacity(state, DEFS) {
  let total = 0;
  for (const b of state.buildings) {
    total += DEFS[b.defId]?.houses ?? 0;
  }
  return total;
}

// Called at the start of each day: up to `count` survivors join, one at a
// time; the gates (enough food, enough water, a free bed) are re-checked
// after every recruit, so the loop stops at the first failed gate.
// Returns the recruits (empty array when nobody joins).
export function tryRecruit(state, DEFS, count = 1) {
  const recruited = [];
  for (let i = 0; i < count; i++) {
    if ((state.resources.food ?? 0) <= RECRUIT_MIN_FOOD) break;
    if ((state.resources.water ?? 0) <= RECRUIT_MIN_WATER) break;
    if (state.survivors.length >= housingCapacity(state, DEFS)) break;
    const s = addSurvivor(state);
    pushEvent(state, 'recruit', `Un nuovo sopravvissuto si è unito alla colonia. (#${s.id})`);
    recruited.push(s);
  }
  return recruited;
}

// Reputazione dell'insediamento (0-100), aggiornata all'alba prima del
// reclutamento: +4 per la notte superata, +2 per ogni Radio staffata e
// accesa, −10 per ogni morto del giorno appena finito (deathsToday, poi
// azzerato). Ritorna il nuovo valore.
export function tickReputation(state) {
  const staffedRadios = (state.buildings ?? []).filter(
    (b) => b.defId === 'radio' && b.enabled !== false && (b.workers?.length ?? 0) > 0
  ).length;
  const next =
    (state.reputation ?? 0) + 4 + 2 * staffedRadios - 10 * (state.deathsToday ?? 0);
  state.reputation = Math.min(100, Math.max(0, next));
  state.deathsToday = 0;
  return state.reputation;
}

// Quante reclute provare ad accogliere all'alba: una di base, più i bonus
// delle Radio (mods.recruitBonus), più una ogni 25 punti reputazione (0-4).
// I gate (cibo/acqua/letti) restano per-recluta, in tryRecruit.
export function recruitCount(state, mods) {
  return 1 + (mods?.recruitBonus ?? 0) + Math.floor((state.reputation ?? 0) / 25);
}
