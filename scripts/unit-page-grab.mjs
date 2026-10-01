/**
 * Unit checks for the page-grab rules (src/book/page-grab.ts). No browser:
 *   npm run test:unit
 * (Node 22+ runs the .ts file directly with --experimental-strip-types.)
 */
import assert from 'node:assert/strict';
import {
  decidePress,
  nearPageSide,
  rayPageHit,
  rayDragX,
  isQuickTap,
} from '../src/book/page-grab.ts';

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ✔', name);
};
const S = { halfWidth: 0.3, halfHeight: 0.15, slope: Math.tan(0.18), baseZ: 0.01 };

test('trigger while held, aimed at a page -> grabs the page (no swap)', () => {
  assert.equal(decidePress({ via: 'trigger', heldByThis: false, heldByOther: true, onPage: true, onBook: true }), 'pageGrab');
});
test('trigger while held, aimed at cover/spine -> nothing (no swap)', () => {
  assert.equal(decidePress({ via: 'trigger', heldByThis: false, heldByOther: true, onPage: false, onBook: true }), 'none');
});
test('pinch while held behaves like trigger', () => {
  assert.equal(decidePress({ via: 'pinch', heldByThis: false, heldByOther: true, onPage: true, onBook: true }), 'pageGrab');
  assert.equal(decidePress({ via: 'pinch', heldByThis: false, heldByOther: true, onPage: false, onBook: true }), 'none');
});
test('squeeze on the book while held by the other hand -> swap (pickUp)', () => {
  assert.equal(decidePress({ via: 'squeeze', heldByThis: false, heldByOther: true, onPage: true, onBook: true }), 'pickUp');
});
test('holding hand presses never change the hold', () => {
  for (const via of ['trigger', 'pinch', 'squeeze'])
    assert.equal(decidePress({ via, heldByThis: true, heldByOther: false, onPage: true, onBook: true }), 'none');
});
test('book at rest: page -> page grab, cover -> pick up, squeeze -> pick up', () => {
  assert.equal(decidePress({ via: 'trigger', heldByThis: false, heldByOther: false, onPage: true, onBook: true }), 'pageGrab');
  assert.equal(decidePress({ via: 'trigger', heldByThis: false, heldByOther: false, onPage: false, onBook: true }), 'pickUp');
  assert.equal(decidePress({ via: 'squeeze', heldByThis: false, heldByOther: false, onPage: true, onBook: true }), 'pickUp');
  assert.equal(decidePress({ via: 'trigger', heldByThis: false, heldByOther: false, onPage: false, onBook: false }), 'none');
});
test('near a page: right page = +1 (forward), left = -1 (back), spine = 0', () => {
  const z = (x) => Math.abs(x) * S.slope + S.baseZ + 0.01;
  assert.equal(nearPageSide({ x: 0.2, y: 0, z: z(0.2) }, S, 1), 1);
  assert.equal(nearPageSide({ x: -0.2, y: 0.05, z: z(-0.2) }, S, 1), -1);
  assert.equal(nearPageSide({ x: 0.005, y: 0, z: z(0.005) }, S, 1), 0);
  assert.equal(nearPageSide({ x: 0.2, y: 0, z: z(0.2) + 0.2 }, S, 1), 0); // too far above
});
test('ray from the reader hits the right / left page', () => {
  const hr = rayPageHit({ x: 0.15, y: 0, z: 0.5 }, { x: 0, y: 0, z: -1 }, S);
  assert.ok(hr && hr.x > 0, 'right page hit');
  const hl = rayPageHit({ x: 0.5, y: 0, z: 0.5 }, { x: -0.8, y: 0, z: -0.6 }, S);
  assert.ok(hl && hl.x < 0, 'slanted ray reaches the left page');
  assert.equal(rayPageHit({ x: 0.15, y: 0, z: -0.5 }, { x: 0, y: 0, z: 1 }, S), null, 'from behind = no page');
  assert.equal(rayPageHit({ x: 0.15, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: -1 }, S), null, 'above the book = no page');
});
test('ray drag x follows the aim', () => {
  assert.ok(Math.abs(rayDragX({ x: -0.1, y: 0, z: 0.5 }, { x: 0, y: 0, z: -1 }, S) + 0.1) < 1e-9);
});
test('quick tap vs drag', () => {
  assert.equal(isQuickTap(0.15, 0.01), true);
  assert.equal(isQuickTap(0.6, 0.01), false);
  assert.equal(isQuickTap(0.15, 0.1), false);
});
console.log(`OK: ${n} page-grab unit checks passed`);
