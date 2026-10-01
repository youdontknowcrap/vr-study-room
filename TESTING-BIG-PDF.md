# Testing the Big PDF performance toggles

Test file: **Great Books of the Western World, Volume 2** — `greatbooks-v2.pdf`
(287 MB, 1,144 pages, 487×702 pt). It's a scanned "MRC" PDF: every page is a
1159×1673 JPEG background plus a 3477×5017 JPEG layer with a JBIG2 mask, so
about **17 megapixels of image per page**. Before these toggles, it froze a Quest 2
a page or two in and left pages blank.

> ⚠️ Never commit this file (or any big PDF) to the repo. Keep it somewhere outside
> the repo folder, e.g. `~/books/greatbooks-v2.pdf`.

The procedure has **two parts**. Every check is tagged with its part:

| Part | Who / where | What it answers |
|---|---|---|
| **[A] AUTOMATED** | An agent or you, on a computer, headless Chrome, **no headset** | Does it work? Do the numbers move the right way? (render ms, cache, texture MB, heap, memory, blank pages, dispose, cancel, regressions) |
| **[B] HUMAN EYE / HEADSET** | Joey, on the **Quest 2** | How does it *feel*? Freezes, hitches, preview feel, sharpness, comfort, real Quest memory and crashes |

Do Part A first: if A fails, B isn't worth your time yet.

---

## The toggles (menu → **Big PDF ▸**)

Open the menu (controller **B/Y**, or poke the **☰ Menu** tab on the desk), then press
**Big PDF ▸** (bottom row, middle). All settings are saved in `localStorage`, so they
survive reloads.

| # | Menu label (as built) | Values | Default | Applies |
|---|---|---|---|---|
| 1 | **Streaming load: On/Off** | On / Off | **On** | when a book is opened. Flipping it reopens the picked file automatically (same page) |
| 2 | **Res − / Res 1200px / Res +** | 640 (old) · 800 · 1200 · 1600 · 2048 px on the page's long side | **1200px** | live: the open spread re-renders (old texture stays until the new one is ready) |
| 3 | **Cache − / Cache 6 pg / Cache +** | 2 · 4 · 6 · 8 pages · **Old ±6** (old rule: anything within 6 pages, up to 13) | **6 pg** | live, at the next refresh |
| 4 | **Queue: On/Off** (render queue) | On / Off | **On** | live |
| 5 | **Blurry 1st: On/Off** (blurry-first preview, ~360 px) | On / Off | **On** | next page render |
| – | **Stats: On/Off** (head-locked readout, lower left) | On / Off | **Off** | live |
| – | **All on (Quest)** | sets 1-5 to the defaults above | | |
| – | **All off (old)** | Streaming Off, Res 640, Cache Old ±6, Queue Off, Blurry 1st Off = the original behaviour = **baseline** | | |
| – | **Reopen book** | reopens the last picked file (or the sample book) | | |

Tapping the middle value button (Res / Cache) resets it to its default. Toggles that
are **On** are tinted green.

**Stats readout** (6 lines, updates twice a second):

```
Render: 2193 ms (last page)        ← time from "start page" to "sharp texture ready" (includes the blurry pass)
Cached: 6 pages · waiting 0 · cancelled 0   ← textures held · renders queued/running · renders cancelled so far
Textures: ~28.9 MB                 ← w×h×4 bytes ×4/3 (mipmaps), summed over cached pages
JS heap: 182 / 4192 MB             ← main-thread JS heap (performance.memory); NOT the pdf.js worker, NOT canvases
Stream on · Res 1200 · Cache 6     ← which toggles are active (handy in photos/recordings)
Queue on · Blurry 1st on
```

Why the heap number can't show everything: the PDF bytes live in pdf.js's **Web
Worker**, and canvas pixels live outside the JS heap. That's why Part A measures
Chrome's process memory (RSS), and Part B uses `adb` for real Quest memory.

---

# Part A — AUTOMATED (no headset)

Run on any Linux/macOS computer with Node 22+, Chrome or Chromium. From the repo root:

### A1. [A] Static checks and the existing tests

```bash
npm ci
npm run typecheck        # TypeScript, no output = OK
npm run build            # production build into dist/
npm run test:unit        # page-grab, palm-frame, EPUB unit checks → "OK: ..." lines
npm run dev:runtime &    # dev server on https://localhost:8081 (needed by smoke)
npm run smoke            # headless Chrome + IWER emulator, ends with "OK: all checks passed"
```

### A2. [A] The scripted big-PDF run: `npm run test:bigpdf`

```bash
PDF=~/books/greatbooks-v2.pdf \
EPUB=~/books/alice.epub \
SMALL_PDF=~/books/some-small.pdf \
npm run test:bigpdf
```

What it does (`scripts/test-bigpdf.mjs`), once **per configuration**, each in a fresh
headless Chrome with a fresh profile:

| config | Streaming | Res | Cache | Queue | Blurry 1st |
|---|---|---|---|---|---|
| `off` (baseline = old behaviour) | Off | 640 | Old ±6 | Off | Off |
| `stream` | **On** | 640 | Old | Off | Off |
| `res` | Off | **1200** | Old | Off | Off |
| `cache` | Off | 640 | **4** | Off | Off |
| `queue` | Off | 640 | Old | **On** | Off |
| `preview` | Off | 640 | Old | Off | **On** |
| `on` (all, Quest defaults) | On | 1200 | 6 | On | On |

1. Opens the PDF through the real file picker input, timing the open and sampling
   Chrome's memory (RSS) 5×/s → **RSS open peak**.
2. **Reading flips** (`FLIPS`, default 10): turn a page, wait until both visible pages
   have a sharp texture → **spread ms**, plus the stats readout's numbers
   (**render ms, cached, texture MB, heap MB**, page pixel size).
3. **No-blank check**: draws each visible page's canvas down to 32×32 and measures
   the pixel spread; a flat canvas or missing texture counts as blank.
4. **Eviction/dispose check**: cached pages ≤ cache size, and
   `texturesCreated − texturesDisposed == cached` (every texture that left the cache,
   or was replaced by a sharper one, was disposed).
5. **Fast-flip stress** (`RAPID`, default 6): turns as fast as the animation allows
   without waiting for renders, then waits for the spread to settle. Records
   **cancelled** renders and **retried** renders. Cancel-not-retried = PASS when
   retries are 0 and the final spread renders.
6. **Reopen** the same file → **RSS reopen peak** (streaming should stay flat; full copy
   loads the 287 MB again).
7. For `off` and `on` only: **regression** — the built-in sample PDF, `SMALL_PDF` and
   `EPUB` must open and render (every page present, at least one with ink).

Output: a markdown results table on stdout, full details in
`test-bigpdf-results.json`. Exit code 1 if a check fails (blank pages in the `off`
baseline are reported but don't fail the run: that's the original bug).

Useful env vars: `CONFIGS=off,on` (subset), `FLIPS=4` (quicker), `THROTTLE=4` (slow
the CPU 4× to imitate a Quest 2 more closely), `SHOTS=/some/folder` (a screenshot per
config), `URL=…`, `CHROME=/path/to/chrome`. It starts `vite` itself if nothing answers
on `URL`, and stops it afterwards.

Runtime: ~1-3 minutes per configuration on a desktop (software WebGL), so the full
7-config run takes 10-20 minutes. `CONFIGS=off,on FLIPS=4` takes ~3 minutes.

### A3. [A] Reading the table — what "good" looks like

| Column | Expected for the fix | Why |
|---|---|---|
| open ms (`stream` vs `off`) | `stream` ≈ 0.1-0.5 s; `off` several seconds | streaming reads ~256 KB pieces, the old way reads all 287 MB first |
| RSS open/reopen peak (`stream`, `on` vs `off`) | clearly lower, and reopen ≈ open | no full 287 MB copy in the worker; the old document's worker is destroyed |
| median render ms (`queue` vs `off`) | lower per page | one render at a time instead of 4-6 fighting for the CPU |
| tex MB (`res`) | ~3.5× the 640 run | pixels grow with the square of the resolution |
| cached (`cache`) | ≤ 4 | eviction works |
| rapid cancelled/retried (`queue`, `on`) | cancelled ≥ 1, retried **0** | stale renders get cancelled and are never re-run without annotations |
| no blank / evict / cancel / regress | PASS (except `off` may show blank) | |

**Reference run** (Oct 1 2026, Linux desktop, headless Chrome with software WebGL,
THROTTLE 1, FLIPS 10; RSS = Chrome renderer process, which includes the pdf.js worker):

| config | open ms | median spread ms | median render ms | cached | tex MB | RSS after 10 flips MB | RSS reopen peak MB | cancelled/retried | checks |
|---|---|---|---|---|---|---|---|---|---|
| off | 588 | 2015 | 4356 | 7 | 9.6 | 1210 | 1858 | 0/0 | all PASS |
| stream | 899 | 2435 | 5485 | 7 | 9.6 | 879 | 1002 | 0/0 | all PASS |
| res (1200) | 822 | 2001 | 4450 | 7 | 33.9 | 1213 | 1901 | 0/0 | all PASS |
| cache (4) | 619 | 1652 | 4090 | 2-4 | 2.7 | 1249 | 1735 | 0/0 | all PASS |
| queue | 726 | 5823 | 3132 | 7 | 9.6 | 1069 | 1644 | 2/0 | all PASS |
| preview | 74 | 1849 | 5315 | 8 | 10.1 | 1153 | 2005 | 0/0 | all PASS |
| on | 46 | 7200 | 3831 | 4-6 | 19.2 | 796 | 915 | 2/0 | all PASS |

How to read it: streaming saves ~330 MB once pages are read and ~950 MB on reopen
(off 1858 vs on 915). The queue makes each page render faster (3.1 s vs 4.4 s) but the
*spread* takes longer in this test, because the script flips the moment a spread is
sharp: a desktop with many cores gains from 4-6 parallel renders, and the next spread
hasn't been prefetched yet. On a Quest 2 those parallel 17-megapixel renders are what
freeze it, and when you actually read a spread the prefetch has time to finish.
That trade-off is exactly what Part B (B3/B4) has to judge. The desktop has plenty of
memory, so the `off` baseline showed no blank pages here; on the Quest it does.

### A4. [A] Results (fill in, or paste the script's table)

| Date | Commit | Machine | THROTTLE | Notes |
|---|---|---|---|---|
| | | | | |

| config | open ms | median spread ms | median render ms | cached | tex MB | RSS open peak MB | RSS reopen peak MB | cancelled/retried | no blank | evict | cancel | regress |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | | | | | | | | | | | | |
| stream | | | | | | | | | | | | |
| res | | | | | | | | | | | | |
| cache | | | | | | | | | | | | |
| queue | | | | | | | | | | | | |
| preview | | | | | | | | | | | | |
| on | | | | | | | | | | | | |

---

# Part B — HUMAN EYE / HEADSET (Quest 2)

These are the things a script can't judge: how it feels, how sharp small print looks,
whether the Quest itself stutters, runs out of memory or kills the tab.

### B0. [B] Setup: run the app and get the file onto the Quest

1. **Laptop:** plug the Quest 2 in with a USB-C *data* cable, accept "Allow USB
   debugging" in the headset, then:
   ```bash
   npm run adb:devices        # your Quest must be listed as "device"
   npm run dev:usb            # adb reverse tcp:8081 + plain-HTTP Vite on port 8081
   ```
2. **Copy the PDF to the Quest's Download folder** (one time, ~30 s over USB):
   ```bash
   adb push ~/books/greatbooks-v2.pdf /sdcard/Download/
   adb push ~/books/alice.epub /sdcard/Download/          # for the EPUB check
   adb push ~/books/some-small.pdf /sdcard/Download/      # for the small-PDF check
   ```
   (No cable? Any way that lands the file in the Quest's Downloads works, e.g.
   downloading it in Quest Browser from a cloud drive.)
3. **Quest:** open Meta Quest Browser → `http://localhost:8081` → **Enter VR**.
4. **Open the file:** menu → **Open book… (leaves VR)** → tap the big button on the
   2D page → pick *Downloads → greatbooks-v2.pdf* → **Enter VR** again.
5. Menu → **Big PDF ▸** → **Stats: On**. Leave the Big PDF page open next to you; it
   has **◀ Page / Page ▶** so you can flip from there.
6. *(Optional, real Quest memory)* In a laptop terminal, run this while testing and
   note the biggest number for the browser processes (names vary by Quest OS version):
   ```bash
   watch -n 2 "adb shell dumpsys meminfo | grep -iE 'browser|sandboxed' | head -8"
   ```
   Or open `chrome://inspect` on the laptop → *inspect* the Quest tab → Performance
   monitor / Memory panel.

Start every test below by **reopening the book** (menu → Reopen book) so tests don't
inherit each other's cache. Read 2 spreads in, then do the test. Look at the stats
readout before and after.

### B1. [B] Baseline: everything off

Press **All off (old)** (this also reopens the file without streaming), then flip
forward ~5 spreads, waiting for each.

- **Watch for:** the freeze (head tracking keeps going but the scene stops updating,
  or the whole view hitches), pages that stay blank paper, the tab reloading or
  crashing back to the browser.
- **Stats:** `Res 640 · Cache Old`, *Render* in the many seconds, *waiting* stays 0
  (no queue) while several renders run at once, *Cached* up to ~6-13.
- This is the "before" you compare everything else to. If it crashes, note on which
  page and move on.

### B2. [B] Each feature alone

From **All off (old)**, switch **one** toggle on, reopen, flip ~5 spreads, then switch
it off again before the next one.

| Toggle alone | What to watch for (feel) | What the stats should show |
|---|---|---|
| **Streaming load: On** | the book opens almost immediately; less chance of the Quest killing the tab on open | *JS heap* barely changes (bytes are in the worker); `adb` memory a few hundred MB lower than baseline on open |
| **Res 1200px** (then also try 800, 1600, 2048) | sharper print, but each page takes longer; 2048 may hitch or crash | *Textures* MB grows ~with Res² (≈5 MB/page at 1200, ≈15 MB/page at 2048) |
| **Cache 2 pg / 4 pg** | flipping back one spread re-renders (blank or blurry briefly) | *Cached* never above the setting (except for a moment mid-turn); *Textures* MB plateaus |
| **Queue: On** | after a flip, the page you're LOOKING at renders first, not a page you passed | *waiting* goes up to ~4-5 then down; *cancelled* increases when you flip before a page finishes |
| **Blurry 1st: On** | a blurry page appears quickly, then snaps sharp | *Render* ms slightly higher (it includes the quick pass) |

### B3. [B] All on

Press **All on (Quest)**. Flip ~10 spreads at reading pace.

- **Watch for:** no freeze, no blank pages (blurry for a moment is fine), smooth head
  tracking while a page renders.
- **Stats:** `Stream on · Res 1200 · Cache 6`, *Cached* ≤ 6, *Textures* ~30 MB.

### B4. [B] Fast-flip stress test (render queue)

With **All on**, press **Page ▶** as fast as the animation allows, 10-15 times, then stop.
Then repeat with **Queue: Off**.

- **Watch for (Queue On):** the book keeps animating smoothly; when you stop, the spread
  you landed on renders within a few seconds (blurry first), and doesn't wait behind
  the pages you skipped.
- **Watch for (Queue Off):** hitching during the flips, a long wait at the end, maybe
  blank pages or a crash. That's the difference the queue makes.
- **Stats (Queue On):** *cancelled* goes up by roughly the number of skipped pages;
  *waiting* drops back to 0 shortly after you stop.

### B5. [B] Long session: 50+ pages (cache + dispose)

With **All on**, read/flip through **at least 50 pages** (25 spreads) at a normal pace,
~5-10 minutes. Note the stats every ~10 spreads.

- **Watch for:** it should feel the same at page 50 as at page 5. Getting slower and
  slower, more hitches, or a crash near the end means something leaks.
- **Stats:** *Cached* and *Textures* MB stay flat (≤ 6 pages, ~30 MB). *JS heap* may
  go up and down (garbage collection) but shouldn't keep climbing. `adb` memory should
  level off, not climb steadily.

### B6. [B] Reopen the book (streaming memory)

With **Streaming load: On**, press **Reopen book** 3 times, waiting for the first
spread each time. Then do the same with **Streaming load: Off**.

- **Watch for:** Off may be slow to reopen, or crash on the 2nd/3rd reopen. On should
  reopen almost instantly every time.
- **Memory (`adb`):** On should return to about the same number after each reopen.
  Off jumps by ~300 MB on every open.

### B7. [B] Sharpness of small print at each resolution

Go to a page with **footnotes or small print**. Hold the book at your normal reading
distance. Step through **Res 640 → 800 → 1200 → 1600 → 2048** (each re-renders the
spread live), and for each, rate readability 1-5 and note the render time.

- **Watch for:** the level where small print stops getting noticeably sharper. On the
  Quest 2 screen it's often around 1200-1600: above that you only pay in memory.
- Also try the book at 150-200% size (menu → Size +), where higher resolution matters more.

### B8. [B] Comfort

During B3-B5, note anything uncomfortable: judder when a page renders, the stats
readout being annoying (it's head-locked), eye strain from blurry pages, menu reach.

### B9. [B] Regression: EPUB and small PDFs

With **All on**, then again with **All off (old)**:

1. Menu → **Sample book**: opens, both pages sharp, page turns work.
2. Open a small PDF (e.g. a paper or slide deck): opens, renders, page turns work.
3. Open an EPUB (e.g. alice.epub): opens, text pages render, page turns work.
   (The Big PDF toggles don't change EPUBs; the stats readout still shows its cache.)
4. Grab the book, hold it from the palm, turn a page by pinching: unchanged.

### B10. [B] Results

| # | Test | Settings | Freeze / hitch? | Blank pages? | Crash / reload? | Render ms (stats) | Cached / Tex MB | adb memory MB | Notes / feel (1-5) |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Baseline | All off | | | | | | | |
| B2 | Streaming alone | | | | | | | | |
| B2 | Res 1200 alone | | | | | | | | |
| B2 | Cache 4 alone | | | | | | | | |
| B2 | Queue alone | | | | | | | | |
| B2 | Blurry 1st alone | | | | | | | | |
| B3 | All on | | | | | | | | |
| B4 | Fast flip, Queue On | | | | | | | | |
| B4 | Fast flip, Queue Off | | | | | | | | |
| B5 | 50+ pages | All on | | | | | | | |
| B6 | Reopen ×3, Streaming On | | | | | | | | |
| B6 | Reopen ×3, Streaming Off | | | | | | | | |
| B9 | Sample / small PDF / EPUB | All on & All off | | | | | | | |

| B7 sharpness | 640 | 800 | 1200 | 1600 | 2048 |
|---|---|---|---|---|---|
| Small print readable (1-5) | | | | | |
| Render ms | | | | | |
| Textures MB | | | | | |
| Hitch or crash? | | | | | |

**Decision after testing** (for the refactor): which toggles become permanent, at what
level, and which code paths get deleted? Every experiment's code is tagged
`[1 STREAMING]` … `[5 PREVIEW]` in `src/book/pdf-pages.ts`.
