import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalizeHeight } from '../src/assets/loader.js';

function boxGroup(w, h, d) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial()));
  return g;
}

function sizeOf(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { box, size };
}

describe('normalizeHeight', () => {
  it('scales to the target height and grounds the base', () => {
    const g = boxGroup(1, 2, 1);
    normalizeHeight(g, 4);
    const { box, size } = sizeOf(g);
    expect(size.y).toBeCloseTo(4, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
  });

  it('shrinks over-wide models to fit maxWidth (never enlarges)', () => {
    const g = boxGroup(10, 2, 10); // pancake: height scale alone would leave it 20 wide
    normalizeHeight(g, 4, 3);
    const { size } = sizeOf(g);
    expect(size.x).toBeCloseTo(3, 6);
    expect(size.y).toBeCloseTo(0.6, 6); // uniform scale 0.3, not the height-driven 2
  });

  it('leaves models already within maxWidth untouched', () => {
    const g = boxGroup(1, 2, 1);
    normalizeHeight(g, 4, 3); // height scale 2 → 2 wide, within the cap
    const { size } = sizeOf(g);
    expect(size.y).toBeCloseTo(4, 6);
    expect(size.x).toBeCloseTo(2, 6);
  });
});
