/**
 * Smoke test: opens the running dev server in headless Chrome (with IWSDK's
 * IWER emulator, which fakes a Quest headset), checks for console errors,
 * turns a page, and runs a REGRESSION CHECK for the "loading an MP3 makes the
 * book vanish" bug:
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
await page.evaluate(() => window.app.world.exitXR());
await page.waitForTimeout(500);

await browser.close();
if (errors.length) failures.push(`${errors.length} console error(s)`);
console.log(failures.length ? `FAIL: ${failures.join('; ')}` : 'OK: all checks passed, no console errors');
process.exit(failures.length ? 1 : 0);
