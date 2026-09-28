/**
 * InputLayerSystem — reads raw WebXR input + keyboard every frame and turns
 * it into the high-level `actions` object (see actions.ts / bindings.ts).
 *
 * How WebXR input works (the 30-second version)
 * ---------------------------------------------
 * - An XR session has a list of `inputSources`: one per controller OR per
 *   tracked hand (Quest switches between them automatically if enabled).
 * - Each source has `handedness` ('left'/'right') and some "spaces":
 *     gripSpace      -> where the palm is
 *     targetRaySpace -> a pointing ray (the laser)
 * - Controllers have a `gamepad` (buttons + thumbstick axes).
 * - Tracked hands have a `hand` with 25 joints (fingertips, knuckles, wrist).
 * - To get an actual position you ask the current XRFrame for a "pose" of a
 *   space, relative to a reference space (IWSDK uses 'local-floor': y = 0 is
 *   your real floor).
 */
import { createSystem, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import {
  actions,
  type ButtonAction,
  type Handedness,
  type HandState,
} from './actions.js';
import { isBound, TUNING } from './bindings.js';

// ---- Scratch objects, reused every frame (no per-frame allocation) ----
const tmpVec = new Vector3();
const tmpQuat = new Quaternion();
const tmpMat = new Matrix4();
const playerQuat = new Quaternion();
const thumbTip = new Vector3();

/** Per-hand memory that must survive between frames. */
interface HandMemory {
  grabHeld: boolean; // grab state last frame (to detect edges)
  pinching: boolean; // hysteresis state for pinch
  stickArmed: boolean; // thumbstick must return to center before next flick
  prevBY: boolean; // B/Y button last frame
  prevStickPress: boolean;
  swipePrevX: number; // fingertip x (in swipe zone space) last frame
  swipePrevValid: boolean;
}
const memory: Record<Handedness, HandMemory> = {
  left: freshMemory(),
  right: freshMemory(),
};
function freshMemory(): HandMemory {
  return {
    grabHeld: false,
    pinching: false,
    stickArmed: true,
    prevBY: false,
    prevStickPress: false,
    swipePrevX: 0,
    swipePrevValid: false,
  };
}

let swipeCooldown = 0;
let frameDelta = 1 / 72;

export class InputLayerSystem extends createSystem({}) {
  update(delta: number): void {
    // 1) Reset one-frame "pulse" actions.
    actions.turnPage = 0;
    actions.toggleMenu = false;
    actions.recenter = false;
    swipeCooldown = Math.max(0, swipeCooldown - delta);
    frameDelta = Math.max(delta, 1e-3);

    const rawGrab: Record<Handedness, boolean> = { left: false, right: false };
    for (const h of ['left', 'right'] as const) {
      const hand = actions.hands[h];
      hand.tracked = false;
      hand.gripValid = false;
      hand.rayValid = false;
      hand.indexTipValid = false;
      hand.kind = 'none';
    }

    // 2) Read XR input sources (only exists while in VR / emulator).
    const frame = this.world.xrFrame;
    const refSpace = this.world.xrReferenceSpace;
    const session = this.world.session;
    if (frame && refSpace && session) {
      // Poses come back in "tracking space". Our player rig might be moved
      // in the scene later (e.g. teleport), so convert to world space.
      const player = this.world.player;
      player.updateMatrixWorld();
      player.getWorldQuaternion(playerQuat);

      for (const source of session.inputSources) {
        const h = source.handedness;
        if (h !== 'left' && h !== 'right') continue;
        const hand = actions.hands[h];
        const mem = memory[h];

        // Pointing ray (both controllers and hands have one on Quest).
        const rayPose = frame.getPose(source.targetRaySpace, refSpace);
        if (rayPose) {
          this.poseToWorld(rayPose.transform, hand.rayOrigin, tmpQuat);
          hand.rayDirection.set(0, 0, -1).applyQuaternion(tmpQuat);
          hand.rayValid = true;
        }
        // Palm / grip pose.
        if (source.gripSpace) {
          const gripPose = frame.getPose(source.gripSpace, refSpace);
          if (gripPose) {
            this.poseToWorld(
              gripPose.transform,
              hand.gripPosition,
              hand.gripQuaternion,
            );
            hand.gripValid = true;
          }
        }

        if (source.hand) {
          hand.kind = 'hand';
          rawGrab[h] = this.readHand(frame, refSpace, source.hand, hand, mem);
        } else if (source.gamepad) {
          hand.kind = 'controller';
          rawGrab[h] = this.readController(source.gamepad, hand, mem);
        }
        hand.tracked = hand.gripValid || hand.rayValid;
      }
    }

    // 3) Keyboard (desktop testing). Codes are KeyboardEvent.code values.
    const kb = this.input.keyboard;
    if (isBound('turnPage', 'keyboard.arrows')) {
      if (kb.getKeyDown('ArrowRight')) actions.turnPage = 1;
      if (kb.getKeyDown('ArrowLeft')) actions.turnPage = -1;
    }
    if (isBound('toggleMenu', 'keyboard.m') && kb.getKeyDown('KeyM')) {
      actions.toggleMenu = true;
    }
    if (isBound('recenter', 'keyboard.r') && kb.getKeyDown('KeyR')) {
      actions.recenter = true;
    }

    // 4) Turn raw "is it held?" into held/pressed/released edges.
    for (const h of ['left', 'right'] as const) {
      updateButton(actions.hands[h].grab, rawGrab[h], memory[h]);
    }
  }

  /** Convert an XRRigidTransform (tracking space) into world position/rotation. */
  private poseToWorld(
    t: XRRigidTransform,
    outPos: Vector3,
    outQuat: Quaternion,
  ): void {
    outPos.set(t.position.x, t.position.y, t.position.z);
    outPos.applyMatrix4(this.world.player.matrixWorld);
    outQuat.set(
      t.orientation.x,
      t.orientation.y,
      t.orientation.z,
      t.orientation.w,
    );
    outQuat.premultiply(playerQuat);
  }

  /** Controller: buttons + thumbstick, following the xr-standard mapping. */
  private readController(
    gp: Gamepad,
    hand: HandState,
    mem: HandMemory,
  ): boolean {
    hand.grabPoint.copy(hand.gripValid ? hand.gripPosition : hand.rayOrigin);

    // Analog buttons with hysteresis: press above 0.6, release below 0.4.
    const threshold = mem.grabHeld ? TUNING.buttonRelease : TUNING.buttonPress;
    const trigger = gp.buttons[0]?.value ?? 0;
    const squeeze = gp.buttons[1]?.value ?? 0;
    let grab = false;
    if (isBound('grab', 'controller.trigger') && trigger > threshold) grab = true;
    if (isBound('grab', 'controller.squeeze') && squeeze > threshold) grab = true;

    // Thumbstick flick left/right -> turn page (edge-triggered).
    if (isBound('turnPage', 'controller.thumbstick')) {
      const x = gp.axes[2] ?? 0;
      if (mem.stickArmed && Math.abs(x) > TUNING.stickFlick) {
        actions.turnPage = x > 0 ? 1 : -1;
        mem.stickArmed = false;
      } else if (Math.abs(x) < TUNING.stickRearm) {
        mem.stickArmed = true;
      }
    }
    // B / Y face button -> menu.
    const by = gp.buttons[5]?.pressed ?? false;
    if (isBound('toggleMenu', 'controller.buttonBY') && by && !mem.prevBY) {
      actions.toggleMenu = true;
    }
    mem.prevBY = by;
    // Thumbstick click -> recenter.
    const stickPress = gp.buttons[3]?.pressed ?? false;
    if (
      isBound('recenter', 'controller.stickPress') &&
      stickPress &&
      !mem.prevStickPress
    ) {
      actions.recenter = true;
    }
    mem.prevStickPress = stickPress;
    return grab;
  }

  /** Tracked hand: pinch = grab, fingertip velocity over the page = swipe. */
  private readHand(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    xrHand: XRHand,
    hand: HandState,
    mem: HandMemory,
  ): boolean {
    const indexJoint = xrHand.get('index-finger-tip');
    const thumbJoint = xrHand.get('thumb-tip');
    const indexPose = indexJoint && frame.getJointPose?.(indexJoint, refSpace);
    const thumbPose = thumbJoint && frame.getJointPose?.(thumbJoint, refSpace);
    if (!indexPose || !thumbPose) {
      mem.swipePrevValid = false;
      return false;
    }
    this.poseToWorld(indexPose.transform, hand.indexTip, tmpQuat);
    this.poseToWorld(thumbPose.transform, thumbTip, tmpQuat);
    hand.indexTipValid = true;

    // If the browser gave no gripSpace for hands, fall back to the wrist joint.
    if (!hand.gripValid) {
      const wrist = xrHand.get('wrist');
      const wristPose = wrist && frame.getJointPose?.(wrist, refSpace);
      if (wristPose) {
        this.poseToWorld(
          wristPose.transform,
          hand.gripPosition,
          hand.gripQuaternion,
        );
        hand.gripValid = true;
      }
    }

    // Pinch detection with hysteresis (start close, end further apart).
    const gap = hand.indexTip.distanceTo(thumbTip);
    if (mem.pinching) mem.pinching = gap < TUNING.pinchEnd;
    else mem.pinching = gap < TUNING.pinchStart;
    // The grab point is halfway between thumb and index tips.
    hand.grabPoint.copy(hand.indexTip).add(thumbTip).multiplyScalar(0.5);

    // Swipe: only while NOT pinching, and only inside the book's swipe zone.
    this.detectSwipe(hand, mem);

    return isBound('grab', 'hand.pinch') && mem.pinching;
  }

  private detectSwipe(hand: HandState, mem: HandMemory): void {
    const zone = actions.swipeZone;
    const allowed =
      zone &&
      isBound('turnPage', 'hand.swipe') &&
      !mem.pinching &&
      (hand.handedness === 'left' ? zone.allowLeft : zone.allowRight);
    if (!zone || !allowed) {
      mem.swipePrevValid = false;
      return;
    }
    // Express the fingertip in the page's own coordinates.
    zone.object.updateWorldMatrix(true, false);
    tmpMat.copy(zone.object.matrixWorld).invert();
    tmpVec.copy(hand.indexTip).applyMatrix4(tmpMat);
    const inside =
      Math.abs(tmpVec.x) < zone.halfWidth &&
      Math.abs(tmpVec.y) < zone.halfHeight &&
      Math.abs(tmpVec.z) < zone.maxDistance;
    if (inside && mem.swipePrevValid && swipeCooldown === 0) {
      const vx = (tmpVec.x - mem.swipePrevX) / frameDelta;
      // Like a paper book: finger moving right-to-left = next page.
      if (vx < -TUNING.swipeSpeed) actions.turnPage = 1;
      else if (vx > TUNING.swipeSpeed) actions.turnPage = -1;
      if (actions.turnPage !== 0) swipeCooldown = TUNING.swipeCooldown;
    }
    mem.swipePrevX = tmpVec.x;
    mem.swipePrevValid = inside;
  }
}

function updateButton(
  button: ButtonAction,
  held: boolean,
  mem: HandMemory,
): void {
  button.pressed = held && !mem.grabHeld;
  button.released = !held && mem.grabHeld;
  button.held = held;
  button.consumed = false;
  mem.grabHeld = held;
}
