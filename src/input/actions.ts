/**
 * ACTIONS — the per-frame "what does the user want?" snapshot.
 *
 * InputLayerSystem (input-layer-system.ts) fills this object once per frame
 * from controllers, hands and the keyboard. Every other system only READS it.
 *
 * Plain mutable objects + reused Vector3s are used on purpose: allocating new
 * objects every frame (72-90 times per second) causes garbage-collection
 * hiccups, which show up as dropped frames in a headset.
 */
import { Object3D, Quaternion, Vector3 } from '@iwsdk/core';

export type Handedness = 'left' | 'right';
export type SourceKind = 'none' | 'controller' | 'hand';

/** A button-like action with "edges" (the frame it went down / up). */
export class ButtonAction {
  /** True every frame while held. */
  held = false;
  /** True only on the first frame it is held. */
  pressed = false;
  /** True only on the frame it is let go. */
  released = false;
  /**
   * A system that handled `pressed` sets this so later systems ignore it.
   * Example: pinching a menu button should not ALSO grab the book behind it.
   */
  consumed = false;
}

/** Everything we know about one hand (or the controller held in it). */
export class HandState {
  kind: SourceKind = 'none';
  /** Is this hand/controller tracked this frame? */
  tracked = false;

  /** Palm pose: where a held book attaches. */
  readonly gripPosition = new Vector3();
  readonly gripQuaternion = new Quaternion();
  gripValid = false;

  /** Where a grab happens: controller grip, or the pinch point between fingers. */
  readonly grabPoint = new Vector3();

  /** Pointing ray (controller laser / hand "pinch ray"), for far UI and grabs. */
  readonly rayOrigin = new Vector3();
  readonly rayDirection = new Vector3(0, 0, -1);
  rayValid = false;

  /** Index fingertip (hands only) for poking buttons. */
  readonly indexTip = new Vector3();
  indexTipValid = false;

  /** The GRAB action for this hand. */
  readonly grab = new ButtonAction();

  constructor(readonly handedness: Handedness) {}
}

/**
 * A rectangle in some object's local XY plane where a sideways fingertip
 * swipe counts as "turn the page". The book system registers its page area.
 */
export interface SwipeZone {
  object: Object3D;
  halfWidth: number;
  halfHeight: number;
  /** How far in front/behind the plane (local z) the fingertip may be. */
  maxDistance: number;
  /** Which hands may swipe (e.g. not the hand holding the book). */
  allowLeft: boolean;
  allowRight: boolean;
}

export const actions = {
  hands: {
    left: new HandState('left'),
    right: new HandState('right'),
  } as Record<Handedness, HandState>,
  /** +1 = next page, -1 = previous page, 0 = nothing this frame. */
  turnPage: 0 as -1 | 0 | 1,
  /** True for one frame when the menu should open/close. */
  toggleMenu: false,
  /** True for one frame when the play area should re-center. */
  recenter: false,
  /** Set by the book system; read by the swipe detector. */
  swipeZone: null as SwipeZone | null,
};

export function otherHand(h: Handedness): Handedness {
  return h === 'left' ? 'right' : 'left';
}
