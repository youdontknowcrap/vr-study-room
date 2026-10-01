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
import { app, loadSampleBook, requestPicker } from '../app.js';
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
} from '../settings.js';
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
    }
    this.dirty = true;
  }

  private rebuild(): void {
    this.dirty = false;
    this.shownTitle = app.bookTitle;
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
          { id: 'play', label: m.playing.value ? '❚❚ Pause' : '▶ Play' },
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
          { id: 'close', label: 'Close' },
        ],
      ],
      `♪ ${m.currentName}   ·   ${app.bookTitle}`,
    );
  }
}
