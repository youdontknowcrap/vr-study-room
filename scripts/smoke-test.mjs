/**
 * Smoke test: opens the running dev server in headless Chrome (with IWSDK's
 * IWER emulator, which fakes a Quest headset), checks for console errors,
 * turns a page, checks "free-hand TRIGGER while the book is held grabs a
 * page and does NOT swap hands (squeeze does)", and runs a REGRESSION CHECK
 * for the "loading an MP3 makes the book vanish" bug:
 *
 *   enter VR -> turn page -> leave VR -> pick an MP3 in the file input ->
 *   enter VR again -> the book must still exist, be visible, show the SAME
 *   pages, and be in front of your eyes (inside the camera's view).
 *
 *   npm run dev:runtime      (terminal 1)
 *   npm i --no-save playwright-core && npm run smoke   (terminal 2)
 *
 * Env: URL (default https://localhost:8081/), CHROME (path to chrome/chromium),
 *      SHOTS (folder for screenshots, default current folder).
 */
import { chromium } from 'playwright-core';

const url = process.env.URL ?? 'https://localhost:8081/';
const shots = process.env.SHOTS ?? '.';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: [
    '--ignore-certificate-errors',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
const errors = [];
const failures = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text());
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); errors.push(e.message); });
const check = (ok, msg) => { console.log(ok ? '  ✔' : '  ✘', msg); if (!ok) failures.push(msg); };

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(8000);
const state = await page.evaluate(() => ({
  hasApp: !!window.app,
  pages: window.app?.book?.pageCount,
  title: window.app?.bookTitle,
  music: window.app?.music?.currentName,
}));
console.log('state', state);
check(state.hasApp && state.pages > 0, 'app started and sample PDF loaded');
await page.screenshot({ path: `${shots}/smoke.png` });
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1500);
console.log('after turn:', await page.evaluate(() => window.app?.book?.spreadLabel));
await page.keyboard.press('KeyM');
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/smoke-menu.png` });
await page.keyboard.press('KeyM');

// ---------------------------------------------------------------------------
// Regression: MP3 file pick must not touch the book.
// ---------------------------------------------------------------------------
/** Snapshot of everything that must survive a file pick. */
const bookSnapshot = () =>
  page.evaluate(() => {
    const { app } = window;
    const root = app.book.root;
    root.updateWorldMatrix(true, true);
    let visible = true;
    for (let o = root; o; o = o.parent) if (!o.visible) visible = false;
    // Is the book's center inside what the camera sees? (three.js camera
    // space: in front of you = negative z; NDC x/y in [-1, 1] = on screen.)
    const p = root.getWorldPosition(root.position.clone());
    const cam = app.world.renderer.xr.isPresenting
      ? app.world.renderer.xr.getCamera()
      : app.world.camera;
    cam.updateMatrixWorld();
    const ndc = p.clone().project(cam);
    const inView = ndc.z < 1 && Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1;
    let attached = false;
    for (let o = root; o; o = o.parent) if (o === app.world.scene) attached = true;
    return {
      attached,
      visible,
      finite: [p.x, p.y, p.z].every(Number.isFinite),
      inView,
      spread: app.book.spreadLabel,
      title: app.bookTitle,
      pos: [p.x, p.y, p.z].map((v) => +v.toFixed(3)),
      music: app.music.currentName,
    };
  });

console.log('XR round trip (Add music…):');
// Emulated headset = a SEATED reader looking down ~30° at the table
// (the emulator's default is a standing person looking at the horizon,
// which can't see a coffee table 1 m below eye level).
await page.evaluate(() => {
  const d = window.IWER_DEVICE;
  d.controlMode = 'programmatic';
  const pitch = (-30 * Math.PI) / 180;
  d.position.set(0, 1.1, 0);
  d.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
  d.notifyStateChange();
});
await page.evaluate(() => window.app.world.launchXR());
await page.waitForTimeout(3000);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1500);
const before = await bookSnapshot();
console.log('  in VR before:', before);
check(before.inView, 'book is in view after entering VR');
// Same path as the in-VR menu "Add music…": leave VR, show the prompt...
await page.evaluate(() => {
  window.app.world.exitXR();
  window.app.overlay.promptPicker('music');
});
await page.waitForTimeout(1500);
// ...tap "Choose music…" and pick an MP3 in the real file dialog.
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('#launch-overlay .prompt button'),
]);
await chooser.setFiles('public/audio/rain-loop.mp3');
await page.waitForTimeout(1500);
await page.evaluate(() => window.app.world.launchXR());
await page.waitForTimeout(3000);
const after = await bookSnapshot();
console.log('  in VR after:', after);
check(after.music === 'rain-loop', 'picked MP3 is the current track');
check(after.attached && after.visible && after.finite, 'book still in the scene and visible');
check(after.spread === before.spread && after.title === before.title, 'same PDF and same pages');
check(after.inView, 'book is still in front of you after re-entering VR');

// ---------------------------------------------------------------------------
// Regression: while the book is held in one hand, the OTHER hand's trigger
// grabs a page (quick tap = flip) and must NOT swap hands. Swap = squeeze.
// ---------------------------------------------------------------------------
console.log('Trigger while held (free hand grabs a page, no swap):');
/** Aim one emulated controller's ray at a point on the book (model x/y as fractions of the page area). */
const aimAt = (hand, fx, fy, dist) =>
  page.evaluate(
    ({ hand, fx, fy, dist }) => {
      const { app } = window;
      const d = window.IWER_DEVICE;
      const V = app.book.root.position.constructor;
      const book = app.book;
      const sf = book.surface;
      const lx = fx * sf.halfWidth;
      const target = book.model.localToWorld(
        new V(lx, fy * sf.halfHeight, Math.abs(lx) * sf.slope + sf.baseZ),
      );
      // Page normal (model +z) in world, so we aim from the reader's side.
      const q = book.model.getWorldQuaternion(app.book.root.quaternion.clone());
      const n = new V(0, 0, 1).applyQuaternion(q);
      const from = target.clone().addScaledVector(n, dist);
      // The emulator's tracking space = world here (player rig at origin).
      const c = d.controllers[hand];
      c.position.set(from.x, from.y, from.z);
      const dir = target.clone().sub(from).normalize();
      c.quaternion.copy(app.book.root.quaternion.clone().setFromUnitVectors(new V(0, 0, -1), dir));
      d.notifyStateChange?.();
    },
    { hand, fx, fy, dist },
  );
const press = (hand, id, v) =>
  page.evaluate(({ hand, id, v }) => window.IWER_DEVICE.controllers[hand].updateButtonValue(id, v), { hand, id, v });
const bookState = () =>
  page.evaluate(() => ({ state: window.app.bookSystem.stateName, spread: window.app.book.spreadLabel, busy: window.app.book.isBusy }));

await page.evaluate(() => { window.IWER_DEVICE.primaryInputMode = 'controller'; });
await page.waitForTimeout(500);
// 1) Right hand: point at the book and SQUEEZE -> it flies into the right hand.
await aimAt('right', 0.5, 0, 0.4);
await page.waitForTimeout(300);
await press('right', 'squeeze', 1);
await page.waitForTimeout(1200);
let st = await bookState();
console.log('  after right squeeze:', st);
check(st.state === 'held-right', 'squeeze picks the book up (held-right)');
// 2) Left hand: aim at the RIGHT page, quick trigger tap -> page flips forward, no swap.
const spread0 = st.spread;
await aimAt('left', 0.5, 0, 0.35);
await page.waitForTimeout(400);
// The emulator runs at ~2-3 fps in software rendering, so a "quick tap" in
// wall-clock time could fall between two frames. Instead: hold the trigger
// until the app has grabbed the page, then let go (the app counts at most
// 1/30 s per frame toward the tap time, see BookSystem.handleHand).
await press('left', 'trigger', 1);
await page.waitForFunction(() => window.app.book.isDragging, null, { timeout: 5000 }).catch(() => {});
await press('left', 'trigger', 0);
await page.waitForTimeout(1500);
await page.waitForTimeout(2000);
st = await bookState();
console.log('  after left trigger tap on right page:', st);
check(st.state === 'held-right', 'free-hand trigger does NOT swap hands');
check(st.spread !== spread0, 'free-hand trigger tap on the right page turns it');
// 3) Left hand: grab the LEFT page with the trigger and DRAG it across to the right
//    (= turn BACK; after the tap we may be on the last spread, so back always works).
const spread1 = st.spread;
await aimAt('left', -0.6, 0, 0.35);
await page.waitForTimeout(300);
await press('left', 'trigger', 1);
await page.waitForTimeout(400);
for (const fx of [-0.3, 0, 0.3, 0.6, 0.85]) {
  await aimAt('left', fx, 0, 0.35);
  await page.waitForTimeout(150);
}
const mid = await bookState();
await press('left', 'trigger', 0);
await page.waitForTimeout(2000);
st = await bookState();
console.log('  after trigger drag left->right:', st, 'mid-drag busy:', mid.busy);
check(mid.busy, 'page follows the hand while the trigger is held');
check(st.state === 'held-right' && st.spread !== spread1, 'dragging the left page past halfway turns back, still held-right');
// 4) Left hand SQUEEZE on the book -> swaps to the left hand.
await aimAt('left', 0.5, 0, 0.35);
await page.waitForTimeout(300);
await press('left', 'squeeze', 1);
await page.waitForTimeout(1000);
await press('right', 'squeeze', 0);
await page.waitForTimeout(300);
st = await bookState();
console.log('  after left squeeze:', st);
check(st.state === 'held-left', 'squeeze with the free hand swaps hands');
await press('left', 'squeeze', 0);
await page.waitForTimeout(1500);
await page.evaluate(() => window.app.world.exitXR());
await page.waitForTimeout(500);

await browser.close();
if (errors.length) failures.push(`${errors.length} console error(s)`);
console.log(failures.length ? `FAIL: ${failures.join('; ')}` : 'OK: all checks passed, no console errors');
process.exit(failures.length ? 1 : 0);
