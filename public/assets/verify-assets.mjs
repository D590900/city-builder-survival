#!/usr/bin/env node
// Asset verification: prints the manifest building keys and checks that every
// required v3 building key exists with a valid, self-contained GLB on disk.
// Run from anywhere: `node public/assets/verify-assets.mjs` (exit code 0 = OK).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const assetsDir = dirname(fileURLToPath(import.meta.url)); // public/assets
const publicDir = dirname(assetsDir); // public
const manifest = JSON.parse(readFileSync(join(assetsDir, 'manifest.json'), 'utf-8'));

// Required building keys for v3 (contract with src/buildings/definitions.js).
const REQUIRED_BUILDINGS = [
  'hq',
  'tent',
  'house',
  'farm',
  'tower',
  'wall',
  'solar-panel',
  'lumber',
  'forester',
  'scrapyard',
  'mine',
  'well',
  'rain-collector',
  'lab',
  'generator',
  'solar-plant',
  'battery',
  'shack',
  'garden',
  'greenhouse',
  'cistern',
  'smelter',
  'warehouse',
  'wind-turbine',
  'clinic',
  'palisade',
  'scrap-wall',
  'brick-wall',
  'concrete-wall',
  'trap',
  'sniper-tower',
];

// Extensions that need a decoder the game loader does not configure.
const UNSUPPORTED_EXTENSIONS = new Set([
  'EXT_meshopt_compression',
  'KHR_draco_mesh_compression',
]);

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};

/** Validates a GLB file: magic bytes, version, self-contained resources. */
function checkGlb(label, absPath) {
  if (!existsSync(absPath)) {
    fail(`${label}: missing file ${absPath}`);
    return;
  }
  const data = readFileSync(absPath);
  if (data.length < 20 || data.subarray(0, 4).toString('latin1') !== 'glTF') {
    fail(`${label}: bad magic bytes (not a GLB)`);
    return;
  }
  const version = data.readUInt32LE(4);
  if (version !== 2) {
    fail(`${label}: unsupported glTF version ${version}`);
    return;
  }
  if (data.readUInt32LE(8) !== data.length) {
    fail(`${label}: header length mismatch`);
    return;
  }
  if (data.readUInt32LE(16) !== 0x4e4f534a) {
    fail(`${label}: first chunk is not JSON`);
    return;
  }
  const jsonLen = data.readUInt32LE(12);
  let doc;
  try {
    doc = JSON.parse(data.subarray(20, 20 + jsonLen).toString('utf-8'));
  } catch {
    fail(`${label}: unparseable JSON chunk`);
    return;
  }
  for (const buffer of doc.buffers || []) {
    if (buffer.uri) fail(`${label}: external buffer uri ${buffer.uri}`);
  }
  for (const image of doc.images || []) {
    if (image.uri && !image.uri.startsWith('data:')) {
      fail(`${label}: external image uri ${image.uri}`);
    }
  }
  for (const ext of doc.extensionsRequired || []) {
    if (UNSUPPORTED_EXTENSIONS.has(ext)) fail(`${label}: requires unsupported extension ${ext}`);
  }
  if (!doc.meshes || doc.meshes.length === 0) fail(`${label}: no meshes`);
}

const buildingKeys = Object.keys(manifest.buildings || {});
console.log(`Building keys in manifest (${buildingKeys.length}):`);
for (const key of buildingKeys) console.log(`  - ${key}`);

for (const key of REQUIRED_BUILDINGS) {
  if (!manifest.buildings?.[key]) fail(`required building key "${key}" missing from manifest`);
}

// Validate every file referenced by the manifest.
for (const [category, entries] of Object.entries(manifest)) {
  for (const [key, relPath] of Object.entries(entries)) {
    checkGlb(`${category}.${key}`, join(publicDir, relPath));
  }
}

// Warn about GLB files on disk that are not referenced by the manifest.
for (const category of ['buildings', 'props', 'characters']) {
  const referenced = new Set(Object.values(manifest[category] || {}));
  for (const file of readdirSync(join(assetsDir, category))) {
    if (file.endsWith('.glb') && !referenced.has(`assets/${category}/${file}`)) {
      console.warn(`WARN orphan file not in manifest: assets/${category}/${file}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log(`\nOK: all ${REQUIRED_BUILDINGS.length} required building keys present, all manifest GLBs valid and self-contained.`);
