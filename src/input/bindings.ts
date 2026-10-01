/**
 * INPUT BINDINGS — the one place that decides which physical input
 * triggers which app action.
 *
 * Why this file exists
 * --------------------
 * The rest of the app never asks "is the grip button down?" or "is the user
 * pinching?". It only asks "is the user GRABBING?" or "did they ask to TURN
 * THE PAGE?". Those are *actions*. This file maps physical inputs -> actions.
 *
 * Today (first demo) controllers are the primary input, with hand tracking
 * wired in as a bonus. The competition requires HANDS-FIRST by submission,
 * so the plan is:
 *   1. Tune the hand entries below until they feel as good as controllers.
 *   2. Flip HANDS_ONLY to true (or delete the 'controller.*' entries).
 *   3. Nothing else in the app has to change.
 */

/** Every physical input the input layer knows how to read. */
export type PhysicalInput =
  // --- Meta Quest Touch controllers (WebXR "xr-standard" gamepad layout) ---
  | 'controller.squeeze' // grip button under the middle finger (buttons[1])
  | 'controller.trigger' // index-finger trigger (buttons[0])
  | 'controller.thumbstick' // left/right flick of the stick (axes[2])
  | 'controller.stickPress' // clicking the thumbstick down (buttons[3])
  | 'controller.buttonBY' // upper face button: B on right, Y on left (buttons[5])
  // --- Hand tracking (WebXR XRHand joints) ---
  | 'hand.pinch' // thumb tip touches index tip
  | 'hand.swipe' // fast sideways fingertip motion over the page
  | 'hand.poke' // index fingertip taps the outer edge of a page
  // --- Desktop keyboard (laptop testing without a headset) ---
  | 'keyboard.arrows' // ArrowLeft / ArrowRight
  | 'keyboard.m' // M key
  | 'keyboard.r' // R key
  | 'keyboard.b'; // B key

/** Every action the app understands. */
export type ActionName =
  | 'grab'
  | 'select'
  | 'turnPage'
  | 'toggleMenu'
  | 'recenter'
  | 'bringBookBack';

/**
 * Set this to true to rehearse the hands-only competition build:
 * all 'controller.*' bindings are ignored.
 */
export const HANDS_ONLY = false;

const ALL_BINDINGS: Record<ActionName, PhysicalInput[]> = {
  // grab = pick up / hold / swap the book (squeeze is the main one), or
  // press a menu button. Trigger + pinch are kept as alternatives.
  grab: ['controller.squeeze', 'controller.trigger', 'hand.pinch'],
  // select = drag a page by its outer edge, press a menu button.
  // Deliberately NOT squeeze: squeezing the book should always grab it.
  select: ['controller.trigger', 'hand.pinch'],
  // turnPage = +1 next page / -1 previous page
  turnPage: ['controller.thumbstick', 'hand.swipe', 'hand.poke', 'keyboard.arrows'],
  // toggleMenu = open / close the floating menu
  // (hands can also poke/pinch the small "Menu" tab on the desk)
  toggleMenu: ['controller.buttonBY', 'keyboard.m'],
  // recenter = move the desk + book in front of where you are looking
  recenter: ['controller.stickPress', 'keyboard.r'],
  // bringBookBack = the book flies back onto the desk (also a menu item)
  bringBookBack: ['keyboard.b'],
};

/** The bindings actually in effect (controllers stripped when HANDS_ONLY). */
export const BINDINGS: Record<ActionName, ReadonlySet<PhysicalInput>> =
  Object.fromEntries(
    Object.entries(ALL_BINDINGS).map(([action, inputs]) => [
      action,
      new Set(
        inputs.filter((i) => !(HANDS_ONLY && i.startsWith('controller.'))),
      ),
    ]),
  ) as unknown as Record<ActionName, ReadonlySet<PhysicalInput>>;

/** Small helper so call sites read like English: isBound('grab', 'hand.pinch'). */
export function isBound(action: ActionName, input: PhysicalInput): boolean {
  return BINDINGS[action].has(input);
}

/**
 * Tuning numbers for gestures. Keeping them together makes on-headset tuning
 * easy: change a number, save, the page hot-reloads.
 */
export const TUNING = {
  /** Pinch starts when thumb and index tips are closer than this (meters). */
  pinchStart: 0.018,
  /** ...and ends when they separate past this. The gap ("hysteresis") stops flicker. */
  pinchEnd: 0.035,
  /** Controller trigger/grip analog value that counts as pressed / released. */
  buttonPress: 0.6,
  buttonRelease: 0.4,
  /** Thumbstick must pass this to count as a flick, and return below re-arm. */
  stickFlick: 0.7,
  stickRearm: 0.3,
  /** Fingertip sideways speed (m/s) over the page that counts as a swipe. */
  swipeSpeed: 0.6,
  /** Seconds to ignore further swipes/pokes after one fires. */
  swipeCooldown: 0.6,
  /** Poke: fingertip within this distance (m) of the page surface counts as touching. */
  pokeTouch: 0.012,
  /** Poke: outer fraction of a page that reacts (0.25 = outer quarter). */
  pokeEdge: 0.25,
} as const;
