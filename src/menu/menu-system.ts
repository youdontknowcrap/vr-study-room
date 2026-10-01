/**
 * MenuSystem — opens/closes the floating menu and handles button presses.
 *
 * Ways to press a button (all go through the shared input actions):
 *  - Point a controller (or a hand's pinch-ray) at it and press trigger,
 *    squeeze or pinch.
 *  - Poke it with your index fingertip (hand tracking).
 *  - Click it with the mouse (desktop browser).
 * Open/close: controller B/Y button, M key, or press the "☰ Menu" tab on the desk.
 */
import { createSystem, Raycaster, Vector2, Vector3, type Intersection } from '@iwsdk/core';
import { actions, type HandState } from '../input/actions.js';
import { app, loadSampleBook, reopenBook, requestPicker } from '../app.js';
import {
  BOOK_SCALE,
  bookScale,
  DESK_HEIGHT,
  DESK_TILT,
  deskHeight,
  deskTilt,
  stepSetting,
  roomChoice,
  roomQuality,
  PDF_CACHE_LEVELS,
  PDF_RES_LEVELS,
  pdfCacheSize,
  pdfPreview,
  pdfRenderQueue,
  pdfResolution,
  pdfStreaming,
  perfStats,
  stepLevel,
} from '../settings.js';
import { pdfKeepCount } from '../book/page-window.js';
import { onRoomChange } from '../room/room-switch.js';
import { createMenuTab, MenuPanel } from './menu-panel.js';

const raycaster = new Raycaster();
const tmp = new Vector3();
const headPos = new Vector3();
const hits: Intersection[] = [];

export class MenuSystem extends createSystem({}) {
  private panel!: MenuPanel;
  private tab!: ReturnType<typeof createMenuTab>;
  private poking = { left: false, right: false };
  private dirty = true;
  private shownTitle = '';
  /**
   * Which page of the menu is showing. WHY a sub-page: the main menu canvas
   * is already full, and the Big PDF experiments are a developer tool you
   * don't want in the way while reading.
   */
  private page: 'main' | 'perf' = 'main';

  init(): void {
    this.panel = new MenuPanel();
    this.world.scene.add(this.panel.mesh);
    this.tab = createMenuTab();
    app.room.desk.menuTabAnchor.add(this.tab);
    // Room swapped (menu "Room"): move the tab onto the new desk/stand.
    onRoomChange((room) => {
      room.desk.menuTabAnchor.add(this.tab);
      this.dirty = true; // the Room button shows the room's name
    });

    // Rebuild the labels whenever something they show changes.
    const markDirty = () => (this.dirty = true);
    this.cleanupFuncs.push(
      bookScale.subscribe(markDirty),
      deskHeight.subscribe(markDirty),
      deskTilt.subscribe(markDirty),
      roomQuality.subscribe(markDirty),
      pdfStreaming.subscribe(markDirty),
      pdfResolution.subscribe(markDirty),
      pdfCacheSize.subscribe(markDirty),
      pdfRenderQueue.subscribe(markDirty),
      pdfPreview.subscribe(markDirty),
      perfStats.subscribe(markDirty),
      app.music.playing.subscribe(markDirty),
      app.music.index.subscribe(markDirty),
      app.music.volume.subscribe(markDirty),
    );

    // Desktop: mouse clicks on the canvas.
    const canvas = this.world.renderer.domElement;
    const onClick = (e: MouseEvent) => {
      if (this.world.session) return; // in VR the controllers handle it
      const r = canvas.getBoundingClientRect();
      const ndc = new Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, this.world.camera);
      const id = this.hitTest();
      if (id) this.press(id);
    };
    canvas.addEventListener('click', onClick);
    this.cleanupFuncs.push(() => canvas.removeEventListener('click', onClick));
  }

  update(): void {
    if (app.bookTitle !== this.shownTitle) this.dirty = true;
    if (this.dirty) this.rebuild();
    if (actions.toggleMenu) this.toggle();

    let hovered: string | null = null;
    for (const hand of Object.values(actions.hands)) {
      const id = this.handleRay(hand);
      hovered ??= id;
      this.handlePoke(hand);
    }
    this.panel.setHovered(hovered);
  }

  private get isOpen(): boolean {
    return this.panel.mesh.visible;
  }

  private toggle(): void {
    if (this.isOpen) {
      this.panel.mesh.visible = false;
      return;
    }
    // Place it ~50 cm in front of your eyes, a bit low, facing you: inside
    // the comfortable field of view, within arm's reach for poking.
    // (world.camera is one frame old here - fine for placing a menu.)
    const cam = this.world.camera;
    cam.getWorldPosition(headPos);
    tmp.set(0, 0, -1).transformDirection(cam.matrixWorld);
    tmp.y = 0;
    tmp.normalize();
    this.panel.mesh.position.copy(headPos).addScaledVector(tmp, 0.5);
    this.panel.mesh.position.y -= 0.12;
    this.panel.mesh.lookAt(headPos);
    this.panel.mesh.visible = true;
    this.dirty = true;
  }

  /** Raycast from `raycaster` against the menu and tab; returns a button id. */
  private hitTest(): string | null {
    hits.length = 0;
    if (this.isOpen) raycaster.intersectObject(this.panel.mesh, false, hits);
    if (hits.length && hits[0].uv) {
      return this.panel.buttonAtUV(hits[0].uv.x, hits[0].uv.y);
    }
    hits.length = 0;
    raycaster.intersectObject(this.tab, false, hits);
    return hits.length ? 'toggle' : null;
  }

  private handleRay(hand: HandState): string | null {
    if (!hand.rayValid) return null;
    raycaster.set(hand.rayOrigin, hand.rayDirection);
    raycaster.far = 2;
    const id = this.hitTest();
    if (id && hand.grab.pressed && !hand.grab.consumed) {
      hand.consumePress(); // don't also grab the book behind the menu
      this.press(id);
    }
    return id;
  }

  /** Fingertip poke: fires once when the tip touches the panel surface. */
  private handlePoke(hand: HandState): void {
    const h = hand.handedness;
    if (!hand.indexTipValid || !this.isOpen) {
      this.poking[h] = false;
      return;
    }
    const local = this.panel.mesh.worldToLocal(tmp.copy(hand.indexTip));
    const geo = this.panel.mesh.geometry.parameters;
    const inside =
      Math.abs(local.x) < geo.width / 2 &&
      Math.abs(local.y) < geo.height / 2 &&
      Math.abs(local.z) < 0.012;
    if (inside && !this.poking[h]) {
      const id = this.panel.buttonAtUV(local.x / geo.width + 0.5, local.y / geo.height + 0.5);
      if (id) this.press(id);
    }
    this.poking[h] = inside;
  }

  private press(id: string): void {
    const m = app.music;
    switch (id) {
      case 'toggle':
      case 'close':
        this.toggle();
        break;
      case 'book':
        requestPicker('book');
        break;
      case 'music-add':
        requestPicker('music');
        break;
      case 'sample':
        void loadSampleBook();
        break;
      case 'bring-back':
        app.bookSystem.bringBack();
        break;
      // Book size / desk height / desk tilt: - and + step, the value resets.
      case 'size-down':
        stepSetting(bookScale, BOOK_SCALE, -1);
        break;
      case 'size-up':
        stepSetting(bookScale, BOOK_SCALE, 1);
        break;
      case 'size-reset':
        bookScale.value = BOOK_SCALE.default;
        break;
      case 'desk-down':
        stepSetting(deskHeight, DESK_HEIGHT, -1);
        break;
      case 'desk-up':
        stepSetting(deskHeight, DESK_HEIGHT, 1);
        break;
      case 'desk-reset':
        deskHeight.value = DESK_HEIGHT.default;
        break;
      case 'tilt-down':
        stepSetting(deskTilt, DESK_TILT, -1);
        break;
      case 'tilt-up':
        stepSetting(deskTilt, DESK_TILT, 1);
        break;
      case 'tilt-reset':
        deskTilt.value = DESK_TILT.default;
        break;
      case 'play':
        m.unlock();
        m.togglePlay();
        break;
      case 'next':
        m.unlock();
        m.next();
        break;
      case 'vol-down':
        m.changeVolume(-0.1);
        break;
      case 'vol-up':
        m.changeVolume(0.1);
        break;
      case 'room':
        // Flip between the two rooms; index.ts swaps the room when it changes.
        roomChoice.value = roomChoice.value === 'apartment' ? 'glass' : 'apartment';
        break;
      case 'quality':
        // High <-> Lite textures for model rooms (only that file downloads).
        roomQuality.value = roomQuality.value === 'high' ? 'lite' : 'high';
        break;
      case 'recenter':
        actions.recenter = true; // BookSystem picks this up this frame
        break;
      case 'prev-page':
        app.book.turnPage(-1);
        break;
      case 'next-page':
        app.book.turnPage(1);
        break;
      // ---- Big PDF / performance sub-page --------------------------------
      case 'perf':
        this.page = 'perf';
        break;
      case 'perf-back':
        this.page = 'main';
        break;
      case 'perf-stream':
        // index.ts reopens a picked file when this changes (it only matters at open).
        pdfStreaming.value = !pdfStreaming.value;
        break;
      case 'res-down':
        stepLevel(pdfResolution, PDF_RES_LEVELS, -1);
        break;
      case 'res-up':
        stepLevel(pdfResolution, PDF_RES_LEVELS, 1);
        break;
      case 'res-reset':
        pdfResolution.value = 1200;
        break;
      case 'cache-down':
        stepLevel(pdfCacheSize, PDF_CACHE_LEVELS, -1);
        break;
      case 'cache-up':
        stepLevel(pdfCacheSize, PDF_CACHE_LEVELS, 1);
        break;
      case 'cache-reset':
        pdfCacheSize.value = 10;
        break;
      case 'perf-queue':
        pdfRenderQueue.value = !pdfRenderQueue.value;
        break;
      case 'perf-preview':
        pdfPreview.value = !pdfPreview.value;
        break;
      case 'perf-stats':
        perfStats.value = !perfStats.value;
        break;
      case 'perf-all-on':
        // The recommended Quest set (same as the first-run defaults).
        pdfStreaming.value = true;
        pdfResolution.value = 1200;
        pdfCacheSize.value = 10;
        pdfRenderQueue.value = true;
        pdfPreview.value = true;
        break;
      case 'perf-all-off':
        // Exactly the old behaviour = your BASELINE for comparisons.
        pdfStreaming.value = false;
        pdfResolution.value = 640;
        pdfCacheSize.value = 0;
        pdfRenderQueue.value = false;
        pdfPreview.value = false;
        break;
      case 'reopen':
        void reopenBook();
        break;
    }
    this.dirty = true;
  }

  private rebuild(): void {
    this.dirty = false;
    this.shownTitle = app.bookTitle;
    if (this.page === 'perf') return this.rebuildPerf();
    this.panel.setTitle('Study Room');
    const m = app.music;
    this.panel.setRows(
      [
        [{ id: 'book', label: 'Open book… (leaves VR)' }],
        [
          { id: 'sample', label: 'Sample book' },
          { id: 'bring-back', label: 'Bring book back' },
        ],
        [
          { id: 'prev-page', label: '◀ Page' },
          { id: 'next-page', label: 'Page ▶' },
        ],
        // Three-button rows: [ - ] [ current value (tap = reset) ] [ + ]
        [
          { id: 'size-down', label: 'Size −' },
          { id: 'size-reset', label: `Book ${Math.round(bookScale.value * 100)}%` },
          { id: 'size-up', label: 'Size +' },
        ],
        [
          { id: 'desk-down', label: 'Desk ▼' },
          { id: 'desk-reset', label: `${Math.round(deskHeight.value * 100)} cm` },
          { id: 'desk-up', label: 'Desk ▲' },
        ],
        [
          { id: 'tilt-down', label: 'Tilt −' },
          { id: 'tilt-reset', label: `Tilt ${Math.round(deskTilt.value)}°` },
          { id: 'tilt-up', label: 'Tilt +' },
        ],
        [
          { id: 'play', label: m.playing.value ? '❚❚ Ambience' : '▶ Ambience' },
          { id: 'next', label: 'Next ▶▶' },
        ],
        [
          { id: 'vol-down', label: 'Vol −' },
          { id: 'vol-up', label: `Vol + (${Math.round(m.volume.value * 100)}%)` },
        ],
        [{ id: 'music-add', label: 'Add music… (leaves VR)' }],
        [
          { id: 'room', label: `Room: ${app.room.name} ⇄` },
          { id: 'quality', label: `Quality: ${roomQuality.value === 'high' ? 'High' : 'Lite'}` },
        ],
        [
          { id: 'recenter', label: 'Recenter' },
          { id: 'perf', label: 'Big PDF ▸' },
          { id: 'close', label: 'Close' },
        ],
      ],
      `♪ ${m.currentName}   ·   ${app.bookTitle}`,
    );
  }

  /**
   * The "Big PDF" sub-page: one control per performance experiment.
   * Labels end in ": On" / ": Off" so the panel can tint active toggles.
   */
  private rebuildPerf(): void {
    const onOff = (v: boolean) => (v ? 'On' : 'Off');
    const cache = pdfKeepCount(pdfCacheSize.value, pdfRenderQueue.value);
    this.panel.setTitle('Big PDF');
    this.panel.setRows(
      [
        [{ id: 'perf-stream', label: `Streaming load: ${onOff(pdfStreaming.value)}` }],
        [
          { id: 'res-down', label: 'Res −' },
          { id: 'res-reset', label: `Res ${pdfResolution.value}px` },
          { id: 'res-up', label: 'Res +' },
        ],
        [
          { id: 'cache-down', label: 'Cache −' },
          { id: 'cache-reset', label: cache === 0 ? 'Cache Old ±6' : `Window ${cache} pg` },
          { id: 'cache-up', label: 'Cache +' },
        ],
        [
          { id: 'perf-queue', label: `Queue: ${onOff(pdfRenderQueue.value)}` },
          { id: 'perf-preview', label: `Blurry 1st: ${onOff(pdfPreview.value)}` },
        ],
        [{ id: 'perf-stats', label: `Stats: ${onOff(perfStats.value)}` }],
        [
          { id: 'perf-all-on', label: 'All on (Quest)' },
          { id: 'perf-all-off', label: 'All off (old)' },
        ],
        [{ id: 'reopen', label: 'Reopen book' }],
        [
          { id: 'prev-page', label: '◀ Page' },
          { id: 'next-page', label: 'Page ▶' },
        ],
        [{ id: 'book', label: 'Open book… (leaves VR)' }],
        [
          { id: 'perf-back', label: '◀ Back' },
          { id: 'close', label: 'Close' },
        ],
      ],
      `Streaming applies on (re)open  ·  ${app.bookTitle}`,
    );
  }
}
