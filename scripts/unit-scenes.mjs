/**
 * Custom scenes: scene.json validation/defaults, the scene-folder scan, and
 * the path-traversal guard of the dev/preview file route.
 *   node --experimental-strip-types --no-warnings scripts/unit-scenes.mjs
 *
 * WHY test the guard with nasty URLs: the dev server listens on your whole
 * Wi-Fi (so the Quest can reach it). Any URL that escapes scenes/<id>/
 * would let a neighbour read your .env or source files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSafeRelativePath, isValidSceneId, validateManifest, DEFAULT_LIGHT } from '../src/room/scene-manifest.ts';
import { resolveSceneFile, scanScenes } from '../vite-plugins/local-scenes.ts';

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ✔', name);
};

const minimal = { name: 'Den', model: 'den.glb', seat: { x: 1, z: 2 }, table: { x: 1, z: 1, y: 0.7, halfW: 0.5, halfD: 0.3 } };

test('minimal manifest gets defaults', () => {
  const v = validateManifest(minimal);
  assert.ok(v.ok, JSON.stringify(v));
  const m = v.manifest;
  assert.deepEqual(m.model, { high: 'den.glb', lite: 'den.glb' }); // one file serves both qualities
  assert.equal(m.scale, 1);
  assert.deepEqual(m.offset, { x: 0, y: 0, z: 0 });
  assert.equal(m.rotationY, 0);
  assert.equal(m.seat.yaw, 0);
  assert.equal(m.table.yaw, 0);
  assert.deepEqual(m.extraSurfaces, []);
  assert.equal(m.bounds, undefined); // measured from the model at load time
  assert.deepEqual(m.light, DEFAULT_LIGHT);
  assert.deepEqual(m.fixes, { decalMaterials: [] });
  assert.ok(v.warnings.some((w) => w.includes('credit')), 'nudges for a credit line');
});

test('degrees become radians exactly (-90 deg = -PI/2)', () => {
  const v = validateManifest({ ...minimal, seat: { x: 0, z: 0, yawDeg: -90 }, rotationYDeg: 180 });
  assert.ok(v.ok);
  assert.equal(v.manifest.seat.yaw, -Math.PI / 2);
  assert.equal(v.manifest.rotationY, Math.PI);
});

test('high/lite variants: one missing falls back to the other', () => {
  const v = validateManifest({ ...minimal, model: { high: 'h.glb' } });
  assert.ok(v.ok);
  assert.deepEqual(v.manifest.model, { high: 'h.glb', lite: 'h.glb' });
});

test('stand.node can replace the table', () => {
  const { table, ...rest } = minimal;
  assert.ok(validateManifest({ ...rest, stand: { node: 'Desk' } }).ok);
  const bad = validateManifest(rest);
  assert.ok(!bad.ok && bad.errors.some((e) => e.includes('table')));
});

test('colors, fixes and near plane are parsed', () => {
  const v = validateManifest({
    ...minimal,
    fixes: { fourthWall: { z: 4, minX: -1, maxX: 1, color: '#c8c6ec' }, ceiling: { y: 2.8, minX: -1, maxX: 1, minZ: -1, maxZ: 1 }, decalMaterials: ['rug'], near: 0.05 },
  });
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.manifest.fixes.fourthWall.color, 0xc8c6ec);
  assert.equal(v.manifest.fixes.fourthWall.tvX, undefined); // no TV unless asked
  assert.equal(v.manifest.fixes.ceiling.color, 0xeeeae2);
  assert.equal(v.manifest.fixes.near, 0.05);
});

test('all errors are reported at once', () => {
  const v = validateManifest({ model: 42, scale: -1, seat: { x: 'a' }, fixes: { near: 5 }, light: { color: 'red' } });
  assert.ok(!v.ok);
  const all = v.errors.join('\n');
  for (const want of ['name', 'model', 'scale', 'seat.x', 'seat.z', 'fixes.near', 'light.color', 'table']) {
    assert.ok(all.includes(want), `expected an error about ${want}:\n${all}`);
  }
  assert.ok(!validateManifest(null).ok);
  assert.ok(!validateManifest([]).ok);
});

test('model paths must stay inside the scene folder', () => {
  for (const p of ['../x.glb', '/etc/passwd', 'a/../../b.glb', 'C:\\x.glb', 'https://evil/x.glb', 'a//b.glb', './x.glb', '']) {
    assert.equal(isSafeRelativePath(p), false, p);
    assert.ok(!validateManifest({ ...minimal, model: p }).ok, p);
  }
  assert.ok(isSafeRelativePath('room.glb'));
  assert.ok(isSafeRelativePath('lite/room.glb'));
});

test('scene ids', () => {
  for (const id of ['den', 'my-room', 'Room_2', 'a.b']) assert.ok(isValidSceneId(id), id);
  for (const id of ['', '..', '.hidden', '_example', 'a..b', 'a/b', 'glass', 'x y']) assert.ok(!isValidSceneId(id), id);
});

// ---- server side: a throwaway scenes folder -------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-'));
const root = path.join(tmp, 'scenes');
const write = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), data);
};
write('scenes/den/scene.json', JSON.stringify(minimal));
write('scenes/den/den.glb', 'glb');
write('scenes/den/.env', 'hidden');
write('scenes/other/scene.json', JSON.stringify({ ...minimal, name: 'Other', model: 'missing.glb' }));
write('scenes/broken/scene.json', '{ nope');
write('scenes/_example/scene.json', JSON.stringify(minimal));
write('scenes/nomanifest/readme.txt', 'x');
write('scenes/README.md', '# docs');
write('secret.txt', 'top secret'); // OUTSIDE scenes/
write('scenes-evil/den/x.glb', 'sibling folder with a matching prefix');

test('scan lists good and broken scenes, skips _ and . folders and files', () => {
  const { scenes } = scanScenes(root);
  const byId = Object.fromEntries(scenes.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['broken', 'den', 'nomanifest', 'other']);
  assert.equal(byId.den.error, undefined);
  assert.equal(byId.den.name, 'Den');
  assert.match(byId.other.error, /model file not found: missing\.glb/);
  assert.match(byId.broken.error, /not valid JSON/);
  assert.match(byId.nomanifest.error, /missing scene\.json/);
  assert.deepEqual(scanScenes(path.join(tmp, 'does-not-exist')), { scenes: [] });
});

test('guard serves files inside scenes/<id>/', () => {
  assert.equal(resolveSceneFile(root, '/custom-scenes/den/den.glb'), path.join(root, 'den', 'den.glb'));
  assert.equal(resolveSceneFile(root, '/custom-scenes/den/scene.json?v=2'), path.join(root, 'den', 'scene.json'));
  // Hosted under a sub-path (base './'): still found.
  assert.equal(resolveSceneFile(root, '/vr-study-room/custom-scenes/den/den.glb'), path.join(root, 'den', 'den.glb'));
});

test('guard blocks path traversal and other tricks', () => {
  const nasty = [
    '/custom-scenes/../secret.txt',
    '/custom-scenes/den/../../secret.txt',
    '/custom-scenes/%2e%2e/secret.txt',
    '/custom-scenes/den/%2e%2e/%2e%2e/secret.txt',
    '/custom-scenes/den/..%2f..%2fsecret.txt',
    '/custom-scenes/den/..%5c..%5csecret.txt',
    '/custom-scenes/den\\..\\..\\secret.txt',
    '/custom-scenes/den/%00den.glb',
    '/custom-scenes/den/%E0%A4%A', // malformed escape
    '/custom-scenes/den//den.glb',
    '/custom-scenes/den/./den.glb',
    '/custom-scenes/den/.env', // hidden files
    '/custom-scenes/_example/scene.json', // disabled scene
    '/custom-scenes/../scenes-evil/den/x.glb',
    '/custom-scenes/den', // the folder itself
    '/custom-scenes/den/',
    '/custom-scenes/den/nope.glb', // doesn't exist
    '/custom-scenes/README.md', // not inside a scene
    '/src/main.ts',
  ];
  for (const url of nasty) assert.equal(resolveSceneFile(root, url), null, url);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`unit-scenes: ${n} tests passed`);
