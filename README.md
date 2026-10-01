# VR Study Room

A cozy study room for Meta Quest that runs right in the browser (WebXR).
Sit down at a slanted reading desk, pick up a real-feeling 3D book made from
any **PDF or EPUB**, turn its pages with your hands, put on some music or
rain, and work things out on a whiteboard next to you. When you're done,
export your notes as a PDF.

It's a personal, open source project: no accounts, no servers, no tracking.
Your books, music and notes stay on your headset.

Built with **Meta Immersive Web SDK (IWSDK) 1.0.0-rc.2** + three.js + Vite +
TypeScript.

## Features

- **Read PDFs and EPUBs as a 3D book.** Hold it in either hand, set it on
  the reading stand, grab a page and turn it, or flick the thumbstick. A
  ribbon bookmark remembers where you stopped in every book.
- **Big PDFs stream in.** Pages render one at a time in a small sliding
  window with a quick blurry preview first, so even a 1,000-page scanned
  book stays smooth on a Quest 2 (menu → *Big PDF ▸*, see
  [TESTING-BIG-PDF.md](TESTING-BIG-PDF.md)).
- **Music and ambience.** Bring your own MP3s or use the built-in fireplace
  and rain loops. They play from a little radio on the desk, in spatial audio.
- **Whiteboard notes.** A whiteboard on an easel with a marker (8 colors,
  5 sizes) and an eraser. Multiple pages, portrait or landscape, save/load,
  autosave, and **Export PDF** (one US Letter page per board page).
- **Custom scenes.** The built-in *Pool room* (a sliding glass door onto a
  backyard pool) is the default. Drop your own 3D rooms into `scenes/` and
  read wherever you like. See [Custom scenes](#custom-scenes-your-own-rooms).
- **Comfortable, seated, adjustable.** Book size, desk height and tilt are
  all in the menu and remembered. Controllers and hand tracking both work.

---

## Quick start

You need **git**, **Node.js 22** (or 20.19+ / 24+) and, for the headset,
**adb**. No gaming GPU needed: on the computer the app runs in an emulator
inside Chrome, and the real rendering happens on the Quest.

```bash
# Linux (Debian/Ubuntu/Mint):  sudo apt install -y git curl android-tools-adb
# macOS (Homebrew):            brew install git node@22 android-platform-tools
# Node via nvm (any OS):       https://github.com/nvm-sh/nvm, then `nvm install 22`

git clone https://github.com/youdontknowcrap/vr-study-room.git
cd vr-study-room
nvm use            # optional: picks the version pinned in .nvmrc
npm install

npm run dev        # opens https://localhost:8081 with a fake Quest (IWER emulator)
```

Then on a **Quest** (Developer Mode on, see [§3](#3-on-the-quest)):

```bash
npm run dev:usb    # USB cable: open http://localhost:8081 in Quest Browser
# or
npm run dev:lan    # same Wi-Fi: open the https://192.168.x.y:8081 address Vite prints
```

Tap **Enter VR** and you're in.

---

## Contents

1. [Running on your computer (emulator)](#1-running-on-your-computer-emulator)
2. [Scripts](#2-scripts)
3. [On the Quest](#3-on-the-quest)
4. [Controls](#4-controls)
5. [How it works / project structure](#5-how-it-works--project-structure)
6. [Hosting your own copy](#6-hosting-your-own-copy)
7. [Ideas and known limitations](#7-ideas-and-known-limitations)
8. [Troubleshooting](#8-troubleshooting)
9. [Credits and attribution](#9-credits-and-attribution)

---

## 1. Running on your computer (emulator)

```bash
npm run dev
```

This is IWSDK's managed dev session: it starts Vite on **https://localhost:8081**
and opens a browser with the **IWER emulator** (a fake Quest in the browser).
If it doesn't open a browser, run `npm run dev:runtime` and open
<https://localhost:8081> in Chrome yourself (accept the self-signed
certificate warning once).

- **Without entering VR**: you see the desk and book. Use the ←/→ arrow keys to
  turn pages, **M** for the menu (click buttons with the mouse), and the
  bottom-left card to open a PDF, add music or change the book hand.
- **Emulated VR**: click **Enter XR** (top of the page). Then:
  - Click the *Play mode* (circle-play) icon to look around with the mouse; Esc leaves play mode.
  - Controller panels (bottom corners): click **Trig**/**Grip** for a momentary
    press; the pin button latches it. Drag the controller gizmos in the scene
    to move a controller.
  - Toolbar *Select input mode* switches between controllers and **hands**.
  - Full emulator controls: <https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls>
- `npm run dev:status` shows the URL; `npm run dev:down` stops a background session.

## 2. Scripts

| Script | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | TypeScript check |
| `npm run smoke` | Headless Chrome check (needs `npm run dev:runtime` running and `npm i --no-save playwright-core`); saves `smoke.png` |
| `npm run smoke:notes` | Headless whiteboard check: grab marker, draw, erase, add page, export PDF (page count + letter size), save/load, Return, autosave restore. Tip: `IWSDK_DEV_OPEN=false npm run dev:runtime` skips the extra managed browser. |
| `npm run assets:sample-pdf` / `assets:ambience` | Regenerate the bundled CC0 sample PDF / audio loops |
| `npm run test:unit` | Unit tests (page grabs, palm frame, EPUB, page window, scene manifests, notes) |
| `npm run test:bigpdf` | Headless big-PDF measurements, see [TESTING-BIG-PDF.md](TESTING-BIG-PDF.md) |
| `npm run dev:usb` / `dev:lan` | Dev server for the headset over USB (adb reverse) or Wi-Fi |

---

## 3. On the Quest

### 3.1 One-time setup

1. **Meta developer account + team/organization.** Sign up at
   <https://developers.meta.com/horizon/> and create (or join) a developer
   organization in the Developer Dashboard. Meta requires a **verified**
   account (see *Verification* in the dashboard) and age 18+.
2. **Developer Mode** (per Meta's docs,
   <https://developers.meta.com/horizon/documentation/native/android/mobile-device-setup/>):
   on your phone open the **Meta Horizon** app → sign in with the developer
   account → make sure the headset is paired → tap the headset icon →
   **Headset Settings** → **Developer Mode** → toggle **on**. Reboot the headset.
   If the toggle is missing, the account/org verification probably hasn't
   finished yet.
3. **Hand tracking.** In the headset: **Settings → Movement tracking →
   Hand and body tracking** → turn on hand tracking and **auto-switch
   between hands and controllers**. *(verify: exact menu names change
   between Quest OS versions.)*
4. **USB debugging.** Connect the Quest to the computer with a **USB-C data
   cable** (charge-only cables won't work). In the headset, accept
   **Allow USB debugging** → *Always allow from this computer*. Then on the computer:
   ```bash
   npm run adb:devices     # = adb devices -l
   # should list one device as "device" (not "unauthorized")
   ```

### 3.2 Open the app on the Quest — pick one

WebXR only works on a **secure context**: `https://…` or `http://localhost`.

**Option A — USB cable + adb reverse (no certificate warning, recommended)**

```bash
npm run dev:usb
# = adb reverse tcp:8081 tcp:8081  &&  plain-HTTP Vite on port 8081
```

In the Quest, open **Meta Quest Browser** → go to **http://localhost:8081**.
`adb reverse` makes "localhost:8081" on the Quest point at your computer, and
localhost counts as secure. Keep the cable plugged in.

**Option B — Wi‑Fi (LAN) with the self-signed HTTPS certificate**

```bash
npm run dev:lan
# Vite prints:  Network: https://192.168.x.y:8081/
```

Quest and computer must be on the same Wi‑Fi. In Quest Browser open
`https://192.168.x.y:8081`, you'll get a certificate warning → *Advanced* →
*Proceed* (wording may differ — verify). IWSDK generates and caches this
dev certificate itself; nothing is installed into your system trust store.
If a Linux firewall (ufw) is on: `sudo ufw allow 8081/tcp`. On macOS, allow
Node through the firewall when asked.

Then, in both cases: tap **Enter VR** on the welcome card (or the Quest's
own "Enter VR" prompt). The desk re-centers in front of you automatically.

The emulator is **not** injected in Quest Browser (IWSDK skips `OculusBrowser`),
so you get real WebXR.


---

## 4. Controls

All controls go through one input layer (`src/input/`). Physical inputs map
to actions — **grab**, **select**, **turnPage**, **toggleMenu**,
**recenter**, **bringBookBack** — in `src/input/bindings.ts`.

| Action | Controllers | Hands | Desktop |
|---|---|---|---|
| **Pick up the book** | **Squeeze (grip)** near it, or point at it and squeeze (it flies to your hand). Trigger works too when the book is NOT held and you aim at its cover/spine/edge (on a page, trigger grabs the page). | Pinch the cover/spine/edge, near it or point + pinch | – |
| **Swap hands** | While holding, **squeeze** with the other hand on the book. Squeeze only: the other hand's trigger never swaps. | – (pinch grabs pages while the book is held) | – |
| **Put it down** | Let go over/near the reading stand: it lands there, open and readable. Let go anywhere else: it falls (lands on the floor, a table or a sofa). | Same | – |
| In your hand | It keeps the angle of your grip (no auto-facing). | Same | – |
| **Turn page** | Thumbstick flick left/right (either hand) | Swipe over the page, or poke the page's outer edge | ← / → keys |
| **Grab a page** | **Trigger** with your hand at a page, or aim the ray at it: the page follows your hand around the spine. Right page = forward, left page = back. Release past halfway = turn, else it falls back. A quick tap just flips it. Works with the book on the stand or in your other hand. The trigger of the hand holding the book does nothing. | Pinch a page (same rules; while the book is held, the free hand's pinch grabs pages) | – |
| **Menu** | **B** or **Y** button | Poke or pinch the **☰ Menu** tab on the stand | **M** key, or click the tab |
| Press a menu button | Point + trigger (or grip) | Poke with index fingertip, or point + pinch | Mouse click |
| **Recenter** | Click the thumbstick | Menu → Recenter | **R** key |
| **Return book + pens** | Menu → Return book + pens: the book goes back to the desk AND the marker + eraser go back to the easel tray (the book alone also comes back automatically on Recenter if it's on the floor / out of reach) | Same | **B** key |
| **Pick up marker / eraser** | **Squeeze** near it (or point at it + squeeze: it flies to your hand). The controller model hides while you hold it. Let go = it glides back to the tray. | Pinch near it / point + pinch | – |
| **Write / erase** | Push the marker tip (or the eraser's felt face) forward onto the whiteboard. Within 2.5 cm you see a cursor dot (marker) or circle (eraser); touching gives a light haptic tick. | Same (tool rides on the hand's grip pose) | – |
| **Whiteboard pages / Save / Load / Export** | Point + trigger at the easel: ◀ left bar, ▶ right bar (**+** on the last page = new page), Rotate, Save, Load…, Export PDF. The marker tip can press them too. | Poke with a fingertip, or point + pinch | Mouse click |
| **Marker color / size** | Menu → color swatches (8) and size circles (5) | Same | – |

Menu contents: Open PDF… (leaves VR) · Sample book · Bring book back ·
◀ Page / Page ▶ · **Size − / Book 100% / Size +** (60–200 %, 10 % steps) ·
**Desk ▼ / 63 cm / Desk ▲** (2 cm steps, 45–95 cm above the floor) ·
**Tilt − / 15° / Tilt +** (5° steps, 0–40°) · Play/Pause · Next track ·
Volume −/+ · Add music… (leaves VR) · **Room: Pool room / your scenes** ·
**Quality: High / Lite** · Recenter · Close. Tapping a middle "value"
button resets it. All settings are saved in localStorage.

**Whiteboard.** A 5 ft × 5.647 ft whiteboard on a wooden easel
stands to your right (0.80 m right, 0.15 m forward of your seat, center
1.10 m high, turned to face you, leaning back 5°), in the same spot relative
to the seat in every room, including custom scenes. Each board page = one
US Letter page in the PDF export (`notes-YYYY-MM-DD_HH-MM-SS.pdf`, 150 dpi).
Save stores the whole notebook in IndexedDB under the same kind of timestamp
name; Load shows a list next to the board. An autosave (3 s after your last
stroke) restores your notes after a crash or reload. Code: `src/notes/`,
details in `src/notes/notes-system.ts`.

**Rooms.** The *Pool room* (built in, the default) has a drafting desk and
is where the whiteboard was tuned. **Custom scenes** from your local
`scenes/` folder are 3D models: the desk height/tilt controls move a
**reading stand on the scene's table** (the furniture never moves). The
easel still sits at the same offset from that scene's seat. *Quality:
High / Lite* picks the scene's full-resolution or low-texture build (only
the selected one downloads). A missing or broken scene falls back to the
Pool room with a message in the menu footer. `?room=glass` forces the Pool
room, `?room=<folder>` a scene (e.g. `?room=example` for the example below).

### Custom scenes (your own rooms)

Put your own rooms in **`scenes/<id>/`** at the repo root: a glTF/GLB model
plus a `scene.json` that says where you sit, which table the reading stand
goes on, the scale, credits and optional fixes. The folder is gitignored
(only `scenes/README.md` and the tiny CC0 `scenes/_example/` are tracked),
so third-party models never land in the public repo. The dev server, `vite
preview` and `vite build` discover them automatically (`custom-scenes/index.json`
from `vite-plugins/local-scenes.ts`), and the menu's **Room** button lists
them after the Pool room. The app remembers the last one you picked.

- Format and field reference: [scenes/README.md](scenes/README.md)
- Step by step (Blender/Sketchfab export, KTX2 compression, picking the
  seat and stand, testing on the Quest): [docs/adding-your-own-scene.md](docs/adding-your-own-scene.md)
- Try it: `cp -r scenes/_example scenes/example`, reload, Room → *Example room*.
- Publishing a build? `LOCAL_SCENES=off npm run build` leaves your scenes out.

**Reading position is remembered** per PDF (localStorage): reopening the
same file resumes there, and the red ribbon marks the page. The page blocks
get thicker on the left / thinner on the right as you read.

### Opening PDFs and music — why it leaves VR

Browsers only open a **file picker in direct response to a click on the 2D
page**, and an immersive WebXR session has no 2D page to show it on. So:

1. **Before entering VR** (most reliable): use the card at the bottom-left:
   **Open PDF…**, **Add music…** (you can pick several MP3s).
2. **From inside VR**: menu → *Open PDF…* / *Add music…* → the app exits VR
   and shows a big **Choose PDF… / Choose music…** button → tap it → pick →
   press **Enter VR** again. Music keeps playing.
3. The bundled **sample book** and two ambience loops are always available
   in VR as a fallback.

*(verify on Quest: whether Quest Browser can show the picker without leaving
VR at all. If it can, `requestPicker()` in `src/app.ts` could skip the exit.)*

Files never leave the headset: PDFs are read in memory, music plays from
temporary `blob:` URLs and is forgotten when the tab closes.

### After a PDF loads

A ~1.3 s animation: page "cards" fan in, stack up, a cover closes over
them, then the book swings open on page 1.

### Music / spatial audio

Music plays from the **radio on the desk** through a three.js
`PositionalAudio` (Web Audio `PannerNode`, HRTF), so it comes from that
direction and shifts as you turn your head. It keeps playing while you
read and turn pages. Bundled: *Fireplace crackle* and *Rain* (self-made,
CC0). Browsers block audio until the first click/tap/Enter VR; that's normal.


---

## 5. How it works / project structure

```
src/
  index.ts                 entry point: creates the World, builds objects, registers systems
  app.ts                   shared objects + loadPdf() + requestPicker() (exit VR for file dialogs)
  settings.ts              book size, desk height/tilt, room + quality (signals, localStorage)
  input/
    bindings.ts            ★ which physical input → which action (+ hands-only switch, tuning)
    actions.ts             the per-frame action snapshot every system reads
    input-layer-system.ts  reads WebXR controllers/hands + keyboard → actions
  book/
    pdf-pages.ts           pdf.js → small canvas textures, lazy + cached; stable book id
    book.ts                boxy book: covers, page blocks, spine, ribbon, page turns, intro
    book-system.ts         grab / swap / drop / settle state machine, page grabs, bring back
    page-grab.ts           ★ which press does what (page grab vs pick up vs swap), unit-tested
    book-physics.ts        tiny rigid-body sim for a dropped book (gravity, bounce, walls)
    reading-progress.ts    last-read page per book (localStorage)
  notes/                   ★ whiteboard
    notes-model.ts         pure data: pages, strokes, smoothing, save format (unit-tested)
    notes-system.ts        marker/eraser grab + snap + writing, easel buttons, save/load/export, autosave
    easel.ts               procedural easel, board, tray, page bars + control panel, Load list
    tools.ts               procedural marker + eraser (modelled in grip space)
    board-canvas.ts        per-page canvases → texture, dirty-rect uploads (once per frame)
    notes-raster.ts        stroke drawing shared by the board and the PDF
    notes-export.ts        PDF export (browser part) + download
    notes-pdf.ts           pdf-lib: page images → letter-size PDF (unit-tested)
    notes-store.ts         IndexedDB: saved notebooks + autosave
  menu/
    menu-panel.ts          canvas-drawn floating menu + "Menu" tab
    menu-system.ts         open/close, ray/poke/mouse button presses
  audio/music.ts           playlist, <audio> → PositionalAudio on the radio
  room/
    room-types.ts          ★ the StudyRoom "plug-in" contract (desk, seat, tables, bounds)
    room-config.ts         built-in rooms, room ids, the GlbRoomConfig type
    scene-manifest.ts      ★ scene.json format: validation + defaults (unit-tested)
    scene-loader.ts        fetches custom-scenes/index.json + a scene's manifest
    create-room.ts         builds the chosen room (falls back to the pool room)
    room-switch.ts         swaps rooms at runtime (menu "Room" / "Quality")
    glb-room.ts            a room from a custom scene's model + reading stand + fixes
    reading-stand.ts       slanted stand that sits on a table (desk height/tilt)
    procedural-room.ts     the pool room built from boxes
    desk.ts                its drafting desk (floor-anchored, slanted)
    outdoor-view.ts        pool photo seen through the glass door
    head-pose.ts           live headset pose (fix for the "book vanished" bug)
  ui2d/launch-overlay.ts   2D page card: Open PDF / Add music
  panel.ts                 IWSDK starter's welcome panel (Enter VR / Exit buttons)
public/
  basis/                   KTX2 texture transcoder (from three.js)
  textures/                pool room: pool photo + floor texture (CC0)
  books/sample-book.pdf    6-page self-made sample (CC0)
  audio/*.mp3              self-made ambience loops (CC0)
  scenes/, ui/             IWSDK authored scene + welcome panel
scenes/                    YOUR rooms (gitignored except README.md + _example/), see scenes/README.md
vite-plugins/local-scenes.ts  lists + safely serves scenes/ at custom-scenes/ (dev, preview, build)
docs/adding-your-own-scene.md  guide: export, compress, seat/stand, test on Quest
scripts/                   asset generators, unit tests, headless smoke test
iwsdk.config.json          IWSDK project manifest (XR mode, hand tracking, emulator device)
vite.config.ts             dev server (HTTPS toggle), base './'
deploy/github-pages-workflow.yml     GitHub Pages workflow (move into .github/workflows/ to enable)
AGENTS.md, .agents/, .claude/, .cursor/   IWSDK's AI-assistant guidance (from the scaffold)
```

**Performance choices** (Quest 2 target 72 fps): unlit `MeshBasicMaterial`
pages; the whole book is ≤5 draw calls; one 2048×1024 sky texture (only the
selected environment is loaded); PDF pages rendered one at a time (1200 px by
default, with a blurry preview first) and only a ~10-page window kept in GPU memory; no per-frame allocations in the input/book loops;
the menu canvas only redraws when something changes.

**Why IWSDK and not plain three.js**: the official scaffold ran
non-interactively (`npm create @iwsdk@latest vr-study-room -- --yes --target vr --language ts ...`),
builds cleanly, and brings the IWER emulator + dev HTTPS + XR session
handling for free. We still use raw WebXR (`world.xrFrame`,
`session.inputSources`) in the input layer so every step is visible.

## 6. Hosting your own copy

`vite.config.ts` uses `base: './'` (relative URLs), so the same build works
on GitHub Pages under `/vr-study-room/` and on any static host at the root.
Before uploading `dist/` anywhere public, build with
`LOCAL_SCENES=off npm run build` so your own custom scenes stay out.

- **GitHub Pages (your fork).** A ready-made workflow lives in
  `deploy/github-pages-workflow.yml`. To use it:
  ```bash
  gh auth refresh -s workflow
  mkdir -p .github/workflows
  git mv deploy/github-pages-workflow.yml .github/workflows/deploy-pages.yml
  git commit -m "Enable Pages workflow" && git push
  ```
  then Settings → Pages → Source: **GitHub Actions**. It builds and deploys
  on every push to `main`.
- **Vercel / Netlify / any static host.** Framework preset *Vite*, build
  command `npm run build`, output folder `dist`.

Test the deployed URL on the Quest itself: WebXR needs `https://`.

---

## 7. Ideas and known limitations

Ideas for later: page-flutter physics when a dropped book falls (instead of
a rigid box); sofas and armchairs as real colliders; texture atlases for
heavy custom scenes; writing with a fingertip on your real desk; pushing
notes to a Git repo; UIKitML menus; a wrist menu.

Things to know:

- **Fingertip handwriting on Quest 2.** Hand tracking jitters by several
  millimeters and loses fingers when the hand is side-on, so the whiteboard
  is written with a held marker. Writing large, stroke smoothing and only
  inking near the surface all help.
- **Quest 2 passthrough is grayscale and low-res**, so the room is fully
  immersive.
- **Cold start**: the bundle is ~7 MB (~1.8 MB gzipped) plus the 1.3 MB
  pdf.js worker. Over slow Wi-Fi the first load takes a moment.
- **Audio autoplay**: browsers only start audio after a click, tap or
  Enter VR.
- **MP3 loop seam**: MP3 encoding adds a tiny gap at the loop point of the
  ambience files. If it bothers you, switch to OGG or decode into an AudioBuffer.
- **Custom scene cost**: one draw call per material in the model (a
  detailed room with joined meshes is easily ~70) + ~20 for the app. Quest 2
  copes with ~100 at 72 Hz; if *High* stutters, use *Quality: Lite* or
  atlas the textures.

---

## 8. Troubleshooting

| Problem | Try |
|---|---|
| `adb devices` shows **unauthorized** | Put the headset on and accept *Allow USB debugging*. If no prompt: unplug/replug, `adb kill-server && adb start-server`, try another (data) cable/port. |
| `adb devices` shows nothing | Developer Mode really on? Rebooted? Data cable? Linux may need udev rules for the Quest — verify with `lsusb` that the device appears. |
| Quest Browser: "Your connection is not private" | Expected with Option B (self-signed cert): proceed via *Advanced*. Or use Option A (adb reverse + http://localhost:8081) to avoid it. |
| No **Enter VR** button / WebXR not available | The page must be `https://…` or `http://localhost`. `http://192.168…` is **not** secure → WebXR is disabled. |
| `npm run dev:usb` fails with "port 8081 in use" | Another dev server is running: `npm run dev:down`, or close the other terminal. |
| Hands not detected | Hand tracking enabled in Quest settings? Put controllers down (auto-switch). Needs decent, even lighting; avoid direct sunlight and very dark rooms; keep hands in front of the headset. |
| No sound | Click/tap once on the page or enter VR (autoplay rule); menu → Play; check volume. |
| Book is too high/low | Menu → Recenter (or thumbstick click / R) while sitting in your normal posture. |

---

## 9. Credits and attribution

Made by Joey Martin ([@youdontknowcrap](https://x.com/youdontknowcrap) on X,
[youdontknowcrap](https://github.com/youdontknowcrap) on GitHub).

Every bundled asset is self-made or freely licensed (CC0, MIT, Apache-2.0):
the pool photo and floor texture are CC0 from [Poly Haven](https://polyhaven.com)
(Greg Zaal; Dario Barresi and Charlotte Baglioni), the ambience loops and
sample book are self-made CC0, and the code stands on IWSDK, three.js,
pdf.js, pdf-lib, uikit and fflate. The full list with sources and licenses
is in **[ATTRIBUTION.md](ATTRIBUTION.md)**.

Custom scenes you add yourself are not part of the repo: credit them in
their `scene.json` and follow their licenses.
