import { describe, it, expect } from 'vitest';
import { DEFAULT_MODS, getModifiers } from '../src/sim/modifiers.js';

function mkState(overrides = {}) {
  return {
    weather: { current: 'clear' },
    researched: [],
    ...overrides,
  };
}

describe('DEFAULT_MODS', () => {
  it('matches the v3 contract', () => {
    expect(DEFAULT_MODS).toEqual({
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
    });
  });
});

describe('getModifiers', () => {
  it('returns the defaults under clear weather with no techs', () => {
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS);
  });

  it('defaults to clear when state.weather is missing or unknown', () => {
    expect(getModifiers({ researched: [] })).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState({ weather: { current: 'bogus' } }))).toEqual(DEFAULT_MODS);
  });

  it('applies the current weather mods', () => {
    const mods = getModifiers(mkState({ weather: { current: 'rain' } }));
    expect(mods.rainProd).toBe(2);
    expect(mods.farmProd).toBe(1.25);
    expect(mods.fogMul).toBe(1.5);
    expect(mods.zombieSpeed).toBe(0.95);
    expect(mods.solarProd).toBe(1); // untouched
  });

  it('applies researched tech effects', () => {
    const mods = getModifiers(mkState({ researched: ['medicine'] }));
    expect(mods.hungerRate).toBeCloseTo(0.7);
    expect(mods.thirstRate).toBeCloseTo(0.7);
    expect(mods.farmProd).toBe(1);
  });

  it('stacks weather and tech effects multiplicatively', () => {
    const mods = getModifiers(
      mkState({ weather: { current: 'storm' }, researched: ['ballistics', 'efficiency'] })
    );
    expect(mods.rainProd).toBe(3); // storm
    expect(mods.solarProd).toBe(0.5); // storm
    expect(mods.towerDamage).toBe(1.5); // ballistics
    expect(mods.towerRangeMul).toBeCloseTo(0.75 * 1.17); // storm * ballistics
    expect(mods.extractProd).toBe(1.25); // efficiency
  });

  it('heat slows rain production to a trickle and boosts solar', () => {
    const mods = getModifiers(mkState({ weather: { current: 'heat' } }));
    expect(mods.rainProd).toBe(0.25);
    expect(mods.solarProd).toBe(1.25);
    expect(mods.thirstRate).toBe(1.5);
  });

  it('ignores unknown tech ids and never mutates DEFAULT_MODS', () => {
    const mods = getModifiers(
      mkState({ weather: { current: 'rain' }, researched: ['nope', 'efficiency'] })
    );
    expect(mods.extractProd).toBe(1.25);
    expect(DEFAULT_MODS.rainProd).toBe(1);
    expect(DEFAULT_MODS.extractProd).toBe(1);
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS);
  });
});

describe('clinic aura', () => {
  const clinic = (workers) => ({ defId: 'clinic', workers });

  it('slows hunger and thirst by 15% with at least one worker', () => {
    const mods = getModifiers(mkState({ buildings: [clinic([7])] }));
    expect(mods.hungerRate).toBeCloseTo(0.85);
    expect(mods.thirstRate).toBeCloseTo(0.85);
  });

  it('does nothing without workers or without a clinic', () => {
    expect(getModifiers(mkState({ buildings: [clinic([])] }))).toEqual(DEFAULT_MODS);
    expect(
      getModifiers(mkState({ buildings: [{ defId: 'farm', workers: [1, 2] }] }))
    ).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState({ buildings: [] }))).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS); // no buildings field
  });

  it('stacks multiplicatively with weather and tech effects', () => {
    const mods = getModifiers(
      mkState({ researched: ['medicine'], buildings: [clinic([1])] })
    );
    expect(mods.hungerRate).toBeCloseTo(0.7 * 0.85);
    expect(mods.thirstRate).toBeCloseTo(0.7 * 0.85);
  });

  it('a single staffed clinic is enough among many buildings', () => {
    const mods = getModifiers(
      mkState({ buildings: [{ defId: 'house', workers: [] }, clinic([3]), { defId: 'clinic', workers: [] }] })
    );
    expect(mods.hungerRate).toBeCloseTo(0.85);
  });

  it('a switched-off clinic grants no aura', () => {
    const mods = getModifiers(
      mkState({ buildings: [{ defId: 'clinic', workers: [7], enabled: false }] })
    );
    expect(mods).toEqual(DEFAULT_MODS);
  });
});

describe('radio aura', () => {
  const radio = (workers) => ({ defId: 'radio', workers });

  it('adds +1 recruitBonus per staffed radio', () => {
    expect(getModifiers(mkState({ buildings: [radio([7])] })).recruitBonus).toBe(1);
    expect(getModifiers(mkState({ buildings: [radio([1]), radio([2, 3])] })).recruitBonus).toBe(2);
  });

  it('does nothing without workers or without a radio', () => {
    expect(getModifiers(mkState({ buildings: [radio([])] }))).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState({ buildings: [] }))).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS); // no buildings field
    // A staffed clinic does not affect recruitment.
    expect(
      getModifiers(mkState({ buildings: [{ defId: 'clinic', workers: [1] }] })).recruitBonus
    ).toBe(0);
  });

  it('stacks with the clinic aura and leaves the other mods untouched', () => {
    const mods = getModifiers(
      mkState({ buildings: [radio([1]), { defId: 'clinic', workers: [2] }] })
    );
    expect(mods.recruitBonus).toBe(1);
    expect(mods.hungerRate).toBeCloseTo(0.85);
    expect(mods.farmProd).toBe(1);
    expect(DEFAULT_MODS.recruitBonus).toBe(0); // never mutated
  });

  it('a switched-off radio grants no recruitBonus', () => {
    const mods = getModifiers(
      mkState({ buildings: [{ defId: 'radio', workers: [1], enabled: false }] })
    );
    expect(mods.recruitBonus).toBe(0);
  });
});

describe('powered auras (spotlight, streetlamp, motor)', () => {
  // Ogni aura richiede l'edificio acceso e la rete carica (energia > 0);
  // non si impila con copie di sé stessa.
  const charged = { energy: 10 };
  const aura = (defId, extra = {}) => ({ defId, workers: [], ...extra });

  it('spotlight boosts towerDamage by 20% while the grid is charged', () => {
    const mods = getModifiers(
      mkState({ resources: charged, buildings: [aura('spotlight')] })
    );
    expect(mods.towerDamage).toBeCloseTo(1.2);
  });

  it('streetlamp boosts garrisonDamage by 25% while the grid is charged', () => {
    const mods = getModifiers(
      mkState({ resources: charged, buildings: [aura('streetlamp')] })
    );
    expect(mods.garrisonDamage).toBeCloseTo(1.25);
  });

  it('motor boosts extractProd by 25% while the grid is charged', () => {
    const mods = getModifiers(
      mkState({ resources: charged, buildings: [aura('motor')] })
    );
    expect(mods.extractProd).toBeCloseTo(1.25);
  });

  it('does nothing without the building, with the grid drained or with no resources field', () => {
    expect(getModifiers(mkState({ resources: charged }))).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState({ buildings: [aura('spotlight')] }))).toEqual(DEFAULT_MODS);
    expect(
      getModifiers(mkState({ resources: { energy: 0 }, buildings: [aura('spotlight')] }))
    ).toEqual(DEFAULT_MODS);
    expect(
      getModifiers(mkState({ resources: { energy: 0 }, buildings: [aura('streetlamp')] }))
    ).toEqual(DEFAULT_MODS);
    expect(
      getModifiers(mkState({ resources: { energy: 0 }, buildings: [aura('motor')] }))
    ).toEqual(DEFAULT_MODS);
  });

  it('a switched-off aura building grants no bonus', () => {
    for (const defId of ['spotlight', 'streetlamp', 'motor']) {
      const mods = getModifiers(
        mkState({ resources: charged, buildings: [aura(defId, { enabled: false })] })
      );
      expect(mods, defId).toEqual(DEFAULT_MODS);
    }
  });

  it('auras do not stack with copies of themselves', () => {
    const mods = getModifiers(
      mkState({ resources: charged, buildings: [aura('spotlight'), aura('spotlight')] })
    );
    expect(mods.towerDamage).toBeCloseTo(1.2);
  });

  it('stack multiplicatively with weather and tech effects', () => {
    const mods = getModifiers(
      mkState({
        resources: charged,
        researched: ['ballistics', 'efficiency'],
        buildings: [aura('spotlight'), aura('motor')],
      })
    );
    expect(mods.towerDamage).toBeCloseTo(1.5 * 1.2); // ballistics × spotlight
    expect(mods.extractProd).toBeCloseTo(1.25 * 1.25); // efficiency × motor
    expect(mods.garrisonDamage).toBe(1); // no streetlamp
    expect(DEFAULT_MODS.towerDamage).toBe(1); // never mutated
  });
});

describe('road aura (logistica)', () => {
  const road = () => ({ defId: 'road', workers: [] });

  it('adds +2% extractProd per standing road', () => {
    expect(getModifiers(mkState({ buildings: [road()] })).extractProd).toBeCloseTo(1.02);
    expect(
      getModifiers(mkState({ buildings: [road(), road(), road()] })).extractProd
    ).toBeCloseTo(1.06);
  });

  it('caps at +40% no matter how many roads', () => {
    const buildings = Array.from({ length: 30 }, road);
    expect(getModifiers(mkState({ buildings })).extractProd).toBeCloseTo(1.4);
  });

  it('counts every road, even switched off (roads never turn off)', () => {
    const mods = getModifiers(mkState({ buildings: [{ defId: 'road', workers: [], enabled: false }] }));
    expect(mods.extractProd).toBeCloseTo(1.02);
  });

  it('does nothing without roads and never mutates DEFAULT_MODS', () => {
    expect(getModifiers(mkState({ buildings: [] }))).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS);
    expect(DEFAULT_MODS.extractProd).toBe(1);
  });

  it('stacks with the motor aura and the efficiency tech', () => {
    const mods = getModifiers(
      mkState({
        resources: { energy: 10 },
        researched: ['efficiency'],
        buildings: [{ defId: 'motor', workers: [] }, road(), road()],
      })
    );
    // (1 × 1.25 tech × 1.25 motor) + 2 × 0.02 roads
    expect(mods.extractProd).toBeCloseTo(1.25 * 1.25 + 0.04);
  });
});

describe('trail bonus (sentieri sterrati)', () => {
  // Griglia fittizia: getModifiers legge solo grid.cells.
  const mkGrid = (trailTiles) => ({
    cells: [
      Array.from({ length: trailTiles }, () => ({ type: 'trail' })),
      [{ type: 'grass' }, { type: 'road' }, { type: 'water' }],
    ],
  });

  it('adds +0.5% extractProd per trail tile on the grid', () => {
    expect(getModifiers(mkState(), mkGrid(4)).extractProd).toBeCloseTo(1.02);
    expect(getModifiers(mkState(), mkGrid(1)).extractProd).toBeCloseTo(1.005);
  });

  it('caps at +15% no matter how many trail tiles', () => {
    expect(getModifiers(mkState(), mkGrid(100)).extractProd).toBeCloseTo(1.15);
  });

  it('is 0 without a grid argument (old call sites keep working)', () => {
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState(), mkGrid(0))).toEqual(DEFAULT_MODS);
  });

  it('stacks with the road aura under its own separate cap', () => {
    const mods = getModifiers(
      mkState({ buildings: [{ defId: 'road', workers: [] }, { defId: 'road', workers: [] }] }),
      mkGrid(4)
    );
    // 2 strade × 2% + 4 sentieri × 0.5%
    expect(mods.extractProd).toBeCloseTo(1.04 + 0.02);
  });
});

describe('garage aura (autorimessa)', () => {
  const garage = (workers, extra = {}) => ({ defId: 'garage', workers, ...extra });

  it('boosts extractProd by 50% while switched on and staffed', () => {
    const mods = getModifiers(mkState({ buildings: [garage([1])] }));
    expect(mods.extractProd).toBeCloseTo(1.5);
  });

  it('does nothing without workers or when switched off', () => {
    expect(getModifiers(mkState({ buildings: [garage([])] }))).toEqual(DEFAULT_MODS);
    expect(
      getModifiers(mkState({ buildings: [garage([1], { enabled: false })] }))
    ).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS); // no buildings field
  });

  it('does not stack with copies of itself', () => {
    const mods = getModifiers(mkState({ buildings: [garage([1]), garage([2])] }));
    expect(mods.extractProd).toBeCloseTo(1.5);
  });

  // Scelta documentata in modifiers.js: l'aura segue il personale, non il
  // carburante in magazzino — senza fuel il garage stalla via `consumes`.
  it('stays nominal even with an empty fuel tank (stall handled by consumes)', () => {
    const mods = getModifiers(
      mkState({ resources: { fuel: 0 }, buildings: [garage([1])] })
    );
    expect(mods.extractProd).toBeCloseTo(1.5);
  });

  it('stacks with the motor aura', () => {
    const mods = getModifiers(
      mkState({
        resources: { energy: 10 },
        buildings: [{ defId: 'motor', workers: [] }, garage([1])],
      })
    );
    expect(mods.extractProd).toBeCloseTo(1.25 * 1.5);
  });
});

describe('ranch aura (animali da lavoro)', () => {
  const ranch = (workers, extra = {}) => ({ defId: 'ranch', workers, ...extra });

  it('adds +15% farmProd and +10% extractProd per staffed ranch', () => {
    const mods = getModifiers(mkState({ buildings: [ranch([1, 2])] }));
    expect(mods.farmProd).toBeCloseTo(1.15);
    expect(mods.extractProd).toBeCloseTo(1.1);
    const two = getModifiers(mkState({ buildings: [ranch([1]), ranch([2])] }));
    expect(two.farmProd).toBeCloseTo(1.3);
    expect(two.extractProd).toBeCloseTo(1.2);
  });

  it('caps at +45% farmProd and +30% extractProd', () => {
    const buildings = [ranch([1]), ranch([2]), ranch([3]), ranch([4]), ranch([5])];
    const mods = getModifiers(mkState({ buildings }));
    expect(mods.farmProd).toBeCloseTo(1.45);
    expect(mods.extractProd).toBeCloseTo(1.3);
  });

  it('does nothing without workers or when switched off', () => {
    expect(getModifiers(mkState({ buildings: [ranch([])] }))).toEqual(DEFAULT_MODS);
    expect(
      getModifiers(mkState({ buildings: [ranch([1], { enabled: false })] }))
    ).toEqual(DEFAULT_MODS);
    expect(getModifiers(mkState())).toEqual(DEFAULT_MODS); // no buildings field
  });

  it('stacks with road and garage auras and never mutates DEFAULT_MODS', () => {
    const mods = getModifiers(
      mkState({ buildings: [ranch([1]), { defId: 'road', workers: [] }, { defId: 'garage', workers: [2] }] })
    );
    expect(mods.farmProd).toBeCloseTo(1.15);
    // Ordine in getModifiers: additivi strade → moltiplicatore garage → additivo ranch.
    expect(mods.extractProd).toBeCloseTo((1 + 0.02) * 1.5 + 0.1, 5);
    expect(DEFAULT_MODS.farmProd).toBe(1);
    expect(DEFAULT_MODS.extractProd).toBe(1);
  });
});
