/**
 * Palm frame for a tracked hand, built only from joint positions.
 *
 * WebXR's grip space sits on the wrist and does not match a controller grip,
 * so a book parented to it floats off the back of the hand. This frame puts
 * the origin in the palm instead.
 *
 * Canonical pose used to pin the signs (right OR left hand, palm up, fingers
 * pointing world −Z):
 *   palm +Z (out of the palm) = world +Y
 *   palm +Y (toward the fingertips) = world −Z
 *   palm +X = world +X
 * Try it with your own right hand: palm up, fingers pointing away from you,
 * and the thumb sticks out to the RIGHT (world +X). The left hand mirrors
 * that: thumb to the LEFT (world −X). So in the palm frame the right thumb
 * is on +X and the left thumb is on −X.
 *
 * WHY the sign flip below exists: thumbward × fingerDir gives a vector that
 * points out of the palm for the RIGHT hand (+X × −Z = +Y, palm up) but out
 * of the BACK of the hand for the left (−X × −Z = −Y), because the two hands
 * are mirror images. Flipping it for the left hand makes +Z come out of the
 * palm on both.
 *
 * (Bug fix, Phase 2: this used to flip the RIGHT hand, and the unit test had
 * the right thumb at −X with the palm up, which is a palm-DOWN right hand.
 * The two mistakes agreed with each other, so the test passed while the
 * frame was mirrored on a real hand.)
 */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface PalmFrame {
  position: V3;
  /** Book axes expressed in world space. */
  x: V3;
  y: V3;
  z: V3;
  quaternion: V3 & { w: number };
}

const PALM_FORWARD_M = 0.045;

function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function add(a: V3, b: V3): V3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale(a: V3, s: number): V3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: V3, b: V3): V3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function norm(a: V3): V3 | null {
  const n = Math.hypot(a.x, a.y, a.z);
  if (n < 1e-5) return null;
  return scale(a, 1 / n);
}

/** Rotation whose columns are the three axes. */
function quatFromBasis(x: V3, y: V3, z: V3): V3 & { w: number } {
  const m00 = x.x, m10 = x.y, m20 = x.z;
  const m01 = y.x, m11 = y.y, m21 = y.z;
  const m02 = z.x, m12 = z.y, m22 = z.z;
  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  return { x: qx / n, y: qy / n, z: qz / n, w: qw / n };
}

/**
 * `indexMeta` / `pinkyMeta` / `middleMeta` are the metacarpal joints.
 * Returns null when the joints are missing or folded on top of each other.
 */
export function palmFrame(
  hand: 'left' | 'right',
  wrist: V3,
  indexMeta: V3,
  pinkyMeta: V3,
  middleMeta: V3,
): PalmFrame | null {
  const thumbward = norm(sub(indexMeta, pinkyMeta));
  const finger = norm(sub(middleMeta, wrist));
  if (!thumbward || !finger) return null;
  if (Math.abs(dot(thumbward, finger)) > 0.92) return null;

  // thumbward × fingerDir points out of the palm on the RIGHT hand only
  // (see the header): mirror it for the left hand.
  let palm = cross(thumbward, finger);
  if (hand === 'left') palm = scale(palm, -1);
  const z = norm(palm);
  if (!z) return null;
  const yFlat = norm(sub(finger, scale(z, dot(finger, z))));
  if (!yFlat) return null;
  const x = norm(cross(yFlat, z));
  if (!x) return null;
  const y = cross(z, x);

  return {
    position: add(wrist, scale(finger, PALM_FORWARD_M)),
    x,
    y,
    z,
    quaternion: quatFromBasis(x, y, z),
  };
}
