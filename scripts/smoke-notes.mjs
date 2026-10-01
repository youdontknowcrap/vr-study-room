/**
 * Whiteboard emulator check (headless Chrome + IWSDK's IWER emulator, which
 * fakes a Quest 2). Drives the real input path with emulated controllers:
 *
 *   grab the marker (squeeze) -> controller model hidden -> draw a stroke on
 *   the board (checks the GPU texture got the ink via the dirty-rect upload)
 *   -> release (marker glides home, controller shown) -> grab the eraser and
 *   erase the middle of the stroke -> add a page with the ray on the right
 *   bar -> rotate it -> Export PDF (download: right page count, letter size)
 *   -> Save -> change -> Load -> Return (B) resets book + marker + eraser ->
 *   reload: the autosave is restored.
 *
 *   npm run dev:runtime      (terminal 1; IWSDK_DEV_OPEN=false skips the managed browser)
 *   npm run smoke:notes      (terminal 2)
 *
 * Env: URL (default https://localhost:8081/), CHROME (default /usr/bin/google-chrome).
 * No screenshots (set SHOTS=dir if you want some for debugging).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright-core';

const url = process.env.URL ?? 'https://localhost:8081/';
const shots = process.env.SHOTS ?? '';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
const failures = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text());
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message);
  errors.push(e.message);
});
const check = (ok, msg) => {
  console.log(ok ? '  ✔' : '  ✘', msg);
  if (!ok) failures.push(msg);
};
const wait = (ms) => page.waitForTimeout(ms);
/** Wait until fn() (run in the page) is truthy; the software-rendered emulator runs at ~3 fps. */
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).catch(() => {});
const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

/** In-page helpers (installed after every load). */
async function installHelpers() {
  await page.evaluate(() => {
    const { app } = window;
    const V = app.book.root.position.constructor;
    const Q = app.book.root.quaternion.constructor;
    const M = app.book.root.matrix.constructor;
    const rel = {};
    const H = {
      V,
      Q,
      M,
      /** Board-space point -> world. */
      boardPoint(x, y, z = 0) {
        const b = app.notes.easel.board;
        b.updateWorldMatrix(true, false);
        return b.localToWorld(new V(x, y, z));
      },
      boardNormal() {
        return new V(0, 0, 1).applyQuaternion(app.notes.easel.board.getWorldQuaternion(new Q()));
      },
      /** Set the emulated controller so its GRIP pose lands at (pos, quat). */
      setGrip(hand, pos, quat) {
        const c = window.IWER_DEVICE.controllers[hand];
        const D = new M().compose(pos, quat, new V(1, 1, 1));
        const C = rel[hand] ? D.multiply(rel[hand].clone().invert()) : D;
        const p = new V();
        const q = new Q();
        C.decompose(p, q, new V());
        c.position.set(p.x, p.y, p.z);
        c.quaternion.set(q.x, q.y, q.z, q.w);
      },
      /** Learn controller->grip offset (call after a setGrip + a few frames). */
      learn(hand) {
        const c = window.IWER_DEVICE.controllers[hand];
        const hs = window.actions.hands[hand];
        const C = new M().compose(new V(c.position.x, c.position.y, c.position.z), new Q(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w), new V(1, 1, 1));
        const G = new M().compose(hs.gripPosition, hs.gripQuaternion, new V(1, 1, 1));
        rel[hand] = C.invert().multiply(G);
      },
      /** Grip pose that puts a tool's contact point `reach` m along grip −Z at d m in front of board point (x, y). */
      toolPose(x, y, d, reach) {
        const n = H.boardNormal();
        const q = new Q().setFromUnitVectors(new V(0, 0, -1), n.clone().negate());
        const p = H.boardPoint(x, y).addScaledVector(n, d + reach);
        return { p, q };
      },
      /** World middle of a tool. */
      toolCenter(kind) {
        const t = kind === 'marker' ? app.notes.marker : app.notes.eraser;
        t.root.updateWorldMatrix(true, false);
        return t.centerLocal.clone().applyMatrix4(t.root.matrixWorld);
      },
      gripErr(hand, pos) {
        return window.actions.hands[hand].gripPosition.distanceTo(pos);
      },
    };
    window.H = H;
  });
}

const press = (hand, id, v) =>
  page.evaluate(({ hand, id, v }) => window.IWER_DEVICE.controllers[hand].updateButtonValue(id, v), { hand, id, v });
const notes = () =>
  page.evaluate(() => {
    const n = window.app.notes;
    return {
      marker: n.toolState('marker'),
      eraser: n.toolState('eraser'),
      label: n.notebook.label,
      orientation: n.notebook.page.orientation,
      strokes: n.notebook.page.strokes.map((s) => ({ tool: s.tool, n: s.points.length / 2, color: s.color })),
      hiddenL: n.controllerHiddenFor('left'),
      hiddenR: n.controllerHiddenFor('right'),
      stats: { ...n.board.stats },
      book: window.app.bookSystem.stateName,
      loadOpen: n.easel.loadOpen,
    };
  });
/** GPU texel (canvas pixel coords) at board-space (x, y). */
const texel = (x, y) =>
  page.evaluate(
    ({ x, y }) => {
      const n = window.app.notes;
      const e = n.easel;
      return n.board.readTexel(window.app.world.renderer, Math.round((x + e.w / 2) * 800), Math.round((e.h / 2 - y) * 800));
    },
    { x, y },
  );
/** Move hand `hand`'s grip so tool `kind`'s contact point is d m in front of (x, y). */
const touchAt = (hand, kind, x, y, d) =>
  page.evaluate(
    ({ hand, kind, x, y, d }) => {
      const t = kind === 'marker' ? window.app.notes.marker.tipLocal : window.app.notes.eraser.faceLocal;
      const { p, q } = window.H.toolPose(x, y, d, -t.z);
      window.H.setGrip(hand, p, q);
    },
    { hand, kind, x, y, d },
  );

/** Put hand's grip on a tool and squeeze. */
async function grabTool(hand, kind) {
  await page.evaluate(
    ({ hand, kind }) => {
      const c = window.H.toolCenter(kind);
      window.H.setGrip(hand, c, new window.H.Q());
    },
    { hand, kind },
  );
  await wait(900);
  const err = await page.evaluate(
    ({ hand, kind }) => window.H.gripErr(hand, window.H.toolCenter(kind)),
    { hand, kind },
  );
  console.log(`  ${hand} grip is ${(err * 100).toFixed(1)} cm from the ${kind}`);
  await press(hand, 'squeeze', 1);
  await wait(1200);
}

// ---------------------------------------------------------------------------
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.notes && window.app.book?.pageCount > 0, null, { timeout: 60000 });
await wait(2000);
await installHelpers();
const start = await page.evaluate(() => ({
  room: window.app.room.name,
  label: window.app.notes.notebook.label,
  easel: window.app.notes.easel.root.position.toArray().map((v) => +v.toFixed(3)),
}));
console.log('start', start);
check(start.room === 'Pool room', 'defaults to the glass-door (pool) room');

// Seated head, looking a bit to the right toward the board.
await page.evaluate(() => {
  const d = window.IWER_DEVICE;
  d.controlMode = 'programmatic';
  d.position.set(0, 1.15, 0);
  d.quaternion.set(0, 0, 0, 1);
  d.notifyStateChange?.();
  d.primaryInputMode = 'controller';
});
await page.evaluate(() => window.app.world.launchXR());
await wait(3000);

// Board position relative to the seat (recentered on the head at the origin).
const place = await page.evaluate(() => {
  const H = window.H;
  const c = H.boardPoint(0, 0);
  const head = new H.V(0, 1.15, 0);
  const area = window.app.room.area;
  const local = area.worldToLocal(c.clone());
  return { center: c.toArray().map((v) => +v.toFixed(3)), dist: +c.distanceTo(head).toFixed(3), local: local.toArray().map((v) => +v.toFixed(3)), draws: window.app.world.renderer.info.render.calls };
});
console.log('board center (world, room)', place);
check(Math.abs(place.local[0] - 0.8) < 0.01 && Math.abs(place.local[2] + 0.15) < 0.01 && Math.abs(place.local[1] - 1.1) < 0.01, 'board center at seat + (0.80 right, 0.15 forward), 1.10 m high');

// Learn the controller->grip offset for both hands.
for (const hand of ['left', 'right']) {
  await page.evaluate((hand) => window.H.setGrip(hand, new window.H.V(hand === 'left' ? -0.2 : 0.2, 1, -0.3), new window.H.Q()), hand);
  await wait(900);
  await page.evaluate((hand) => window.H.learn(hand), hand);
}

// --- Marker ------------------------------------------------------------------
console.log('Marker:');
await grabTool('right', 'marker');
let st = await notes();
check(st.marker === 'held-right', `squeeze picks up the marker (${st.marker})`);
check(st.hiddenR && !st.hiddenL, 'right controller model hidden while holding');

const Y = 0.1;
await touchAt('right', 'marker', -0.3, Y, 0.06); // hover in front
await wait(800);
for (let x = -0.3; x <= 0.3001; x += 0.05) {
  await touchAt('right', 'marker', x, Y, -0.002);
  await wait(450);
}
await touchAt('right', 'marker', 0.3, Y, 0.05); // lift
await wait(900);
st = await notes();
console.log('  after stroke:', st.strokes, st.stats);
check(st.strokes.length === 1 && st.strokes[0].tool === 'pen' && st.strokes[0].n >= 8, 'one pen stroke with points');
check(st.stats.partial > 0, 'board texture updated with dirty-rect (partial) uploads');
const ink = await texel(-0.2, Y);
console.log('  GPU texel on the stroke:', ink);
check(ink && ink[0] < 120 && ink[1] < 120, 'ink is on the GPU texture at the stroke');
await shot('notes-stroke');

await press('right', 'squeeze', 0);
await until(() => window.app.notes.toolState('marker') === 'home');
st = await notes();
check(st.marker === 'home' && !st.hiddenR, `release: marker back on the tray, controller shown (${st.marker})`);

// --- Eraser -------------------------------------------------------------------
console.log('Eraser:');
await grabTool('left', 'eraser');
st = await notes();
check(st.eraser === 'held-left' && st.hiddenL, `left squeeze picks up the eraser (${st.eraser})`);
await touchAt('left', 'eraser', -0.04, Y, 0.06);
await wait(700);
for (const x of [-0.04, 0, 0.04]) {
  await touchAt('left', 'eraser', x, Y, -0.003);
  await wait(500);
}
await touchAt('left', 'eraser', 0.04, Y, 0.06);
await wait(900);
st = await notes();
console.log('  after erase:', st.strokes);
check(st.strokes.length === 2 && st.strokes[1].tool === 'erase', 'an erase stroke was added');
const erased = await texel(0, Y);
const kept = await texel(-0.2, Y);
console.log('  texel erased / kept:', erased, kept);
check(erased && erased[0] > 230 && erased[1] > 230, 'middle of the stroke is erased (white)');
check(kept && kept[0] < 120, 'ink outside the eraser stays');
await press('left', 'squeeze', 0);
await until(() => window.app.notes.toolState('eraser') === 'home');

// --- Pages: ray + trigger on the right bar -----------------------------------
console.log('Pages:');
await page.evaluate(() => {
  const H = window.H;
  const e = window.app.notes.easel;
  const target = H.boardPoint(e.w / 2 + 0.095, 0.1, 0.001);
  const from = target.clone().addScaledVector(H.boardNormal(), 0.45);
  const c = window.IWER_DEVICE.controllers.right;
  c.position.set(from.x, from.y, from.z);
  const q = new H.Q().setFromUnitVectors(new H.V(0, 0, -1), target.clone().sub(from).normalize());
  c.quaternion.set(q.x, q.y, q.z, q.w);
});
await wait(900);
await press('right', 'trigger', 1);
await wait(900);
await press('right', 'trigger', 0);
await wait(900);
st = await notes();
check(st.label === 'Page 2 / 2' && st.strokes.length === 0, `right bar on the last page adds a blank page (${st.label})`);
await page.evaluate(() => window.app.notes.press('prev'));
await wait(600);
st = await notes();
check(st.label === 'Page 1 / 2' && st.strokes.length === 2, 'left bar goes back to page 1 with its strokes');
await page.evaluate(() => window.app.notes.press('next'));
await page.evaluate(() => window.app.notes.press('rotate'));
await wait(900);
st = await notes();
check(st.label === 'Page 2 / 2' && st.orientation === 'landscape', 'Rotate turns page 2 to landscape');

// --- Export PDF -----------------------------------------------------------------
console.log('Export PDF:');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.evaluate(() => window.app.notes.press('export')),
]);
const file = path.join(os.tmpdir(), download.suggestedFilename());
await download.saveAs(file);
const pdf = await PDFDocument.load(fs.readFileSync(file));
const sizes = pdf.getPages().map((p) => p.getSize());
console.log('  ', download.suggestedFilename(), sizes);
check(/^notes-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.pdf$/.test(download.suggestedFilename()), 'timestamp filename');
check(pdf.getPageCount() === 2, 'PDF has 2 pages');
check(sizes[0].width === 612 && sizes[0].height === 792 && sizes[1].width === 792 && sizes[1].height === 612, 'letter size (portrait + landscape)');
fs.rmSync(file, { force: true });

// --- Save / load --------------------------------------------------------------------
console.log('Save / Load:');
const saved = await page.evaluate(() => window.app.notes.save());
check(/^notes-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(saved ?? ''), `saved as ${saved}`);
await page.evaluate(() => window.app.notes.press('next')); // page 3 = unsaved change
await page.evaluate(() => window.app.notes.press('load'));
await until(() => window.app.notes.easel.loadOpen);
st = await notes();
check(st.loadOpen, 'Load shows the list panel');
const listed = await page.evaluate(() => window.app.notes['loadKeys']);
console.log('  listed:', listed);
check(listed[0] === saved, 'the save is listed');
await page.evaluate(() => window.app.notes.press('load-0'));
await until(() => /^Loaded/.test(window.app.notes['status']));
st = await notes();
check(!st.loadOpen && st.label === 'Page 2 / 2' && st.orientation === 'landscape', `loaded: back to 2 pages (${st.label})`);
// The unsaved 3-page state was saved first (nothing lost), so 2 saves now.
await page.evaluate(() => window.app.notes.press('load'));
await until(() => window.app.notes.easel.loadOpen);
const listed2 = await page.evaluate(() => window.app.notes['loadKeys']);
console.log('  listed after load:', listed2);
check(listed2.length === 2, 'unsaved work was saved before loading (2 notebooks listed)');
await page.evaluate(() => window.app.notes.press('load-cancel'));

// --- Return resets everything ------------------------------------------------------------
console.log('Return (B key):');
await grabTool('right', 'marker');
await page.evaluate(() => {
  // Book into the left hand: aim the left ray at the book and squeeze.
  const { app } = window;
  const H = window.H;
  const target = app.book.root.getWorldPosition(new H.V());
  const from = target.clone().add(new H.V(-0.1, 0.35, 0.25));
  const c = window.IWER_DEVICE.controllers.left;
  c.position.set(from.x, from.y, from.z);
  const q = new H.Q().setFromUnitVectors(new H.V(0, 0, -1), target.clone().sub(from).normalize());
  c.quaternion.set(q.x, q.y, q.z, q.w);
});
await wait(900);
await press('left', 'squeeze', 1);
await wait(1500);
st = await notes();
console.log('  holding:', st.marker, st.book, 'hidden L/R', st.hiddenL, st.hiddenR);
check(st.marker === 'held-right' && st.book === 'held-left', 'marker in right hand, book in left');
check(st.hiddenL && st.hiddenR, 'both controller models hidden (book + marker)');
await page.keyboard.press('KeyB');
await until(() => window.app.notes.toolState('marker') === 'home' && window.app.notes.toolState('eraser') === 'home');
await wait(1500);
st = await notes();
console.log('  after B:', st.marker, st.eraser, st.book);
check(st.marker === 'home' && st.eraser === 'home', 'marker and eraser back on the tray');
check(st.book.startsWith('resting-desk') || st.book === 'settling', `book back on the desk (${st.book})`);
await press('left', 'squeeze', 0);
await press('right', 'squeeze', 0);
await wait(1200);
st = await notes();
check(!st.hiddenL && !st.hiddenR, 'controller models visible again');
const draws = await page.evaluate(() => window.app.world.renderer.info.render.calls);
console.log('  draw calls (XR, both eyes, glass room):', draws);

// --- Autosave restore ------------------------------------------------------------------------
console.log('Autosave:');
await wait(4500); // > 3 s debounce
await page.evaluate(() => window.app.world.exitXR());
await wait(500);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.notes, null, { timeout: 60000 });
await page.evaluate(() => window.app.notes.restored);
await wait(1000);
const after = await page.evaluate(() => ({
  label: window.app.notes.notebook.label,
  strokes: window.app.notes.notebook.pages[0].strokes.length,
}));
console.log('  after reload:', after);
check(after.label === 'Page 2 / 2' && after.strokes === 2, 'autosave restored on launch');

await browser.close();
if (errors.length) failures.push(`${errors.length} console error(s)`);
console.log(failures.length ? `FAIL: ${failures.join('; ')}` : 'OK: all whiteboard checks passed, no console errors');
process.exit(failures.length ? 1 : 0);
