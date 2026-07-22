// Gameplay modifiers: the current weather and every researched tech folded
// into a single multiplier set. Pure logic, no I/O.

import { TECHS } from './research.js';
import { WEATHERS } from './weather.js';

export const DEFAULT_MODS = {
  farmProd: 1,
  rainProd: 1,
  solarProd: 1,
  windProd: 1,
  extractProd: 1,
  hungerRate: 1,
  thirstRate: 1,
  towerDamage: 1,
  towerRangeMul: 1,
  garrisonDamage: 1,
  zombieSpeed: 1,
  fogMul: 1,
  darkenMul: 1,
  recruitBonus: 0,
};

// Multiplies each effect into the accumulator; unknown keys pass through.
function applyEffects(mods, effects) {
  for (const [key, value] of Object.entries(effects ?? {})) {
    mods[key] = (mods[key] ?? 1) * value;
  }
}

// Merges WEATHERS[state.weather.current].mods with the effects of every tech
// in state.researched on top of DEFAULT_MODS. A staffed clinic (defId
// 'clinic' with at least one worker, switched on) slows hunger and thirst by
// 15%; every staffed switched-on radio (defId 'radio') adds +1 to
// recruitBonus (extra survivor at each dawn). The three powered auras —
// spotlight (towers +20% damage), streetlamp (garrison/militia +25% damage),
// motor (extractors +25% output) — apply while their building stands
// switched on and the grid holds charge (energy > 0); they never stack with
// copies of themselves. Three logistics auras follow instead:
// - road: +2% extractProd per road tile standing (roads cannot be switched
//   off, so every copy counts), additive, capped at +40%;
// - trail (dirt paths trampled by idle survivors, see sim/trails.js):
//   +0.5% extractProd per trail tile on the grid, additive, capped at
//   +15% — a separate cap from the road bonus, summed right after it; the
//   tiles are counted on the grid passed as the optional `grid` argument
//   (without it the bonus is 0, so old call sites keep working);
// - garage: ×1.5 extractProd while at least one garage is switched on and
//   staffed; never stacks with copies of itself. The condition mirrors the
//   staff, not the fuel stock: without fuel the garage stalls via the
//   regular `consumes` pattern in tickEconomy, while the aura stays nominal
//   (the vehicles are assumed ready in the depot);
// - ranch: +15% farmProd and +10% extractProd per staffed switched-on ranch
//   (working animals), additive, capped at +45% / +30%.
// Missing/unknown weather and tech ids are ignored.
// Never mutates DEFAULT_MODS.
// `grid` is optional: only the trail bonus reads it (grid.cells scan).
export function getModifiers(state, grid) {
  const mods = { ...DEFAULT_MODS };
  applyEffects(mods, WEATHERS[state.weather?.current ?? 'clear']?.mods);
  for (const id of state.researched ?? []) {
    applyEffects(mods, TECHS[id]?.effects);
  }
  const clinicActive = (state.buildings ?? []).some(
    (b) => b.defId === 'clinic' && b.enabled !== false && (b.workers?.length ?? 0) > 0
  );
  if (clinicActive) {
    mods.hungerRate *= 0.85;
    mods.thirstRate *= 0.85;
  }
  let ranchCount = 0;
  let roadCount = 0;
  let garageActive = false;
  for (const b of state.buildings ?? []) {
    const staffed = (b.workers?.length ?? 0) > 0;
    if (b.defId === 'radio' && b.enabled !== false && staffed) {
      mods.recruitBonus += 1;
    } else if (b.defId === 'ranch' && b.enabled !== false && staffed) {
      ranchCount += 1;
    } else if (b.defId === 'road') {
      roadCount += 1; // le strade non si spengono: contano tutte
    } else if (b.defId === 'garage' && b.enabled !== false && staffed) {
      garageActive = true;
    }
  }
  // Sentieri sterrati: +0.5% per tile 'trail' sulla griglia (tetto +15%).
  let trailCount = 0;
  for (const row of grid?.cells ?? []) {
    for (const cell of row) {
      if (cell.type === 'trail') trailCount += 1;
    }
  }
  // Auree elettriche (non impilabili): servono l'edificio acceso e la rete
  // carica — rete scarica, niente bonus.
  const gridCharged = (state.resources?.energy ?? 0) > 0;
  const auraActive = (defId) =>
    gridCharged &&
    (state.buildings ?? []).some((b) => b.defId === defId && b.enabled !== false);
  if (auraActive('spotlight')) mods.towerDamage *= 1.2;
  if (auraActive('streetlamp')) mods.garrisonDamage *= 1.25;
  if (auraActive('motor')) mods.extractProd *= 1.25;
  // Auree logistiche: strade, sentieri e allevamenti danno bonus additivi
  // con tetto, l'autorimessa un moltiplicatore che non si cumula.
  mods.extractProd += Math.min(0.4, roadCount * 0.02);
  mods.extractProd += Math.min(0.15, trailCount * 0.005);
  if (garageActive) mods.extractProd *= 1.5;
  mods.farmProd += Math.min(0.45, ranchCount * 0.15);
  mods.extractProd += Math.min(0.3, ranchCount * 0.1);
  return mods;
}
