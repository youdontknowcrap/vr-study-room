/**
 * BookSystem — everything you can DO with the book, driven by input actions.
 *
 * The book is always in exactly one STATE:
 *
 *   resting  - lying on the desk (or the floor). It stays exactly how it
 *              landed and is a CHILD of the desk top (or the room), so it
 *              moves along when you change desk height/tilt or Recenter.
 *   held     - in one of your hands. A near grab keeps the pose the book
 *              had relative to that hand. A far grab settles into the palm
 *              (tracked hands) or just above the controller. Turn your hand
 *              and the book turns with it. No auto-facing your eyes.
 *   falling  - you let go away from the desk: gravity, bounces, walls
 *              (see book-physics.ts).
 *   settling - a short glide into a resting pose (after landing, after a
 *              release over the desk, or for "Bring book back").
 *
 * Controls (bindings live in input/bindings.ts):
 *   (Full press rules + reasons: page-grab.ts. Unit-tested.)
 *   SQUEEZE near the book, or pointing the ray at it -> pick it up (from
 *     afar it flies into your hand). Works from desk, table or floor.
 *     While one hand holds it, SQUEEZE with the OTHER hand -> it swaps to
 *     that hand. Squeeze is the ONLY way to swap.
 *   TRIGGER / PINCH
 *     - at (or aimed at) a PAGE -> grab that page and drag it around the
 *       spine (right page forward, left page back). Let go past halfway ->
 *       it turns, else it falls back. A quick tap just flips it. Works with
 *       the book on the stand or in your other hand.
 *     - on the cover / spine / edge of a book that is NOT held -> pick it
 *       up (as with squeeze). While the book is held: nothing (no swap).
 *     - on the hand that HOLDS the book: nothing.
 *   Let go (of the button that picked it up) over / near the desk -> it
 *     lands open on the slanted top. Elsewhere -> it falls (throwable).
 *   turnPage (thumbstick flick, hand swipe/poke, arrow keys, menu) -> turn.
 *   recenter -> room re-faces you; a book on the floor comes back too.
 *   bringBookBack (menu, B key) -> the book glides back onto the desk.
 */
import {
  Box3,
  createSystem,
  Euler,
  Matrix4,
  type Object3D,
  Quaternion,
  Raycaster,
  Vector3,
} from '@iwsdk/core';
import { actions, type Handedness, type HandState, type PressSource } from '../input/actions.js';
import { decidePress, isQuickTap, nearPageSide, rayDragX, rayPageHit } from './page-grab.js';
import { noteFrame } from '../debug/stream-log.js';
import { flushXrPaintPump, setXrPresenting } from './xr-paint-pump.js';
import { app } from '../app.js';
import { bookScale } from '../settings.js';
import { getHeadPose } from '../room/head-pose.js';
import { onRoomChange } from '../room/room-switch.js';
import type { FlatSurface } from '../room/room-types.js';
import { FallingBody, restPose, lowestAlong, type Surface } from './book-physics.js';

/** A room table as a landing surface (remembers which table it is). */
interface TableSurface extends Surface {
  table: FlatSurface;
}

// ---- Tuning ---------------------------------------------------------------
/** How close (m) your hand must be to the book's box to grab it directly. */
const NEAR_GRAB_MARGIN = 0.05;
/** Farthest a ray grab reaches (m). The whole room fits. */
const RAY_GRAB_DISTANCE = 5;
/** Seconds the book takes to fly into your hand after a ray grab. */
const FLY_TO_HAND_SECONDS = 0.3;
/** Release counts as "on the desk" this close to the desk top (m). */
const DESK_SNAP_MARGIN = 0.12;
const DESK_SNAP_HEIGHT = 0.4;
/** Holding hand untracked this long (s) -> book goes back to the desk. */
const LOST_HAND_SECONDS = 0.6;
/** Farther than this (m) from your seat -> Recenter also brings the book back. */
const OUT_OF_REACH = 0.9;
/**
 * Default pose when a CONTROLLER ray-grabs the book. Grip space: +Y is up
 * off the fist, −Z runs along the barrel. ~11 cm above the fist, tilted up
 * ~35 degrees. x is mirrored so the book sits toward the body's center.
 */
const IN_HAND_OFFSET = { x: 0.06, y: 0.11, z: -0.02, tiltX: -0.6 };
/**
 * Default pose when a TRACKED HAND ray-grabs the book, in the palm frame
 * (palm-frame.ts): +Y toward the fingertips, +Z out of the palm. A couple
 * of centimeters out of the palm, shifted toward the thumb, tilted so the
 * top of the page comes toward the eyes (−0.55 rad about X).
 */
const PALM_OFFSET = { x: 0.03, y: 0, z: 0.02, tiltX: -0.55 };

type BookState =
  | { kind: 'resting'; on: 'desk' | 'floor' | 'table' }
  | {
      kind: 'held';
      hand: Handedness;
      /** book pose = hand pose * offset */
      offset: Matrix4;
      /** 0 -> 1 while flying into the hand after a ray grab (1 = arrived). */
      arrive: number;
      lostFor: number;
      /** The button that picked it up; the hold ends when THAT one is let go. */
      via: PressSource;
    }
  | { kind: 'falling' }
  | {
      kind: 'settling';
      on: 'desk' | 'floor' | 'table';
      parent: Object3D;
      /** Target pose in PARENT space (so it follows a moving desk). */
      toPos: Vector3;
      toQuat: Quaternion;
      t: number;
      duration: number;
    };

// ---- Scratch objects (no allocations per frame) --------------------------
const m1 = new Matrix4();
const m2 = new Matrix4();
const local = new Vector3();
const headPos = new Vector3();
const headQuat = new Quaternion();
const pos = new Vector3();
const quat = new Quaternion();
const scl = new Vector3();
const prevPos = new Vector3();
const prevQuat = new Quaternion();
const startPos = new Vector3();
const startQuat = new Quaternion();
const vInst = new Vector3();
const qDelta = new Quaternion();
const ONE = new Vector3(1, 1, 1);
const UP = new Vector3(0, 1, 0);
const raycaster = new Raycaster();
const rayO = new Vector3();
const rayD = new Vector3();
const bounds = new Box3();
/** Book lying flat on the desk, top of the pages pointing away from you. */
const DESK_HOME_QUAT = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));

const ease = (t: number) => t * t * (3 - 2 * t);

export class BookSystem extends createSystem({}) {
  private state: BookState = { kind: 'resting', on: 'desk' };
  private readonly body = new FallingBody();
  /** Which hand is dragging a page (null = none). */
  private pageDragHand: Handedness | null = null;
  /** The current page drag: by ray (aimed) or by the hand's position? */
  private pageDragByRay = false;
  /** Seconds since the page grab started, and where (model x) it started. */
  private pageDragTime = 0;
  private pageDragStartX = 0;
  private pageDragLastX = 0;
  private pageDragMoved = 0;
  private pageDragDir: 1 | -1 = 1;
  /** Smoothed book velocity + spin while held (for throwing). */
  private readonly velocity = new Vector3();
  private readonly spin = new Vector3();
  private trackedValid = false;
  /** For the fly-in / settle glides: the pose we started from (world). */
  private readonly fromPos = new Vector3();
  private readonly fromQuat = new Quaternion();

  private wasInXR = false;
  /** Set when a VR session starts; cleared once we got a real head pose. */
  private recenterPending = false;
  private lastBookId = '';

  private readonly floor: Surface = {
    kind: 'floor',
    normal: new Vector3(0, 1, 0),
    point: new Vector3(),
    contains: () => true,
  };
  private readonly deskSurface: Surface = {
    kind: 'desk',
    normal: new Vector3(0, 1, 0),
    point: new Vector3(),
    contains: (p) => {
      const d = app.room.desk;
      d.top.worldToLocal(local.copy(p));
      return Math.abs(local.x) < d.halfW && Math.abs(local.z) < d.halfD;
    },
  };

  /** Extra flat surfaces (e.g. a coffee table) from the room, as landing spots. */
  private tableSurfaces: TableSurface[] = [];

  init(): void {
    this.buildTableSurfaces();
    // Menu "Room": a new room means a new desk, tables and seat. Put the book
    // on the new desk and line the new room up with your head (= Recenter).
    onRoomChange(() => {
      if (this.pageDragHand) {
        app.book.endDrag();
        this.pageDragHand = null;
      }
      this.buildTableSurfaces();
      this.placeAtHomeNow();
      this.recenterPending = true;
    });
    // Line the room up with the (2D or VR) head once at startup too, so a
    // room whose seat is not at the origin (most custom scenes) starts right.
    this.recenterPending = true;
    app.bookSystem = this; // handy for debugging: window.app.bookSystem
    this.world.scene.add(app.book.root);
    app.book.setScale(bookScale.value);
    this.placeAtHomeNow();
    this.cleanupFuncs.push(
      bookScale.subscribe((s) => {
        app.book.setScale(s);
        this.reRest(); // bigger/smaller book: lift it so it sits on its surface
      }),
    );
  }

  /** Each room table becomes a landing surface (world positions updated per frame). */
  private buildTableSurfaces(): void {
    this.tableSurfaces = app.room.tables.map((t) => {
      return {
        table: t,
        kind: 'floor', // physics-wise a table is just a raised floor
        normal: new Vector3(0, 1, 0),
        point: new Vector3(),
        contains: (p) => {
          app.room.area.worldToLocal(local.copy(p));
          // rotate into the table's own frame
          const dx = local.x - t.x;
          const dz = local.z - t.z;
          const c = Math.cos(-t.yaw);
          const s2 = Math.sin(-t.yaw);
          return Math.abs(dx * c - dz * s2) < t.halfW && Math.abs(dx * s2 + dz * c) < t.halfD;
        },
      };
    });
  }

  /**
   * For the whiteboard tools (NotesSystem runs BEFORE this system): would a
   * grab press from `hand` go to the book? Near = hand at the book; rayDist
   * = how far along the hand's ray the book is (null = ray misses it).
   * Lets the marker/eraser and the book share the squeeze button fairly.
   */
  grabCandidate(hand: HandState): { near: boolean; rayDist: number | null } {
    const near = this.isNear(hand);
    if (!hand.rayValid) return { near, rayDist: null };
    raycaster.set(hand.rayOrigin, hand.rayDirection);
    raycaster.far = RAY_GRAB_DISTANCE;
    const hit = raycaster.intersectObject(app.book.hitMesh, false)[0];
    return { near, rayDist: hit ? hit.distance : null };
  }

  /** Which hand holds the book (null = none). Used to hide that controller. */
  get holderHand(): Handedness | null {
    return this.state.kind === 'held' ? this.state.hand : null;
  }

  /** What the book is doing right now (for menus, tests, debugging). */
  get stateName(): string {
    const s = this.state;
    return s.kind === 'held' ? `held-${s.hand}` : s.kind === 'resting' ? `resting-${s.on}` : s.kind;
  }

  update(delta: number): void {
    noteFrame(delta);
    // Drive pdf.js paint slices from this frame. Quest does not deliver
    // window.requestAnimationFrame during an immersive session, so a page
    // opened in VR otherwise waits until the session ends.
    setXrPresenting(!!this.world.session);
    flushXrPaintPump(performance.now());
    const book = app.book;

    // 1) Recenter: automatically when a VR session starts, or on request.
    //    BUG FIX ("MP3 makes the book vanish"): never use world.camera here,
    //    it still holds the 2D pose on the first VR frame. getHeadPose()
    //    reads the live headset pose. And because a resting book is a child
    //    of the desk/room, it simply moves WITH the room: its page, PDF and
    //    spot on the desk survive leaving VR to pick files.
    const inXR = !!this.world.session;
    if (inXR && !this.wasInXR) this.recenterPending = true;
    if (!inXR && this.wasInXR) this.onSessionEnd();
    this.wasInXR = inXR;
    if (this.recenterPending || actions.recenter) {
      if (getHeadPose(this.world, headPos, headQuat)) {
        this.recenterPending = false;
        app.room.recenter(headPos, headQuat);
        if (this.isOnFloorOrFar()) this.bringBack();
      }
    }
    if (actions.bringBookBack) this.bringBack();

    // A new PDF can have a different size/thickness: re-seat the book.
    if (book.bookId !== this.lastBookId) {
      this.lastBookId = book.bookId;
      this.reRest();
    }

    // 2) Tell the swipe/poke detector where the pages are.
    const s = this.state;
    const holder = s.kind === 'held' ? s.hand : null;
    if (s.kind === 'resting' || s.kind === 'held') {
      const sf = book.surface;
      actions.swipeZone = {
        object: book.model,
        halfWidth: sf.halfWidth,
        halfHeight: sf.halfHeight,
        slope: sf.slope,
        baseZ: sf.baseZ,
        maxDistance: 0.06 / book.scale, // model units: keep ~6 cm in the world
        allowLeft: holder !== 'left',
        allowRight: holder !== 'right',
      };
    } else {
      actions.swipeZone = null;
    }

    // 3) Page-turn pulses (thumbstick, swipe, poke, arrow keys, menu).
    if (actions.turnPage !== 0) book.turnPage(actions.turnPage);

    // 4) Hands: page drags, grabs, swaps.
    for (const h of ['left', 'right'] as const) this.handleHand(h, actions.hands[h], delta);

    // 5) Move the book according to its state.
    this.updateState(delta);

    book.update(delta);
  }

  // ------------------------------------------------------------------
  // Hands
  // ------------------------------------------------------------------

  private handleHand(h: Handedness, hand: HandState, dt: number): void {
    const book = app.book;
    // Continue (or finish) a page drag.
    if (this.pageDragHand === h) {
      const x = this.pageDragX(hand);
      if (hand.select.held && book.isDragging) {
        // At most 1/30 s per frame counts toward "quick tap": a single
        // hitch frame (or a slow emulator) must not turn a tap into a drag.
        this.pageDragTime += Math.min(dt, 1 / 30);
        this.pageDragMoved = Math.max(this.pageDragMoved, Math.abs(x - this.pageDragStartX) * book.scale);
        book.dragTo(this.relativeDragX(x));
      } else {
        // Quick tap on a page = flip it; a real drag decides by halfway.
        if (isQuickTap(this.pageDragTime, this.pageDragMoved)) book.completeDrag();
        else book.endDrag();
        this.pageDragHand = null;
      }
      return;
    }
    const s = this.state;
    const heldByThis = s.kind === 'held' && s.hand === h;
    const heldByOther = s.kind === 'held' && s.hand !== h;
    if (heldByThis) {
      // The holding hand's presses never change the hold (or grab pages).
      if (hand.grab.pressed || hand.select.pressed) hand.consumePress();
      return;
    }

    // One decision per fresh press (see page-grab.ts for the rules).
    // SELECT (trigger/pinch) and GRAB fire on the same frame for a trigger
    // press; squeeze only fires GRAB.
    const fine = hand.select.pressed && !hand.select.consumed;
    const coarse = hand.grab.pressed && !hand.grab.consumed;
    if (!fine && !coarse) return;
    const via: PressSource = fine ? hand.select.via : hand.grab.via;
    const page = s.kind === 'resting' || s.kind === 'held' ? this.pageTarget(hand) : null;
    const near = this.isNear(hand);
    const onBook = near || this.rayHitsBook(hand);
    const intent = decidePress({ via, heldByThis, heldByOther, onPage: page !== null, onBook });
    if (intent === 'pageGrab' && page && book.beginDrag(page.side)) {
      this.pageDragHand = h;
      this.pageDragByRay = page.byRay;
      this.pageDragTime = 0;
      this.pageDragMoved = 0;
      this.pageDragDir = page.side;
      // For a ray drag, measure the start on the same plane the drag uses.
      const startX = page.byRay && this.rayInModel(hand) ? (rayDragX(rayO, rayD, book.surface) ?? page.x) : page.x;
      this.pageDragStartX = this.pageDragLastX = startX;
      book.dragTo(this.relativeDragX(startX));
    } else if (intent === 'pickUp') {
      this.grab(h, hand, near, via);
    }
    // Handled either way: a trigger on a page that can't turn (first/last
    // page) or a trigger next to a held book must NOT fall through to a grab.
    hand.consumePress();
  }

  /**
   * Is this hand at a page (grab point within a few cm of it) or aiming its
   * ray at one? Returns the side (+1 right = forward, -1 left = back) and
   * the model-space x where it touches.
   */
  private pageTarget(hand: HandState): { side: 1 | -1; x: number; byRay: boolean } | null {
    const book = app.book;
    const sf = book.surface;
    const p = book.toModel(hand.grabPoint, local);
    const nearSide = nearPageSide(p, sf, book.scale);
    if (nearSide !== 0) return { side: nearSide, x: p.x, byRay: false };
    // Pinch/grip is on the cover, spine, or edge. The pointing ray would
    // otherwise go through the hand and hit a page underneath.
    if (this.isNear(hand, 0.01)) return null;
    if (!this.rayInModel(hand)) return null;
    const hit = rayPageHit(rayO, rayD, sf);
    if (!hit || hit.t * book.scale > RAY_GRAB_DISTANCE) return null;
    return { side: hit.x > 0 ? 1 : -1, x: hit.x, byRay: true };
  }

  /**
   * The page you grab starts flat, wherever on it you grabbed: only MOVING
   * your hand toward the other side lifts it. Grabbed at startX, the page
   * is fully turned when your hand reaches the far edge of the spread.
   * Returns the x for Book.dragTo (which maps x = +w -> lying right,
   * x = -w -> lying left).
   */
  private relativeDragX(x: number): number {
    const w = app.book.surface.halfWidth;
    const x0 = clamp(this.pageDragStartX, -w * 0.98, w * 0.98);
    // leafP: 0 = page lying on the right, 1 = lying on the left.
    const p =
      this.pageDragDir === 1
        ? clamp((x0 - x) / (x0 + w), 0, 1) // right page: drag it leftward
        : 1 - clamp((x - x0) / (w - x0), 0, 1); // left page: drag it rightward
    return w - 2 * w * p;
  }

  /** Model-space x of the hand during a page drag (hand position, or where the ray points). */
  private pageDragX(hand: HandState): number {
    const book = app.book;
    if (!this.pageDragByRay) return book.toModel(hand.grabPoint, local).x;
    if (this.rayInModel(hand)) {
      const x = rayDragX(rayO, rayD, book.surface);
      if (x !== null) this.pageDragLastX = x;
    }
    return this.pageDragLastX;
  }

  /** The hand's pointing ray in book MODEL space -> rayO / rayD. */
  private rayInModel(hand: HandState): boolean {
    if (!hand.rayValid) return false;
    const model = app.book.model;
    model.updateWorldMatrix(true, false);
    model.worldToLocal(rayO.copy(hand.rayOrigin));
    model.worldToLocal(rayD.copy(hand.rayOrigin).add(hand.rayDirection)).sub(rayO).normalize();
    return true;
  }

  /** Is the hand's grab point inside (or within `marginM` meters of) the book's box? */
  private isNear(hand: HandState, marginM = NEAR_GRAB_MARGIN): boolean {
    const book = app.book;
    const hit = book.hitMesh;
    const p = book.toModel(hand.grabPoint, local).sub(hit.position);
    const margin = marginM / book.scale; // world meters -> model units
    return (
      Math.abs(p.x) < hit.scale.x / 2 + margin &&
      Math.abs(p.y) < hit.scale.y / 2 + margin &&
      Math.abs(p.z) < hit.scale.z / 2 + margin
    );
  }

  private rayHitsBook(hand: HandState): boolean {
    if (!hand.rayValid) return false;
    raycaster.set(hand.rayOrigin, hand.rayDirection);
    raycaster.far = RAY_GRAB_DISTANCE;
    return raycaster.intersectObject(app.book.hitMesh, false).length > 0;
  }

  /**
   * Put the book in hand `h`.
   *  near = true: keep the book exactly where it is relative to the hand.
   *  near = false (ray grab from afar): it flies into the hand and ends in
   *  the default IN_HAND_OFFSET pose.
   */
  private grab(h: Handedness, hand: HandState, near: boolean, via: PressSource): void {
    if (this.pageDragHand) {
      app.book.endDrag();
      this.pageDragHand = null;
    }
    const root = app.book.root;
    this.world.scene.attach(root); // hold it in WORLD space (keeps its pose)
    root.updateMatrixWorld();
    const offset = new Matrix4();
    if (near) {
      // offset = inverse(hand) * book  -> later: book = hand * offset
      this.handMatrix(hand, m1);
      offset.copy(m1).invert().multiply(root.matrixWorld);
    } else if (hand.kind === 'hand' && hand.palmValid) {
      // Right-hand thumb is +X in the palm frame, left-hand thumb is −X
      // (palm-frame.ts), so `side` moves the book toward the thumb on both.
      const side = h === 'right' ? 1 : -1;
      offset.compose(
        local.set(side * PALM_OFFSET.x, PALM_OFFSET.y, PALM_OFFSET.z),
        quat.setFromEuler(new Euler(PALM_OFFSET.tiltX, 0, 0)),
        ONE,
      );
    } else {
      const side = h === 'left' ? 1 : -1;
      offset.compose(
        local.set(side * IN_HAND_OFFSET.x, IN_HAND_OFFSET.y, IN_HAND_OFFSET.z),
        quat.setFromEuler(new Euler(IN_HAND_OFFSET.tiltX, 0, 0)),
        ONE,
      );
    }
    this.fromPos.copy(root.position);
    this.fromQuat.copy(root.quaternion);
    this.state = { kind: 'held', hand: h, offset, arrive: near ? 1 : 0, lostFor: 0, via };
    this.trackedValid = false;
  }

  /** Let go: onto the desk if you're over it, otherwise fall. */
  private release(): void {
    const root = app.book.root;
    root.updateMatrixWorld();
    const desk = app.room.desk;
    desk.top.worldToLocal(local.copy(root.position));
    const overDesk =
      Math.abs(local.x) < desk.halfW + DESK_SNAP_MARGIN &&
      Math.abs(local.z) < desk.halfD + DESK_SNAP_MARGIN &&
      local.y > -0.05 &&
      local.y < DESK_SNAP_HEIGHT;
    if (overDesk) {
      // Keep the book's center on the desk top (it may be a bit off the edge).
      local.x = clamp(local.x, -desk.halfW + 0.08, desk.halfW - 0.08);
      local.z = clamp(local.z, -desk.halfD + 0.06, desk.halfD - 0.03);
      desk.top.localToWorld(pos.copy(local));
      this.updateDeskSurface();
      // Face up so it stays OPEN and readable; heading stays as you held it.
      restPose(this.deskSurface, app.book.localBounds(bounds), pos, root.quaternion, pos, quat, true);
      this.startSettle('desk', desk.top, pos, quat, 0.25);
    } else {
      // Measure the book once now; it doesn't change size while falling.
      app.book.localBounds(bounds);
      this.body.start(root.position, root.quaternion, this.velocity, this.spin);
      this.state = { kind: 'falling' };
    }
  }

  /**
   * World matrix the book is parented to. Tracked hands use the palm frame
   * so a near grab pivots in the palm, not around the wrist. Controllers
   * keep the grip pose.
   */
  private handMatrix(hand: HandState, out: Matrix4): Matrix4 {
    if (hand.kind === 'hand' && hand.palmValid) {
      return out.compose(hand.palmPosition, hand.palmQuaternion, ONE);
    }
    return out.compose(hand.gripPosition, hand.gripQuaternion, ONE);
  }

  // ------------------------------------------------------------------
  // State machine
  // ------------------------------------------------------------------

  private updateState(dt: number): void {
    const root = app.book.root;
    const s = this.state;
    if (s.kind === 'held') {
      const hand = actions.hands[s.hand];
      // Let go = the button that picked the book up is released (pressing
      // or releasing the OTHER buttons on this hand changes nothing).
      if (!sourceDown(hand, s.via) && hand.gripValid) {
        this.release();
        return;
      }
      if (!hand.gripValid) {
        // Hand/controller lost (put down, out of view): don't leave the
        // book floating in mid-air forever.
        s.lostFor += dt;
        if (s.lostFor > LOST_HAND_SECONDS) this.bringBack();
        return;
      }
      s.lostFor = 0;
      // Target pose = hand * offset.
      m2.multiplyMatrices(this.handMatrix(hand, m1), s.offset);
      m2.decompose(pos, quat, scl);
      if (s.arrive < 1) {
        // Flying into the hand: glide from where it was.
        s.arrive = Math.min(1, s.arrive + dt / FLY_TO_HAND_SECONDS);
        const k = ease(s.arrive);
        pos.lerpVectors(this.fromPos, pos, k);
        quat.slerpQuaternions(this.fromQuat, quat, k);
        root.position.copy(pos);
        root.quaternion.copy(quat);
      } else if (hand.kind === 'hand') {
        // Tracked hands jitter a little: smooth lightly (frame-rate independent).
        const a = 1 - Math.exp(-dt * 30);
        root.position.lerp(pos, a);
        root.quaternion.slerp(quat, a);
      } else {
        root.position.copy(pos);
        root.quaternion.copy(quat);
      }
      this.trackVelocity(dt);
    } else if (s.kind === 'falling') {
      this.updateDeskSurface();
      this.floor.point.set(0, app.room.area.position.y, 0);
      for (const ts of this.tableSurfaces) {
        app.room.area.localToWorld(ts.point.set(ts.table.x, ts.table.y, ts.table.z));
      }
      const landed = this.body.step(
        dt,
        bounds, // measured in release()
        [this.deskSurface, ...this.tableSurfaces, this.floor],
        (p, v) => this.clampToWalls(p, v),
      );
      root.position.copy(this.body.position);
      root.quaternion.copy(this.body.quaternion);
      if (landed) {
        restPose(landed, bounds, root.position, root.quaternion, pos, quat);
        if (landed.kind === 'desk') this.startSettle('desk', app.room.desk.top, pos, quat, 0.2);
        else if (landed === this.floor) this.startSettle('floor', app.room.area, pos, quat, 0.2);
        else this.startSettle('table', app.room.area, pos, quat, 0.2);
      } else if (this.body.age > 8) {
        this.bringBack(); // safety net: something went wrong, fetch it
      }
    } else if (s.kind === 'settling') {
      s.t = Math.min(1, s.t + dt / s.duration);
      const k = ease(s.t);
      // Target in world space (the desk may move while we glide).
      s.parent.updateWorldMatrix(true, false);
      pos.copy(s.toPos).applyMatrix4(s.parent.matrixWorld);
      s.parent.getWorldQuaternion(quat).multiply(s.toQuat);
      root.position.lerpVectors(this.fromPos, pos, k);
      root.quaternion.slerpQuaternions(this.fromQuat, quat, k);
      if (s.t >= 1) {
        // Arrived: become a child of the desk top / room, exact local pose.
        s.parent.add(root);
        root.position.copy(s.toPos);
        root.quaternion.copy(s.toQuat);
        this.state = { kind: 'resting', on: s.on };
      }
    }
  }

  /** Begin a glide to a WORLD pose, ending as a child of `parent`. */
  private startSettle(
    on: 'desk' | 'floor' | 'table',
    parent: Object3D,
    worldPos: Vector3,
    worldQuat: Quaternion,
    duration: number,
  ): void {
    const root = app.book.root;
    this.world.scene.attach(root); // glide in world space
    this.fromPos.copy(root.position);
    this.fromQuat.copy(root.quaternion);
    parent.updateWorldMatrix(true, false);
    const toPos = parent.worldToLocal(worldPos.clone());
    const toQuat = parent.getWorldQuaternion(new Quaternion()).invert().multiply(worldQuat);
    this.state = { kind: 'settling', on, parent, toPos, toQuat, t: 0, duration };
  }

  /** Smoothed velocity/spin of the held book, used when you let go (throw). */
  private trackVelocity(dt: number): void {
    const root = app.book.root;
    if (this.trackedValid && dt > 0) {
      vInst.subVectors(root.position, prevPos).divideScalar(dt);
      this.velocity.lerp(vInst, 0.4);
      // Rotation since last frame -> axis * angle / dt
      qDelta.copy(root.quaternion).multiply(prevQuat.invert());
      if (qDelta.w < 0) qDelta.set(-qDelta.x, -qDelta.y, -qDelta.z, -qDelta.w);
      const angle = 2 * Math.acos(Math.min(1, qDelta.w));
      const sinHalf = Math.sqrt(Math.max(0, 1 - qDelta.w * qDelta.w));
      if (sinHalf > 1e-5) {
        vInst.set(qDelta.x, qDelta.y, qDelta.z).divideScalar(sinHalf).multiplyScalar(angle / dt);
        this.spin.lerp(vInst, 0.4);
      }
    } else {
      this.velocity.set(0, 0, 0);
      this.spin.set(0, 0, 0);
    }
    prevPos.copy(root.position);
    prevQuat.copy(root.quaternion);
    this.trackedValid = true;
  }

  private updateDeskSurface(): void {
    const top = app.room.desk.top;
    top.updateWorldMatrix(true, false);
    top.getWorldPosition(this.deskSurface.point);
    this.deskSurface.normal.copy(UP).applyQuaternion(top.getWorldQuaternion(quat));
  }

  /** Keep the falling book inside the room (walls + ceiling). */
  private clampToWalls(p: Vector3, v: Vector3): void {
    const area = app.room.area;
    area.updateWorldMatrix(true, false);
    area.worldToLocal(local.copy(p));
    // Velocity in room space (the room is only turned around y).
    const inv = area.getWorldQuaternion(quat).invert();
    vInst.copy(v).applyQuaternion(inv);
    const r = 0.12; // ~half the book
    const bounce = (min: number, max: number, axis: 'x' | 'y' | 'z') => {
      if (local[axis] < min) {
        local[axis] = min;
        vInst[axis] = Math.abs(vInst[axis]) * 0.3;
      } else if (local[axis] > max) {
        local[axis] = max;
        vInst[axis] = -Math.abs(vInst[axis]) * 0.3;
      }
    };
    const b = app.room.bounds;
    bounce(b.minX + r, b.maxX - r, 'x');
    bounce(b.minZ + r, b.maxZ - r, 'z');
    bounce(-10, b.height - r, 'y');
    area.localToWorld(p.copy(local));
    v.copy(vInst).applyQuaternion(inv.invert());
  }

  // ------------------------------------------------------------------
  // Home / bring back / re-seat
  // ------------------------------------------------------------------

  /** Desk "home" pose in desk-top space: centered, flat, open, facing you. */
  private homeLocal(outPos: Vector3, outQuat: Quaternion): void {
    outQuat.copy(DESK_HOME_QUAT);
    const lift = -lowestAlong(app.book.localBounds(bounds), outQuat, UP);
    outPos.copy(app.room.desk.bookHome.position).addScaledVector(UP, lift);
  }

  /** Instantly put the book at its desk home (startup, leaving VR while held). */
  private placeAtHomeNow(): void {
    const root = app.book.root;
    this.homeLocal(pos, quat);
    app.room.desk.top.add(root);
    root.position.copy(pos);
    root.quaternion.copy(quat);
    this.state = { kind: 'resting', on: 'desk' };
  }

  /** "Bring book back": glide from wherever it is back onto the desk. */
  bringBack(): void {
    if (this.pageDragHand) {
      app.book.endDrag();
      this.pageDragHand = null;
    }
    const top = app.room.desk.top;
    this.homeLocal(pos, quat);
    top.updateWorldMatrix(true, false);
    pos.applyMatrix4(top.matrixWorld);
    quat.premultiply(top.getWorldQuaternion(startQuat));
    startPos.copy(pos);
    this.startSettle('desk', top, startPos, quat, 0.5);
  }

  /** Leaving VR while holding the book: park it on the desk (no hands in 2D). */
  private onSessionEnd(): void {
    const s = this.state;
    if (s.kind === 'held' || s.kind === 'falling' || s.kind === 'settling') this.placeAtHomeNow();
  }

  /** Book on the floor, or out of reach of your seat? */
  private isOnFloorOrFar(): boolean {
    const s = this.state;
    if (s.kind === 'held') return false;
    if (s.kind === 'resting' && s.on === 'floor') return true;
    app.book.root.getWorldPosition(pos);
    app.room.area.worldToLocal(pos);
    return Math.hypot(pos.x, pos.z) > OUT_OF_REACH;
  }

  /**
   * The book changed size/thickness while resting: keep its spot and
   * heading, but lift/lower it so it sits exactly on its surface again.
   */
  reRest(): void {
    const s = this.state;
    if (s.kind !== 'resting') return;
    const root = app.book.root;
    root.updateWorldMatrix(true, false);
    root.getWorldPosition(pos);
    root.getWorldQuaternion(quat);
    let surface: Surface = this.floor;
    let parent: Object3D = app.room.area;
    if (s.on === 'table') {
      // Find the table under the book (fall back to the floor if none).
      const ts = this.tableSurfaces.find((t) => t.contains(pos));
      if (ts) {
        app.room.area.localToWorld(ts.point.set(ts.table.x, ts.table.y, ts.table.z));
        surface = ts;
      }
    } else if (s.on === 'desk') {
      this.updateDeskSurface();
      surface = this.deskSurface;
      parent = app.room.desk.top;
    }
    if (surface === this.floor) this.floor.point.set(0, app.room.area.position.y, 0);
    restPose(surface, app.book.localBounds(bounds), pos, quat, pos, quat, s.on === 'desk');
    parent.updateWorldMatrix(true, false);
    root.position.copy(parent.worldToLocal(pos));
    root.quaternion.copy(parent.getWorldQuaternion(startQuat).invert().multiply(quat));
  }
}

/** Is the physical input that started a press still down? */
function sourceDown(hand: HandState, via: PressSource): boolean {
  if (via === 'squeeze') return hand.squeezeDown;
  if (via === 'trigger') return hand.triggerDown;
  if (via === 'pinch') return hand.pinchDown;
  return hand.grab.held;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
