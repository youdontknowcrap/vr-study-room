/**
 * BookSystem — connects input ACTIONS to the Book.
 *
 *  Book on a hand ("Book: Left/Right hand" in the menu):
 *    - the book follows that hand's palm, tilted to face your eyes;
 *    - the OTHER hand turns pages: thumbstick flick, grab-and-drag a page,
 *      or (hands) a sideways swipe over the page.
 *  Book on desk ("Book: On desk"):
 *    - grab near the SPINE / cover (or point + grab from afar) to move it;
 *    - grab near a page's outer EDGE to drag that page over.
 *  Always: turnPage action (stick flick, swipe, arrow keys) turns pages;
 *  recenter action puts the desk in front of you.
 */
import { createSystem, Matrix4, Quaternion, Raycaster, Vector3 } from '@iwsdk/core';
import { actions, type Handedness, type HandState } from '../input/actions.js';
import { app } from '../app.js';
import { bookHand } from '../settings.js';

// scratch objects
const m1 = new Matrix4();
const m2 = new Matrix4();
const local = new Vector3();
const headPos = new Vector3();
const target = new Vector3();
const targetQuat = new Quaternion();
const up = new Vector3(0, 1, 0);
const right = new Vector3();
const ONE = new Vector3(1, 1, 1);
const raycaster = new Raycaster();

/** Outer part of each page (fraction of page width) that starts a page drag. */
const EDGE_ZONE = 0.45;

type GrabMode =
  | { kind: 'move'; offset: Matrix4 } // carrying the book
  | { kind: 'page' }; // dragging a page

export class BookSystem extends createSystem({}) {
  private grabs: Record<Handedness, GrabMode | null> = { left: null, right: null };
  private wasInXR = false;

  init(): void {
    const book = app.book;
    this.world.scene.add(book.root);
    this.putOnDesk();
    // Changing the book hand drops anything currently held.
    this.cleanupFuncs.push(
      bookHand.subscribe(() => {
        this.grabs = { left: null, right: null };
        if (bookHand.value === 'desk') this.putOnDesk();
      }),
    );
  }

  update(delta: number): void {
    const book = app.book;

    // 1) Recenter: automatically when entering VR, or on request.
    const inXR = !!this.world.session;
    if ((inXR && !this.wasInXR && this.world.xrFrame) || actions.recenter) {
      app.room.recenter(this.world.camera);
      if (!this.bookIsHeld()) this.putOnDesk();
    }
    if (this.world.xrFrame || !inXR) this.wasInXR = inXR;

    // 2) Which hand (if any) holds the book?
    const holderName = bookHand.value === 'desk' ? null : bookHand.value;
    const holder = holderName ? actions.hands[holderName] : null;
    const attached = !!holder && holder.gripValid;
    if (attached) this.followHand(holder!, delta);

    // Tell the swipe detector where the pages are and which hands may swipe.
    actions.swipeZone = {
      object: book.root,
      halfWidth: book.pageWidth,
      halfHeight: book.pageHeight / 2,
      maxDistance: 0.06,
      allowLeft: !(attached && holderName === 'left'),
      allowRight: !(attached && holderName === 'right'),
    };

    // 3) Page-turn pulses (thumbstick, swipe, arrow keys, menu).
    if (actions.turnPage !== 0) book.turnPage(actions.turnPage);

    // 4) Grabs, per hand.
    for (const h of ['left', 'right'] as const) {
      if (attached && h === holderName) continue; // this hand is holding the book
      this.handleGrab(h, actions.hands[h], attached);
    }

    book.update(delta);
  }

  private bookIsHeld(): boolean {
    return (
      this.grabs.left?.kind === 'move' ||
      this.grabs.right?.kind === 'move' ||
      (bookHand.value !== 'desk' && actions.hands[bookHand.value].gripValid)
    );
  }

  private putOnDesk(): void {
    const anchor = app.room.bookAnchor;
    anchor.updateWorldMatrix(true, false);
    anchor.matrixWorld.decompose(app.book.root.position, app.book.root.quaternion, target);
  }

  /** Hold the book above the palm, turned toward your eyes (like reading). */
  private followHand(hand: HandState, delta: number): void {
    const root = app.book.root;
    this.world.camera.getWorldPosition(headPos);
    // Put the book ~10 cm above the palm and a bit toward the body's center
    // line, so the whole spread (not just one page) sits over your hand.
    const side = hand.handedness === 'left' ? 1 : -1;
    target.copy(hand.gripPosition);
    target.y += 0.1;
    // offset sideways (toward the other hand), in the head's horizontal frame
    local.subVectors(target, headPos).setY(0).normalize(); // forward
    right.crossVectors(local, up).normalize();
    target.addScaledVector(right, side * 0.06);

    // Orientation: book's +z (its page side) faces the eyes; y stays "up-ish".
    m1.lookAt(headPos, target, up); // Matrix4.lookAt(eye, target, up) -> z axis = eye - target
    targetQuat.setFromRotationMatrix(m1);

    // Smooth a little to hide tracking jitter (frame-rate independent).
    const alpha = 1 - Math.exp(-delta * 20);
    root.position.lerp(target, alpha);
    root.quaternion.slerp(targetQuat, alpha);
  }

  private handleGrab(h: Handedness, hand: HandState, attached: boolean): void {
    const book = app.book;
    const grab = hand.grab;
    const current = this.grabs[h];

    if (grab.pressed && !grab.consumed && !current) {
      book.root.updateMatrixWorld();
      local.copy(hand.grabPoint);
      book.root.worldToLocal(local);
      const w = book.pageWidth;
      const nearPages =
        Math.abs(local.x) < w * 1.1 &&
        Math.abs(local.y) < book.pageHeight * 0.6 &&
        Math.abs(local.z) < 0.08;
      const onEdge = Math.abs(local.x) > w * (1 - EDGE_ZONE);

      if (nearPages && (attached || onEdge)) {
        // Page drag: right half -> forward, left half -> backward.
        if (book.beginDrag(local.x > 0 ? 1 : -1)) {
          this.grabs[h] = { kind: 'page' };
          grab.consumed = true;
        }
      } else if (!attached && (nearPages || this.rayHitsBook(hand))) {
        // Carry the book: remember the book pose RELATIVE to the hand, then
        // every frame set  book = hand * offset.
        this.handMatrix(hand, m1);
        this.grabs[h] = {
          kind: 'move',
          offset: new Matrix4().copy(m1).invert().multiply(book.root.matrixWorld),
        };
        grab.consumed = true;
      }
    }

    const g = this.grabs[h];
    if (!g) return;
    if (grab.held) {
      if (g.kind === 'page') {
        local.copy(hand.grabPoint);
        book.root.worldToLocal(local);
        book.dragTo(local.x);
      } else {
        this.handMatrix(hand, m1);
        m2.multiplyMatrices(m1, g.offset);
        m2.decompose(book.root.position, book.root.quaternion, target);
      }
    } else {
      if (g.kind === 'page') book.endDrag();
      this.grabs[h] = null;
    }
  }

  /** World matrix of the "grabbing pose": grab point + palm rotation. */
  private handMatrix(hand: HandState, out: Matrix4): void {
    out.compose(hand.grabPoint, hand.gripQuaternion, ONE);
  }

  private rayHitsBook(hand: HandState): boolean {
    if (!hand.rayValid) return false;
    raycaster.set(hand.rayOrigin, hand.rayDirection);
    raycaster.far = 3;
    return raycaster.intersectObject(app.book.hitMesh, false).length > 0;
  }
}
