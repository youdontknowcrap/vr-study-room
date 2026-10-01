/**
 * Whiteboard notes: stroke model, pages, save/load format, PDF export.
 *   node --experimental-strip-types --no-warnings scripts/unit-notes.mjs
 */
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  BOARD_LONG_M,
  BOARD_SHORT_M,
  boardSize,
  deserializeNotebook,
  letterPlacement,
  MIN_POINT_SPACING,
  Notebook,
  PEN_COLORS,
  PEN_SIZES_MM,
  pointsRect,
  serializeNotebook,
  StrokeBuilder,
  timestampName,
} from '../src/notes/notes-model.ts';
import { buildNotesPdf, LETTER_PT } from '../src/notes/notes-pdf.ts';

let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log('  ✔', name);
};

// ---- Stroke model ---------------------------------------------------------
await test('board is 5 ft x 5.647 ft, portrait by default', () => {
  assert.deepEqual(boardSize('portrait'), { w: 1.524, h: 1.7212 });
  assert.deepEqual(boardSize('landscape'), { w: 1.7212, h: 1.524 });
  assert.ok(Math.abs(BOARD_SHORT_M / 0.3048 - 5) < 1e-9);
  assert.ok(Math.abs(BOARD_LONG_M / 0.3048 - 5.64705) < 1e-4);
  assert.equal(new Notebook().page.orientation, 'portrait');
});

await test('palette has 8 colors incl. black/blue/red/green; 5 sizes', () => {
  assert.equal(PEN_COLORS.length, 8);
  for (const c of ['Black', 'Blue', 'Red', 'Green']) assert.ok(PEN_COLORS.some((p) => p.name === c), c);
  assert.equal(PEN_SIZES_MM.length, 5);
});

await test('first sample is kept as-is; jitter below the spacing is dropped', () => {
  const b = new StrokeBuilder('pen', '#000', 0.0025);
  assert.equal(b.add(0.5, 0.5, 1 / 72), true);
  assert.deepEqual(b.stroke.points, [0.5, 0.5]);
  // Sub-millimeter jitter: no new points.
  for (let i = 0; i < 20; i++) b.add(0.5 + (i % 2 ? 0.0004 : -0.0004), 0.5, 1 / 72);
  assert.equal(b.pointCount, 1);
});

await test('smoothing lags behind a jump and converges', () => {
  const b = new StrokeBuilder('pen', '#000', 0.0025);
  b.add(0, 0, 1 / 72);
  b.add(0.1, 0, 1 / 72); // 10 cm jump in one frame
  assert.ok(b.smoothX > 0 && b.smoothX < 0.06, `one frame moves only part way (${b.smoothX})`);
  for (let i = 0; i < 60; i++) b.add(0.1, 0, 1 / 72);
  assert.ok(Math.abs(b.smoothX - 0.1) < 0.001, 'converges onto the pen');
  // Spacing between kept points is never below the minimum.
  const p = b.stroke.points;
  for (let i = 2; i < p.length; i += 2) {
    assert.ok(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) >= MIN_POINT_SPACING - 1e-4);
  }
});

await test('smoothing is frame-rate independent (72 vs 120 Hz end in the same place)', () => {
  const run = (hz) => {
    const b = new StrokeBuilder('pen', '#000', 0.0025);
    b.add(0, 0, 1 / hz);
    for (let i = 0; i < hz * 0.05; i++) b.add(0.1, 0, 1 / hz); // 50 ms
    return b.smoothX;
  };
  assert.ok(Math.abs(run(72) - run(120)) < 0.004, `${run(72)} vs ${run(120)}`);
});

await test('a straight line stays straight and points are rounded to 0.1 mm', () => {
  const b = new StrokeBuilder('pen', '#000', 0.0025);
  for (let i = 0; i <= 100; i++) b.add(0.2 + i * 0.003, 0.4, 1 / 72);
  for (let i = 1; i < b.stroke.points.length; i += 2) assert.equal(b.stroke.points[i], 0.4);
  for (const v of b.stroke.points) assert.equal(Math.round(v * 1e4) / 1e4, v);
});

await test('pointsRect = bounding box + pad (dirty rect)', () => {
  const r = pointsRect([0.1, 0.2, 0.3, 0.1, 0.2, 0.5], 0, 3, 0.01);
  assert.deepEqual(
    [r.x0, r.y0, r.x1, r.y1].map((v) => +v.toFixed(6)),
    [0.09, 0.09, 0.31, 0.51],
  );
  const tail = pointsRect([0.1, 0.2, 0.3, 0.1, 0.2, 0.5], 1, 3, 0);
  assert.equal(tail.x0, 0.2);
});

// ---- Pages ----------------------------------------------------------------
await test('next on the last page adds a blank page; prev stops at page 1', () => {
  const nb = new Notebook();
  assert.equal(nb.label, 'Page 1 / 1');
  assert.equal(nb.prev(), false);
  assert.equal(nb.next(), 'added');
  assert.equal(nb.label, 'Page 2 / 2');
  assert.equal(nb.prev(), true);
  assert.equal(nb.label, 'Page 1 / 2');
  assert.equal(nb.next(), 'moved');
  assert.equal(nb.label, 'Page 2 / 2');
  assert.equal(nb.next(), 'added');
  assert.equal(nb.pageCount, 3);
  assert.equal(nb.page.strokes.length, 0);
});

await test('rotate toggles the current page; new pages inherit its orientation', () => {
  const nb = new Notebook();
  assert.equal(nb.rotate(), 'landscape');
  nb.next();
  assert.equal(nb.page.orientation, 'landscape');
  nb.prev();
  assert.equal(nb.rotate(), 'portrait');
  assert.equal(nb.pages[1].orientation, 'landscape');
});

await test('isEmpty only when no page has strokes', () => {
  const nb = new Notebook();
  assert.ok(nb.isEmpty);
  nb.next();
  nb.page.strokes.push({ tool: 'pen', color: '#000', radius: 0.002, points: [0, 0] });
  assert.ok(!nb.isEmpty);
});

// ---- Save / load ------------------------------------------------------------
const sample = () => {
  const nb = new Notebook();
  nb.page.strokes.push({ tool: 'pen', color: '#1f5fd1', radius: 0.0025, points: [0.1, 0.1, 0.2, 0.15, 0.3, 0.1] });
  nb.page.strokes.push({ tool: 'erase', color: '#ffffff', radius: 0.035, points: [0.2, 0.12] });
  nb.next();
  nb.rotate();
  nb.page.strokes.push({ tool: 'pen', color: '#d0312d', radius: 0.006, points: [1.6, 1.4, 1.65, 1.45] });
  return nb;
};

await test('serialize -> JSON -> deserialize round-trips pages, strokes, color/size', () => {
  const nb = sample();
  const saved = serializeNotebook(nb, 'notes-2026-10-01_15-42-07', 1759358527000, '#1e8a3c', 4);
  const back = deserializeNotebook(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(back, saved);
  assert.equal(back.pages.length, 2);
  assert.equal(back.pages[1].orientation, 'landscape');
  assert.equal(back.pages[0].strokes[1].tool, 'erase');
  assert.equal(back.current, 1);
  assert.equal(back.penColor, '#1e8a3c');
  assert.equal(back.penSizeMm, 4);
  const nb2 = new Notebook();
  nb2.replace(back.pages, back.current);
  assert.equal(nb2.label, 'Page 2 / 2');
});

await test('a save is a deep copy (later strokes do not leak into it)', () => {
  const nb = sample();
  const saved = serializeNotebook(nb, 'x', 0, '#000', 2.5);
  nb.page.strokes[0].points.push(9, 9);
  nb.page.strokes.push({ tool: 'pen', color: '#000', radius: 0.002, points: [0, 0] });
  assert.equal(saved.pages[1].strokes.length, 1);
  assert.equal(saved.pages[1].strokes[0].points.length, 4);
});

await test('broken / old records are rejected or cleaned, never thrown', () => {
  assert.equal(deserializeNotebook(null), null);
  assert.equal(deserializeNotebook({ format: 99, pages: [] }), null);
  assert.equal(deserializeNotebook({ format: 1, pages: [] }), null);
  const cleaned = deserializeNotebook({
    format: 1,
    current: 7,
    pages: [{ orientation: 'sideways', strokes: [{ points: [1] }, { points: [0, 'x'] }, { points: [0.1, 0.2] }] }],
  });
  assert.equal(cleaned.pages[0].orientation, 'portrait');
  assert.equal(cleaned.pages[0].strokes.length, 1);
  assert.equal(cleaned.current, 0);
});

await test('timestamp names: notes-YYYY-MM-DD_HH-MM-SS (local time)', () => {
  const d = new Date(2026, 9, 1, 15, 42, 7);
  assert.equal(timestampName(d), 'notes-2026-10-01_15-42-07');
  assert.equal(`${timestampName(new Date(2026, 0, 2, 3, 4, 5))}.pdf`, 'notes-2026-01-02_03-04-05.pdf');
});

// ---- PDF --------------------------------------------------------------------
await test('board fits a letter page uniformly (portrait fills width, landscape height)', () => {
  const p = letterPlacement('portrait');
  assert.equal(p.w, 8.5);
  assert.ok(Math.abs(p.h / p.w - 1.7212 / 1.524) < 1e-9);
  assert.ok(Math.abs(p.y * 2 + p.h - 11) < 1e-9);
  const l = letterPlacement('landscape');
  assert.equal(l.pageW, 11);
  assert.equal(l.h, 8.5);
});

// 1x1 white PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  ),
);

await test('PDF export: one letter page per notebook page, landscape pages turned', async () => {
  const bytes = await buildNotesPdf(
    [
      { png: PNG, landscape: false },
      { png: PNG, landscape: true },
      { png: PNG, landscape: false },
    ],
    'notes-2026-10-01_15-42-07',
  );
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 3);
  const sizes = doc.getPages().map((p) => p.getSize());
  assert.deepEqual(sizes[0], { width: LETTER_PT.w, height: LETTER_PT.h });
  assert.deepEqual(sizes[1], { width: 792, height: 612 });
  assert.deepEqual(sizes[2], { width: 612, height: 792 });
  assert.equal(doc.getTitle(), 'notes-2026-10-01_15-42-07');
});

console.log(`OK: ${n} notes checks passed`);
