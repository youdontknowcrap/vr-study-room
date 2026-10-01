/**
 * ReadingStand — a slanted book stand that sits ON a table (used in 3D-model
 * rooms, where we must not move the room's own furniture).
 *
 *      side view (you are on the right)
 *          ___
 *         /   \___   <- slanted board (tilt), with a small lip at the
 *        |        \_|    near edge so the book can't slide off
 *        |  post   |
 *     ===+=========+===  base plate, resting on the table top (tableY)
 *
 *  - It is the room's READING SURFACE: the book rests on `top`, the menu tab
 *    is on its front-left corner. The radio sits on the table beside it.
 *  - The "Desk height" setting = height of the board's middle above the
 *    FLOOR (same meaning as for the drafting desk). It can't go lower than
 *    a few cm above the table: the stand just gets shorter.
 *  - "Desk tilt" tilts the board, near edge lower.
 */
import { Group, MathUtils, Mesh, MeshStandardMaterial, Object3D } from '@iwsdk/core';
import { box, merge } from './geometry-utils.js';
import type { ReadingSurface } from './room-types.js';

const BOARD_W = 0.56;
const BOARD_D = 0.4;
const BOARD_T = 0.015;
/** The board's middle stays at least this far above the table top. */
const MIN_RISE = 0.07;

export class ReadingStand implements ReadingSurface {
  /** Sits on the table: origin = table-top point under the board's middle. */
  readonly group = new Group();
  readonly top = new Group();
  readonly bookHome = new Object3D();
  readonly menuTabAnchor = new Object3D();
  /** On the TABLE, to the right of the stand. */
  readonly radioAnchor = new Object3D();
  readonly halfW = BOARD_W / 2;
  readonly halfD = BOARD_D / 2;

  private readonly wood = new MeshStandardMaterial({ color: 0x7a5236, roughness: 0.6 });
  private readonly frame: Mesh;

  /** `tableY` = height of the table top above the floor. */
  constructor(private readonly tableY: number) {
    const board = new Mesh(
      merge([
        box(BOARD_W, BOARD_T, BOARD_D, 0, -BOARD_T / 2, 0),
        // lip along the near edge (+z): 2 cm tall
        box(BOARD_W, 0.02, 0.012, 0, 0.004, BOARD_D / 2 - 0.006),
      ]),
      this.wood,
    );
    this.top.add(board, this.bookHome, this.menuTabAnchor);
    this.frame = new Mesh(undefined, this.wood);
    this.group.add(this.top, this.frame, this.radioAnchor);
    this.bookHome.position.set(0, 0, 0.0);
    this.menuTabAnchor.position.set(-BOARD_W / 2 + 0.06, 0.012, BOARD_D / 2 - 0.05);
    this.menuTabAnchor.rotation.x = -Math.PI / 2 + 0.5;
    this.radioAnchor.position.set(BOARD_W / 2 + 0.14, 0, -0.05);
    this.radioAnchor.rotation.y = -0.45;
  }

  set(height: number, tiltDeg: number): void {
    const t = MathUtils.degToRad(tiltDeg);
    // Height is measured from the FLOOR, but the stand stands on the table.
    const rise = Math.max(MIN_RISE, height - this.tableY);
    this.top.position.set(0, rise, 0);
    this.top.rotation.set(t, 0, 0);
    const postH = rise - 0.02;
    this.frame.geometry.dispose();
    this.frame.geometry = merge([
      box(0.3, 0.012, 0.22, 0, 0.006, 0), // base plate on the table
      box(0.04, postH, 0.04, 0, postH / 2, 0), // center post up to the board
    ]);
    this.group.updateMatrixWorld(true);
  }
}
