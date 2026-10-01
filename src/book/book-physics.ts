/**
 * Book drop physics — a tiny, purpose-built rigid body.
 *
 * Why not a physics engine? IWSDK has one (Havok, loaded as WebAssembly in
 * a worker), but for ONE falling book that is a lot of download + memory on
 * Quest 2. A real engine also needs collision shapes for everything. Here
 * we only need: gravity, the floor, the slanted desk top, the four walls,
 * a little bounce, and then "come to rest lying flat". ~150 lines.
 *
 * How a frame works (all in WORLD space; y is up, the floor is y = 0):
 *  1. velocity += gravity * dt;  position += velocity * dt
 *  2. spin the book by its angular velocity (and slow the spin a little)
 *  3. for each surface (floor, desk top): find the book's LOWEST corner
 *     along the surface normal. Below the surface = touching:
 *       - fast?  bounce (keep 25% of the speed into the surface)
 *       - slow?  stop simulating and SETTLE: glide into a resting pose
 *         lying flat on that surface (see restPose()).
 *  4. keep the book inside the room's walls.
 *
 * FUTURE: page-flutter while falling, sliding down the slanted desk,
 * tipping over edges. See README roadmap ("book drop page-flutter physics").
 */
import { Box3, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';

export const GRAVITY = -9.81; // m/s^2
const RESTITUTION = 0.25; // how bouncy (0 = dead stop, 1 = perfect bounce)
const FRICTION = 0.6; // fraction of sideways speed kept per bounce
const BOUNCE_MIN_SPEED = 0.9; // slower than this into a surface -> settle
const AIR_SPIN_DAMPING = 0.6; // per second
const MAX_SPEED = 4; // m/s, clamps wild throws
const MAX_SPIN = 10; // rad/s

/** A flat surface the book can land on. */
export interface Surface {
  kind: 'floor' | 'desk';
  /** Unit normal pointing up out of the surface (world space). */
  normal: Vector3;
  /** Any point on the surface (world space). */
  point: Vector3;
  /** Is this world point above the usable area (e.g. inside the desk top)? */
  contains(p: Vector3): boolean;
}

/** Room walls in WORLD space are given as a function that clamps a point. */
export type WallClamp = (pos: Vector3, vel: Vector3) => void;

const corner = new Vector3();
const tmp = new Vector3();
const prevPos = new Vector3();
const dq = new Quaternion();
const m = new Matrix4();

/** The 8 corners of a box. */
function corners(b: Box3, i: number, out: Vector3): Vector3 {
  return out.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
}

/**
 * Lowest point of the book along `normal`: min over the corners of the
 * book's bounding box (root space), rotated by `quat`, of normal . corner.
 */
export function lowestAlong(bounds: Box3, quat: Quaternion, normal: Vector3): number {
  let min = Infinity;
  for (let i = 0; i < 8; i++) {
    corners(bounds, i, corner).applyQuaternion(quat);
    min = Math.min(min, corner.dot(normal));
  }
  return min;
}

/**
 * Where the book should come to rest on a surface:
 *  - lying flat: its page side (+z) points along the surface normal (face
 *    up) - or against it if it landed mostly face down;
 *  - keeping its current heading: the book's "up the page" direction
 *    (+y) is projected onto the surface, so it stays turned the way it
 *    landed instead of snapping to face you;
 *  - lifted so its lowest corner just touches the surface.
 */
export function restPose(
  surface: Surface,
  bounds: Box3,
  pos: Vector3,
  quat: Quaternion,
  outPos: Vector3,
  outQuat: Quaternion,
  forceFaceUp = false,
): void {
  const n = surface.normal;
  const bookZ = tmp.set(0, 0, 1).applyQuaternion(quat);
  const faceUp = forceFaceUp || bookZ.dot(n) > -0.2;
  const z = new Vector3().copy(n).multiplyScalar(faceUp ? 1 : -1);
  // Book's "up the page" axis flattened onto the surface.
  const y = new Vector3(0, 1, 0).applyQuaternion(quat);
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-4) {
    // Book was exactly flat-on: use its x axis to find a heading instead.
    const x0 = new Vector3(1, 0, 0).applyQuaternion(quat);
    y.crossVectors(z, x0);
  }
  y.normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  m.makeBasis(x, y, z);
  outQuat.setFromRotationMatrix(m);

  // Height: slide pos onto the surface plane, then lift by the lowest corner.
  const dist = tmp.subVectors(pos, surface.point).dot(n);
  outPos.copy(pos).addScaledVector(n, -dist);
  outPos.addScaledVector(n, -lowestAlong(bounds, outQuat, n));
}

/** State of a book flying through the air. */
export class FallingBody {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly velocity = new Vector3();
  readonly spin = new Vector3(); // angular velocity, rad/s (world axes)
  /** Seconds spent falling (safety net: give up after a while). */
  age = 0;

  start(pos: Vector3, quat: Quaternion, vel: Vector3, spin: Vector3): void {
    this.position.copy(pos);
    this.quaternion.copy(quat);
    this.velocity.copy(vel).clampLength(0, MAX_SPEED);
    this.spin.copy(spin).clampLength(0, MAX_SPIN);
    this.age = 0;
  }

  /**
   * Advance one frame. Returns the surface the book came to rest on, or
   * null while it is still flying/bouncing.
   */
  step(dt: number, bounds: Box3, surfaces: Surface[], walls: WallClamp): Surface | null {
    // Big time steps would let the book tunnel through the floor, so we cut
    // the frame into small SUB-STEPS of at most 1/60 s. (A huge hiccup, e.g.
    // the headset taken off, is capped at 0.25 s of simulated time.)
    let remaining = Math.min(dt, 0.25);
    while (remaining > 1e-6) {
      const h = Math.min(remaining, 1 / 60);
      remaining -= h;
      const landed = this.subStep(h, bounds, surfaces, walls);
      if (landed) return landed;
    }
    return null;
  }

  private subStep(dt: number, bounds: Box3, surfaces: Surface[], walls: WallClamp): Surface | null {
    this.age += dt;

    // 1) gravity + move
    prevPos.copy(this.position);
    this.velocity.y += GRAVITY * dt;
    this.position.addScaledVector(this.velocity, dt);

    // 2) spin: rotate by (spin * dt) around the spin axis
    const angle = this.spin.length() * dt;
    if (angle > 1e-6) {
      dq.setFromAxisAngle(corner.copy(this.spin).normalize(), angle);
      this.quaternion.premultiply(dq).normalize();
    }
    this.spin.multiplyScalar(Math.exp(-AIR_SPIN_DAMPING * dt));

    // 3) surfaces
    for (const s of surfaces) {
      if (!s.contains(this.position)) continue;
      const n = s.normal;
      // Only collide if the book's center was ABOVE the surface last frame
      // (otherwise a book flying under the desk would "land" on its underside).
      if (corner.subVectors(prevPos, s.point).dot(n) < -0.02) continue;
      const centerDist = corner.subVectors(this.position, s.point).dot(n);
      const pen = centerDist + lowestAlong(bounds, this.quaternion, n);
      if (pen >= 0) continue;
      const vn = this.velocity.dot(n);
      if (vn < -BOUNCE_MIN_SPEED) {
        // Bounce: push out, reflect the into-surface speed, lose some speed.
        this.position.addScaledVector(n, -pen);
        this.velocity.addScaledVector(n, -(1 + RESTITUTION) * vn);
        const vnAfter = this.velocity.dot(n);
        this.velocity.addScaledVector(n, -vnAfter).multiplyScalar(FRICTION);
        this.velocity.addScaledVector(n, vnAfter);
        this.spin.multiplyScalar(0.5);
      } else {
        this.position.addScaledVector(n, -pen);
        return s; // slow enough: settle here
      }
    }

    // 4) walls
    walls(this.position, this.velocity);
    return null;
  }
}
