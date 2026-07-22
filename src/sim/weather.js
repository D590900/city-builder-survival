// Daily weather: deterministic per (mapSeed, day) roll plus the modifier
// table consumed by getModifiers(). Pure logic, no I/O.

export const WEATHERS = {
  clear: { name: 'Sereno', icon: '☀️', weight: 40, mods: {} },
  rain: {
    name: 'Pioggia',
    icon: '🌧️',
    weight: 25,
    mods: { rainProd: 2, farmProd: 1.25, windProd: 1.25, fogMul: 1.5, zombieSpeed: 0.95 },
  },
  storm: {
    name: 'Tempesta',
    icon: '⛈️',
    weight: 10,
    mods: { rainProd: 3, solarProd: 0.5, windProd: 2, towerRangeMul: 0.75, zombieSpeed: 0.85, fogMul: 2 },
  },
  fog: {
    name: 'Nebbia',
    icon: '🌫️',
    weight: 15,
    mods: { fogMul: 3.5, towerRangeMul: 0.7 },
  },
  heat: {
    name: 'Ondata di calore',
    icon: '🔥',
    weight: 10,
    mods: { thirstRate: 1.5, rainProd: 0.25, farmProd: 0.75, solarProd: 1.25, windProd: 0.75 },
  },
};

// mulberry32: tiny seeded PRNG. Returns a function yielding floats in [0, 1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic weather id for a (day, seed) pair: the same map seed always
// replays the same forecast. The day is mixed into the seed so consecutive
// days draw independent rolls.
export function rollWeatherForDay(day, seed) {
  const mixed = ((seed >>> 0) ^ Math.imul(day >>> 0, 0x9e3779b9)) >>> 0;
  const rand = mulberry32(mixed);
  const totalWeight = Object.values(WEATHERS).reduce((sum, w) => sum + w.weight, 0);
  let roll = rand() * totalWeight;
  for (const [id, w] of Object.entries(WEATHERS)) {
    roll -= w.weight;
    if (roll < 0) return id;
  }
  return 'clear';
}

// Call at the start of each day: sets state.weather.current from the map
// seed (defaults to 0 when absent). Returns the new weather id.
export function advanceWeather(state) {
  state.weather = state.weather ?? {};
  state.weather.current = rollWeatherForDay(state.day ?? 1, state.mapSeed ?? 0);
  return state.weather.current;
}
