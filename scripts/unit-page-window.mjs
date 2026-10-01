/**
 * Window + turn gate for PDF streaming (src/book/page-window.ts).
 *   node --experimental-strip-types --no-warnings scripts/unit-page-window.mjs
 */
import assert from 'node:assert/strict';
import { PDF_STREAM_WINDOW, pagesAround, pdfKeepCount, turnAllowed, turnNeeds } from '../src/book/page-window.ts';

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ✔', name);
};

test('window is 10 pages with the open spread in the middle', () => {
  assert.equal(PDF_STREAM_WINDOW, 10);
  const center = 500;
  const w = pagesAround(center, 1000);
  assert.equal(w.length, 10);
  assert.equal(w[0], 495);
  assert.equal(w[4], center - 1);
  assert.equal(w[5], center);
  assert.equal(w[9], 504);
});

test('window fills forward at the start and backward at the end', () => {
  const start = pagesAround(0, 1000);
  assert.deepEqual([start[0], start.length, start.at(-1)], [0, 10, 9]);
  const end = pagesAround(999, 1000);
  assert.deepEqual([end[0], end.length, end.at(-1)], [990, 10, 999]);
  assert.ok(end.includes(998) && end.includes(999));
});

test('a short book keeps every page', () => {
  assert.deepEqual(pagesAround(1, 6), [0, 1, 2, 3, 4, 5]);
});

test('queue-on keep count is 10 even if a larger cache was saved; queue-off honors the stored cache', () => {
  assert.equal(pdfKeepCount(6, true), 10);
  assert.equal(pdfKeepCount(30, true), 10);
  assert.equal(pdfKeepCount(4, false), 4);
  assert.equal(pdfKeepCount(0, true), 0);
});

test('forward turn waits until the pages it would show are painted', () => {
  const has = new Set([0, 1]);
  assert.equal(turnAllowed(-1, 1000, 1, (i) => has.has(i)), false);
  has.add(2);
  assert.deepEqual(turnNeeds(-1, 1), [0, 1, 2]);
  assert.equal(turnAllowed(-1, 1000, 1, (i) => has.has(i)), true);
});

test('back into cached pages works while forward is still painting', () => {
  const has = new Set([3, 4, 5]);
  assert.equal(turnAllowed(5, 1000, -1, (i) => has.has(i)), true);
  assert.equal(turnAllowed(5, 1000, 1, (i) => has.has(i)), false);
});

test('covers do not block, and the ends of the book do', () => {
  assert.equal(turnAllowed(-1, 10, -1, () => true), false);
  assert.equal(turnAllowed(9, 10, 1, () => true), false);
  // Last real turn of a 2-page book: page 2 is the back cover, not a load.
  assert.equal(turnAllowed(-1, 2, 1, (i) => i === 0 || i === 1), true);
});

console.log(`page-window: ${n} checks passed`);
