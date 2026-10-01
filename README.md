# VR Study Room

A cozy virtual study room for Meta Quest, running in the browser (WebXR).
You sit at a slanted reading desk in a room with a sliding glass door onto
a backyard pool (the built-in **Pool room**), or in **your own 3D room**
(see [Custom scenes](#custom-scenes-your-own-rooms)). You hold a book made
from any PDF and turn its pages with your hands, while your own music plays
from a little radio on the desk. Coming next: a whiteboard where you write math with your
fingertip (ideally on your real desk), and exporting your notes as a PDF.

Built with **Meta Immersive Web SDK (IWSDK) 1.0.0-rc.2** + three.js + Vite +
TypeScript, scaffolded with the official `npm create @iwsdk@latest`.

> This is Joey's entry for the **Meta VR Start Developer Competition 2026**,
> Productivity track, New Experience division.

---

## Contents

1. [The competition: key facts & rule checklist](#1-the-competition)
2. [Laptop setup (Linux Mint)](#2-laptop-setup-linux-mint)
3. [Running on the laptop (emulator)](#3-running-on-the-laptop-emulator)
4. [Quest 2 setup & testing on the headset](#4-quest-2-setup--testing-on-the-headset)
5. [Controls](#5-controls)
6. [How the demo works / project structure](#6-how-the-demo-works--project-structure)
7. [Deploying (hosted link for judges)](#7-deploying-hosted-link-for-judges)
8. [Roadmap & calendar](#8-roadmap--calendar)
9. [Known risks](#9-known-risks)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. The competition

Rules: <https://start-developer-competition-26.devpost.com/rules>
(read them yourself too — they are the contract).

### Key dates (all Pacific Time)

| What | When |
|---|---|
| Entry period opens | Thu **Sep 24, 2026**, 10:00 AM PT |
| **Submission deadline** | Wed **Nov 18, 2026, 12:00 PM (noon) PT** |
| Judging | ~Nov 18 – ~Dec 9, 2026 |
| Winners announced | ~**Dec 11, 2026** — the hosted app must stay online & free until then |
| Joey away (Mexico) | Oct 18 – Oct 26 (no dev time) |

Plan to submit on **Nov 16–17**, not on the last morning.

### What to submit (IWSDK / WebXR entries)

- [ ] A **link** judges can open in Meta Quest Browser (GitHub Pages, Vercel, …).
- [ ] A **demo video < 3 min**, filmed on a Quest (or an emulator), uploaded
      **public** to YouTube or Vimeo. Show real footage, lead with what's unique.
- [ ] **Devpost text**: inspiration, how it was built, future plans, target launch date.
- [ ] Pick **Track = Productivity**, **Division = New Experience**.

### Before you can submit

1. **Meta developer account with Developer Access** (see §4.1).
2. **Join the Meta VR Start program** (must be a member *by submission*):
   - Program info: <https://developers.meta.com/horizon/resources/meta-start-developer-program/>
   - Apply: <https://developers.meta.com/horizon/programs/start/apply/> — sign in
     with your Meta developer account, fill in the form, wait for approval
     (reviewed on a rolling basis, so apply **now**).
3. **Register on Devpost**: open <https://start-developer-competition-26.devpost.com/>,
   click **Join Hackathon**, create/log in to a Devpost account.

### Rule checklist (keep this green)

- [ ] **HANDS-FIRST (required).** The whole experience must work *without ever
      pairing a controller*. Controllers are an optional extra.
      → Current build is controller-first on purpose (faster to iterate); see
      milestone M4 "fade out controllers → hands-only pass". Flip
      `HANDS_ONLY = true` in `src/input/bindings.ts` to rehearse.
- [ ] **Seated-optimized.** Every interaction within ~2 ft (60 cm) radius
      ("airplane seat test"). → Desk, book, radio and menu all sit within reach; auto-recenter on Enter VR.
- [ ] **Fast cold start, clean pause/resume, satisfying in ≤10 min** ("one bus stop test").
      → Watch bundle size (currently ~1.8 MB gzipped JS; see §9).
- [ ] **≥ 60 fps on Meta Quest hardware** (judges likely use Quest 3/3S;
      aim for 72 fps on Quest 2).
- [ ] **FoV-aware UI.** Essential UI stays in a narrow, comfortable field of
      view (think Meta VR Glasses' narrower FoV). → Menu opens 45 cm in front, slightly low.
      Test with emulator device `metaVRGlasses` later.
- [ ] **Passthrough only if purposeful.** This build is fully immersive (no passthrough).
      If the real-desk handwriting uses passthrough, the real desk must matter.
- [ ] **Original / New Experience**: code written from Sep 24, 2026 on. ✔ (repo started Sep 28, 2026)
- [ ] **English** UI and materials. ✔
- [ ] **No third-party logos/brands** in the repo: the shipped Pool room is CC0, and third-party room models live only in the local, gitignored `scenes/` folder.
- [ ] All third-party assets properly licensed → **ATTRIBUTION.md**.
- [ ] Not a thin wrapper around another service.
- [ ] Free, available until winner announcement (~Dec 11, 2026).
- [ ] You are a **Meta VR Start member** when you submit.

---

## 2. Laptop setup (Linux Mint)

No gaming GPU is needed: the emulator runs in Chrome/Chromium, and the
real rendering happens on the Quest.

```bash
# 1. Basics
sudo apt update
sudo apt install -y git curl android-tools-adb

# 2. Node.js LTS via nvm (Node Version Manager)
#    Check https://github.com/nvm-sh/nvm for the latest install line (verify version number).
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
# close and reopen the terminal, then:
nvm install 22        # this repo pins 22.12.0 in .nvmrc; `nvm use` picks it up
nvm use
node -v               # should print v22.x

# 3. GitHub CLI (gh). Official apt repo instructions:
#    https://github.com/cli/cli/blob/trunk/docs/install_linux.md
#    (Mint is Ubuntu-based, so the Debian/Ubuntu steps apply.)
gh auth login          # choose GitHub.com, HTTPS, log in with browser

# 4. Get the code (private repo — you must be logged in with gh)
gh repo clone youdontknowcrap/vr-study-room
cd vr-study-room
npm install

# 5. A browser for the emulator: Chrome or Chromium
#    (Chromium: sudo apt install chromium  — package name may differ on Mint, verify)
```

`adb` alternative: Google's "SDK Platform-Tools" zip
(<https://developer.android.com/tools/releases/platform-tools>) if the
apt version is too old to see the headset.

---

## 3. Running on the laptop (emulator)

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

Other useful scripts:

| Script | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | TypeScript check |
| `npm run smoke` | Headless Chrome check (needs `npm run dev:runtime` running and `npm i --no-save playwright-core`); saves `smoke.png` |
| `npm run assets:sample-pdf` / `assets:ambience` | Regenerate the bundled CC0 sample PDF / audio loops |

---

## 4. Quest 2 setup & testing on the headset

### 4.1 One-time setup

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
4. **USB debugging.** Connect the Quest to the laptop with a **USB-C data
   cable** (charge-only cables won't work). In the headset, accept
   **Allow USB debugging** → *Always allow from this computer*. Then on the laptop:
   ```bash
   npm run adb:devices     # = adb devices -l
   # should list one device as "device" (not "unauthorized")
   ```

### 4.2 Open the app on the Quest — pick one

WebXR only works on a **secure context**: `https://…` or `http://localhost`.

**Option A — USB cable + adb reverse (no certificate warning, recommended)**

```bash
npm run dev:usb
# = adb reverse tcp:8081 tcp:8081  &&  plain-HTTP Vite on port 8081
```

In the Quest, open **Meta Quest Browser** → go to **http://localhost:8081**.
`adb reverse` makes "localhost:8081" on the Quest point at your laptop, and
localhost counts as secure. Keep the cable plugged in.

**Option B — Wi‑Fi (LAN) with the self-signed HTTPS certificate**

```bash
npm run dev:lan
# Vite prints:  Network: https://192.168.x.y:8081/
```

Quest and laptop must be on the same Wi‑Fi. In Quest Browser open
`https://192.168.x.y:8081`, you'll get a certificate warning → *Advanced* →
*Proceed* (wording may differ — verify). IWSDK generates and caches this
dev certificate itself; nothing is installed into your system trust store.
If Linux Mint's firewall (ufw) is on: `sudo ufw allow 8081/tcp`.

Then, in both cases: tap **Enter VR** on the welcome card (or the Quest's
own "Enter VR" prompt). The desk re-centers in front of you automatically.

The emulator is **not** injected in Quest Browser (IWSDK skips `OculusBrowser`),
so you get real WebXR.

---

## 5. Controls

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
| **Bring book back** | Menu → Bring book back (also automatic on Recenter if it's on the floor / out of reach) | Same | **B** key |

Menu contents: Open PDF… (leaves VR) · Sample book · Bring book back ·
◀ Page / Page ▶ · **Size − / Book 100% / Size +** (60–200 %, 10 % steps) ·
**Desk ▼ / 63 cm / Desk ▲** (2 cm steps, 45–95 cm above the floor) ·
**Tilt − / 15° / Tilt +** (5° steps, 0–40°) · Play/Pause · Next track ·
Volume −/+ · Add music… (leaves VR) · **Room: Pool room / your scenes** ·
**Quality: High / Lite** · Recenter · Close. Tapping a middle "value"
button resets it. All settings are saved in localStorage.

**Rooms.** The *Pool room* (built in, the default) has a drafting desk.
**Custom scenes** from your local `scenes/` folder are 3D models: the desk
height/tilt controls move a **reading stand on the scene's table** (the
furniture never moves). *Quality: High / Lite* picks the scene's
full-resolution or low-texture build (only the selected one downloads). A
missing or broken scene falls back to the Pool room with a message in the
menu footer. `?room=glass` forces the Pool room, `?room=<folder>` a scene.

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

## 6. How the demo works / project structure

```
src/
  index.ts                 entry point: creates the World, builds objects, registers systems
  app.ts                   shared objects + loadPdf() + requestPicker() (exit VR for file dialogs)
  settings.ts              book size, desk height/tilt, room + quality (signals, localStorage)
  input/
    bindings.ts            ★ which physical input → which action (+ HANDS_ONLY switch, tuning)
    actions.ts             the per-frame action snapshot every system reads
    input-layer-system.ts  reads WebXR controllers/hands + keyboard → actions
  book/
    pdf-pages.ts           pdf.js → small canvas textures, lazy + cached; stable book id
    book.ts                boxy book: covers, page blocks, spine, ribbon, page turns, intro
    book-system.ts         grab / swap / drop / settle state machine, page grabs, bring back
    page-grab.ts           ★ which press does what (page grab vs pick up vs swap), unit-tested
    book-physics.ts        tiny rigid-body sim for a dropped book (gravity, bounce, walls)
    reading-progress.ts    last-read page per book (localStorage)
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
selected environment is loaded); PDF pages rendered at 640 px tall and only
~12 kept in GPU memory; no per-frame allocations in the input/book loops;
the menu canvas only redraws when something changes.

**Why IWSDK and not plain three.js**: the official scaffold ran
non-interactively (`npm create @iwsdk@latest vr-study-room -- --yes --target vr --language ts ...`),
builds cleanly, and brings the IWER emulator + dev HTTPS + XR session
handling for free. We still use raw WebXR (`world.xrFrame`,
`session.inputSources`) in the input layer so every step is visible.

---

## 7. Deploying (hosted link for judges)

`vite.config.ts` uses `base: './'` (relative URLs), so the same build works
on GitHub Pages under `/vr-study-room/` and on Vercel at the root.

**This repo is PRIVATE.** GitHub Pages on a free account only works for
**public** repos. Options:

- **A) GitHub Pages** — make the repo public when you're ready (Settings →
  General → Danger Zone → Change visibility), then Settings → Pages → Source:
  **GitHub Actions**. The ready-made workflow is in
  `deploy/github-pages-workflow.yml` (it could not be pushed into
  `.github/workflows/` because the setup token lacked GitHub's `workflow`
  scope). To activate it:
  ```bash
  gh auth refresh -s workflow
  mkdir -p .github/workflows
  git mv deploy/github-pages-workflow.yml .github/workflows/deploy-pages.yml
  git commit -m "Enable Pages workflow" && git push
  ```
  It then builds and deploys on every push to `main`. URL:
  `https://youdontknowcrap.github.io/vr-study-room/`. The competition rules
  mention GitHub Pages explicitly for IWSDK entries. Double-check nothing
  private is in the repo history first.
- **B) Vercel from the private repo** — <https://vercel.com> → Add New
  Project → import `youdontknowcrap/vr-study-room` → framework preset
  *Vite*, build `npm run build`, output `dist`. Free Hobby plan (verify the
  plan's terms fit a contest entry). Keeps the code private.

Either way: test the **deployed** URL on the Quest before submitting, and
keep it up until ~Dec 11, 2026.

---

## 8. Roadmap & calendar

Today: Mon Sep 28, 2026. Deadline: Wed Nov 18, 12:00 PM PT.

| # | Dates | Milestone | Done when |
|---|---|---|---|
| M0 | Sep 28 – Oct 4 | **Demo book** (this starter) on the real Quest 2 | Runs ≥72 fps; book-in-hand pose tuned; page drag feels OK; MP3s play during reading |
| M1 | Oct 5 – Oct 11 | **Handwriting spike on the desk surface** | Index fingertip draws a line on a virtual plane aligned to the real desk (calibrate by touching the desk / 3 corner taps); jitter measured; decide touch-to-write vs pinch-to-write |
| M2 | Oct 12 – Oct 17 | **Whiteboard + eraser** | Strokes stored as vector polylines; eraser; clear; undo. **Push + deploy a working build before the trip.** |
| — | **Oct 18 – Oct 26** | **Mexico — no dev** | (Optional: sketch the video script on paper) |
| M3 | Oct 27 – Nov 2 | **PDF export** with jsPDF, **vector** strokes | "Export notes" writes a PDF (strokes as lines, not screenshots); download works from Quest Browser (verify) |
| M4 | Nov 3 – Nov 8 | **Fade out controllers → hands-only pass** | `HANDS_ONLY = true`; every feature reachable with hands (palm-up menu, pinch page drag, poke buttons); test full session without pairing controllers |
| M5 | Nov 9 – Nov 15 | **Polish / onboarding / video** | 30-second hands-only onboarding, perf pass on Quest (≥60 fps, target 72), FoV check, sound polish, record < 3 min video, write Devpost text, deploy public link |
| — | Nov 16 – 17 | **Submit** (buffer day) | Devpost submission complete; deployed URL re-tested on Quest |
| — | Nov 18, 12:00 PM PT | Hard deadline | |

Later / stretch: **book drop page-flutter physics** (pages flap while the
book falls, instead of a rigid box); sofa/armchair as real colliders;
texture atlases for heavy custom scenes (fewer draw calls); push notes to a
Git repo; UIKitML menus; wrist menu.

---

## 9. Known risks

- **Fingertip handwriting precision on Quest 2.** Hand tracking jitters by
  several millimeters and loses fingers when the hand is side-on or
  occluded. Math symbols are small. Mitigations to try in M1: write large
  on a whiteboard rather than tiny on paper; smooth strokes (One-Euro
  filter); only ink while the fingertip is within a few mm of the desk
  plane; pinch-to-write as a fallback.
- **"Real desk" alignment.** Without scene understanding on a WebXR Quest 2
  setup, the desk plane must be calibrated by the user (touch the desk).
  Drift over time is possible — add a quick re-calibrate gesture.
- **Quest 2 passthrough is grayscale and low-res**, so a passthrough "real
  desk" mode would look much worse on Quest 2 than on judges' Quest 3/3S.
  Keep the core experience fully immersive; passthrough only if it truly
  helps (rule: passthrough must be purposeful).
- **Cold start**: the IWSDK starter bundle is ~7 MB (~1.8 MB gzipped) plus a
  1.3 MB pdf.js worker. Trim unused IWSDK features/fonts in M5 and measure
  load time on Quest over Wi‑Fi.
- **Audio autoplay**: audio only starts after a user gesture (verify it
  starts reliably after Enter VR on Quest Browser).
- **MP3 loop seam**: MP3 encoding adds a tiny gap at loop points of the
  ambience files. If audible, switch to OGG or decode into an AudioBuffer.
- **Book-in-hand pose**: grab offsets in `book-system.ts` are first
  guesses; tune them on the device.
- **Custom scene cost**: one draw call per material in the model (a
  sitcom-set model with joined meshes was ~69) + ~20 for the app. Quest 2 copes with ~100 at 72 Hz, but check
  frame timing; if High stutters use *Quality: Lite*, or atlas the textures.

---

## 10. Troubleshooting

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
