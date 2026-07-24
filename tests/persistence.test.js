import { describe, it, expect } from 'vitest';
import { restoreSave } from '../src/persistence.js';

// Minimal valid v4 save: a Refuge (required) plus, by default, a warehouse
// (capBonus wood +100). Resources carry wood above the 150 base cap.
function mkSave(overrides = {}) {
  return {
    version: 4,
    seed: 42,
    day: 3,
    resources: { wood: 200 },
    survivors: [],
    buildings: [
      { defId: 'hq', x: 30, z: 30 },
      { defId: 'warehouse', x: 20, z: 20 },
    ],
    changedTiles: [],
    ...overrides,
  };
}

describe('restoreSave resources', () => {
  it('keeps resources above the base cap when storage raises it', () => {
    const { state } = restoreSave(mkSave());
    expect(state.resources.wood).toBe(200); // effective cap 250
  });

  it('clamps resources to the base cap without storage buildings', () => {
    const save = mkSave({ buildings: [{ defId: 'hq', x: 30, z: 30 }] });
    const { state } = restoreSave(save);
    expect(state.resources.wood).toBe(150);
  });

  it('clamps restored resources to the effective cap', () => {
    const save = mkSave({ resources: { wood: 999 } });
    const { state } = restoreSave(save);
    expect(state.resources.wood).toBe(250);
  });

  it('clamps negative restored resources to zero', () => {
    const save = mkSave({ resources: { wood: -10 } });
    const { state } = restoreSave(save);
    expect(state.resources.wood).toBe(0);
  });
});
