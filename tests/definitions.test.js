import { describe, it, expect } from 'vitest';
import { BUILDING_DEFS, BUILD_MENU_ORDER, CATEGORIES, getDef } from '../src/buildings/definitions.js';

const REQUIRED_FIELDS = [
  'id',
  'name',
  'desc',
  'cost',
  'category',
  'w',
  'h',
  'hp',
  'produces',
  'consumes',
  'jobs',
  'houses',
  'requiresEnergy',
  'energyDayOnly',
  'capBonus',
  'extracts',
  'extractRate',
  'plants',
  'researchRate',
  'requiresTech',
  'isWall',
  'isTower',
  'isTrap',
  'trapDamage',
  'damage',
  'range',
  'fireRate',
  'model',
];

// The v3 contract values for every definition. Only the fields that
// distinguish a building are listed; the rest is covered by default checks.
const SPEC = {
  hq: {
    category: 'infrastrutture', cost: {}, w: 3, h: 3, hp: 1000,
    produces: { energy: 4 }, jobs: 0, houses: 4, model: 'hq',
  },
  tent: { category: 'abitazioni', cost: { wood: 15 }, w: 1, h: 1, hp: 100, houses: 2, model: 'tent' },
  shack: {
    category: 'abitazioni', name: 'Shack', cost: { wood: 10 }, w: 1, h: 1, hp: 80,
    houses: 3, model: 'shack',
  },
  house: { category: 'abitazioni', cost: { wood: 25, metal: 10 }, w: 2, h: 2, hp: 200, houses: 4, model: 'house' },
  farm: {
    category: 'sostentamento', cost: { wood: 30 }, w: 2, h: 2, hp: 150, jobs: 2,
    produces: { food: 8 }, consumes: { water: 3 }, model: 'farm',
  },
  garden: {
    category: 'sostentamento', name: 'Garden', cost: { wood: 15 }, w: 1, h: 1, hp: 100,
    jobs: 1, produces: { food: 4 }, consumes: { water: 2 }, model: 'garden',
  },
  greenhouse: {
    category: 'sostentamento', name: 'Greenhouse', cost: { wood: 40, metal: 20 }, w: 2, h: 2, hp: 180,
    jobs: 2, produces: { food: 14 }, consumes: { water: 5 }, requiresEnergy: 1, model: 'greenhouse',
  },
  rain: {
    category: 'sostentamento', name: 'Rain Collector', cost: { wood: 15 }, w: 1, h: 1, hp: 80,
    produces: { water: 4 }, model: 'rain-collector',
  },
  well: {
    category: 'sostentamento', name: 'Well', cost: { wood: 20, metal: 10 }, w: 1, h: 1, hp: 100,
    jobs: 0, produces: { water: 8 }, model: 'well',
    proximity: { tile: 'water', range: 3, poor: 0.4 },
  },
  cistern: {
    category: 'sostentamento', name: 'Cistern', cost: { metal: 25 }, w: 1, h: 1, hp: 150,
    produces: { water: 2 }, capBonus: { water: 60 }, model: 'cistern',
  },
  hunt: {
    category: 'sostentamento', name: 'Hunting Cabin', cost: { wood: 20 }, w: 1, h: 1, hp: 100,
    jobs: 1, produces: { food: 6 }, model: 'hunt',
    proximity: { tile: 'forest', range: 3, poor: 0.5 },
  },
  fish: {
    category: 'sostentamento', name: 'Fishing Cabin', cost: { wood: 15 }, w: 1, h: 1, hp: 100,
    jobs: 1, produces: { food: 5 }, model: 'fish',
    proximity: { tile: 'water', range: 2, poor: 0.5 },
  },
  ranch: {
    category: 'sostentamento', name: 'Ranch', cost: { wood: 40 }, w: 2, h: 2, hp: 150,
    jobs: 2, produces: { food: 6 }, model: 'ranch',
    proximity: { tile: 'wildlife', range: 3, poor: 0.5 },
  },
  lumber: {
    category: 'risorse', name: 'Lumberjack', cost: { wood: 15 }, w: 1, h: 1, hp: 120,
    jobs: 2, extracts: 'forest', extractRate: 10, model: 'lumber',
  },
  forester: {
    category: 'risorse', name: 'Forester', cost: { wood: 20 }, w: 1, h: 1, hp: 120,
    jobs: 1, extracts: null, plants: 'forest', requiresTech: 'forestry', model: 'forester',
  },
  scavenger: {
    category: 'risorse', name: 'Scavenger', cost: { wood: 25 }, w: 2, h: 2, hp: 150,
    jobs: 2, extracts: 'ruins', extractRate: 6, model: 'scrapyard',
  },
  mine: {
    category: 'risorse', name: 'Mine', cost: { wood: 30, metal: 20 }, w: 2, h: 2, hp: 250,
    jobs: 3, extracts: 'ore', extractRate: 8, requiresTech: 'mining', model: 'mine',
  },
  smelter: {
    category: 'risorse', name: 'Smelter', cost: { wood: 30, metal: 30 }, w: 2, h: 2, hp: 250,
    jobs: 2, produces: { metal: 3 }, consumes: { wood: 2 }, model: 'smelter',
  },
  distillery: {
    category: 'risorse', name: 'Distillery', cost: { wood: 30, metal: 15 }, w: 1, h: 1, hp: 120,
    jobs: 1, produces: { fuel: 4 }, consumes: { wood: 3 }, model: 'distillery',
  },
  garage: {
    category: 'risorse', name: 'Garage', cost: { wood: 40, metal: 30 }, w: 2, h: 2, hp: 200,
    jobs: 1, consumes: { fuel: 3 }, model: 'garage',
  },
  warehouse: {
    category: 'risorse', name: 'Warehouse', cost: { wood: 40 }, w: 2, h: 2, hp: 300,
    capBonus: { food: 100, wood: 100, metal: 100 }, model: 'warehouse',
  },
  lab: {
    category: 'infrastrutture', name: 'Laboratory', cost: { wood: 30, metal: 25 }, w: 2, h: 2,
    hp: 200, jobs: 2, researchRate: 4, model: 'lab',
  },
  clinic: {
    category: 'infrastrutture', name: 'Clinic', cost: { wood: 30, metal: 15 }, w: 2, h: 2,
    hp: 200, jobs: 1, model: 'clinic',
  },
  radio: {
    category: 'infrastrutture', name: 'Emergency Radio', cost: { wood: 30, metal: 20 },
    w: 1, h: 1, hp: 120, jobs: 1, model: 'radio',
  },
  road: {
    category: 'infrastrutture', name: 'Road', cost: { wood: 2 }, w: 1, h: 1, hp: 50,
    jobs: 0, model: 'road', isRoad: true,
  },
  solar: {
    category: 'energia', cost: { metal: 35 }, w: 1, h: 1, hp: 80,
    produces: { energy: 5 }, energyDayOnly: true, model: 'solar-panel',
  },
  'solar-plant': {
    category: 'energia', name: 'Solar Plant', cost: { metal: 80 }, w: 2, h: 2, hp: 150,
    produces: { energy: 14 }, energyDayOnly: true, requiresTech: 'solar2', model: 'solar-plant',
  },
  wind: {
    category: 'energia', name: 'Wind Turbine', cost: { metal: 45 }, w: 1, h: 1, hp: 120,
    produces: { energy: 3 }, model: 'wind-turbine',
  },
  generator: {
    category: 'energia', name: 'Generator', cost: { metal: 40 }, w: 1, h: 1, hp: 120,
    jobs: 1, produces: { energy: 6 }, consumes: { wood: 3 }, model: 'generator',
  },
  motor: {
    category: 'energia', name: 'Electric Motor', cost: { metal: 30 }, w: 1, h: 1, hp: 120,
    jobs: 0, requiresEnergy: 2, model: 'motor',
  },
  battery: {
    category: 'energia', name: 'Battery', cost: { metal: 35 }, w: 1, h: 1, hp: 100,
    capBonus: { energy: 50 }, requiresTech: 'batteries', model: 'battery',
  },
  palisade: {
    category: 'difesa', name: 'Palisade', cost: { wood: 8 }, w: 1, h: 1, hp: 200,
    isWall: true, model: 'palisade',
  },
  'scrap-wall': {
    category: 'difesa', name: 'Scrap Wall', cost: { metal: 15 }, w: 1, h: 1, hp: 450,
    isWall: true, model: 'scrap-wall',
  },
  'brick-wall': {
    category: 'difesa', name: 'Brick Wall', cost: { wood: 20 }, w: 1, h: 1, hp: 800,
    isWall: true, model: 'brick-wall',
  },
  'concrete-wall': {
    category: 'difesa', name: 'Concrete Wall', cost: { metal: 30 }, w: 1, h: 1, hp: 1400,
    isWall: true, requiresTech: 'concrete', model: 'concrete-wall',
  },
  tower: {
    category: 'difesa', name: 'Watch Tower', cost: { wood: 20, metal: 30 }, w: 1, h: 1, hp: 200,
    jobs: 1, isTower: true, damage: 10, range: 6, fireRate: 1, requiresEnergy: 1, model: 'tower',
  },
  sniper: {
    category: 'difesa', name: 'Sniper Turret', cost: { metal: 35 }, w: 1, h: 1, hp: 250,
    jobs: 1, isTower: true, damage: 22, range: 8, fireRate: 0.8, requiresEnergy: 2,
    requiresTech: 'ballistics', model: 'sniper-tower',
  },
  spotlight: {
    category: 'difesa', name: 'Field Spotlight', cost: { wood: 25, metal: 15 }, w: 1, h: 1,
    hp: 120, jobs: 0, requiresEnergy: 2, model: 'spotlight',
  },
  streetlamp: {
    category: 'difesa', name: 'Street Lamp', cost: { wood: 10, metal: 5 }, w: 1, h: 1,
    hp: 80, jobs: 0, requiresEnergy: 1, model: 'streetlamp',
  },
  trap: {
    category: 'difesa', name: 'Trap Field', cost: { wood: 10 }, w: 1, h: 1, hp: 100,
    isTrap: true, trapDamage: 6, model: 'trap',
  },
};

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

describe('BUILDING_DEFS', () => {
  it('contains exactly the 40 v3 buildings (hq + 39 buildable)', () => {
    expect(Object.keys(BUILDING_DEFS).sort()).toEqual(
      [
        'battery', 'brick-wall', 'cistern', 'clinic', 'concrete-wall', 'distillery',
        'farm', 'fish', 'forester', 'garage', 'garden', 'generator', 'greenhouse',
        'hq', 'house', 'hunt', 'lab', 'lumber', 'mine', 'motor', 'palisade',
        'radio', 'rain', 'ranch', 'road', 'scavenger', 'scrap-wall', 'shack',
        'smelter', 'sniper', 'solar', 'solar-plant', 'spotlight', 'streetlamp',
        'tent', 'tower', 'trap', 'warehouse', 'well', 'wind',
      ].sort()
    );
    expect(BUILDING_DEFS.wall).toBeUndefined(); // replaced by the 4 walls
  });

  it('every def has all required fields', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      for (const field of REQUIRED_FIELDS) {
        expect(def, `${def.id} missing field "${field}"`).toHaveProperty(field);
      }
    }
  });

  it('every def id matches its key', () => {
    for (const [key, def] of Object.entries(BUILDING_DEFS)) {
      expect(def.id).toBe(key);
    }
  });

  it('matches the v3 contract values', () => {
    for (const [id, spec] of Object.entries(SPEC)) {
      const def = BUILDING_DEFS[id];
      expect(def, `missing def "${id}"`).toBeDefined();
      for (const [field, value] of Object.entries(spec)) {
        expect(def[field], `${id}.${field}`).toEqual(value);
      }
    }
  });

  it('every def has a valid category and every category is used', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(CATEGORY_IDS, `${def.id} category`).toContain(def.category);
    }
    for (const id of CATEGORY_IDS) {
      expect(
        Object.values(BUILDING_DEFS).some((def) => def.category === id),
        `unused category "${id}"`
      ).toBe(true);
    }
  });

  it('CATEGORIES lists the six categories in display order', () => {
    expect(CATEGORIES).toEqual([
      { id: 'abitazioni', name: 'Housing', icon: '🏠' },
      { id: 'sostentamento', name: 'Sustenance', icon: '🥫' },
      { id: 'risorse', name: 'Resources', icon: '🪵' },
      { id: 'energia', name: 'Energy', icon: '⚡' },
      { id: 'difesa', name: 'Defense', icon: '🛡️' },
      { id: 'infrastrutture', name: 'Infrastructure', icon: '🏛️' },
    ]);
  });

  it('costs only use wood and metal, positive amounts (hq is free)', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      for (const [resource, amount] of Object.entries(def.cost)) {
        expect(['wood', 'metal'], `${def.id} cost resource`).toContain(resource);
        expect(amount, `${def.id} cost ${resource}`).toBeGreaterThan(0);
      }
    }
    expect(BUILDING_DEFS.hq.cost).toEqual({});
  });

  it('every def has positive size and hp', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(def.w, `${def.id} w`).toBeGreaterThan(0);
      expect(def.h, `${def.id} h`).toBeGreaterThan(0);
      expect(def.hp, `${def.id} hp`).toBeGreaterThan(0);
    }
  });

  it('every def has a non-empty Italian name and description', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(typeof def.name, `${def.id} name`).toBe('string');
      expect(def.name.length, `${def.id} name`).toBeGreaterThan(0);
      expect(typeof def.desc, `${def.id} desc`).toBe('string');
      expect(def.desc.length, `${def.id} desc`).toBeGreaterThan(0);
    }
  });

  it('only farm, garden, greenhouse, smelter, generator, distillery and garage consume fuel', () => {
    const consumers = ['farm', 'garden', 'greenhouse', 'smelter', 'generator', 'distillery', 'garage'];
    for (const def of Object.values(BUILDING_DEFS)) {
      if (consumers.includes(def.id)) {
        expect(Object.keys(def.consumes).length, def.id).toBeGreaterThan(0);
      } else {
        expect(def.consumes, def.id).toEqual({});
      }
    }
  });

  it('only lumber, scavenger and mine extract from map nodes', () => {
    const extractors = ['lumber', 'scavenger', 'mine'];
    for (const def of Object.values(BUILDING_DEFS)) {
      if (extractors.includes(def.id)) {
        expect(def.extracts, def.id).toBeTruthy();
        expect(def.extractRate, def.id).toBeGreaterThan(0);
      } else {
        expect(def.extracts, def.id).toBeNull();
        expect(def.extractRate, def.id).toBe(0);
      }
    }
  });

  it('only well, hunt, fish and ranch have a proximity rule, with a valid shape', () => {
    const proximityDefs = { well: 'water', hunt: 'forest', fish: 'water', ranch: 'wildlife' };
    for (const def of Object.values(BUILDING_DEFS)) {
      if (proximityDefs[def.id]) {
        expect(def.proximity?.tile, def.id).toBe(proximityDefs[def.id]);
        expect(def.proximity?.range, def.id).toBeGreaterThan(0);
        expect(def.proximity?.poor, def.id).toBeGreaterThan(0);
        expect(def.proximity?.poor, def.id).toBeLessThan(1);
      } else {
        expect(def.proximity, def.id).toBeUndefined();
      }
    }
  });

  it('only the forester plants, only the lab researches', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      if (def.id !== 'forester') expect(def.plants, def.id).toBeNull();
      if (def.id !== 'lab') expect(def.researchRate, def.id).toBe(0);
    }
    expect(BUILDING_DEFS.lab.researchRate).toBeGreaterThan(0);
  });

  it('tech requirements are set exactly where expected', () => {
    const gated = {
      forester: 'forestry',
      mine: 'mining',
      'solar-plant': 'solar2',
      battery: 'batteries',
      'concrete-wall': 'concrete',
      sniper: 'ballistics',
    };
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(def.requiresTech, def.id).toBe(gated[def.id] ?? null);
    }
  });

  it('solar buildings produce energy only during the day', () => {
    for (const id of ['solar', 'solar-plant']) {
      expect(BUILDING_DEFS[id].energyDayOnly, id).toBe(true);
      expect(BUILDING_DEFS[id].produces.energy, id).toBeGreaterThan(0);
    }
    for (const def of Object.values(BUILDING_DEFS)) {
      if (def.id !== 'solar' && def.id !== 'solar-plant') {
        expect(def.energyDayOnly, def.id).toBe(false);
      }
    }
  });

  it('only battery, cistern and warehouse grant cap bonuses', () => {
    const bonuses = {
      battery: { energy: 50 },
      cistern: { water: 60 },
      warehouse: { food: 100, wood: 100, metal: 100 },
    };
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(def.capBonus, def.id).toEqual(bonuses[def.id] ?? {});
    }
  });

  it('towers have combat stats and an energy requirement', () => {
    for (const id of ['tower', 'sniper']) {
      const def = BUILDING_DEFS[id];
      expect(def.isTower, id).toBe(true);
      expect(def.damage, id).toBeGreaterThan(0);
      expect(def.range, id).toBeGreaterThan(0);
      expect(def.fireRate, id).toBeGreaterThan(0);
      expect(def.requiresEnergy, id).toBeGreaterThan(0);
    }
  });

  it('exactly the four walls are isWall, the two towers isTower, the trap isTrap', () => {
    const walls = ['palisade', 'scrap-wall', 'brick-wall', 'concrete-wall'];
    const towers = ['tower', 'sniper'];
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(def.isWall, def.id).toBe(walls.includes(def.id));
      expect(def.isTower, def.id).toBe(towers.includes(def.id));
      expect(def.isTrap, def.id).toBe(def.id === 'trap');
      expect(def.trapDamage, def.id).toBe(def.id === 'trap' ? 6 : 0);
    }
  });

  it('walls are ordered by rising hp (palisade < scrap < brick < concrete)', () => {
    const hps = ['palisade', 'scrap-wall', 'brick-wall', 'concrete-wall'].map(
      (id) => BUILDING_DEFS[id].hp
    );
    expect(hps).toEqual([200, 450, 800, 1400]);
  });

  it('only the road def is isRoad (drag-placement in a row, like walls)', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(def.isRoad ?? false, def.id).toBe(def.id === 'road');
    }
  });

  it('BUILD_MENU_ORDER lists the 39 buildable ids grouped by category (no hq, no wall)', () => {
    expect(BUILD_MENU_ORDER).toHaveLength(39);
    expect(BUILD_MENU_ORDER).not.toContain('hq');
    expect(BUILD_MENU_ORDER).not.toContain('wall');
    for (const id of BUILD_MENU_ORDER) {
      expect(BUILDING_DEFS[id], `menu id "${id}"`).toBeDefined();
    }
    // Every buildable def appears exactly once.
    expect(new Set(BUILD_MENU_ORDER).size).toBe(39);
    // Category blocks follow the CATEGORIES display order.
    const menuCategories = BUILD_MENU_ORDER.map((id) => BUILDING_DEFS[id].category);
    const categoryIndexes = menuCategories.map((c) => CATEGORY_IDS.indexOf(c));
    const sorted = [...categoryIndexes].sort((a, b) => a - b);
    expect(categoryIndexes).toEqual(sorted);
  });
});

describe('getDef', () => {
  it('returns the definition for a valid id', () => {
    expect(getDef('farm')).toBe(BUILDING_DEFS.farm);
    expect(getDef('solar-plant')).toBe(BUILDING_DEFS['solar-plant']);
  });

  it('returns undefined for an unknown id', () => {
    expect(getDef('castle')).toBeUndefined();
    expect(getDef('wall')).toBeUndefined();
  });
});
