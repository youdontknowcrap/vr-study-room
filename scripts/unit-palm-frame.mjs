/**
 * Pins the palm-frame signs. The expected axes are the canonical pose
 * written in palm-frame.ts, not a second copy of the cross-product code.
 *   node --experimental-strip-types scripts/unit-palm-frame.mjs
 */
import assert from 'node:assert/strict';
import { palmFrame } from '../src/book/palm-frame.ts';

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ✔', name);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const vNear = (a, x, y, z) => near(a.x, x) && near(a.y, y) && near(a.z, z);

/** Quaternion rotate, written out so it is not quatFromBasis run twice. */
function rotate(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function palmUp(hand, wristX) {
  const wrist = { x: wristX, y: 1, z: 0.3 };
  // Palm up, fingers forward (−Z): a RIGHT thumb points to +X, a left one to −X.
  // (Hold your own right hand out palm-up to check.)
  const thumbSign = hand === 'right' ? 1 : -1;
  return palmFrame(
    hand,
    wrist,
    { x: wristX + thumbSign * 0.02, y: 1, z: 0.24 },
    { x: wristX - thumbSign * 0.02, y: 1, z: 0.24 },
    { x: wristX, y: 1, z: 0.22 },
  );
}

for (const hand of ['right', 'left']) {
  test(`${hand} palm-up: +Z out of the palm, +Y toward the fingers, +X to world +X`, () => {
    const wristX = hand === 'right' ? 0.2 : -0.2;
    const f = palmUp(hand, wristX);
    assert.ok(f, 'frame');
    assert.ok(vNear(f.z, 0, 1, 0), `palm normal ${f.z.x} ${f.z.y} ${f.z.z}`);
    assert.ok(vNear(f.y, 0, 0, -1), `finger axis ${f.y.x} ${f.y.y} ${f.y.z}`);
    assert.ok(vNear(f.x, 1, 0, 0), `across ${f.x.x} ${f.x.y} ${f.x.z}`);
    assert.ok(vNear(f.position, wristX, 1, 0.3 - 0.045), 'palm center is 4.5 cm toward the fingers');
    const q = f.quaternion;
    assert.ok(vNear(rotate(q, { x: 1, y: 0, z: 0 }), f.x.x, f.x.y, f.x.z), 'quat +X');
    assert.ok(vNear(rotate(q, { x: 0, y: 1, z: 0 }), f.y.x, f.y.y, f.y.z), 'quat +Y');
    assert.ok(vNear(rotate(q, { x: 0, y: 0, z: 1 }), f.z.x, f.z.y, f.z.z), 'quat +Z');
    const handed = f.x.y * f.y.z - f.x.z * f.y.y;
    // (x × y) · z should be +1
    const cx = f.x.y * f.y.z - f.x.z * f.y.y;
    const cy = f.x.z * f.y.x - f.x.x * f.y.z;
    const cz = f.x.x * f.y.y - f.x.y * f.y.x;
    assert.ok(near(cx * f.z.x + cy * f.z.y + cz * f.z.z, 1), 'basis is right-handed');
    assert.equal(handed, cx);
  });
}

test('right hand palm-up has its thumb at +X (left at −X)', () => {
  const r = palmUp('right', 0.2);
  const l = palmUp('left', -0.2);
  // thumbward = index metacarpal − pinky metacarpal, expressed in the frame's X.
  const thumbX = (hand, f) => {
    const s = hand === 'right' ? 1 : -1; // what palmUp() built
    return s * f.x.x; // world thumb direction is (s, 0, 0)
  };
  assert.ok(thumbX('right', r) > 0.99, 'right thumb along palm +X');
  assert.ok(thumbX('left', l) < -0.99, 'left thumb along palm −X');
});

test('palm-down right hand: +Z still comes out of the palm (world −Y)', () => {
  // Palm down, fingers forward: the right thumb now points to −X.
  const f = palmFrame(
    'right',
    { x: 0, y: 1, z: 0.3 },
    { x: -0.02, y: 1, z: 0.24 },
    { x: 0.02, y: 1, z: 0.24 },
    { x: 0, y: 1, z: 0.22 },
  );
  assert.ok(f && vNear(f.z, 0, -1, 0), 'palm normal points down');
});

test('collapsed joints are not a palm', () => {
  const wrist = { x: 0, y: 0, z: 0 };
  assert.equal(
    palmFrame('right', wrist, { x: 0, y: 0, z: -0.02 }, { x: 0, y: 0, z: -0.02 }, { x: 0, y: 0, z: -0.08 }),
    null,
  );
});

console.log(`OK: ${n} palm-frame checks passed`);
