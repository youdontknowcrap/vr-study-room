/**
 * MenuSystem — opens/closes the floating menu and handles button presses.
 *
 * Ways to press a button (all go through the shared input actions):
 *  - Point a controller (or a hand's pinch-ray) at it and GRAB (trigger/pinch).
 *  - Poke it with your index fingertip (hand tracking).
 *  - Click it with the mouse (desktop browser).
 * Open/close: controller B/Y button, M key, or press the "☰ Menu" tab on the desk.
 */
import { createSystem, Raycaster, Vector2, Vector3, type Intersection } from '@iwsdk/core';
import { actions, type HandState } from '../input/actions.js';
import { app, loadSampleBook, requestPicker } from '../app.js';
import { ENVIRONMENTS } from '../room/environments.js';
import {
  bookHand,
  BOOK_HAND_LABEL,
  cycleBookHand,
  cycleEnvironment,
  environmentId,
} from '../settings.js';
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
    app.room.menuTabAnchor.add(this.tab);

    // Rebuild the labels whenever something they show changes.
    const markDirty = () => (this.dirty = true);
    this.cleanupFuncs.push(
      bookHand.subscribe(markDirty),
      environmentId.subscribe(markDirty),
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
    // Place it ~45 cm in front of your eyes, a bit low, facing you: inside
    // the comfortable field of view, within arm's reach for poking.
    const cam = this.world.camera;
    cam.getWorldPosition(headPos);
    tmp.set(0, 0, -1).transformDirection(cam.matrixWorld);
    tmp.y = 0;
    tmp.normalize();
    this.panel.mesh.position.copy(headPos).addScaledVector(tmp, 0.45);
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
      hand.grab.consumed = true; // don't also grab the book
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
      case 'pdf':
        requestPicker('pdf');
        break;
      case 'music-add':
        requestPicker('music');
        break;
      case 'sample':
        void loadSampleBook();
        break;
      case 'hand':
        cycleBookHand();
        break;
      case 'env':
        cycleEnvironment();
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
        [{ id: 'pdf', label: 'Open PDF… (leaves VR)' }],
        [
          { id: 'sample', label: 'Sample book' },
          { id: 'hand', label: `Book: ${BOOK_HAND_LABEL[bookHand.value]}` },
        ],
        [
          { id: 'prev-page', label: '◀ Page' },
          { id: 'next-page', label: 'Page ▶' },
        ],
        [{ id: 'env', label: `Room: ${ENVIRONMENTS[environmentId.value].label}` }],
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
          { id: 'recenter', label: 'Recenter' },
          { id: 'close', label: 'Close' },
        ],
      ],
      `♪ ${m.currentName}   ·   ${app.bookTitle}`,
    );
  }
}
