/**
 * Where is the user's head RIGHT NOW?
 *
 * Why this file exists (bug fix, "MP3 makes the book vanish")
 * ------------------------------------------------------------
 * The obvious answer is "read world.camera". But IWSDK runs our systems
 * BEFORE it renders, and three.js only copies the headset pose into
 * world.camera DURING rendering. So inside a system's update():
 *   - on a normal VR frame, world.camera is one frame old (harmless), but
 *   - on the FIRST frame of a VR session, world.camera still holds the 2D
 *     browser camera pose (x 0, y 1.4, z 0.5, looking down at the desk).
 * We auto-recentered the desk on that first frame, so the desk (and the
 * book sitting on it) were placed relative to a head that wasn't there:
 * the book ended up ~0.5 m straight below your eyes, out of view. Every
 * "leave VR -> pick a file -> Enter VR" round trip (e.g. Add music…)
 * triggered it again, so after loading an MP3 the book "vanished".
 *
 * The fix: in VR, ask the CURRENT XRFrame for the viewer (head) pose
 * directly. That is always the real, up-to-date head.
 */
import { Quaternion, Vector3, type World } from '@iwsdk/core';

// Scratch objects reused every call (no per-frame allocations).
const playerQuat = new Quaternion();
const scratchScale = new Vector3();

/**
 * Writes the head's world position + rotation into `outPos` / `outQuat`.
 * Returns false if no pose is available yet (e.g. tracking not started),
 * in which case callers should simply try again next frame.
 */
export function getHeadPose(world: World, outPos: Vector3, outQuat: Quaternion): boolean {
  const frame = world.xrFrame;
  const refSpace = world.xrReferenceSpace;
  if (world.session) {
    if (!frame || !refSpace) return false;
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return false;
    const t = pose.transform;
    // Pose is in "tracking space"; the player rig may be moved in the scene,
    // so convert to world space with the player's matrix.
    const player = world.player;
    player.updateMatrixWorld();
    outPos.set(t.position.x, t.position.y, t.position.z).applyMatrix4(player.matrixWorld);
    outQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
    outQuat.premultiply(player.getWorldQuaternion(playerQuat));
    return true;
  }
  // 2D browser (no VR): the camera IS the head.
  world.camera.updateWorldMatrix(true, false);
  world.camera.matrixWorld.decompose(outPos, outQuat, scratchScale);
  return true;
}

/** Heading (yaw, radians) of a head rotation, ignoring up/down tilt. */
export function yawOf(q: Quaternion, scratch: Vector3): number {
  // three.js cameras look down -z; flatten that direction onto the floor.
  const fwd = scratch.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-fwd.x, -fwd.z);
}
