import { describe, it, expect } from 'vitest';
import { WEATHERS, rollWeatherForDay, advanceWeather } from '../src/sim/weather.js';

describe('WEATHERS table', () => {
  it('matches the v3 contract', () => {
    expect(Object.keys(WEATHERS).sort()).toEqual(['clear', 'fog', 'heat', 'rain', 'storm']);
    expect(WEATHERS.clear).toMatchObject({ name: 'Clear', icon: '☀️', weight: 40, mods: {} });
    expect(WEATHERS.rain.mods).toEqual({
      rainProd: 2,
      farmProd: 1.25,
      windProd: 1.25,
      fogMul: 1.5,
      zombieSpeed: 0.95,
    });
    expect(WEATHERS.storm.mods).toEqual({
      rainProd: 3,
      solarProd: 0.5,
      windProd: 2,
      towerRangeMul: 0.75,
      zombieSpeed: 0.85,
      fogMul: 2,
    });
    expect(WEATHERS.fog.mods).toEqual({ fogMul: 3.5, towerRangeMul: 0.7 });
    expect(WEATHERS.heat.mods).toEqual({
      thirstRate: 1.5,
      rainProd: 0.25,
      farmProd: 0.75,
      solarProd: 1.25,
      windProd: 0.75,
    });
  });

  it('has weights summing to 100 and a name/icon for each weather', () => {
    const total = Object.values(WEATHERS).reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBe(100);
    for (const w of Object.values(WEATHERS)) {
      expect(w.name.length).toBeGreaterThan(0);
      expect(w.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('rollWeatherForDay', () => {
  it('is deterministic for the same (day, seed) pair', () => {
    for (let day = 1; day <= 20; day++) {
      expect(rollWeatherForDay(day, 1234)).toBe(rollWeatherForDay(day, 1234));
    }
  });

  it('always returns a valid weather id', () => {
    for (let day = 1; day <= 200; day++) {
      expect(WEATHERS[rollWeatherForDay(day, 7)]).toBeDefined();
    }
  });

  it('varies across days and seeds', () => {
    const byDay = new Set();
    for (let day = 1; day <= 50; day++) byDay.add(rollWeatherForDay(day, 3));
    expect(byDay.size).toBeGreaterThan(1);
    const bySeed = new Set();
    for (let seed = 0; seed < 50; seed++) bySeed.add(rollWeatherForDay(1, seed));
    expect(bySeed.size).toBeGreaterThan(1);
  });

  it('follows the weights: clear is the most common outcome', () => {
    const counts = {};
    for (let day = 1; day <= 1000; day++) {
      const id = rollWeatherForDay(day, 42);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts.clear).toBeGreaterThan(counts.storm);
    expect(counts.clear).toBeGreaterThan(counts.heat);
  });
});

describe('advanceWeather', () => {
  it('sets state.weather.current from day and mapSeed', () => {
    const state = { day: 5, mapSeed: 42, weather: { current: 'clear' } };
    const id = advanceWeather(state);
    expect(state.weather.current).toBe(id);
    expect(id).toBe(rollWeatherForDay(5, 42));
  });

  it('defaults mapSeed to 0 and creates the weather object if missing', () => {
    const state = { day: 3 };
    const id = advanceWeather(state);
    expect(id).toBe(rollWeatherForDay(3, 0));
    expect(state.weather.current).toBe(id);
  });

  it('is deterministic across a whole playthrough', () => {
    const a = { day: 1, mapSeed: 99 };
    const b = { day: 1, mapSeed: 99 };
    for (let day = 1; day <= 15; day++) {
      a.day = day;
      b.day = day;
      expect(advanceWeather(a)).toBe(advanceWeather(b));
    }
  });
});
