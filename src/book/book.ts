/**
 * Book — the 3D book: meshes, the open spread, and page-turn animations.
 *
 * Anatomy (all in the book's LOCAL space; origin = middle of the spine):
 *
 *            y
 *            ^        leftPage   |   rightPage
 *            |      +------------+------------+
 *            |      |  page L    |  page L+1  |     pages face +z (toward you)
 *            +---> x+------------+------------+
 *                                ^ spine (x = 0)
 *
 *  - `leftPage` / `rightPage`: two flat planes showing the open spread.
 *  - `leaf`: ONE extra sheet, hinged at the spine, that only appears while a
 *    page is turning. Its FRONT shows the page being lifted and its BACK
 *    shows the next page. Rotating the hinge from 0 to -180 degrees (around y)
 *    swings it from the right side to the left side.
 *
 *  So at most 5 meshes are drawn -> 5 draw calls. Cheap on Quest.
 *
 *  Spread state: `left` = index of the page on the left (-1 = inside cover).
 *  Right page is always left + 1.
 */
import {
  BoxGeometry,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
} from '@iwsdk/core';
import type { PdfPages } from './pdf-pages.js';

const PAGE_HEIGHT = 0.21; // meters (A5 height) - fits in a hand, readable up close
const TURN_SECONDS = 0.45;
const ASSEMBLE_SECONDS = 1.3;
const CARD_COUNT = 6;

const PAPER = 0xfbf7ee;
const INSIDE_COVER = 0x5b2a1c;

type TurnDir = 1 | -1;

/** Smooth ease in/out: slow start, fast middle, slow end. */
const ease = (t: number) => t * t * (3 - 2 * t);

export class Book {
  /** Move/rotate THIS to move the whole book. */
  readonly root = new Group();
  /** Big invisible-ish box used for grabbing & ray hits. */
  readonly hitMesh: Mesh;

  pageWidth = PAGE_HEIGHT * 0.707;
  readonly pageHeight = PAGE_HEIGHT;

  private pages: PdfPages | null = null;
  private left = -1;

  private readonly pageGeo = new PlaneGeometry(1, 1);
  private readonly leftPage: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly rightPage: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly leaf = new Group(); // the hinge; child meshes are the sheet
  private readonly leafFront: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly leafBack: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly cover: Mesh;
  private readonly coverMat = new MeshBasicMaterial({ color: 0x7a3322 });
  /** The leaf front's own page material (the intro temporarily swaps in coverMat). */
  private readonly leafFrontPageMat: MeshBasicMaterial;

  /** Leaf progress: 0 = lying on the right, 1 = lying on the left. */
  private leafP = 0;
  private turn: {
    dir: TurnDir;
    dragging: boolean;
    target: 0 | 1;
    onDone?: () => void;
  } | null = null;

  /** The "PDF becomes a book" intro animation. */
  private assemble: { t: number } | null = null;
  private readonly cards: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private readonly cardGroup = new Group();

  constructor() {
    const makePage = () =>
      new Mesh(this.pageGeo, new MeshBasicMaterial({ color: PAPER }));
    this.leftPage = makePage();
    this.rightPage = makePage();
    this.leafFront = makePage();
    this.leafBack = makePage();
    this.leafFrontPageMat = this.leafFront.material;
    // The back of the leaf faces -z: rotate it half a turn around its own
    // vertical center line so its texture is not mirrored.
    this.leafBack.rotation.y = Math.PI;
    this.leaf.add(this.leafFront, this.leafBack);
    this.leaf.visible = false;

    // A thin box behind the pages = the hard cover. Standard material so the
    // room lighting touches it a little.
    this.cover = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: 0x6e2c1d, roughness: 0.8 }),
    );
    this.hitMesh = this.cover;

    this.root.add(this.cover, this.leftPage, this.rightPage, this.leaf);

    // Cards used only by the intro animation (hidden otherwise).
    for (let i = 0; i < CARD_COUNT; i++) {
      const card = new Mesh(
        this.pageGeo,
        new MeshBasicMaterial({ color: PAPER, side: DoubleSide }),
      );
      this.cards.push(card);
      this.cardGroup.add(card);
    }
    this.cardGroup.visible = false;
    this.root.add(this.cardGroup);

    this.layout();
  }

  /** Size all meshes to the current page aspect ratio. */
  private layout(): void {
    const w = this.pageWidth;
    const h = this.pageHeight;
    for (const m of [
      this.leftPage,
      this.rightPage,
      this.leafFront,
      this.leafBack,
      ...this.cards,
    ]) {
      m.scale.set(w, h, 1);
    }
    this.leftPage.position.set(-w / 2, 0, 0.002);
    this.rightPage.position.set(w / 2, 0, 0.002);
    this.leafFront.position.set(w / 2, 0, 0);
    this.leafBack.position.set(w / 2, 0, -0.0005);
    this.leaf.position.set(0, 0, 0.004);
    this.cover.scale.set(w * 2 + 0.012, h + 0.012, 0.008);
    this.cover.position.set(0, 0, -0.003);
  }

  get pageCount(): number {
    return this.pages?.pageCount ?? 0;
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

  /** Swap in a new PDF and play the "assemble into a book" animation. */
  setPages(pages: PdfPages): void {
    this.pages?.dispose();
    this.pages = pages;
    this.left = -1;
    this.pageWidth = PAGE_HEIGHT * MathUtils.clamp(pages.aspect, 0.4, 1.6);
    this.layout();
    pages.onPageReady = () => this.refresh();
    this.turn = null;
    this.startAssemble();
    this.refresh();
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
   * While dragging: `localX` is the hand position in book space. At the
   * right edge (x = +w) the leaf is flat on the right; at x = -w it is
   * flat on the left.
   */
  dragTo(localX: number): void {
    if (!this.turn?.dragging) return;
    const w = this.pageWidth;
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
    if (committed) this.left += 2 * t.dir;
    this.turn = null;
    this.leaf.visible = false;
    this.refresh();
    t.onDone?.();
  }

  // ------------------------------------------------------------------
  // Intro animation: page "cards" fly together, cover closes, book opens
  // ------------------------------------------------------------------

  private startAssemble(): void {
    this.assemble = { t: 0 };
    this.cardGroup.visible = true;
    for (let i = 0; i < this.cards.length; i++) {
      const tex = this.pages?.get(i) ?? null;
      this.cards[i].material.map = tex;
      this.cards[i].material.color.set(tex ? 0xffffff : PAPER);
      this.cards[i].material.needsUpdate = true;
    }
    // Start with the cover lying closed on the right: the leaf, showing the
    // cover material on its front.
    this.leafFront.material = this.coverMat;
    this.setMat(this.leafBack, -1);
    this.leaf.visible = false;
  }

  private updateAssemble(dt: number): void {
    const a = this.assemble!;
    a.t += dt;
    const w = this.pageWidth;
    const h = this.pageHeight;
    const T = ASSEMBLE_SECONDS;

    // Phase 1 (0 - 45%): cards fly from a fan into a stack on the right page.
    const p1 = ease(MathUtils.clamp(a.t / (T * 0.45), 0, 1));
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i];
      const spread = (i - (this.cards.length - 1) / 2) / this.cards.length;
      // fan position: spread out in a gentle arc above the book
      const fx = spread * w * 3.2;
      const fy = h * 0.35 + Math.cos(spread * 2.5) * h * 0.25;
      const fz = 0.06 + i * 0.004;
      card.position.set(
        MathUtils.lerp(fx, w / 2, p1),
        MathUtils.lerp(fy, 0, p1),
        MathUtils.lerp(fz, 0.006 + i * 0.0015, p1),
      );
      card.rotation.z = MathUtils.lerp(-spread * 0.9, 0, p1);
      card.scale.set(w * (0.6 + 0.4 * p1), h * (0.6 + 0.4 * p1), 1);
    }

    // While "closed", only the right half of the book exists.
    const closed = a.t < T * 0.55;
    this.leftPage.visible = !closed;
    this.cover.scale.x = closed ? w + 0.006 : w * 2 + 0.012;
    this.cover.position.x = closed ? w / 2 + 0.003 : 0;

    // Phase 2 (45% - 55%): stack disappears under a closed cover.
    if (a.t > T * 0.45) {
      this.cardGroup.visible = false;
      this.leaf.visible = true;
    }
    // Phase 3 (55% - 100%): the cover swings open to the left.
    const p3 = ease(MathUtils.clamp((a.t - T * 0.55) / (T * 0.45), 0, 1));
    this.leafP = p3;
    // a tiny "pop" in scale when the book forms
    const pop = a.t < T * 0.55 ? 1 + 0.06 * Math.sin((a.t / (T * 0.55)) * Math.PI) : 1;
    this.root.scale.setScalar(pop);

    if (a.t >= T) {
      this.assemble = null;
      this.root.scale.setScalar(1);
      this.leaf.visible = false;
      this.leafFront.material = this.leafFrontPageMat;
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
        this.turn.target === 1
          ? Math.min(1, this.leafP + step)
          : Math.max(0, this.leafP - step);
      if (this.leafP === this.turn.target) this.finishTurn();
    }
    if (this.leaf.visible) {
      const shown = this.turn?.dragging ? this.leafP : ease(this.leafP);
      // Rotate the hinge: 0 rad = flat right, -PI = flat left. Negative angles
      // swing the free edge TOWARD the reader (+z), like a real page.
      this.leaf.rotation.y = -Math.PI * shown;
      // lift slightly mid-turn so it never z-fights with the static pages
      this.leaf.position.z = 0.004 + Math.sin(shown * Math.PI) * 0.01;
    }
  }

  /** Re-apply textures for the current spread (e.g. after a page finished rendering). */
  refresh(): void {
    if (this.assemble) {
      // Keep the intro cards up to date as textures arrive.
      for (let i = 0; i < this.cards.length; i++) {
        const tex = this.pages?.get(i) ?? null;
        if (tex && this.cards[i].material.map !== tex) {
          this.cards[i].material.map = tex;
          this.cards[i].material.color.set(0xffffff);
          this.cards[i].material.needsUpdate = true;
        }
      }
      this.setMat(this.rightPage, this.left + 1);
      this.setMat(this.leftPage, this.left);
      return;
    }
    if (this.turn) return; // mid-turn materials are managed by beginTurn
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
