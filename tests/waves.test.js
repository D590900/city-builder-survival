import { describe, it, expect } from 'vitest';
import { waveForNight, spawnPlan } from '../src/sim/waves.js';
import { CONFIG } from '../src/sim/state.js';

describe('waveForNight', () => {
  it('matches the scaling formulas for night 1', () => {
    expect(waveForNight(1)).toEqual({
      count: 5,
      hp: 26,
      damage: 4,
      speed: 1.5,
      spawnInterval: 1.85,
    });
  });

  it('scales monotonically with the night number', () => {
    let prev = waveForNight(1);
    for (let n = 2; n <= 12; n++) {
      const w = waveForNight(n);
      expect(w.count).toBeGreaterThan(prev.count);
      expect(w.hp).toBeGreaterThan(prev.hp);
      expect(w.damage).toBeGreaterThan(prev.damage);
      expect(w.spawnInterval).toBeLessThanOrEqual(prev.spawnInterval);
      prev = w;
    }
  });

  it('keeps the linear branch unchanged up to night 12', () => {
    expect(waveForNight(12).count).toBe(3 + 12 * 2); // 27
    expect(waveForNight(12).hp).toBe(20 + 12 * 6); // 92
    expect(waveForNight(12).damage).toBe(3 + 12); // 15
  });

  it('keeps growing (non-decreasing) past night 12, up to night 50', () => {
    let prev = waveForNight(12);
    for (let n = 13; n <= 50; n++) {
      const w = waveForNight(n);
      expect(w.count).toBeGreaterThanOrEqual(prev.count);
      expect(w.hp).toBeGreaterThanOrEqual(prev.hp);
      expect(w.damage).toBeGreaterThanOrEqual(prev.damage);
      prev = w;
    }
  });

  it('grows sub-linearly past night 12 (dampened scaling)', () => {
    expect(waveForNight(40).count).toBeLessThan(3 + 2 * 40);
    expect(waveForNight(40).hp).toBeLessThan(20 + 6 * 40);
    expect(waveForNight(40).damage).toBeLessThan(3 + 40);
  });

  it('keeps spawnInterval above its floor', () => {
    for (let n = 1; n <= 50; n++) {
      expect(waveForNight(n).spawnInterval).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe('spawnPlan', () => {
  it('covers the total wave count for several nights', () => {
    for (const n of [1, 2, 3, 5, 10]) {
      const plan = spawnPlan(n, CONFIG.nightLength);
      const total = plan.reduce((sum, batch) => sum + batch.count, 0);
      expect(total).toBe(waveForNight(n).count);
    }
  });

  it('schedules batches in ascending time within the night', () => {
    const plan = spawnPlan(5, CONFIG.nightLength);
    let prevT = -1;
    for (const batch of plan) {
      expect(batch.t).toBeGreaterThan(prevT);
      expect(batch.t).toBeGreaterThanOrEqual(0);
      expect(batch.t).toBeLessThanOrEqual(CONFIG.nightLength);
      expect(batch.count).toBeGreaterThan(0);
      prevT = batch.t;
    }
  });

  it('concentrates the wave toward the middle/end of the night', () => {
    const plan = spawnPlan(10, CONFIG.nightLength);
    const midpoint = CONFIG.nightLength / 2;
    const lateCount = plan
      .filter((batch) => batch.t >= midpoint)
      .reduce((sum, batch) => sum + batch.count, 0);
    expect(lateCount).toBeGreaterThan(waveForNight(10).count / 2);
  });
});
