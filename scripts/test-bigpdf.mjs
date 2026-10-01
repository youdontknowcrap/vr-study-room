/**
 * test-bigpdf — PART A (automated) of TESTING-BIG-PDF.md.
 *
 * Opens a big PDF in headless Chrome once per toggle configuration, flips
 * pages, and prints a results table: open time, time until each spread is
 * sharp, last render ms, pages cached, texture MB, JS heap, Chrome memory
 * (RSS) on open and on reopen, plus pass/fail checks:
 *   - no blank pages (samples the rendered canvas pixels)
 *   - cache eviction + dispose (textures created - disposed == cached <= limit)
 *   - cancel-not-retried (fast flip: cancels happen, zero annotation retries)
 *   - EPUB and small-PDF regression (with everything on and everything off)
 *
 * It doesn't need a headset. It needs Chrome/Chromium and playwright-core
 * (already in node_modules via @iwsdk). It starts `vite` itself when nothing
 * is answering on URL, and stops it again at the end.
 *
 *   PDF=/path/to/big.pdf npm run test:bigpdf
 *
 * Env (all optional except PDF):
 *   PDF        big PDF to test (required)
 *   CONFIGS    comma list or "all" (default all): off,stream,res,cache,queue,preview,on
 *   FLIPS      page turns per config (default 10)
 *   RAPID      fast flips for the render-queue stress test (default 6)
 *   EPUB       EPUB for the regression check (skipped if unset)
 *   SMALL_PDF  small PDF for the regression check (the built-in sample book is always checked)
 *   URL        app URL (default https://localhost:8081/)
 *   CHROME     browser path (default /usr/bin/google-chrome)
 *   THROTTLE   CPU slowdown factor to roughly imitate Quest 2 (default 1 = none)
 *   OUT        JSON results file (default ./test-bigpdf-results.json)
 *   SHOTS      folder for a screenshot per config (default: none)
 *
 * WHY measure Chrome's process memory (RSS) and not just the JS heap: the
 * PDF bytes live in pdf.js's Web Worker and canvases/textures live outside
 * the JS heap, so the heap alone would hide exactly what we're testing.
 */
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const PDF = process.env.PDF;
if (!PDF || !fs.existsSync(PDF)) {
  console.error('Set PDF=/path/to/big.pdf (file not found: %s)', PDF);
  process.exit(2);
}
const URL_ = process.env.URL ?? 'https://localhost:8081/';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const FLIPS = +(process.env.FLIPS ?? 10);
const RAPID = +(process.env.RAPID ?? 6);
const THROTTLE = +(process.env.THROTTLE ?? 1);
const OUT = process.env.OUT ?? 'test-bigpdf-results.json';
const SHOTS = process.env.SHOTS ?? '';
const SPREAD_TIMEOUT = 90_000;

// Each config = localStorage values for the five toggles (see settings.ts).
// "off" is the old behaviour; each single-feature config is "off" + ONE fix.
const OFF = { pdfStreaming: '0', pdfResolution: '640', pdfCache: '0', pdfRenderQueue: '0', pdfPreview: '0' };
const ALL = {
  off: { ...OFF },
  stream: { ...OFF, pdfStreaming: '1' },
  res: { ...OFF, pdfResolution: '1200' },
  cache: { ...OFF, pdfCache: '4' },
  queue: { ...OFF, pdfRenderQueue: '1' },
  preview: { ...OFF, pdfPreview: '1' },
  on: { pdfStreaming: '1', pdfResolution: '1200', pdfCache: '6', pdfRenderQueue: '1', pdfPreview: '1' },
};
const wanted = (process.env.CONFIGS ?? 'all') === 'all' ? Object.keys(ALL) : process.env.CONFIGS.split(',');

// ---------------------------------------------------------------- server
function up() {
  // Plain https.get so we can accept the dev server's self-signed cert.
  return new Promise((resolve) => {
    const lib = URL_.startsWith('https') ? https : null;
    if (!lib) return fetch(URL_).then((r) => resolve(r.ok), () => resolve(false));
    const req = https.get(URL_, { rejectUnauthorized: false, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
let server = null;
if (!(await up())) {
  console.log('Starting vite…');
  server = spawn('npx', ['vite'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await up())) throw new Error('vite did not start');
}

// ---------------------------------------------------------------- memory
/** RSS (MB) of every process of the browser using profile `dir`, and its largest renderer. */
function rss(dir) {
  try {
    const rows = execSync('ps -eo pid,ppid,rss,args --no-headers').toString().trim().split('\n');
    const procs = rows.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: +m[1], ppid: +m[2], kb: +m[3], args: m[4] }));
    // Start from processes started with our private profile folder, then add their children.
    const mine = new Set(procs.filter((p) => p.args.includes(dir)).map((p) => p.pid));
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of procs) if (!mine.has(p.pid) && mine.has(p.ppid)) (mine.add(p.pid), (grew = true));
    }
    let total = 0, renderer = 0;
    for (const p of procs) {
      if (!mine.has(p.pid)) continue;
      total += p.kb;
      if (p.args.includes('--type=renderer')) renderer = Math.max(renderer, p.kb);
    }
    return { total: Math.round(total / 1024), renderer: Math.round(renderer / 1024) };
  } catch {
    return { total: 0, renderer: 0 };
  }
}

// ---------------------------------------------------------------- helpers run in the page
/** State of the open spread: textures present, sharp, and do they look blank? */
const spreadState = () => {
  const b = window.app.book, p = b.pageSource, L = b.currentLeft;
  const idx = [L, L + 1].filter((i) => i >= 0 && i < b.pageCount);
  const res = window.settings.pdfResolution.value;
  const pages = idx.map((i) => {
    const e = p.textures?.get(i);
    const tex = e?.tex ?? e; // PDF entries wrap the texture, EPUB maps store it directly
    const c = tex?.image;
    let blank = true, std = 0;
    if (c && c.width > 0 && c.height > 0) {
      // Sample a 32x32 grid of pixels; a real page has ink, a blank one is flat.
      const g = document.createElement('canvas');
      g.width = g.height = 32;
      const ctx = g.getContext('2d');
      ctx.drawImage(c, 0, 0, 32, 32);
      const d = ctx.getImageData(0, 0, 32, 32).data;
      let sum = 0, sq = 0;
      for (let k = 0; k < d.length; k += 4) {
        const v = (d[k] + d[k + 1] + d[k + 2]) / 3;
        sum += v; sq += v * v;
      }
      const n = d.length / 4;
      std = Math.sqrt(sq / n - (sum / n) ** 2);
      blank = std < 2;
    }
    const sharp = e?.sharp === undefined ? !!tex : e.sharp && e.px === res;
    return { i, has: !!tex, sharp, blank, std: +std.toFixed(1), w: c?.width ?? 0, h: c?.height ?? 0 };
  });
  return { L, pages, ready: pages.every((x) => x.has && x.sharp), busy: b.isBusy };
};
const statsNow = () => {
  const s = window.app.book.pageSource?.getStats?.() ?? {};
  const m = performance.memory;
  return { ...s, debug: { ...(window.app.book.pageSource?.debug ?? {}) }, heapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null };
};

async function waitSpread(page, ms = SPREAD_TIMEOUT) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < ms) {
    st = await page.evaluate(spreadState);
    if (st.ready && !st.busy) return { ms: Date.now() - t0, st };
    await page.waitForTimeout(100);
  }
  return { ms: null, st };
}
const idle = (page) => page.waitForFunction(() => !window.app.book.isBusy, null, { timeout: 30000, polling: 50 }).catch(() => {});
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function openFile(page, path, expectPages) {
  await page.setInputFiles('input[type=file][accept*="pdf"]', path);
  await page.waitForFunction((n) => window.app.book.pageCount > 0 && (!n || window.app.book.pageCount === n) && window.app.bookTitle.includes('p.)'),
    expectPages, { timeout: 300000, polling: 100 });
}

// ---------------------------------------------------------------- one configuration
async function runConfig(name) {
  const cfg = ALL[name];
  // A fresh private profile per config: clean memory, clean localStorage,
  // and a folder name we can find in `ps` to measure this browser's memory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigpdf-profile-'));
  const browser = await chromium.launchPersistentContext(root, {
    executablePath: CHROME,
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    args: ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
  });
  const page = browser.pages()[0] ?? (await browser.newPage());
  const warns = [];
  page.on('console', (m) => { if (m.type() === 'error' || /\[pdf\]/.test(m.text())) warns.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => warns.push('pageerror ' + e.message.slice(0, 160)));
  page.on('crash', () => warns.push('PAGE CRASHED'));
  // Write the toggles into localStorage before the app reads them.
  await page.addInitScript((c) => { for (const [k, v] of Object.entries(c)) localStorage.setItem('vrStudyRoom.' + k, v); }, cfg);
  const cdp = await browser.newCDPSession(page);
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.book?.pageCount > 0, null, { timeout: 120000 });
  await idle(page);
  await waitSpread(page, 30000);

  // Peak memory sampler (5x a second) for the open / reopen phases.
  let peak = { total: 0, renderer: 0 };
  const sampler = setInterval(() => { const r = rss(root); peak = { total: Math.max(peak.total, r.total), renderer: Math.max(peak.renderer, r.renderer) }; }, 200);
  const before = rss(root);

  const r = { config: name, toggles: cfg, flips: [], checks: {}, warns };
  let t0 = Date.now();
  await openFile(page, PDF);
  r.openMs = Date.now() - t0;
  r.pageCount = await page.evaluate(() => window.app.book.pageCount);
  await idle(page);
  const first = await waitSpread(page);
  r.firstSpreadMs = first.ms;
  r.memOpen = { baseMB: before.renderer, peakRendererMB: peak.renderer, peakTotalMB: peak.total, afterRendererMB: rss(root).renderer };

  // ---- reading flips: turn, then wait until the new spread is sharp
  let blank = 0, missing = 0;
  for (let k = 0; k < FLIPS; k++) {
    await idle(page);
    await page.evaluate(() => window.app.book.turnPage(1));
    await idle(page);
    const w = await waitSpread(page);
    const s = await page.evaluate(statsNow);
    for (const p of w.st.pages) { if (!p.has) missing++; else if (p.blank) blank++; }
    r.flips.push({ L: w.st.L, readyMs: w.ms, lastRenderMs: s.lastRenderMs, cached: s.cachedPages, texMB: +((s.textureBytes ?? 0) / 1048576).toFixed(1), heapMB: s.heapMB, size: `${w.st.pages[0]?.w}x${w.st.pages[0]?.h}`, blank: w.st.pages.filter((p) => p.blank).map((p) => p.i + 1) });
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bigpdf-${name}.png` });

  // ---- eviction / dispose check (let the prefetch finish first)
  await page.waitForTimeout(1500);
  const ev = await page.evaluate(() => {
    const p = window.app.book.pageSource;
    return { cached: p.textures.size, created: p.debug.texturesCreated, disposed: p.debug.texturesDisposed, limit: window.settings.pdfCacheSize.value };
  });
  const limit = ev.limit === 0 ? 13 : Math.max(2, ev.limit);
  r.checks.eviction = { ...ev, ok: ev.cached <= limit && ev.created - ev.disposed === ev.cached };

  // ---- fast-flip stress: turn as soon as the animation allows, no waiting for renders
  const d0 = await page.evaluate(() => ({ ...window.app.book.pageSource.debug }));
  t0 = Date.now();
  for (let k = 0; k < RAPID; k++) { await idle(page); await page.evaluate(() => window.app.book.turnPage(1)); }
  await idle(page);
  const settle = await waitSpread(page);
  const d1 = await page.evaluate(() => ({ ...window.app.book.pageSource.debug }));
  r.rapid = { flipsMs: Date.now() - t0 - (settle.ms ?? 0), settleMs: settle.ms, cancelled: d1.cancelled - d0.cancelled, retried: d1.retriedWithoutAnnotations - d0.retriedWithoutAnnotations, renders: d1.renders - d0.renders };
  for (const p of settle.st.pages) { if (!p.has) missing++; else if (p.blank) blank++; }
  r.checks.cancelNotRetried = { ok: r.rapid.retried === 0 && settle.ms !== null, cancelled: r.rapid.cancelled, retried: r.rapid.retried };
  r.checks.noBlank = { ok: blank === 0 && missing === 0, blank, missing };

  // ---- reopen the same file (streaming memory)
  peak = { total: 0, renderer: 0 };
  const beforeReopen = rss(root).renderer;
  t0 = Date.now();
  await page.evaluate(async () => { const m = await import('/src/app.ts'); await m.reopenBook(); });
  await page.waitForFunction(() => window.app.bookTitle.includes('p.)'), null, { timeout: 300000 });
  r.reopenMs = Date.now() - t0;
  await idle(page);
  await waitSpread(page);
  await page.waitForTimeout(1000);
  r.memReopen = { beforeMB: beforeReopen, peakRendererMB: peak.renderer, afterRendererMB: rss(root).renderer };
  clearInterval(sampler);

  r.summary = {
    openMs: r.openMs,
    firstSpreadMs: r.firstSpreadMs,
    medianSpreadMs: median(r.flips.map((f) => f.readyMs)),
    medianRenderMs: median(r.flips.map((f) => f.lastRenderMs)),
    cached: r.flips.at(-1)?.cached,
    texMB: r.flips.at(-1)?.texMB,
    heapMB: r.flips.at(-1)?.heapMB,
    pageSize: r.flips.at(-1)?.size,
  };

  // ---- regression: EPUB and small PDFs still open and render (only for off/on)
  if (name === 'off' || name === 'on') {
    const reg = [];
    const check = async (label, fn) => {
      try {
        await fn();
        await idle(page);
        const a = await waitSpread(page, 30000);
        // Title pages can be nearly empty, so also turn once and look at a
        // content spread: every page must exist and at least one must have ink.
        await page.evaluate(() => window.app.book.turnPage(1));
        await idle(page);
        const b = await waitSpread(page, 30000);
        const all = [...a.st.pages, ...b.st.pages];
        const ok = a.ms !== null && b.ms !== null && all.every((p) => p.has) && all.some((p) => !p.blank);
        reg.push({ label, ok, pages: await page.evaluate(() => window.app.book.pageCount), detail: all.map((p) => `${p.i + 1}:${p.has ? (p.blank ? 'flat' : 'ink') : 'missing'}`).join(' ') });
      } catch (e) {
        reg.push({ label, ok: false, error: String(e).slice(0, 120) });
      }
    };
    await check('sample PDF', () => page.evaluate(async () => { const m = await import('/src/app.ts'); await m.loadSampleBook(); }));
    if (process.env.SMALL_PDF) await check('small PDF', () => openFile(page, process.env.SMALL_PDF));
    if (process.env.EPUB) await check('EPUB', () => openFile(page, process.env.EPUB));
    r.checks.regression = { ok: reg.every((x) => x.ok), items: reg };
  }
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
  return r;
}

// ---------------------------------------------------------------- main
const results = [];
try {
  for (const name of wanted) {
    if (!ALL[name]) { console.warn('unknown config', name); continue; }
    process.stdout.write(`▶ ${name} … `);
    const t = Date.now();
    try {
      results.push(await runConfig(name));
      console.log(`${Math.round((Date.now() - t) / 1000)} s`);
    } catch (e) {
      console.log('FAILED', String(e).slice(0, 200));
      results.push({ config: name, error: String(e).slice(0, 300), checks: { run: { ok: false } } });
    }
  }
} finally {
  if (server) try { process.kill(-server.pid); } catch { /* already gone */ }
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
const cell = (v) => (v === null || v === undefined ? '—' : String(v));
const ok = (c) => (!c ? '—' : c.ok ? 'PASS' : 'FAIL');
console.log(`\nBig PDF results  (${PDF}, ${FLIPS} flips, CPU throttle ${THROTTLE}x)\n`);
console.log('| config | open ms | 1st spread ms | median spread ms | median render ms | cached | tex MB | heap MB | page px | RSS open peak MB | RSS reopen peak MB | rapid cancelled/retried | no blank | evict | cancel | regress |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const s = r.summary ?? {};
  console.log(`| ${r.config} | ${cell(s.openMs)} | ${cell(s.firstSpreadMs)} | ${cell(s.medianSpreadMs)} | ${cell(s.medianRenderMs)} | ${cell(s.cached)} | ${cell(s.texMB)} | ${cell(s.heapMB)} | ${cell(s.pageSize)} | ${cell(r.memOpen?.peakRendererMB)} | ${cell(r.memReopen?.peakRendererMB)} | ${r.rapid ? `${r.rapid.cancelled}/${r.rapid.retried}` : '—'} | ${ok(r.checks?.noBlank)} | ${ok(r.checks?.eviction)} | ${ok(r.checks?.cancelNotRetried)} | ${ok(r.checks?.regression)} |`);
}
for (const r of results) {
  if (r.error) console.log(`\n${r.config}: ERROR ${r.error}`);
  if (r.checks?.regression) console.log(`${r.config} regression: ${r.checks.regression.items.map((i) => `${i.label}=${i.ok ? 'ok' : 'FAIL'} (${i.pages ?? '?'} p.; ${i.detail ?? i.error ?? ''})`).join(', ')}`);
  if (r.warns?.length) console.log(`${r.config} warnings: ${[...new Set(r.warns)].slice(0, 4).join(' | ')}`);
}
console.log(`\nFull details: ${OUT}`);
// Blank pages only FAIL the run when a fix is on; the old path is allowed to be bad (that's the bug).
const failed = results.some((r) => Object.entries(r.checks ?? {}).some(([k, c]) => !c.ok && !(k === 'noBlank' && r.config === 'off')));
process.exit(failed ? 1 : 0);
