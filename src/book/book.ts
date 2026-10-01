/**
 * Book — the 3D book: a boxy hardcover, open at ~145 degrees, with real page
 * blocks, a spine, a ribbon bookmark, and page-turn animations.
 *
 * Anatomy, seen from the TOP of the book (looking down the spine, y axis):
 *
 *        left page                          right page
 *     \_____________                    _____________/     <- page textures
 *      \  left block  \______  ______/  right block /      <- page stacks
 *       \______cover______\  \/  /______cover______/       <- hard covers
 *                           [spine]                         (thickness ~ pages)
 *
 *  - Local space: origin = middle of the spine, x = across the spread,
 *    y = up the page, +z = the side the pages face (toward the reader).
 *  - The two HALVES are each tilted up by 17.5 degrees, so the angle
 *    between them is 145 degrees (= 80% of a flat 180-degree spread).
 *  - Each half = cover box + page-block box + one page texture plane.
 *  - Page-block THICKNESS follows the PDF's page count (clamped), and moves
 *    from the right block to the left block as you read, so you can SEE
 *    where you are in the book.
 *  - `leaf`: ONE extra sheet, hinged at the spine, only visible while a page
 *    turns. Front = page being lifted, back = the next page.
 *  - `model` carries the BOOK SIZE (scale) and the intro "pop". `root` is
 *    never scaled, so grabbing math stays simple.
 *
 *  Draw calls: 2 covers + 2 blocks + 2 pages + spine + ribbon (+2 while a
 *  page turns) = 8-10. Cheap on Quest.
 *
 *  Spread state: `left` = index of the page on the left (-1 = inside cover).
 *  Right page is always left + 1.
 */
import {
  Box3,
  BoxGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from '@iwsdk/core';
import type { PdfPages } from './pdf-pages.js';

const PAGE_HEIGHT = 0.21; // meters (A5 height) at 100% size
const TURN_SECONDS = 0.45;
const ASSEMBLE_SECONDS = 1.4;
const CARD_COUNT = 6;

/** Each half tilts up by this much: 180 - 2 * 17.5 = 145 degrees open. */
export const HALF_TILT = MathUtils.degToRad(17.5);
const COVER_T = 0.004; // hard cover board thickness (4 mm)
const COVER_MARGIN = 0.006; // cover sticks out past the pages by 6 mm
/** Page-block thickness: base + per page, clamped (meters, at 100% size). */
const BLOCK_BASE = 0.004;
const BLOCK_PER_PAGE = 0.00007; // 0.07 mm per PDF page (~0.14 mm per sheet)
const BLOCK_MIN = 0.008; // tiny PDFs still look like a book...
const BLOCK_MAX = 0.04; // ...and huge ones don't turn into bricks
const SLIVER = 0.0008; // never let a block shrink to exactly zero

const PAPER = 0xfbf7ee;
const INSIDE_COVER = 0x5b2a1c;
const COVER_COLOR = 0x6e2c1d;
const RIBBON_COLOR = 0xa3172a;

type TurnDir = 1 | -1;

/** Smooth ease in/out: slow start, fast middle, slow end. */
const ease = (t: number) => t * t * (3 - 2 * t);

export class Book {
  /** Move/rotate THIS to move the whole book. Never scaled. */
  readonly root = new Group();
  /** Scaled by the book size setting (and the intro pop). */
  readonly model = new Group();
  /** Invisible box around the whole book, used for grabbing & ray hits. */
  readonly hitMesh: Mesh;

  pageWidth = PAGE_HEIGHT * 0.707;
  readonly pageHeight = PAGE_HEIGHT;

  /** Called whenever the open spread changes (used to save reading progress). */
  onSpreadChange: (left: number) => void = () => {};

  private pages: PdfPages | null = null;
  private left = -1;
  /** Book size multiplier (1 = 100%). */
  private size = 1;

  private readonly halves: { left: Group; right: Group } = { left: new Group(), right: new Group() };
  private readonly unitBox = new BoxGeometry(1, 1, 1);
  private readonly pageGeo = new PlaneGeometry(1, 1);
  private readonly covers: Mesh[];
  private readonly blocks: Mesh[];
  private readonly spine: Mesh;
  private readonly leftPage: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly rightPage: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly leaf = new Group(); // the hinge; child meshes are the sheet
  private readonly leafFront: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly leafBack: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly ribbon: Mesh<PlaneGeometry, MeshStandardMaterial>;

  /** Total page-block thickness for this PDF, and the shown left/right split. */
  private blockT = BLOCK_MIN;
  private shownLeftT = SLIVER;
  private shownRightT = BLOCK_MIN;
  /** Gap between the two page blocks at the spine. */
  private gutter = 0.002;

  /** Leaf progress: 0 = lying on the right, 1 = lying on the left. */
  private leafP = 0;
  private turn: {
    dir: TurnDir;
    dragging: boolean;
    target: 0 | 1;
  } | null = null;

  /** The "PDF becomes a book" intro animation. */
  private assemble: { t: number } | null = null;
  private readonly cards: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private readonly cardGroup = new Group();

  constructor() {
    this.root.add(this.model);
    const coverMat = new MeshStandardMaterial({ color: COVER_COLOR, roughness: 0.75 });
    // Page edges: a tiny striped canvas texture makes the block read as
    // "many sheets of paper" instead of a white brick.
    const blockMat = new MeshStandardMaterial({
      color: 0xffffff,
      map: makePageEdgeTexture(),
      roughness: 0.95,
    });
    this.covers = [new Mesh(this.unitBox, coverMat), new Mesh(this.unitBox, coverMat)];
    const blockGeo = makeBlockGeometry();
    this.blocks = [new Mesh(blockGeo, blockMat), new Mesh(blockGeo, blockMat)];
    this.spine = new Mesh(this.unitBox, coverMat);

    const makePage = () => new Mesh(this.pageGeo, new MeshBasicMaterial({ color: PAPER }));
    this.leftPage = makePage();
    this.rightPage = makePage();
    this.leafFront = makePage();
    this.leafBack = makePage();
    // The back of the leaf faces -z: rotate it half a turn around its own
    // vertical center line so its texture is not mirrored.
    this.leafBack.rotation.y = Math.PI;
    this.leaf.add(this.leafFront, this.leafBack);
    this.leaf.visible = false;

    this.halves.left.add(this.covers[0], this.blocks[0], this.leftPage);
    this.halves.right.add(this.covers[1], this.blocks[1], this.rightPage);

    // Ribbon bookmark: a thin cloth strip. Its shape is built in layout().
    this.ribbon = new Mesh(
      new PlaneGeometry(0.007, 1, 1, 24),
      new MeshStandardMaterial({ color: RIBBON_COLOR, roughness: 0.6, side: DoubleSide }),
    );
    this.halves.right.add(this.ribbon);

    this.hitMesh = new Mesh(this.unitBox, new MeshBasicMaterial());
    this.hitMesh.visible = false; // raycasts still hit invisible meshes

    this.model.add(this.halves.left, this.halves.right, this.spine, this.leaf, this.hitMesh);

    // Cards used only by the intro animation (hidden otherwise).
    for (let i = 0; i < CARD_COUNT; i++) {
      const card = new Mesh(this.pageGeo, new MeshBasicMaterial({ color: PAPER, side: DoubleSide }));
      this.cards.push(card);
      this.cardGroup.add(card);
    }
    this.cardGroup.visible = false;
    this.model.add(this.cardGroup);

    this.layout();
  }

  // ------------------------------------------------------------------
  // Layout: sizes and positions of every part
  // ------------------------------------------------------------------

  /** Size all meshes to the current page size, thickness and spread. */
  private layout(): void {
    const w = this.pageWidth;
    const h = this.pageHeight;
    const c = COVER_T;
    const m = COVER_MARGIN;
    this.gutter = Math.min(this.blockT / 2, 0.004);
    const g = this.gutter;

    // Halves: hinged near the spine, tilted up so the spread is 145 degrees.
    this.halves.left.position.set(-g, 0, 0);
    this.halves.right.position.set(g, 0, 0);
    if (!this.assemble) this.halves.left.rotation.set(0, HALF_TILT, 0);
    this.halves.right.rotation.set(0, -HALF_TILT, 0);

    // side = -1 for the left half (it extends toward -x), +1 for the right.
    const parts = [
      { side: -1, cover: this.covers[0], block: this.blocks[0], page: this.leftPage, t: this.shownLeftT },
      { side: 1, cover: this.covers[1], block: this.blocks[1], page: this.rightPage, t: this.shownRightT },
    ];
    for (const p of parts) {
      // Cover board: from the spine out past the page edge, under the block.
      p.cover.scale.set(w + m, h + 2 * m, c);
      p.cover.position.set((p.side * (w + m)) / 2, 0, -c / 2);
      // Page block: a solid box, as thick as the pages on that side.
      p.block.scale.set(w, h, p.t);
      p.block.position.set((p.side * w) / 2, 0, p.t / 2);
      // Page texture sits just above the block (0.6 mm, avoids flicker).
      p.page.scale.set(w, h, 1);
      p.page.position.set((p.side * w) / 2, 0, p.t + 0.0006);
    }

    // Spine: behind the gutter, as wide as both blocks + covers.
    const spineW = this.blockT + 2 * c + 2 * g;
    this.spine.scale.set(spineW, h + 2 * m, c * 1.3);
    this.spine.position.set(0, 0, -c * Math.cos(HALF_TILT) - c * 0.55);

    for (const card of this.cards) card.scale.set(w, h, 1);
    this.leafFront.scale.set(w, h, 1);
    this.leafBack.scale.set(w, h, 1);
    this.leafFront.position.set(w / 2, 0, 0.0003);
    this.leafBack.position.set(w / 2, 0, -0.0003);

    this.layoutRibbon();

    // Invisible grab/hit box around everything (a bit generous).
    const reach = (w + m) * Math.cos(HALF_TILT) + g;
    this.hitMesh.scale.set(2 * reach + 0.02, h + 2 * m + 0.02, 0.07 + this.blockT);
    this.hitMesh.position.set(0, 0, (w * Math.sin(HALF_TILT)) / 2);
  }

  /**
   * Ribbon: lies on the right page next to the gutter, from just past the
   * top edge (where it is glued to the spine) to the bottom edge, then hangs
   * out of the book bending backward. Built by bending a strip of
   * PlaneGeometry vertex by vertex.
   */
  private layoutRibbon(): void {
    const h = this.pageHeight;
    const top = h / 2 + 0.004;
    const hang = 0.06; // how much ribbon dangles below the book
    const length = top + h / 2 + hang;
    const geo = this.ribbon.geometry;
    const pos = geo.attributes.position;
    const base = new PlaneGeometry(0.007, length, 1, 24).attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = base.getX(i);
      // PlaneGeometry y goes from +length/2 to -length/2: map to top..bottom.
      const y = top - (length / 2 - base.getY(i));
      let px = x;
      let py = y;
      let pz = 0;
      if (y < -h / 2) {
        // Past the bottom edge: bend backward (-z) and drift outward a bit.
        const s = -h / 2 - y;
        const bend = MathUtils.degToRad(55);
        py = -h / 2 - s * Math.cos(bend);
        pz = -s * Math.sin(bend);
        px += s * 0.12;
      }
      pos.setXYZ(i, px, py, pz);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // 1.2 cm from the gutter, just above the right page surface.
    this.ribbon.position.set(0.012, 0, this.shownRightT + 0.0012);
  }

  /** Page-block thickness for a page count, clamped so it always looks right. */
  static blockThickness(pageCount: number): number {
    return MathUtils.clamp(BLOCK_BASE + pageCount * BLOCK_PER_PAGE, BLOCK_MIN, BLOCK_MAX);
  }

  /** How the total thickness splits between left and right for a spread. */
  private targetSplit(): { l: number; r: number } {
    const n = Math.max(1, this.pageCount);
    const p = MathUtils.clamp((this.left + 1) / n, 0, 1);
    const l = SLIVER + (this.blockT - 2 * SLIVER) * p;
    return { l, r: this.blockT - l };
  }

  // ------------------------------------------------------------------
  // Public info
  // ------------------------------------------------------------------

  get pageCount(): number {
    return this.pages?.pageCount ?? 0;
  }
  /** PdfPages.id of the open book ('' if none). */
  get bookId(): string {
    return this.pages?.id ?? '';
  }
  get currentLeft(): number {
    return this.left;
  }
  get isBusy(): boolean {
    return this.turn !== null || this.assemble !== null;
  }
  get spreadLabel(): string {
    const n = this.pageCount;
    const a = Math.max(this.left + 1, 1);
    const b = Math.min(this.left + 2, n);
    return n === 0 ? '' : a === b ? `page ${a} / ${n}` : `pages ${a}-${b} / ${n}`;
  }
  /** Book size multiplier currently applied. */
  get scale(): number {
    return this.size;
  }
  /**
   * Swipe/poke zone for the input layer, in `model` space: page area
   * half-size, plus slope/base of the V-shaped page surface.
   */
  get surface(): { halfWidth: number; halfHeight: number; slope: number; baseZ: number } {
    return {
      halfWidth: this.pageWidth * Math.cos(HALF_TILT) + this.gutter,
      halfHeight: this.pageHeight / 2,
      slope: Math.tan(HALF_TILT),
      baseZ: (this.shownLeftT + this.shownRightT) / 2,
    };
  }

  /**
   * Bounding box of the book in ROOT space (includes the size scale). Used
   * by the drop physics to find the lowest point when the book lands.
   */
  localBounds(out: Box3): Box3 {
    // Temporarily ignore the intro pop so the box is the "real" size.
    const prevScale = this.model.scale.x;
    this.model.scale.setScalar(this.size);
    this.model.updateMatrix();
    out.makeEmpty();
    const tmp = new Box3();
    for (const mesh of [...this.covers, ...this.blocks, this.spine]) {
      mesh.geometry.computeBoundingBox();
      tmp.copy(mesh.geometry.boundingBox!);
      mesh.updateMatrix();
      // mesh -> half (or model) -> model scale = root space
      tmp.applyMatrix4(mesh.matrix);
      if (mesh.parent && mesh.parent !== this.model) {
        mesh.parent.updateMatrix();
        tmp.applyMatrix4(mesh.parent.matrix);
      }
      tmp.applyMatrix4(this.model.matrix);
      out.union(tmp);
    }
    this.model.scale.setScalar(prevScale);
    return out;
  }

  /** Convert a world point into `model` space (unscaled book units). */
  toModel(world: Vector3, out: Vector3): Vector3 {
    this.model.updateWorldMatrix(true, false);
    return this.model.worldToLocal(out.copy(world));
  }

  // ------------------------------------------------------------------
  // Size, PDF, spread
  // ------------------------------------------------------------------

  /** Apply the BOOK SIZE setting (1 = 100%). */
  setScale(s: number): void {
    this.size = s;
    if (!this.assemble) this.model.scale.setScalar(s);
  }

  /**
   * Swap in a new PDF and play the "assemble into a book" animation.
   * `startLeft` = spread to open at (e.g. the saved reading position).
   */
  setPages(pages: PdfPages, startLeft = -1): void {
    this.pages?.dispose();
    this.pages = pages;
    this.left = this.validLeft(startLeft);
    this.pageWidth = PAGE_HEIGHT * MathUtils.clamp(pages.aspect, 0.4, 1.6);
    this.blockT = Book.blockThickness(pages.pageCount);
    const split = this.targetSplit();
    this.shownLeftT = split.l;
    this.shownRightT = split.r;
    this.turn = null;
    this.leaf.visible = false;
    pages.onPageReady = () => this.refresh();
    this.layout();
    this.startAssemble();
    this.refresh();
  }

  /** Spread indexes are -1, 1, 3, 5... and must exist in this PDF. */
  private validLeft(left: number): number {
    const n = this.pageCount;
    if (!Number.isInteger(left) || left < -1 || left > n - 1) return -1;
    return left % 2 === 0 ? left - 1 : left; // snap to an odd index (or -1)
  }

  // ------------------------------------------------------------------
  // Page turning
  // ------------------------------------------------------------------

  canTurn(dir: TurnDir): boolean {
    if (!this.pages) return false;
    return dir === 1 ? this.left + 1 <= this.pageCount - 1 : this.left >= 0;
  }

  /** Animated turn triggered by a button / swipe / thumbstick. */
  turnPage(dir: TurnDir): void {
    if (this.isBusy || !this.canTurn(dir)) return;
    this.beginTurn(dir, false);
  }

  /** Start dragging a page with a hand/controller. Returns false if not possible. */
  beginDrag(dir: TurnDir): boolean {
    if (this.isBusy || !this.canTurn(dir)) return false;
    this.beginTurn(dir, true);
    return true;
  }

  /**
   * While dragging: `localX` is the hand position in model space. At the
   * right edge the leaf lies on the right; at the left edge, on the left.
   */
  dragTo(localX: number): void {
    if (!this.turn?.dragging) return;
    const w = this.surface.halfWidth;
    this.leafP = MathUtils.clamp((w - localX) / (2 * w), 0, 1);
  }

  /** Let go of a dragged page: finish the turn if past halfway, else fall back. */
  endDrag(): void {
    if (!this.turn?.dragging) return;
    this.turn.dragging = false;
    this.turn.target = this.leafP > 0.5 ? 1 : 0;
  }

  get isDragging(): boolean {
    return this.turn?.dragging ?? false;
  }

  private beginTurn(dir: TurnDir, dragging: boolean): void {
    const L = this.left;
    if (dir === 1) {
      // Lift the right page: front = L+1, back = L+2, uncover L+3 beneath.
      this.setMat(this.leafFront, L + 1);
      this.setMat(this.leafBack, L + 2);
      this.setMat(this.rightPage, L + 3);
      this.leafP = 0;
    } else {
      // Lift the left page: back = L, front = L-1, uncover L-2 beneath.
      this.setMat(this.leafFront, L - 1);
      this.setMat(this.leafBack, L);
      this.setMat(this.leftPage, L - 2);
      this.leafP = 1;
    }
    this.leaf.visible = true;
    this.turn = { dir, dragging, target: dir === 1 ? 1 : 0 };
  }

  /** Called when the leaf reaches its target. */
  private finishTurn(): void {
    const t = this.turn!;
    const committed = (t.dir === 1 && t.target === 1) || (t.dir === -1 && t.target === 0);
    this.turn = null;
    this.leaf.visible = false;
    if (committed) {
      this.left += 2 * t.dir;
      this.onSpreadChange(this.left);
    }
    this.refresh();
  }

  // ------------------------------------------------------------------
  // Intro animation: page "cards" fly together, cover shuts, book opens
  // ------------------------------------------------------------------

  private startAssemble(): void {
    this.assemble = { t: 0 };
    this.cardGroup.visible = true;
    for (let i = 0; i < this.cards.length; i++) {
      const tex = this.pages?.get(this.left + 1 + i) ?? null;
      this.cards[i].material.map = tex;
      this.cards[i].material.color.set(tex ? 0xffffff : PAPER);
      this.cards[i].material.needsUpdate = true;
    }
  }

  private updateAssemble(dt: number): void {
    const a = this.assemble!;
    a.t += dt;
    const w = this.pageWidth;
    const h = this.pageHeight;
    const T = ASSEMBLE_SECONDS;

    // Phase 1 (0 - 40%): cards fly from a fan into a stack on the right page.
    const p1 = ease(MathUtils.clamp(a.t / (T * 0.4), 0, 1));
    const rightTop = this.shownRightT + 0.002;
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i];
      const spread = (i - (this.cards.length - 1) / 2) / this.cards.length;
      // fan position: spread out in a gentle arc above the book
      const fx = spread * w * 3.2;
      const fy = h * 0.35 + Math.cos(spread * 2.5) * h * 0.25;
      const fz = 0.06 + i * 0.004;
      // target: lying on the right page (tilted like the right half)
      const tx = (w / 2) * Math.cos(HALF_TILT) + this.gutter;
      const tz = (w / 2) * Math.sin(HALF_TILT) + rightTop + i * 0.0012;
      card.position.set(MathUtils.lerp(fx, tx, p1), MathUtils.lerp(fy, 0, p1), MathUtils.lerp(fz, tz, p1));
      card.rotation.set(0, MathUtils.lerp(0, -HALF_TILT, p1), MathUtils.lerp(-spread * 0.9, 0, p1));
      card.scale.set(w * (0.6 + 0.4 * p1), h * (0.6 + 0.4 * p1), 1);
    }
    if (a.t > T * 0.4) this.cardGroup.visible = false;

    // Phase 2 (40 - 55%): the left cover swings SHUT over the pages.
    // Phase 3 (55 - 100%): it swings OPEN again to 145 degrees.
    const closedAngle = Math.PI - HALF_TILT; // left half folded onto the right
    const p2 = ease(MathUtils.clamp((a.t - T * 0.4) / (T * 0.15), 0, 1));
    const p3 = ease(MathUtils.clamp((a.t - T * 0.55) / (T * 0.45), 0, 1));
    const angle =
      a.t < T * 0.55
        ? MathUtils.lerp(HALF_TILT, closedAngle, p2)
        : MathUtils.lerp(closedAngle, HALF_TILT, p3);
    this.halves.left.rotation.set(0, angle, 0);

    // A tiny "pop" in size while the book forms.
    const pop = a.t < T * 0.55 ? 1 + 0.06 * Math.sin((a.t / (T * 0.55)) * Math.PI) : 1;
    this.model.scale.setScalar(this.size * pop);

    if (a.t >= T) {
      this.assemble = null;
      this.model.scale.setScalar(this.size);
      this.halves.left.rotation.set(0, HALF_TILT, 0);
      this.refresh();
    }
  }

  // ------------------------------------------------------------------
  // Per-frame update + helpers
  // ------------------------------------------------------------------

  update(dt: number): void {
    if (this.assemble) {
      this.updateAssemble(dt);
    } else if (this.turn && !this.turn.dragging) {
      // Move leafP toward its target at a constant speed, then ease visually.
      const step = dt / TURN_SECONDS;
      this.leafP =
        this.turn.target === 1 ? Math.min(1, this.leafP + step) : Math.max(0, this.leafP - step);
      if (this.leafP === this.turn.target) this.finishTurn();
    }
    if (this.leaf.visible) {
      const shown = this.turn?.dragging ? this.leafP : ease(this.leafP);
      // Hinge angle: -17.5 deg = lying on the right half, -(180 - 17.5) deg
      // = lying on the left half. Swinging through the middle lifts the free
      // edge toward the reader (+z), like a real page.
      this.leaf.rotation.y = -HALF_TILT - (Math.PI - 2 * HALF_TILT) * shown;
      // The hinge sits on top of the block the leaf is lying on: blend from
      // the right block's top (start) to the left block's top (end).
      const s = Math.sin(HALF_TILT);
      const cz = Math.cos(HALF_TILT);
      const rx = this.gutter - this.shownRightT * s;
      const lx = -this.gutter + this.shownLeftT * s;
      this.leaf.position.set(
        MathUtils.lerp(rx, lx, shown),
        0,
        MathUtils.lerp(this.shownRightT, this.shownLeftT, shown) * cz +
          0.0015 +
          Math.sin(shown * Math.PI) * 0.01, // lift mid-turn: no flicker
      );
    }
    // Slide page-stack thickness toward the current spread (smoothly, so you
    // see the stack grow on the left as you read).
    const target = this.targetSplit();
    if (Math.abs(target.l - this.shownLeftT) > 1e-5) {
      const k = 1 - Math.exp(-dt * 8);
      this.shownLeftT += (target.l - this.shownLeftT) * k;
      this.shownRightT = this.blockT - this.shownLeftT;
      this.layout();
    }
  }

  /** Re-apply textures for the current spread (e.g. after a page finished rendering). */
  refresh(): void {
    if (this.assemble) {
      // Keep the intro cards up to date as textures arrive.
      for (let i = 0; i < this.cards.length; i++) {
        const tex = this.pages?.get(this.left + 1 + i) ?? null;
        if (tex && this.cards[i].material.map !== tex) {
          this.cards[i].material.map = tex;
          this.cards[i].material.color.set(0xffffff);
          this.cards[i].material.needsUpdate = true;
        }
      }
    } else if (this.turn) {
      return; // mid-turn materials are managed by beginTurn
    }
    this.setMat(this.leftPage, this.left);
    this.setMat(this.rightPage, this.left + 1);
    this.pages?.keepAround(this.left + 1);
  }

  /** Point a page mesh at page `index` (blank paper / inside cover if unavailable). */
  private setMat(mesh: Mesh<PlaneGeometry, MeshBasicMaterial>, index: number): void {
    const mat = mesh.material;
    const tex: Texture | null = this.pages?.get(index) ?? null;
    if (mat.map !== tex) {
      mat.map = tex;
      mat.needsUpdate = true; // shader changes when a map is added/removed
    }
    mat.color.set(tex ? 0xffffff : index < 0 ? INSIDE_COVER : PAPER);
  }
}

/**
 * A 64x64 canvas with fine horizontal lines, tiled over the page blocks so
 * their edges look like stacked sheets of paper. Made in code: no download.
 */
function makePageEdgeTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f3ecdc';
  g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 2) {
    g.fillStyle = y % 8 === 0 ? 'rgba(120,100,70,0.22)' : 'rgba(120,100,70,0.1)';
    g.fillRect(0, y, 64, 1);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

/**
 * A unit box whose texture coordinates are rewritten so that on every SIDE
 * face the texture's v axis runs through the THICKNESS (local z). Then the
 * horizontal lines of makePageEdgeTexture() lie parallel to the pages on
 * the fore-edge and on the top/bottom edges alike.
 */
function makeBlockGeometry(): BoxGeometry {
  const geo = new BoxGeometry(1, 1, 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const n = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + 0.5;
    const y = pos.getY(i) + 0.5;
    const z = pos.getZ(i) + 0.5;
    if (Math.abs(n.getX(i)) > 0.5) uv.setXY(i, y, z); // fore-edge / spine side
    else if (Math.abs(n.getY(i)) > 0.5) uv.setXY(i, x, z); // top / bottom edge
  }
  uv.needsUpdate = true;
  return geo;
}
