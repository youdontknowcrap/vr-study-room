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
import { palmFrame } from '../book/palm-frame.js';
import {
  actions,
  type ButtonAction,
  type Handedness,
  type HandState,
  type PressSource,
} from './actions.js';
import { isBound, TUNING } from './bindings.js';

// ---- Scratch objects, reused every frame (no per-frame allocation) ----
const tmpVec = new Vector3();
const tmpQuat = new Quaternion();
const tmpMat = new Matrix4();
const playerQuat = new Quaternion();
const thumbTip = new Vector3();
const jWrist = new Vector3();
const jIndex = new Vector3();
const jPinky = new Vector3();
const jMiddle = new Vector3();

/** Raw result of reading one hand this frame. */
interface RawPress {
  grab: PressSource; // 'none' or what is holding grab down
  select: PressSource;
}

/** Per-hand memory that must survive between frames. */
interface HandMemory {
  triggerHeld: boolean; // hysteresis state for the analog trigger
  squeezeHeld: boolean; // ...and for the analog grip
  pinching: boolean; // hysteresis state for pinch
  /** Seconds the fingertips have been missing while a pinch is still held. */
  pinchMiss: number;
  /** Smoothed palm pose. Reset when the hand leaves tracking. */
  palmPos: Vector3;
  palmQuat: Quaternion;
  palmInit: boolean;
  pokeArmed: boolean; // fingertip must leave the page edge before the next poke
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
    triggerHeld: false,
    squeezeHeld: false,
    pinching: false,
    pinchMiss: 0,
    palmPos: new Vector3(),
    palmQuat: new Quaternion(),
    palmInit: false,
    pokeArmed: true,
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
    actions.bringBookBack = false;
    swipeCooldown = Math.max(0, swipeCooldown - delta);
    frameDelta = Math.max(delta, 1e-3);

    const raw: Record<Handedness, RawPress> = {
      left: { grab: 'none', select: 'none' },
      right: { grab: 'none', select: 'none' },
    };
    for (const h of ['left', 'right'] as const) {
      const hand = actions.hands[h];
      hand.tracked = false;
      hand.gripValid = false;
      hand.rayValid = false;
      hand.palmValid = false;
      hand.indexTipValid = false;
      hand.kind = 'none';
      hand.squeezeDown = false;
      hand.triggerDown = false;
      hand.pinchDown = false;
    }

    // 2) Read XR input sources (only exists while in VR / emulator).
    const frame = this.world.xrFrame;
    const refSpace = this.world.xrReferenceSpace;
    const session = this.world.session;
    const seen = { left: false, right: false };
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
        seen[h] = true;

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
          const pinch = this.readHand(frame, refSpace, source.hand, source.gamepad ?? null, hand, mem);
          hand.pinchDown = pinch;
          if (pinch && isBound('grab', 'hand.pinch')) raw[h].grab = 'pinch';
          if (pinch && isBound('select', 'hand.pinch')) raw[h].select = 'pinch';
        } else if (source.gamepad) {
          hand.kind = 'controller';
          this.readController(source.gamepad, hand, mem, raw[h]);
        }
        hand.tracked = hand.gripValid || hand.rayValid;
      }
    }
    for (const h of ['left', 'right'] as const) {
      if (!seen[h]) memory[h].palmInit = false;
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
    if (isBound('bringBookBack', 'keyboard.b') && kb.getKeyDown('KeyB')) {
      actions.bringBookBack = true;
    }

    // 4) Turn raw "is it held?" into held/pressed/released edges.
    for (const h of ['left', 'right'] as const) {
      updateButton(actions.hands[h].grab, raw[h].grab);
      updateButton(actions.hands[h].select, raw[h].select);
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
    out: RawPress,
  ): void {
    hand.grabPoint.copy(hand.gripValid ? hand.gripPosition : hand.rayOrigin);

    // Analog buttons with hysteresis: press above 0.6, release below 0.4.
    // Each button keeps its own state so they don't disturb each other.
    const trigger = gp.buttons[0]?.value ?? 0;
    const squeeze = gp.buttons[1]?.value ?? 0;
    mem.triggerHeld =
      trigger > (mem.triggerHeld ? TUNING.buttonRelease : TUNING.buttonPress);
    mem.squeezeHeld =
      squeeze > (mem.squeezeHeld ? TUNING.buttonRelease : TUNING.buttonPress);
    hand.triggerDown = mem.triggerHeld;
    hand.squeezeDown = mem.squeezeHeld;
    // Squeeze wins if both are down: it is the "real" grab button.
    if (isBound('grab', 'controller.trigger') && mem.triggerHeld) out.grab = 'trigger';
    if (isBound('grab', 'controller.squeeze') && mem.squeezeHeld) out.grab = 'squeeze';
    if (isBound('select', 'controller.trigger') && mem.triggerHeld) out.select = 'trigger';

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
  }

  /**
   * Tracked hand: pinch = grab, fingertip velocity over the page = swipe.
   *
   * A pinch is the browser's select button (Quest's own pinch detector)
   * OR the fingertip gap. Either one is enough, so a browser that leaves
   * the button at 0 still works from the gap. If the fingertips drop out
   * for a frame — common when the fingers occlude each other — the pinch
   * stays down for `pinchGrace` instead of dropping the book.
   */
  private readHand(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    xrHand: XRHand,
    gamepad: Gamepad | null,
    hand: HandState,
    mem: HandMemory,
  ): boolean {
    // Wrist pose even when a fingertip is missing, so a one-frame blip
    // doesn't also invalidate the grip the book is parented to.
    if (!hand.gripValid) {
      const wrist = xrHand.get('wrist');
      const wristPose = wrist && frame.getJointPose?.(wrist, refSpace);
      if (wristPose) {
        this.poseToWorld(wristPose.transform, hand.gripPosition, hand.gripQuaternion);
        hand.gripValid = true;
      }
    }
    this.updatePalm(frame, refSpace, xrHand, hand, mem);

    const indexJoint = xrHand.get('index-finger-tip');
    const thumbJoint = xrHand.get('thumb-tip');
    const indexPose = indexJoint && frame.getJointPose?.(indexJoint, refSpace);
    const thumbPose = thumbJoint && frame.getJointPose?.(thumbJoint, refSpace);
    const tipsOk = !!(indexPose && thumbPose);
    if (tipsOk) {
      this.poseToWorld(indexPose.transform, hand.indexTip, tmpQuat);
      this.poseToWorld(thumbPose.transform, thumbTip, tmpQuat);
      hand.indexTipValid = true;
      hand.grabPoint.copy(hand.indexTip).add(thumbTip).multiplyScalar(0.5);
    } else {
      mem.swipePrevValid = false;
    }

    const button = gamepad?.buttons[0];
    const uaValue = button ? (button.value > 0 ? button.value : button.pressed ? 1 : 0) : 0;
    const uaPinch = uaValue > (mem.pinching ? TUNING.buttonRelease : TUNING.buttonPress);
    let gapPinch = false;
    if (tipsOk) {
      const gap = hand.indexTip.distanceTo(thumbTip);
      gapPinch = mem.pinching ? gap < TUNING.pinchEnd : gap < TUNING.pinchStart;
    }
    if (uaPinch || gapPinch) {
      mem.pinching = true;
      mem.pinchMiss = 0;
    } else if (mem.pinching && !tipsOk) {
      mem.pinchMiss += frameDelta;
      if (mem.pinchMiss > TUNING.pinchGrace) mem.pinching = false;
    } else {
      mem.pinching = false;
      mem.pinchMiss = 0;
    }

    // Swipe / poke: only while NOT pinching, and only inside the book's zone.
    this.detectSwipe(hand, mem);
    return mem.pinching;
  }

  /** Palm basis from the metacarpals, lightly smoothed so the book doesn't buzz. */
  private updatePalm(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    xrHand: XRHand,
    hand: HandState,
    mem: HandMemory,
  ): void {
    if (!this.jointPoint(frame, refSpace, xrHand, 'wrist', jWrist)) return;
    if (!this.jointPoint(frame, refSpace, xrHand, 'index-finger-metacarpal', jIndex)) return;
    if (!this.jointPoint(frame, refSpace, xrHand, 'pinky-finger-metacarpal', jPinky)) return;
    if (!this.jointPoint(frame, refSpace, xrHand, 'middle-finger-metacarpal', jMiddle)) return;
    const framePose = palmFrame(hand.handedness, jWrist, jIndex, jPinky, jMiddle);
    if (!framePose) return;
    tmpVec.set(framePose.position.x, framePose.position.y, framePose.position.z);
    tmpQuat.set(framePose.quaternion.x, framePose.quaternion.y, framePose.quaternion.z, framePose.quaternion.w);
    if (!mem.palmInit) {
      mem.palmPos.copy(tmpVec);
      mem.palmQuat.copy(tmpQuat);
      mem.palmInit = true;
    } else {
      const a = 1 - Math.exp(-frameDelta * 24);
      mem.palmPos.lerp(tmpVec, a);
      mem.palmQuat.slerp(tmpQuat, a);
    }
    hand.palmPosition.copy(mem.palmPos);
    hand.palmQuaternion.copy(mem.palmQuat);
    hand.palmValid = true;
  }

  /** World position of one joint, or null. Reuses `out` only for the result. */
  private jointPoint(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    xrHand: XRHand,
    name: XRHandJoint,
    out: Vector3,
  ): Vector3 | null {
    const joint = xrHand.get(name);
    const pose = joint && frame.getJointPose?.(joint, refSpace);
    if (!pose) return null;
    this.poseToWorld(pose.transform, out, tmpQuat);
    return out;
  }

  /**
   * Two hand gestures over the page area of the book:
   *  - SWIPE: fingertip moves sideways fast (like flicking a page).
   *  - POKE: fingertip touches the OUTER edge of a page (right edge = next).
   * Both share one cooldown so a swipe that starts on an edge only turns once.
   */
  private detectSwipe(hand: HandState, mem: HandMemory): void {
    const zone = actions.swipeZone;
    const swipeOn = isBound('turnPage', 'hand.swipe');
    const pokeOn = isBound('turnPage', 'hand.poke');
    const allowed =
      zone &&
      (swipeOn || pokeOn) &&
      !mem.pinching &&
      (hand.handedness === 'left' ? zone.allowLeft : zone.allowRight);
    if (!zone || !allowed) {
      mem.swipePrevValid = false;
      mem.pokeArmed = true;
      return;
    }
    // Express the fingertip in the book's own coordinates.
    zone.object.updateWorldMatrix(true, false);
    tmpMat.copy(zone.object.matrixWorld).invert();
    tmpVec.copy(hand.indexTip).applyMatrix4(tmpMat);
    // Height above the (V-shaped) page surface at this x.
    const aboveSurface = tmpVec.z - (Math.abs(tmpVec.x) * zone.slope + zone.baseZ);
    const overPage =
      Math.abs(tmpVec.x) < zone.halfWidth && Math.abs(tmpVec.y) < zone.halfHeight;
    const inside = overPage && Math.abs(aboveSurface) < zone.maxDistance;

    if (swipeOn && inside && mem.swipePrevValid && swipeCooldown === 0) {
      const vx = (tmpVec.x - mem.swipePrevX) / frameDelta;
      // Like a paper book: finger moving right-to-left = next page.
      if (vx < -TUNING.swipeSpeed) actions.turnPage = 1;
      else if (vx > TUNING.swipeSpeed) actions.turnPage = -1;
      if (actions.turnPage !== 0) swipeCooldown = TUNING.swipeCooldown;
    }
    mem.swipePrevX = tmpVec.x;
    mem.swipePrevValid = inside;

    if (pokeOn) {
      const onEdge = Math.abs(tmpVec.x) > zone.halfWidth * (1 - TUNING.pokeEdge);
      const touching = overPage && onEdge && Math.abs(aboveSurface) < TUNING.pokeTouch;
      if (touching && mem.pokeArmed && swipeCooldown === 0) {
        actions.turnPage = tmpVec.x > 0 ? 1 : -1;
        swipeCooldown = TUNING.swipeCooldown;
        mem.pokeArmed = false;
      }
      // Re-arm only after the fingertip clearly lifted off (3x the touch distance).
      if (!overPage || Math.abs(aboveSurface) > TUNING.pokeTouch * 3) mem.pokeArmed = true;
    }
  }
}

/**
 * Turn "is it down this frame?" into edges. `button.held` still holds LAST
 * frame's value when we get here, which is exactly what edge detection needs.
 */
function updateButton(button: ButtonAction, via: PressSource): void {
  const held = via !== 'none';
  button.pressed = held && !button.held;
  button.released = !held && button.held;
  button.held = held;
  button.consumed = false;
  if (button.pressed) button.via = via; // remember what started this press
  if (!held) button.via = 'none';
}
