/**
 * Smoke test: opens the running dev server in headless Chrome, waits for the
 * scene, prints console errors, turns a page with the keyboard and saves a
 * screenshot to smoke.png.
 *
 *   npm run dev:runtime      (terminal 1)
 *   npm i --no-save playwright-core && npm run smoke   (terminal 2)
 *
 * Env: URL (default https://localhost:8081/), CHROME (path to chrome/chromium).
 */
import { chromium } from 'playwright-core';

const url = process.env.URL ?? 'https://localhost:8081/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text());
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); errors.push(e.message); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(8000);
const state = await page.evaluate(() => ({
  hasApp: !!window.app,
  pages: window.app?.book?.pageCount,
  title: window.app?.bookTitle,
  music: window.app?.music?.currentName,
}));
console.log('state', state);
await page.screenshot({ path: 'smoke.png' });
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1500);
console.log('after turn:', await page.evaluate(() => window.app?.book?.spreadLabel));
await page.keyboard.press('KeyM');
await page.waitForTimeout(500);
await page.screenshot({ path: 'smoke-menu.png' });
await browser.close();
console.log(errors.length ? `FAIL: ${errors.length} console error(s)` : 'OK: no console errors');
process.exit(errors.length ? 1 : 0);
