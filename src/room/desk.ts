/**
 * Desk — a drafting-style desk standing on the floor, with a SLANTED top.
 *
 *            far edge (higher)            side view (user on the right)
 *        ____________ ledge                    ___ ledge (flat, radio)
 *       /           /                         /  \___
 *      /  top      /  <- tilted by `tilt`    |       \___  top
 *     /___________/                          |           \___
 *        near edge (lower, toward you)       |  legs     |   <- near edge
 *
 *  - The whole desk stands on the REAL floor (y = 0 in "local-floor"
 *    space, which IWSDK uses). So its height no longer depends on how you
 *    held your head when you pressed Recenter.
 *  - `height` is measured at the MIDDLE of the slanted top, where the book
 *    lies. `tilt` in degrees: 0 = flat table.
 *  - `top` is a pivot group whose origin is ON the top surface, at its
 *    center, so "local y = 0" is the desk surface. The book, menu tab and
 *    the book's home spot are children of it, so when you change height or
 *    tilt they ride along automatically.
 */
import {
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from '@iwsdk/core';
import { box, merge } from './geometry-utils.js';
import type { ReadingSurface } from './room-types.js';

export const TOP_W = 1.0; // meters, left-right
export const TOP_D = 0.55; // meters, near-far (along the slant)
const TOP_T = 0.025; // thickness
const LEDGE_D = 0.12; // flat strip behind the slant (for the radio)
const LEG = 0.04; // leg cross-section

export class Desk implements ReadingSurface {
  /** Stands on the floor; origin = floor point under the top's center. */
  readonly group = new Group();
  /** Tilted pivot; local y = 0 is the desk surface, +z points toward you. */
  readonly top = new Group();
  /** Where "Bring book back" puts the book (on the top surface). */
  readonly bookHome = new Object3D();
  /** Small "Menu" tab button, front-left corner of the top. */
  readonly menuTabAnchor = new Object3D();
  /** The radio sits on the flat ledge at the back. */
  readonly radioAnchor = new Object3D();
  /** Half the size of the top surface (for "did the book land on the desk?"). */
  readonly halfW = TOP_W / 2;
  readonly halfD = TOP_D / 2;

  private readonly wood = new MeshStandardMaterial({ color: 0x6a4630, roughness: 0.65 });
  private readonly frame: Mesh;

  constructor() {
    // The slanted top: one box, shifted down so its UPPER face is at y = 0.
    const topMesh = new Mesh(box(TOP_W, TOP_T, TOP_D, 0, -TOP_T / 2, 0), this.wood);
    this.top.add(topMesh, this.bookHome, this.menuTabAnchor);
    // Legs + rails + ledge are rebuilt when height/tilt change (one mesh).
    this.frame = new Mesh(undefined, this.wood);
    this.group.add(this.top, this.frame, this.radioAnchor);

    // Book home: middle of the desk, a little toward you.
    this.bookHome.position.set(0, 0, 0.02);
    // Menu tab: lying on the top, front-left, propped up ~30 degrees.
    this.menuTabAnchor.position.set(-0.38, 0.012, 0.17);
    this.menuTabAnchor.rotation.x = -Math.PI / 2 + 0.5;
  }

  /** Rebuild the desk for a new height (m, at the middle of the top) and tilt (deg). */
  set(height: number, tiltDeg: number): void {
    const t = MathUtils.degToRad(tiltDeg);
    const sin = Math.sin(t);
    const cos = Math.cos(t);
    const hd = TOP_D / 2;

    // Positive rotation around x lowers the +z (near) edge. See the diagram.
    this.top.position.set(0, height, 0);
    this.top.rotation.set(t, 0, 0);

    // Key heights / depths (desk-group space, y up, +z toward you).
    const farY = height + hd * sin; // top surface at the far edge
    const farZ = -hd * cos;
    const nearZ = hd * cos;
    // Underside of the slanted top at its near edge:
    const nearUnderY = height - hd * sin - TOP_T * cos;
    const apronTop = nearUnderY - 0.005;
    const apronH = 0.06;
    const backZ = farZ - LEDGE_D + 0.03;
    const frontZ = nearZ - 0.04;
    const legX = TOP_W / 2 - LEG;

    const parts = [
      // Flat ledge at the far edge (same height as the far edge).
      box(TOP_W, TOP_T, LEDGE_D, 0, farY - TOP_T / 2, farZ - LEDGE_D / 2),
      // Apron rails (front, back, left, right) just under the top.
      box(TOP_W - 0.02, apronH, 0.025, 0, apronTop - apronH / 2, frontZ),
      box(TOP_W - 0.02, apronH, 0.025, 0, apronTop - apronH / 2, backZ),
      box(0.025, apronH, frontZ - backZ, -legX, apronTop - apronH / 2, (frontZ + backZ) / 2),
      box(0.025, apronH, frontZ - backZ, legX, apronTop - apronH / 2, (frontZ + backZ) / 2),
    ];
    // Four legs from the floor up to the apron.
    for (const x of [-legX, legX]) {
      for (const z of [frontZ, backZ]) {
        parts.push(box(LEG, apronTop, LEG, x, apronTop / 2, z));
      }
    }
    // Back posts hold up the ledge (only needed when the desk is tilted).
    const postH = farY - TOP_T - apronTop;
    if (postH > 0.01) {
      for (const x of [-legX, legX]) {
        parts.push(box(LEG, postH, LEG, x, apronTop + postH / 2, backZ));
      }
    }
    this.frame.geometry.dispose();
    this.frame.geometry = merge(parts);

    // Radio on the ledge, angled toward you.
    this.radioAnchor.position.set(0.34, farY, farZ - LEDGE_D / 2);
    this.radioAnchor.rotation.set(0, -0.45, 0);
    this.group.updateMatrixWorld(true);
  }
}
