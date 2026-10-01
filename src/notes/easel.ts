/**
 * Easel — the whiteboard, its wooden easel and tray, and the easel's buttons.
 *
 * PLACEMENT (spec item 4): the easel is a child of the room's `area` and is
 * placed from the room's SEAT pose, so it sits in the same spot relative to
 * you in every room. Numbers (seat frame: "right" = your right, "forward" =
 * the way you face when seated):
 *   - board center 0.80 m to your RIGHT and 0.15 m FORWARD of your eyes'
 *     floor point, turned to face the seat (~79° to your right),
 *   - board center 1.10 m above the floor (seated shoulder/eye height is
 *     ~1.0-1.2 m), leaning back 5° like a real easel.
 * WHY these: your right shoulder is ~0.2 m right of your head, so the board
 * plane is ~0.6 m from it: inside a seated arm + 8.5 cm of marker, without
 * standing up. Tuned for the glass-door (pool) room: its desk ends 0.5 m to
 * your right, so the board (front edge at x ≈ 0.67 m) clears it. Easy to tune:
 * change PLACEMENT below.
 *
 * FRAMES:
 *   root  = on the floor under the board center, turned to face the seat.
 *   board = tilted pivot at the board center; local z = 0 IS the writing
 *           surface, +Z points out of it toward you, +X to your right as you
 *           look at it, +Y up. Tools on the tray are children of `board`.
 *
 * DRAW CALLS: wood + aluminium frame + tray = 1 mesh (vertex colors), the
 * board surface = 1, both page bars + the control panel = 1 (they share one
 * canvas "atlas" texture), the Load list = 1 (only while open), the cursor
 * dot and eraser ring = 1 each (only while near the board).
 */
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
} from '@iwsdk/core';
import { merge } from '../room/geometry-utils.js';
import type { SeatPose } from '../room/room-types.js';
import { boardSize, type Orientation } from './notes-model.js';
import { paint } from './tools.js';

/** Seat-relative placement. See the header for the reasoning. */
export const PLACEMENT = {
  right: 0.8,
  forward: 0.15,
  centerY: 1.1,
  tiltDeg: 5,
};

/** Page bars: 9 x 70 cm, centered on the board's height (reachable when seated). */
const BAR_W = 0.09;
const BAR_H = 0.7;
const BAR_GAP = 0.05; // from the board edge
/** Control panel: 27 x 36 cm, left of the left bar, turned 25° more toward you. */
const PANEL_W = 0.27;
const PANEL_H = 0.36;
const PANEL_TURN = 0.44;
/** Load list: 42 x 56 cm, floating 4 cm in front of the board's left half. */
const LOAD_W = 0.42;
const LOAD_H = 0.56;

/** Atlas layout (canvas px). One 1024 x 1024 texture for bars + panel. */
const ATLAS = 1024;
const R_PREV = { x: 0, y: 12, w: 128, h: 1000 };
const R_NEXT = { x: 128, y: 12, w: 128, h: 1000 };
const R_PANEL = { x: 256, y: 0, w: 768, h: 1024 };

type Region = { x: number; y: number; w: number; h: number };

export interface PanelButton {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EaselUiState {
  pageLabel: string;
  canPrev: boolean;
  isLast: boolean;
  orientation: Orientation;
  status: string;
  busy: boolean;
  penColor: string;
  hovered: string | null;
}

export interface LoadEntry {
  id: string;
  label: string;
}

/** A flat button area in some local frame, for fingertip pokes. */
interface PokePlane {
  /** board-space -> plane-space */
  inverse: Matrix4;
  w: number;
  h: number;
  /** Map plane-local (x, y) to a button id. */
  hit: (x: number, y: number) => string | null;
}

const tmpV = new Vector3();

export class Easel {
  readonly root = new Group();
  readonly board = new Group();
  readonly surface: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly cursor: Mesh<CircleGeometry, MeshBasicMaterial>;
  readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  /** Where the marker and eraser lie on the tray (children of `board`). */
  readonly markerHome = new Object3D();
  readonly eraserHome = new Object3D();
  readonly loadPanel: Mesh<PlaneGeometry, MeshBasicMaterial>;

  orientation: Orientation = 'portrait';
  w = 1;
  h = 1;

  private readonly structure: Mesh;
  private readonly ui: Mesh;
  private readonly atlas = document.createElement('canvas');
  private readonly atlasTex: CanvasTexture;
  private readonly loadCanvas = document.createElement('canvas');
  private readonly loadTex: CanvasTexture;
  private panelButtons: PanelButton[] = [];
  private loadButtons: PanelButton[] = [];
  private pokePlanes: PokePlane[] = [];
  private loadPoke: PokePlane | null = null;
  private lastUi = '';
  private loadHovered: string | null = null;
  private loadEntries: LoadEntry[] = [];
  private loadTitle = '';

  constructor() {
    this.root.name = 'easel';
    this.board.rotation.x = -(PLACEMENT.tiltDeg * Math.PI) / 180; // top leans away from you
    this.board.position.y = PLACEMENT.centerY;
    this.root.add(this.board);

    // Writing surface: a 1 x 1 plane scaled to the board size per layout.
    // UVs are flipped vertically because the board texture has flipY off
    // (see board-canvas.ts): canvas row 0 = top of the board.
    const plane = new PlaneGeometry(1, 1);
    const uv = plane.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    // MeshBasicMaterial: unlit, so ink reads the same in every room's light
    // and it costs the GPU less than a lit material. Slightly off-white so it
    // doesn't glare in the headset.
    this.surface = new Mesh(plane, new MeshBasicMaterial({ color: 0xf4f4f2 }));
    this.surface.name = 'whiteboard';
    this.board.add(this.surface, this.markerHome, this.eraserHome);

    this.structure = new Mesh(undefined, new MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
    this.root.add(this.structure);

    this.atlas.width = this.atlas.height = ATLAS;
    this.atlasTex = new CanvasTexture(this.atlas);
    this.atlasTex.colorSpace = SRGBColorSpace;
    this.ui = new Mesh(undefined, new MeshBasicMaterial({ map: this.atlasTex }));
    this.ui.name = 'easel-ui';
    this.board.add(this.ui);

    this.loadCanvas.width = 512;
    this.loadCanvas.height = Math.round((512 * LOAD_H) / LOAD_W);
    this.loadTex = new CanvasTexture(this.loadCanvas);
    this.loadTex.colorSpace = SRGBColorSpace;
    this.loadPanel = new Mesh(new PlaneGeometry(LOAD_W, LOAD_H), new MeshBasicMaterial({ map: this.loadTex }));
    this.loadPanel.visible = false;
    this.board.add(this.loadPanel);

    // Contact helpers: drawn just in front of the surface (1.5 mm) so they
    // never z-fight with it. Hidden until a tool is within snap distance.
    this.cursor = new Mesh(new CircleGeometry(1, 24), new MeshBasicMaterial({ color: 0x000000 }));
    this.ring = new Mesh(
      new RingGeometry(0.9, 1, 48),
      new MeshBasicMaterial({ color: 0x333333, side: DoubleSide, transparent: true, opacity: 0.85 }),
    );
    this.cursor.visible = this.ring.visible = false;
    this.board.add(this.cursor, this.ring);

    this.layout('portrait');
  }

  /** Put the easel at the seat-relative spot in a room's `area`. */
  placeForSeat(seat: SeatPose): void {
    // Seat frame: forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw).
    const s = Math.sin(seat.yaw);
    const c = Math.cos(seat.yaw);
    const x = seat.x + c * PLACEMENT.right - s * PLACEMENT.forward;
    const z = seat.z - s * PLACEMENT.right - c * PLACEMENT.forward;
    this.root.position.set(x, 0, z);
    // Turn the board's +Z (its face) toward the seat: yaw = atan2(dx, dz).
    this.root.rotation.set(0, Math.atan2(seat.x - x, seat.z - z), 0);
    this.root.updateMatrixWorld(true);
  }

  /** Rebuild everything that depends on portrait/landscape. */
  layout(o: Orientation): void {
    this.orientation = o;
    const { w, h } = boardSize(o);
    this.w = w;
    this.h = h;
    this.surface.scale.set(w, h, 1);
    this.buildStructure();
    this.buildUi();
    // Tray homes (tray top is 3.5 cm below the board's bottom edge).
    const trayY = -h / 2 - 0.035;
    // Marker lying along the tray, tip pointing to the right (−Z -> +X).
    this.markerHome.position.set(-0.3, trayY + 0.0095, 0.035);
    this.markerHome.rotation.set(0, -Math.PI / 2, 0);
    // Eraser felt-down: rotate −90° about X so its −Z face points down.
    this.eraserHome.position.set(0.3, trayY + 0.0836, 0.035);
    this.eraserHome.rotation.set(-Math.PI / 2, 0, 0);
    this.loadPanel.position.set(-w / 2 + LOAD_W / 2 + 0.08, 0, 0.04);
    this.lastUi = ''; // force a UI redraw
    this.root.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------
  // Geometry
  // ------------------------------------------------------------------

  private buildStructure(): void {
    const { w, h } = this;
    const tilt = this.board.rotation.x;
    // board space -> root space (the board pivot's transform).
    const M = new Matrix4().compose(
      new Vector3(0, PLACEMENT.centerY, 0),
      new Quaternion().setFromEuler(new Euler(tilt, 0, 0)),
      new Vector3(1, 1, 1),
    );
    const WOOD = 0x8a5a36;
    const WOOD_DARK = 0x6b4329;
    const ALU = 0xb9bec4;
    const parts: BufferGeometry[] = [];
    const inBoard = (g: BufferGeometry) => parts.push(g.applyMatrix4(M));
    const boxAt = (bw: number, bh: number, bd: number, x: number, y: number, z: number, color: number) => {
      const g = paint(new BoxGeometry(bw, bh, bd), color);
      g.translate(x, y, z);
      return g;
    };
    const F = 0.03; // aluminium frame width
    // Backing board (just behind the surface) + aluminium frame, 6 mm proud.
    inBoard(boxAt(w, h, 0.016, 0, 0, -0.0085, 0xe9e9e6));
    inBoard(boxAt(w + 2 * F, F, 0.026, 0, h / 2 + F / 2, -0.007, ALU));
    inBoard(boxAt(w + 2 * F, F, 0.026, 0, -h / 2 - F / 2, -0.007, ALU));
    inBoard(boxAt(F, h, 0.026, -w / 2 - F / 2, 0, -0.007, ALU));
    inBoard(boxAt(F, h, 0.026, w / 2 + F / 2, 0, -0.007, ALU));
    // Tray: a shelf under the board with a front lip.
    const trayY = -h / 2 - 0.035;
    inBoard(boxAt(w + 0.12, 0.018, 0.085, 0, trayY - 0.009, 0.03, WOOD));
    inBoard(boxAt(w + 0.12, 0.022, 0.012, 0, trayY + 0.011, 0.072, WOOD));
    // Front legs at both sides, from the floor to above the board. In board
    // space the floor is at y = -centerY / cos(tilt).
    const legX = w / 2 + F + 0.03;
    const floorY = -PLACEMENT.centerY / Math.cos(tilt);
    const legTop = h / 2 + 0.12;
    for (const sx of [-1, 1]) {
      inBoard(boxAt(0.045, legTop - floorY, 0.032, sx * legX, (legTop + floorY) / 2, -0.03, WOOD));
    }
    // Clamp block on top of the board.
    inBoard(boxAt(0.16, 0.05, 0.05, 0, h / 2 + F + 0.02, -0.01, WOOD_DARK));
    // Back leg: from behind the top of the board down to the floor 0.55 m back.
    const top = new Vector3(0, h / 2 + 0.08, -0.06).applyMatrix4(M);
    parts.push(beam(top, new Vector3(0, 0, -0.6), 0.04, WOOD));
    // Page-bar backings and the control panel's backing + support arm.
    for (const sx of [-1, 1]) {
      const bx = sx * (w / 2 + BAR_GAP + BAR_W / 2);
      inBoard(boxAt(BAR_W + 0.02, BAR_H + 0.02, 0.02, bx, 0, -0.011, WOOD_DARK));
    }
    const panel = this.panelMatrix();
    const back = paint(new BoxGeometry(PANEL_W + 0.02, PANEL_H + 0.02, 0.02), WOOD_DARK);
    back.translate(0, 0, -0.011);
    parts.push(back.applyMatrix4(panel.clone().premultiply(M)));
    const armA = new Vector3(-legX, 0, -0.03).applyMatrix4(M);
    const armB = new Vector3(0, 0, -0.02).applyMatrix4(panel).applyMatrix4(M);
    parts.push(beam(armA, armB, 0.025, WOOD));

    const old = this.structure.geometry;
    this.structure.geometry = merge(parts);
    old?.dispose();
  }

  /** Control panel pose in board space: left of the left bar, turned toward you. */
  private panelMatrix(): Matrix4 {
    const x = -(this.w / 2 + BAR_GAP + BAR_W + 0.06 + (PANEL_W / 2) * Math.cos(PANEL_TURN));
    return new Matrix4().compose(
      new Vector3(x, 0, (PANEL_W / 2) * Math.sin(PANEL_TURN)),
      new Quaternion().setFromEuler(new Euler(0, PANEL_TURN, 0)),
      new Vector3(1, 1, 1),
    );
  }

  private buildUi(): void {
    const { w } = this;
    const bars: { m: Matrix4; r: Region; pw: number; ph: number; id: (x: number, y: number) => string | null }[] = [];
    const barM = (sx: number) =>
      new Matrix4().makeTranslation(sx * (w / 2 + BAR_GAP + BAR_W / 2), 0, 0.001);
    bars.push({ m: barM(-1), r: R_PREV, pw: BAR_W, ph: BAR_H, id: () => 'prev' });
    bars.push({ m: barM(1), r: R_NEXT, pw: BAR_W, ph: BAR_H, id: () => 'next' });
    const pm = this.panelMatrix();
    pm.multiply(new Matrix4().makeTranslation(0, 0, 0.001));
    bars.push({
      m: pm,
      r: R_PANEL,
      pw: PANEL_W,
      ph: PANEL_H,
      id: (x, y) => this.panelButtonAt((x / PANEL_W + 0.5) * R_PANEL.w, (0.5 - y / PANEL_H) * R_PANEL.h),
    });
    const geos: BufferGeometry[] = [];
    this.pokePlanes = [];
    for (const b of bars) {
      const g = new PlaneGeometry(b.pw, b.ph);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        // Atlas has the default flipY = true: v = 1 is the canvas TOP.
        uv.setXY(i, (b.r.x + uv.getX(i) * b.r.w) / ATLAS, 1 - (b.r.y + (1 - uv.getY(i)) * b.r.h) / ATLAS);
      }
      geos.push(g.applyMatrix4(b.m));
      this.pokePlanes.push({ inverse: b.m.clone().invert(), w: b.pw, h: b.ph, hit: b.id });
    }
    const old = this.ui.geometry;
    this.ui.geometry = merge(geos);
    old?.dispose();
    this.loadPanel.updateMatrix();
  }

  // ------------------------------------------------------------------
  // UI drawing + hit testing
  // ------------------------------------------------------------------

  /** Redraw the atlas if anything it shows changed. Cheap to call every frame. */
  updateUi(s: EaselUiState): void {
    const key = JSON.stringify(s);
    if (key === this.lastUi) return;
    this.lastUi = key;
    const g = this.atlas.getContext('2d')!;
    g.clearRect(0, 0, ATLAS, ATLAS);
    // Page bars.
    const bar = (r: Region, glyph: string, label: string, enabled: boolean, hot: boolean) => {
      roundRect(g, r.x + 8, r.y, r.w - 16, r.h, 40);
      g.fillStyle = hot ? '#d9a55b' : enabled ? '#3c4a5c' : '#2b2f36';
      g.fill();
      g.fillStyle = hot ? '#1c1612' : enabled ? '#f3efe6' : '#6b7079';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = 'bold 92px sans-serif';
      g.fillText(glyph, r.x + r.w / 2, r.y + r.h / 2);
      g.font = 'bold 38px sans-serif';
      // Vertical label, one letter per line.
      [...label].forEach((ch, i) => g.fillText(ch, r.x + r.w / 2, r.y + 120 + i * 44));
    };
    bar(R_PREV, '◀', 'PREV', s.canPrev, s.hovered === 'prev');
    bar(R_NEXT, s.isLast ? '+' : '▶', s.isLast ? 'NEW' : 'NEXT', true, s.hovered === 'next');

    // Control panel.
    const P = R_PANEL;
    roundRect(g, P.x, P.y, P.w, P.h, 40);
    g.fillStyle = 'rgba(28, 22, 18, 0.95)';
    g.fill();
    g.fillStyle = '#f3e6cf';
    g.textAlign = 'center';
    g.font = 'bold 84px sans-serif';
    g.fillText(s.pageLabel, P.x + P.w / 2, P.y + 90);
    const rot = s.orientation === 'portrait' ? 'Rotate ⟳ (Landscape)' : 'Rotate ⟳ (Portrait)';
    const rows = [
      { id: 'rotate', label: rot },
      { id: 'save', label: 'Save' },
      { id: 'load', label: 'Load…' },
      { id: 'export', label: 'Export PDF' },
    ];
    this.panelButtons = rows.map((r, i) => ({ ...r, x: 40, y: 180 + i * 170, w: P.w - 80, h: 145 }));
    g.font = '60px sans-serif';
    for (const b of this.panelButtons) {
      roundRect(g, P.x + b.x, P.y + b.y, b.w, b.h, 28);
      const hot = s.hovered === b.id;
      g.fillStyle = hot ? '#d9a55b' : s.busy && b.id !== 'rotate' ? '#3a3029' : '#4a3a2e';
      g.fill();
      g.fillStyle = hot ? '#1c1612' : '#f3e6cf';
      g.fillText(b.label, P.x + b.x + b.w / 2, P.y + b.y + b.h / 2 + 2, b.w - 30);
    }
    // Status line + current marker color.
    g.beginPath();
    g.arc(P.x + 70, P.y + 935, 26, 0, Math.PI * 2);
    g.fillStyle = s.penColor;
    g.fill();
    g.strokeStyle = '#f3e6cf';
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = '#bfae94';
    g.font = '38px sans-serif';
    g.textAlign = 'left';
    g.fillText(s.status, P.x + 120, P.y + 937, P.w - 150);
    this.atlasTex.needsUpdate = true; // only when something changed
  }

  private panelButtonAt(px: number, py: number): string | null {
    const b = this.panelButtons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    return b?.id ?? null;
  }

  /** Button under a ray hit's UV on the UI mesh. */
  buttonAtUv(u: number, v: number): string | null {
    const px = u * ATLAS;
    const py = (1 - v) * ATLAS;
    const inR = (r: Region) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    if (inR(R_PREV)) return 'prev';
    if (inR(R_NEXT)) return 'next';
    if (inR(R_PANEL)) return this.panelButtonAt(px - R_PANEL.x, py - R_PANEL.y);
    return null;
  }

  /** Meshes a ray can hit: [ui, loadPanel (when open)]. */
  get uiMesh(): Mesh {
    return this.ui;
  }

  /**
   * Fingertip / tool-tip poke: is `boardPoint` (in BOARD space) touching a
   * button? `depth` = how far in front/behind the button counts (m).
   */
  pokeAt(boardPoint: Vector3, depth: number): string | null {
    if (this.loadPanel.visible && this.loadPoke) {
      const id = this.planeHit(this.loadPoke, boardPoint, depth);
      if (id) return id;
    }
    for (const p of this.pokePlanes) {
      const id = this.planeHit(p, boardPoint, depth);
      if (id) return id;
    }
    return null;
  }

  private planeHit(p: PokePlane, boardPoint: Vector3, depth: number): string | null {
    tmpV.copy(boardPoint).applyMatrix4(p.inverse);
    if (Math.abs(tmpV.z) > depth || Math.abs(tmpV.x) > p.w / 2 || Math.abs(tmpV.y) > p.h / 2) return null;
    return p.hit(tmpV.x, tmpV.y);
  }

  // ------------------------------------------------------------------
  // Load list panel
  // ------------------------------------------------------------------

  /** Show the Load list (entries already sliced to one screen). */
  showLoad(title: string, entries: LoadEntry[]): void {
    this.loadTitle = title;
    this.loadEntries = entries;
    this.loadHovered = null;
    this.drawLoad();
    this.loadPanel.visible = true;
    this.loadPanel.updateMatrix();
    const inv = this.loadPanel.matrix.clone().invert();
    const cw = this.loadCanvas.width;
    const ch = this.loadCanvas.height;
    this.loadPoke = {
      inverse: inv,
      w: LOAD_W,
      h: LOAD_H,
      hit: (x, y) => this.loadButtonAt((x / LOAD_W + 0.5) * cw, (0.5 - y / LOAD_H) * ch),
    };
  }

  hideLoad(): void {
    this.loadPanel.visible = false;
  }

  get loadOpen(): boolean {
    return this.loadPanel.visible;
  }

  setLoadHovered(id: string | null): void {
    if (id === this.loadHovered || !this.loadPanel.visible) return;
    this.loadHovered = id;
    this.drawLoad();
  }

  loadButtonAtUv(u: number, v: number): string | null {
    return this.loadButtonAt(u * this.loadCanvas.width, (1 - v) * this.loadCanvas.height);
  }

  private loadButtonAt(px: number, py: number): string | null {
    const b = this.loadButtons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    return b?.id ?? null;
  }

  private drawLoad(): void {
    const c = this.loadCanvas;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    roundRect(g, 0, 0, c.width, c.height, 26);
    g.fillStyle = 'rgba(28, 22, 18, 0.96)';
    g.fill();
    g.fillStyle = '#f3e6cf';
    g.font = 'bold 34px sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(this.loadTitle, 22, 36, c.width - 44);
    const rowH = 52;
    const gap = 8;
    const top = 74;
    this.loadButtons = this.loadEntries.map((e, i) => ({ ...e, x: 20, y: top + i * (rowH + gap), w: c.width - 40, h: rowH }));
    g.font = '27px sans-serif';
    for (const b of this.loadButtons) {
      roundRect(g, b.x, b.y, b.w, b.h, 12);
      const hot = b.id === this.loadHovered;
      g.fillStyle = hot ? '#d9a55b' : b.id.startsWith('load-') && /^\d/.test(b.id.slice(5)) ? '#4a3a2e' : '#2f251e';
      g.fill();
      g.fillStyle = hot ? '#1c1612' : '#f3e6cf';
      g.fillText(b.label, b.x + 16, b.y + rowH / 2 + 1, b.w - 32);
    }
    this.loadTex.needsUpdate = true;
  }

  // ------------------------------------------------------------------
  // Contact helpers
  // ------------------------------------------------------------------

  /** Show the marker's cursor dot at board-space (x, y). */
  showCursor(x: number, y: number, radius: number, color: string): void {
    this.cursor.position.set(x, y, 0.0015);
    this.cursor.scale.setScalar(Math.max(radius, 0.0012));
    this.cursor.material.color.set(color);
    this.cursor.visible = true;
  }

  showRing(x: number, y: number, radius: number): void {
    this.ring.position.set(x, y, 0.0015);
    this.ring.scale.setScalar(radius);
    this.ring.visible = true;
  }
}

/** A square beam from a to b (for slanted legs/arms), vertex-colored. */
function beam(a: Vector3, b: Vector3, t: number, color: number): BufferGeometry {
  const len = a.distanceTo(b);
  const g = paint(new BoxGeometry(t, len, t), color);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
