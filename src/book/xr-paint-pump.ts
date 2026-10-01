/**
 * Quest does not run window.requestAnimationFrame while an immersive session
 * is up. pdf.js paints a page in slices and waits on that callback between
 * slices, so a page opened inside VR sits on the loading mark until the
 * session ends. The flat view then paints in one go, which is why stepping
 * out of VR and back in makes the page look fine.
 *
 * While a session is active, those callbacks are queued here and run from
 * the VR frame (BookSystem.update) instead of the paused browser loop.
 *
 * EMULATOR EXCEPTION: IWER (the desktop headset emulator, injected on
 * localhost) builds its fake XR frame loop ON TOP of
 * window.requestAnimationFrame. If we queued those calls too, the emulated
 * session's next frame would only run from inside a frame: the loop stalls
 * after a few frames (the smoke test's controllers then never move). So when
 * IWER is driving the session we let every call through. That changes
 * nothing on a Quest: there the browser's real WebXR runs the frames.
 */

const nativeRAF = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);

let installed = false;
let presenting = false;
let nextId = 1_000_000_000;
const queued = new Map<number, FrameRequestCallback>();

/**
 * True when the IWER emulator (not a real headset) runs the XR frames.
 * The IWSDK dev plugin records how it set things up: runtime 'IWER' = fully
 * emulated. Its "native override" mode (a paired physical headset) reports
 * 'IWER-native-override'; there the real WebXR loop runs, so the pump stays on.
 */
function emulatorDrivesXR(): boolean {
  const profile = (window as { __IWSDK_EMULATION_PROFILE?: { runtime?: string } }).__IWSDK_EMULATION_PROFILE;
  return profile?.runtime === 'IWER';
}

function wrappedRAF(cb: FrameRequestCallback): number {
  if (!presenting || emulatorDrivesXR()) return nativeRAF(cb);
  const id = nextId++;
  queued.set(id, cb);
  return id;
}

function wrappedCancel(id: number): void {
  if (queued.delete(id)) return;
  nativeCancel(id);
}

export function installXrPaintPump(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.requestAnimationFrame = wrappedRAF as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = wrappedCancel;
}

/**
 * True while an immersive session is running. On the way out, run whatever
 * was still queued and let the rest of that paint use the real browser loop.
 */
export function setXrPresenting(on: boolean): void {
  if (presenting === on) return;
  const was = presenting;
  presenting = on;
  if (!was || on || queued.size === 0) return;
  const pending = [...queued.entries()];
  queued.clear();
  const now = performance.now();
  for (const [, cb] of pending) cb(now);
}

/** Run the paints pdf.js queued since the last VR frame. One slice per frame. */
export function flushXrPaintPump(now: number): void {
  if (!presenting || queued.size === 0) return;
  const batch = [...queued.entries()];
  queued.clear();
  for (const [, cb] of batch) cb(now);
}
