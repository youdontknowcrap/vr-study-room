/**
 * NotesSystem — the whiteboard: marker, eraser, pages, save/load/export.
 *
 * Runs every XR frame, AFTER the input layer and the menu and BEFORE the
 * book (see index.ts priorities), so a squeeze near the marker picks up the
 * marker instead of the book, and the book never sees that press.
 *
 * CONTROLS
 *   SQUEEZE (grip) near the marker or eraser -> pick it up. Pointing the
 *     ray at it and squeezing also works (it flies into your hand), which
 *     matters because the tray is low. Tracked hands: pinch.
 *     Squeezing a tool held in your OTHER hand takes it over.
 *   Let go -> the tool glides back to its spot on the easel tray.
 *   Tool held -> it sits exactly on the grip axis (no free rotation):
 *     marker tip / eraser felt face point "forward" out of the top of your fist.
 *   Tip/face within 2.5 cm of the board -> snap: a cursor dot (marker, in
 *     the current color + size) or a circle (eraser, its erase area) shows
 *     where it will touch. Reaching the surface -> touch down: short haptic
 *     tick, ink (or erasing) starts. Pull back > 8 mm -> lift.
 *     Pushing "through" the board keeps the tool ON the surface (clamped).
 *   Easel buttons (ray + trigger/squeeze/pinch, fingertip poke, the marker's
 *   tip, or a mouse click in the 2D page):
 *     ◀ left bar = previous page, ▶ right bar = next page (+ on the last
 *     page = add a blank page), Rotate (portrait/landscape), Save, Load…,
 *     Export PDF. "Page N / M" is shown on the panel.
 *   Menu "Return book + pens" or the B key -> book, marker and eraser all go home.
 *
 * WHY everything happens in update(): Quest Browser does NOT run
 * window.requestAnimationFrame during an immersive session, so canvas
 * drawing and texture uploads are driven from the XR frame (here) only.
 */
import {
  createSystem,
  Matrix4,
  type Object3D,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Intersection,
} from '@iwsdk/core';
import { app } from '../app.js';
import { actions, type Handedness, type HandState, type PressSource } from '../input/actions.js';
import { onRoomChange } from '../room/room-switch.js';
import { penColor, penSizeMm } from '../settings.js';
import { BoardCanvas } from './board-canvas.js';
import { Easel, type LoadEntry } from './easel.js';
import { downloadBytes, renderNotebookPdf } from './notes-export.js';
import {
  ERASER_RADIUS_M,
  Notebook,
  PEN_COLORS,
  PEN_SIZES_MM,
  serializeNotebook,
  StrokeBuilder,
  timestampName,
} from './notes-model.js';
import { AUTOSAVE_KEY, getNotebook, listNotebooks, putNotebook } from './notes-store.js';
import { Eraser, Marker } from './tools.js';

// ---- Tuning ---------------------------------------------------------------
/** Snap assist starts this close to the board (m). Spec: about 2-3 cm. */
const SNAP_DISTANCE = 0.025;
/** Touch down at/through the surface (allowing 1.5 mm of tracking noise)... */
const TOUCH_ON = 0.0015;
/** ...and lift once the tip is this far off it. The gap (hysteresis) stops flicker. */
const TOUCH_OFF = 0.008;
/** Deeper than this behind the surface = your hand went through the board: no snap. */
const PASS_THROUGH = 0.15;
/** Hand within this distance (m) of a tool's middle = near grab. */
const NEAR_GRAB = 0.08;
/** Ray grab: ray passes within this of the tool's middle, up to RAY_REACH away. */
const RAY_RADIUS = 0.05;
const RAY_REACH = 3;
/** Seconds to fly into the hand (near / ray grab) and to glide home. */
const SNAP_IN_S = 0.12;
const FLY_IN_S = 0.3;
const GLIDE_HOME_S = 0.4;
/** Hand untracked this long while holding -> the tool goes home. */
const LOST_HAND_S = 0.6;
/** Autosave this many seconds after the last change (stroke, page, rotate). */
const AUTOSAVE_DELAY_S = 3;
/** Haptic tick on touch-down: 30% strength for 15 ms (a light "tap"). */
const HAPTIC = { intensity: 0.3, ms: 15 };
/** How many saved notebooks the Load list shows per screen. */
const LOAD_PAGE = 7;

type ToolKind = 'marker' | 'eraser';

interface ToolState {
  kind: ToolKind;
  obj: Object3D;
  home: Object3D;
  /** Tip (marker) / felt face center (eraser), in tool space. */
  contactLocal: Vector3;
  centerLocal: Vector3;
  mode: 'home' | 'held' | 'gliding';
  hand: Handedness | null;
  via: PressSource;
  arrive: number;
  arriveSeconds: number;
  lostFor: number;
  glideT: number;
  readonly fromPos: Vector3;
  readonly fromQuat: Quaternion;
  touching: boolean;
  builder: StrokeBuilder | null;
  /** Was the tip touching an easel button last frame (edge-trigger)? */
  poking: boolean;
}

// ---- Scratch (no per-frame allocation) -------------------------------------
const boardInv = new Matrix4();
const boardQuat = new Quaternion();
const boardNormal = new Vector3();
const pos = new Vector3();
const quat = new Quaternion();
const scl = new Vector3();
const p1 = new Vector3();
const p2 = new Vector3();
const raycaster = new Raycaster();
const hits: Intersection[] = [];
const ease = (t: number) => t * t * (3 - 2 * t);

export class NotesSystem extends createSystem({}) {
  readonly notebook = new Notebook();
  easel!: Easel;
  board!: BoardCanvas;
  marker!: Marker;
  eraser!: Eraser;
  private tools!: Record<ToolKind, ToolState>;
  /** The same two tools as an array, made once (no per-frame Object.values() arrays). */
  private toolList: ToolState[] = [];

  private status = 'Grab the marker (squeeze)';
  private busy = false;
  private uiDirty = true;
  private hovered: string | null = null;
  private handPoking: Record<Handedness, boolean> = { left: false, right: false };
  private controllerHidden: Record<Handedness, boolean> = { left: false, right: false };
  private changedSinceSave = false;
  private autosaveIn = 0;
  private loadOffset = 0;
  private loadKeys: string[] = [];
  /** For tests/debugging: the last exported PDF. */
  lastExport: { name: string; pages: number; bytes: number } | null = null;
  lastSaved = '';
  private readonly usedNames = new Set<string>();
  /** Resolves once the autosave restore attempt on launch is done. */
  restored: Promise<void> = Promise.resolve();

  init(): void {
    app.notes = this;
    this.easel = new Easel();
    this.board = new BoardCanvas();
    this.marker = new Marker();
    this.eraser = new Eraser();
    const tool = (kind: ToolKind, obj: Object3D, home: Object3D, contact: Vector3, center: Vector3): ToolState => ({
      kind,
      obj,
      home,
      contactLocal: contact,
      centerLocal: center,
      mode: 'home',
      hand: null,
      via: 'none',
      arrive: 1,
      arriveSeconds: SNAP_IN_S,
      lostFor: 0,
      glideT: 0,
      fromPos: new Vector3(),
      fromQuat: new Quaternion(),
      touching: false,
      builder: null,
      poking: false,
    });
    this.tools = {
      marker: tool('marker', this.marker.root, this.easel.markerHome, this.marker.tipLocal, this.marker.centerLocal),
      eraser: tool('eraser', this.eraser.root, this.easel.eraserHome, this.eraser.faceLocal, this.eraser.centerLocal),
    };
    this.toolList = [this.tools.marker, this.tools.eraser];
    this.easel.markerHome.add(this.marker.root);
    this.easel.eraserHome.add(this.eraser.root);

    // The easel lives in the room, placed from the room's seat (so it is in
    // the same spot relative to you in every room). New room -> move it.
    app.room.area.add(this.easel.root);
    this.easel.placeForSeat(app.room.seat);
    onRoomChange((room) => {
      room.area.add(this.easel.root);
      this.easel.placeForSeat(room.seat);
    });

    this.showCurrentPage();

    // Settings -> marker cap color, UI color dot.
    this.cleanupFuncs.push(
      penColor.subscribe((c) => {
        this.marker.setColor(c);
        this.uiDirty = true;
      }),
    );

    // Restore the quiet autosave from the last session (crash safety net).
    this.restored = getNotebook(AUTOSAVE_KEY)
      .then((saved) => {
        if (!saved || !this.notebook.isEmpty) return;
        this.notebook.replace(saved.pages, saved.current);
        this.board.clearCache();
        this.showCurrentPage();
        this.setStatus(`Restored notes (${saved.pages.length} p.)`);
      })
      .catch((err) => console.warn('[notes] autosave restore failed', err));

    // Leaving the page (tab closed, headset sleeping): write a pending autosave now.
    const flush = () => {
      if (document.visibilityState === 'hidden' && this.autosaveIn > 0) void this.autosave();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    this.cleanupFuncs.push(() => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    });

    // Desktop: mouse clicks on the easel buttons (no headset needed).
    const canvas = this.world.renderer.domElement;
    const ndc = new Vector2();
    const onClick = (e: MouseEvent) => {
      if (this.world.session) return;
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, this.world.camera);
      raycaster.far = 10;
      const id = this.uiHit()?.id;
      if (id) this.press(id);
    };
    canvas.addEventListener('click', onClick);
    this.cleanupFuncs.push(() => canvas.removeEventListener('click', onClick));
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    if (actions.bringBookBack) this.returnTools(); // B key (BookSystem brings the book)

    const board = this.easel.board;
    board.updateWorldMatrix(true, true);
    boardInv.copy(board.matrixWorld).invert();
    board.getWorldQuaternion(boardQuat);
    boardNormal.set(0, 0, 1).applyQuaternion(boardQuat);
    this.easel.cursor.visible = false;
    this.easel.ring.visible = false;

    let hovered: string | null = null;
    let loadHovered: string | null = null;
    for (const h of ['left', 'right'] as const) {
      const hand = actions.hands[h];
      const holding = this.toolIn(h);
      const fresh = hand.grab.pressed && !hand.grab.consumed;
      const squeezeLike = hand.grab.via === 'squeeze' || hand.grab.via === 'pinch';
      // 1) Near grab beats everything else for a squeeze/pinch.
      if (fresh && squeezeLike && !holding && app.bookSystem?.holderHand !== h) {
        const t = this.nearTool(hand, h);
        if (t) {
          this.grabTool(t, h, hand, SNAP_IN_S);
          hand.consumePress();
          continue;
        }
      }
      // 2) Easel buttons by ray.
      if (hand.rayValid) {
        raycaster.set(hand.rayOrigin, hand.rayDirection);
        raycaster.far = RAY_REACH;
        const hit = this.uiHit();
        if (hit) {
          if (hit.load) loadHovered ??= hit.id;
          else hovered ??= hit.id;
          if (hand.grab.pressed && !hand.grab.consumed) {
            hand.consumePress();
            this.press(hit.id);
          }
        }
      }
      // 3) Fingertip poke (tracked hands).
      this.handPoke(hand, h);
      // 4) Ray grab (point at a tool + squeeze/pinch), if the book isn't closer.
      if (hand.grab.pressed && !hand.grab.consumed && squeezeLike && !holding && app.bookSystem?.holderHand !== h) {
        const t = this.rayTool(hand);
        if (t) {
          this.grabTool(t, h, hand, FLY_IN_S);
          hand.consumePress();
        }
      }
      // 5) A hand holding a tool never grabs the book or its pages too.
      if (this.toolIn(h) && (hand.grab.pressed || hand.select.pressed)) hand.consumePress();
    }
    if (hovered !== this.hovered) {
      this.hovered = hovered;
      this.uiDirty = true;
    }
    this.easel.setLoadHovered(loadHovered);

    for (const t of this.toolList) {
      if (t.mode === 'held') this.updateHeld(t, dt);
      else if (t.mode === 'gliding') this.updateGlide(t, dt);
    }

    this.updateControllerVisibility();

    // At most ONE texture upload per frame, covering everything drawn above.
    this.board.flush(this.world.renderer);

    if (this.uiDirty) {
      this.uiDirty = false;
      this.easel.updateUi({
        pageLabel: this.notebook.label,
        canPrev: this.notebook.current > 0,
        isLast: this.notebook.isLast,
        orientation: this.notebook.page.orientation,
        status: this.status,
        busy: this.busy,
        penColor: penColor.peek(),
        hovered: this.hovered,
      });
    }

    if (this.autosaveIn > 0) {
      this.autosaveIn -= dt;
      if (this.autosaveIn <= 0) void this.autosave();
    }
  }

  // ------------------------------------------------------------------
  // Grabbing
  // ------------------------------------------------------------------

  private toolIn(h: Handedness): ToolState | null {
    const { marker, eraser } = this.tools;
    if (marker.mode === 'held' && marker.hand === h) return marker;
    if (eraser.mode === 'held' && eraser.hand === h) return eraser;
    return null;
  }

  private worldCenter(t: ToolState, out: Vector3): Vector3 {
    t.obj.updateWorldMatrix(true, false);
    return out.copy(t.centerLocal).applyMatrix4(t.obj.matrixWorld);
  }

  /** Closest tool within NEAR_GRAB of the hand (a tool in the OTHER hand can be taken over). */
  private nearTool(hand: HandState, h: Handedness): ToolState | null {
    let best: ToolState | null = null;
    let bestD = NEAR_GRAB;
    for (const t of this.toolList) {
      if (t.mode === 'held' && t.hand === h) continue;
      const d = this.worldCenter(t, p1).distanceTo(hand.grabPoint);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /** Tool the hand's ray points at (resting/gliding only), unless the book is nearer. */
  private rayTool(hand: HandState): ToolState | null {
    if (!hand.rayValid) return null;
    let best: ToolState | null = null;
    let bestT = RAY_REACH;
    for (const t of this.toolList) {
      if (t.mode === 'held') continue;
      this.worldCenter(t, p1).sub(hand.rayOrigin);
      const along = p1.dot(hand.rayDirection);
      if (along <= 0 || along > bestT) continue;
      const off = p1.addScaledVector(hand.rayDirection, -along).length();
      if (off < RAY_RADIUS) {
        bestT = along;
        best = t;
      }
    }
    if (!best) return null;
    const book = app.bookSystem?.grabCandidate(hand);
    if (book && (book.near || (book.rayDist !== null && book.rayDist < bestT))) return null;
    return best;
  }

  private grabTool(t: ToolState, h: Handedness, hand: HandState, seconds: number): void {
    if (t.mode === 'held') this.endStroke(t); // taken over from the other hand
    this.world.scene.attach(t.obj); // hold in WORLD space
    t.fromPos.copy(t.obj.position);
    t.fromQuat.copy(t.obj.quaternion);
    t.mode = 'held';
    t.hand = h;
    t.via = hand.grab.via;
    t.arrive = 0;
    t.arriveSeconds = seconds;
    t.lostFor = 0;
    t.poking = true; // don't press a button the moment it arrives
    this.setStatus(t.kind === 'marker' ? 'Marker: touch the board to write' : 'Eraser: wipe the board');
  }

  /** Back to its spot on the tray (smooth glide). */
  private sendHome(t: ToolState): void {
    this.endStroke(t);
    if (t.mode === 'home') return;
    this.world.scene.attach(t.obj);
    t.fromPos.copy(t.obj.position);
    t.fromQuat.copy(t.obj.quaternion);
    t.mode = 'gliding';
    t.hand = null;
    t.glideT = 0;
  }

  /** Menu "Return book + pens" / B key: marker and eraser go back to the tray. */
  returnTools(): void {
    for (const t of this.toolList) this.sendHome(t);
  }

  private updateGlide(t: ToolState, dt: number): void {
    t.glideT = Math.min(1, t.glideT + dt / GLIDE_HOME_S);
    t.home.updateWorldMatrix(true, false);
    t.home.matrixWorld.decompose(pos, quat, scl);
    const k = ease(t.glideT);
    t.obj.position.lerpVectors(t.fromPos, pos, k);
    t.obj.quaternion.slerpQuaternions(t.fromQuat, quat, k);
    if (t.glideT >= 1) {
      t.home.add(t.obj);
      t.obj.position.set(0, 0, 0);
      t.obj.quaternion.identity();
      t.mode = 'home';
    }
  }

  // ------------------------------------------------------------------
  // Holding + writing
  // ------------------------------------------------------------------

  private updateHeld(t: ToolState, dt: number): void {
    const hand = actions.hands[t.hand!];
    if (!hand.gripValid) {
      // Controller/hand lost: lift the pen; after a moment, send it home.
      this.endStroke(t);
      t.lostFor += dt;
      if (t.lostFor > LOST_HAND_S) this.sendHome(t);
      return;
    }
    t.lostFor = 0;
    if (!sourceDown(hand, t.via)) {
      this.sendHome(t); // let go: back to the tray
      return;
    }

    // Tool pose = grip pose. Snapped to the grip axis, no free rotation.
    pos.copy(hand.gripPosition);
    quat.copy(hand.gripQuaternion);
    if (t.arrive < 1) {
      t.arrive = Math.min(1, t.arrive + dt / t.arriveSeconds);
      const k = ease(t.arrive);
      pos.lerpVectors(t.fromPos, pos, k);
      quat.slerpQuaternions(t.fromQuat, quat, k);
    }

    // Where is the tip / felt face, in board space? local.z = distance in front.
    p2.copy(t.contactLocal).applyQuaternion(quat).add(pos);
    const local = p1.copy(p2).applyMatrix4(boardInv);
    const e = this.easel;
    const halfW = e.w / 2;
    const halfH = e.h / 2;
    const d = local.z;
    const onBoard = Math.abs(local.x) <= halfW && Math.abs(local.y) <= halfH;
    const snapping =
      t.arrive >= 1 && onBoard && d < SNAP_DISTANCE && d > -PASS_THROUGH && !e.loadOpen;

    // Clamp onto the surface: if the tip went INTO the board, slide the
    // whole tool back out along the board's normal so the tip rests on it.
    // (A real board stops your marker; ours can't, so we fake it visually.)
    if (snapping && d < 0) pos.addScaledVector(boardNormal, -d);
    t.obj.position.copy(pos);
    t.obj.quaternion.copy(quat);

    // Easel buttons can be pressed with the tip too (edge-triggered).
    const poke = e.pokeAt(local, 0.015);
    if (poke && !t.poking) this.press(poke);
    t.poking = !!poke;

    if (!snapping) {
      this.endStroke(t);
      return;
    }
    const radius = t.kind === 'marker' ? penSizeMm.peek() / 1000 : ERASER_RADIUS_M;
    if (t.kind === 'marker') e.showCursor(local.x, local.y, radius, penColor.peek());
    else e.showRing(local.x, local.y, radius);

    // Page coordinates: meters from the top-left corner, y down.
    const px = local.x + halfW;
    const py = halfH - local.y;
    if (!t.touching && d <= TOUCH_ON) {
      t.touching = true;
      this.pulse(t.hand!);
      const color = t.kind === 'marker' ? penColor.peek() : '#ffffff';
      t.builder = new StrokeBuilder(t.kind === 'marker' ? 'pen' : 'erase', color, radius);
      this.notebook.page.strokes.push(t.builder.stroke);
      t.builder.add(px, py, dt);
      this.board.drawPiece(t.builder.stroke, 0);
    } else if (t.touching && d > TOUCH_OFF) {
      this.endStroke(t);
    } else if (t.touching && t.builder) {
      if (t.builder.add(px, py, dt)) this.board.drawPiece(t.builder.stroke, t.builder.pointCount - 1);
    }
  }

  private endStroke(t: ToolState): void {
    if (t.builder) {
      this.board.finish(t.builder.stroke);
      t.builder = null;
      this.markChanged();
    }
    t.touching = false;
  }

  private endAllStrokes(): void {
    for (const t of this.toolList) this.endStroke(t);
  }

  /** A short, light haptic tick on the controller in hand `h` (if it has one). */
  private pulse(h: Handedness): void {
    const session = this.world.session;
    if (!session) return;
    for (const src of session.inputSources) {
      if (src.handedness !== h || !src.gamepad) continue;
      // `hapticActuators[0].pulse()` is what Quest Browser implements; the
      // newer `vibrationActuator.playEffect()` is the standard Gamepad API.
      const gp = src.gamepad as Gamepad & {
        hapticActuators?: { pulse?: (v: number, ms: number) => Promise<boolean> }[];
      };
      try {
        const act = gp.hapticActuators?.[0];
        if (act?.pulse) void act.pulse(HAPTIC.intensity, HAPTIC.ms).catch(() => {});
        else
          void gp.vibrationActuator
            ?.playEffect('dual-rumble', { duration: HAPTIC.ms, strongMagnitude: HAPTIC.intensity, weakMagnitude: HAPTIC.intensity })
            .catch(() => {});
      } catch {
        /* no haptics on this device: fine */
      }
    }
  }

  /** Hide the controller model of any hand holding something (tool or book). */
  private updateControllerVisibility(): void {
    const adapters = this.world.input.xr.visualAdapters.controller;
    for (const h of ['left', 'right'] as const) {
      const holding = this.toolIn(h) !== null || app.bookSystem?.holderHand === h;
      if (holding === this.controllerHidden[h]) continue;
      this.controllerHidden[h] = holding;
      adapters[h].toggleVisual(!holding);
    }
  }

  // ------------------------------------------------------------------
  // Buttons
  // ------------------------------------------------------------------

  /** The easel button under `raycaster` (Load list first: it floats in front). */
  private uiHit(): { id: string; load: boolean } | null {
    const e = this.easel;
    if (e.loadOpen) {
      hits.length = 0;
      raycaster.intersectObject(e.loadPanel, false, hits);
      const uv = hits[0]?.uv;
      if (uv) {
        const id = e.loadButtonAtUv(uv.x, uv.y);
        return id ? { id, load: true } : null; // the panel blocks what's behind it
      }
    }
    hits.length = 0;
    raycaster.intersectObject(e.uiMesh, false, hits);
    const uv = hits[0]?.uv;
    if (!uv) return null;
    const id = e.buttonAtUv(uv.x, uv.y);
    return id ? { id, load: false } : null;
  }

  private handPoke(hand: HandState, h: Handedness): void {
    if (!hand.indexTipValid) {
      this.handPoking[h] = false;
      return;
    }
    const local = p1.copy(hand.indexTip).applyMatrix4(boardInv);
    const id = this.easel.pokeAt(local, 0.012);
    if (id && !this.handPoking[h]) this.press(id);
    this.handPoking[h] = !!id;
  }

  /** Run an easel button. Public so tests (and the console) can press them. */
  press(id: string): void {
    const nb = this.notebook;
    switch (id) {
      case 'prev':
        if (nb.prev()) this.showCurrentPage();
        break;
      case 'next':
        if (nb.next() === 'added') {
          this.markChanged();
          this.setStatus('New blank page');
        }
        this.showCurrentPage();
        break;
      case 'rotate':
        nb.rotate();
        this.showCurrentPage();
        this.markChanged();
        break;
      case 'save':
        void this.save();
        break;
      case 'load':
        void this.openLoad(0);
        break;
      case 'export':
        void this.exportPdf();
        break;
      case 'load-cancel':
        this.easel.hideLoad();
        break;
      case 'load-older':
        void this.openLoad(this.loadOffset + LOAD_PAGE);
        break;
      case 'load-newer':
        void this.openLoad(Math.max(0, this.loadOffset - LOAD_PAGE));
        break;
      default:
        if (id.startsWith('load-')) {
          const key = this.loadKeys[Number(id.slice(5))];
          if (key) void this.loadNotebook(key);
        }
    }
    this.uiDirty = true;
  }

  /** Put the current page on the board (re-layout if its orientation differs). */
  private showCurrentPage(): void {
    this.endAllStrokes(); // a stroke must never continue onto another page
    const page = this.notebook.page;
    if (page.orientation !== this.easel.orientation) this.easel.layout(page.orientation);
    this.board.show(page);
    const mat = this.easel.surface.material;
    if (mat.map !== this.board.texture) {
      mat.map = this.board.texture;
      mat.needsUpdate = true; // map null -> texture changes the shader
    }
    this.uiDirty = true;
  }

  private setStatus(s: string): void {
    this.status = s;
    this.uiDirty = true;
  }

  // ------------------------------------------------------------------
  // Save / load / export / autosave
  // ------------------------------------------------------------------

  private markChanged(): void {
    this.changedSinceSave = true;
    this.autosaveIn = AUTOSAVE_DELAY_S; // restart the countdown (debounce)
  }

  private snapshot(name: string) {
    return serializeNotebook(this.notebook, name, Date.now(), penColor.peek(), penSizeMm.peek());
  }

  private async autosave(): Promise<void> {
    this.autosaveIn = 0;
    try {
      await putNotebook(AUTOSAVE_KEY, this.snapshot('autosave'));
    } catch (err) {
      console.warn('[notes] autosave failed', err);
    }
  }

  /** Save button: the whole notebook under a timestamp name. Returns the name. */
  async save(): Promise<string | null> {
    // Two saves in the same second would get the same name and the second
    // would overwrite the first: add -2, -3, ... instead.
    const base = timestampName(new Date());
    let name = base;
    for (let i = 2; this.usedNames.has(name); i++) name = `${base}-${i}`;
    this.usedNames.add(name);
    try {
      await putNotebook(name, this.snapshot(name));
      this.changedSinceSave = false;
      this.lastSaved = name;
      this.setStatus(`Saved ${name}`);
      return name;
    } catch (err) {
      console.error('[notes] save failed', err);
      this.setStatus('Save failed (storage full?)');
      return null;
    }
  }

  private async openLoad(offset: number): Promise<void> {
    try {
      const all = await listNotebooks();
      this.loadOffset = Math.min(offset, Math.max(0, all.length - 1));
      const shown = all.slice(this.loadOffset, this.loadOffset + LOAD_PAGE);
      this.loadKeys = shown.map((n) => n.key);
      const entries: LoadEntry[] = shown.map((n, i) => ({ id: `load-${i}`, label: `${n.name}  ·  ${n.pages} p.` }));
      if (this.loadOffset > 0) entries.push({ id: 'load-newer', label: '◂ Newer' });
      if (this.loadOffset + LOAD_PAGE < all.length) entries.push({ id: 'load-older', label: 'Older ▸' });
      entries.push({ id: 'load-cancel', label: 'Cancel' });
      const title = all.length ? `Load notes (${all.length} saved)` : 'No saved notes yet';
      this.easel.showLoad(title, entries);
    } catch (err) {
      console.error('[notes] list failed', err);
      this.setStatus('Could not read saved notes');
    }
  }

  /** Load a saved notebook by key (unsaved work is saved first, so nothing is lost). */
  async loadNotebook(key: string): Promise<boolean> {
    this.easel.hideLoad();
    if (!this.notebook.isEmpty && this.changedSinceSave) await this.save();
    const saved = await getNotebook(key).catch(() => null);
    if (!saved) {
      this.setStatus('Could not read that notebook');
      return false;
    }
    this.endAllStrokes();
    this.notebook.replace(saved.pages, saved.current);
    this.board.clearCache();
    if (PEN_COLORS.some((c) => c.hex === saved.penColor)) penColor.value = saved.penColor;
    if ((PEN_SIZES_MM as readonly number[]).includes(saved.penSizeMm)) penSizeMm.value = saved.penSizeMm;
    this.showCurrentPage();
    this.changedSinceSave = false;
    this.autosaveIn = 0.5; // the loaded notebook becomes the crash-safety copy
    this.setStatus(`Loaded ${saved.name}`);
    return true;
  }

  /** Export PDF button: all pages, letter size, downloaded as notes-<time>.pdf. */
  async exportPdf(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.endAllStrokes();
    this.setStatus('Exporting PDF…');
    try {
      const name = `${timestampName(new Date())}.pdf`;
      const { bytes, pages } = await renderNotebookPdf(this.notebook, name.replace(/\.pdf$/, ''));
      downloadBytes(bytes, name);
      this.lastExport = { name, pages, bytes: bytes.length };
      this.setStatus(`Exported ${pages} p. → ${name}`);
    } catch (err) {
      console.error('[notes] export failed', err);
      this.setStatus('PDF export failed');
    } finally {
      this.busy = false;
      this.uiDirty = true;
    }
  }

  // ------------------------------------------------------------------
  // For tests / the console
  // ------------------------------------------------------------------

  /** 'home' | 'held-left' | 'held-right' | 'gliding' */
  toolState(kind: ToolKind): string {
    const t = this.tools[kind];
    return t.mode === 'held' ? `held-${t.hand}` : t.mode;
  }

  /** Is the tool's tip/face touching the board right now? */
  isTouching(kind: ToolKind): boolean {
    return this.tools[kind].touching;
  }

  /** Is the controller model of hand `h` currently hidden by us? */
  controllerHiddenFor(h: Handedness): boolean {
    return this.controllerHidden[h];
  }
}

/** Is the physical input that started a hold still down? (Same rule as the book.) */
function sourceDown(hand: HandState, via: PressSource): boolean {
  if (via === 'squeeze') return hand.squeezeDown;
  if (via === 'trigger') return hand.triggerDown;
  if (via === 'pinch') return hand.pinchDown;
  return hand.grab.held;
}
