/**
 * Notes model — the whiteboard notebook as plain data. No three.js, no DOM.
 *
 * WHY keep this file "pure": everything here can run in Node, so the unit
 * tests (scripts/unit-notes.mjs) check strokes, pages and save/load without a
 * browser or a headset. The 3D board, the canvas and IndexedDB all sit on top
 * of this and only ever read/write these objects.
 *
 * Units: a stroke point is in METERS on the board, measured from the page's
 * TOP-LEFT corner (x to the right, y DOWN, like a canvas). Meters, not pixels,
 * so the same data can be drawn at 800 px/m on the live board and at 150 dpi
 * in the PDF export without any conversion bugs.
 */

// ---------------------------------------------------------------------------
// Board + tool constants (one place to tune them)
// ---------------------------------------------------------------------------

/** Whiteboard surface: 5 ft x 5.64705 ft. PORTRAIT = 5 ft wide, 5.647 ft tall. */
export const BOARD_SHORT_M = 1.524;
export const BOARD_LONG_M = 1.7212;

export type Orientation = 'portrait' | 'landscape';

/** Width/height (m) of the writable board for an orientation. */
export function boardSize(o: Orientation): { w: number; h: number } {
  return o === 'portrait' ? { w: BOARD_SHORT_M, h: BOARD_LONG_M } : { w: BOARD_LONG_M, h: BOARD_SHORT_M };
}

/**
 * Marker palette (menu "Marker color"). Dark, saturated colors read well on a
 * white board in a headset; light ones (yellow) would vanish, so none here.
 */
export const PEN_COLORS = [
  { name: 'Black', hex: '#1b1b1f' },
  { name: 'Blue', hex: '#1f5fd1' },
  { name: 'Red', hex: '#d0312d' },
  { name: 'Green', hex: '#1e8a3c' },
  { name: 'Orange', hex: '#e8730c' },
  { name: 'Purple', hex: '#7a3db8' },
  { name: 'Teal', hex: '#0f8c8c' },
  { name: 'Pink', hex: '#d63a8a' },
] as const;
export const DEFAULT_PEN_COLOR = PEN_COLORS[0].hex;

/**
 * Writing sizes = stroke RADIUS in millimeters (the line is twice as wide).
 * 2.5 mm radius (5 mm line) is a normal whiteboard marker; the board is big,
 * so the larger sizes are there for headings.
 */
export const PEN_SIZES_MM = [1.5, 2.5, 4, 6, 9] as const;
export const DEFAULT_PEN_SIZE_MM = 2.5;

/**
 * Eraser radius (m). Our call (see PR): a FIXED 3.5 cm circle, not tied to
 * the marker size. WHY: an eraser that shrinks to 1.5 mm when you pick a fine
 * marker would be useless, and 3.5 cm matches the felt face (10 x 4.5 cm).
 */
export const ERASER_RADIUS_M = 0.035;

/** The board's canvas color. Erasing paints this color (see notes-raster.ts). */
export const BOARD_COLOR = '#ffffff';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export type Tool = 'pen' | 'erase';

export interface Stroke {
  tool: Tool;
  /** CSS hex color (pen); erase strokes use BOARD_COLOR. */
  color: string;
  /** Radius in meters. */
  radius: number;
  /** Flat list x0, y0, x1, y1, ... in meters from the page's top-left. */
  points: number[];
}

export interface Page {
  orientation: Orientation;
  strokes: Stroke[];
}

/** Bounding box of some points, grown by `pad`. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function blankPage(orientation: Orientation): Page {
  return { orientation, strokes: [] };
}

/**
 * The notebook: a list of pages and which one is on the board.
 *
 * Navigation rules (spec item 5):
 *  - prev() on page 1 does nothing.
 *  - next() moves forward; on the LAST page it adds a new blank page first,
 *    with the same orientation as the page you are on.
 */
export class Notebook {
  pages: Page[] = [blankPage('portrait')];
  current = 0;

  get page(): Page {
    return this.pages[this.current];
  }
  get pageCount(): number {
    return this.pages.length;
  }
  /** "Page N / M" for the easel. */
  get label(): string {
    return `Page ${this.current + 1} / ${this.pages.length}`;
  }
  get isLast(): boolean {
    return this.current === this.pages.length - 1;
  }
  /** True when no page has any stroke (nothing worth saving). */
  get isEmpty(): boolean {
    return this.pages.every((p) => p.strokes.length === 0);
  }

  /** Returns true if the page changed. */
  prev(): boolean {
    if (this.current === 0) return false;
    this.current--;
    return true;
  }

  /** Forward one page; adds a blank page when on the last one. Returns 'moved' | 'added'. */
  next(): 'moved' | 'added' {
    if (this.isLast) {
      this.pages.push(blankPage(this.page.orientation));
      this.current++;
      return 'added';
    }
    this.current++;
    return 'moved';
  }

  /** Toggle portrait <-> landscape for the CURRENT page (its strokes stay where they are). */
  rotate(): Orientation {
    const p = this.page;
    p.orientation = p.orientation === 'portrait' ? 'landscape' : 'portrait';
    return p.orientation;
  }

  /** Replace everything (after Load). */
  replace(pages: Page[], current: number): void {
    this.pages = pages.length ? pages : [blankPage('portrait')];
    this.current = Math.min(Math.max(0, current | 0), this.pages.length - 1);
  }
}

// ---------------------------------------------------------------------------
// Stroke building (smoothing)
// ---------------------------------------------------------------------------

/** Points closer than this (m) to the last one are skipped. */
export const MIN_POINT_SPACING = 0.0015;
/**
 * Smoothing speed (1/s). WHY smoothing: a tracked controller jitters by a
 * millimeter or so every frame, which makes a raw stroke look hairy. An
 * exponential filter pulls each new sample only part of the way toward the
 * raw position; 30/s at 72 fps means ~34% per frame (about 30 ms of lag,
 * which you can't feel while writing). The curves between kept points are
 * drawn as quadratic Béziers through the midpoints (notes-raster.ts), which
 * smooths the corners on top of this.
 */
export const SMOOTHING_RATE = 30;

/**
 * Builds one stroke from raw tip samples. Feed it with add() every frame
 * while the tip touches the board, then finish().
 */
export class StrokeBuilder {
  readonly stroke: Stroke;
  private sx = 0;
  private sy = 0;
  private started = false;

  constructor(tool: Tool, color: string, radius: number) {
    this.stroke = { tool, color, radius, points: [] };
  }

  /**
   * Add a raw sample (m). Returns true when a point was appended (so the
   * caller can draw the new piece).
   */
  add(x: number, y: number, dt: number): boolean {
    const pts = this.stroke.points;
    if (!this.started) {
      this.started = true;
      this.sx = x;
      this.sy = y;
      pts.push(round(x), round(y));
      return true;
    }
    // Frame-rate independent: the same smoothing at 72, 90 or 120 Hz.
    const a = 1 - Math.exp(-Math.max(dt, 0) * SMOOTHING_RATE);
    this.sx += (x - this.sx) * a;
    this.sy += (y - this.sy) * a;
    const n = pts.length;
    const dx = this.sx - pts[n - 2];
    const dy = this.sy - pts[n - 1];
    if (dx * dx + dy * dy < MIN_POINT_SPACING * MIN_POINT_SPACING) return false;
    pts.push(round(this.sx), round(this.sy));
    return true;
  }

  /** The smoothed position (for a cursor that should match the ink). */
  get smoothX(): number {
    return this.sx;
  }
  get smoothY(): number {
    return this.sy;
  }

  get pointCount(): number {
    return this.stroke.points.length / 2;
  }
}

/** 0.1 mm grid: keeps saved files small, far below what you can see. */
function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Bounding box of points [from..to) (point indices), grown by `pad` m. */
export function pointsRect(points: number[], from: number, to: number, pad: number): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = Math.max(0, from); i < to; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

// ---------------------------------------------------------------------------
// Save / load format
// ---------------------------------------------------------------------------

export const NOTEBOOK_FORMAT = 1;

/** What goes into IndexedDB (and could go into a .json file one day). */
export interface SavedNotebook {
  format: number;
  /** e.g. notes-2026-10-01_15-42-07 */
  name: string;
  /** ms since 1970 (Date.now()). */
  savedAt: number;
  current: number;
  /** The marker color/size that were selected when saved. */
  penColor: string;
  penSizeMm: number;
  pages: Page[];
}

export function serializeNotebook(
  nb: Notebook,
  name: string,
  savedAt: number,
  penColor: string,
  penSizeMm: number,
): SavedNotebook {
  // A deep copy, so later strokes don't change a save that's still being written.
  return {
    format: NOTEBOOK_FORMAT,
    name,
    savedAt,
    current: nb.current,
    penColor,
    penSizeMm,
    pages: nb.pages.map((p) => ({
      orientation: p.orientation,
      strokes: p.strokes.map((s) => ({ tool: s.tool, color: s.color, radius: s.radius, points: s.points.slice() })),
    })),
  };
}

/**
 * Check + copy a saved notebook. Returns null when it isn't one we can read.
 * WHY so defensive: IndexedDB survives app updates, so an old or half-written
 * record must not crash the app on launch (autosave restores on startup).
 */
export function deserializeNotebook(raw: unknown): SavedNotebook | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SavedNotebook>;
  if (r.format !== NOTEBOOK_FORMAT || !Array.isArray(r.pages)) return null;
  const pages: Page[] = [];
  for (const p of r.pages) {
    if (!p || typeof p !== 'object') return null;
    const orientation: Orientation = p.orientation === 'landscape' ? 'landscape' : 'portrait';
    const strokes: Stroke[] = [];
    for (const s of Array.isArray(p.strokes) ? p.strokes : []) {
      if (!s || !Array.isArray(s.points) || s.points.length < 2 || s.points.length % 2) continue;
      const points = Array.from(s.points, Number);
      if (!points.every(Number.isFinite)) continue;
      strokes.push({
        tool: s.tool === 'erase' ? 'erase' : 'pen',
        color: typeof s.color === 'string' ? s.color : DEFAULT_PEN_COLOR,
        radius: Number.isFinite(s.radius) && s.radius > 0 ? s.radius : DEFAULT_PEN_SIZE_MM / 1000,
        points,
      });
    }
    pages.push({ orientation, strokes });
  }
  if (!pages.length) return null;
  return {
    format: NOTEBOOK_FORMAT,
    name: typeof r.name === 'string' ? r.name : 'notes',
    savedAt: Number.isFinite(r.savedAt) ? (r.savedAt as number) : 0,
    current: Math.min(Math.max(0, Number(r.current) | 0), pages.length - 1),
    penColor: typeof r.penColor === 'string' ? r.penColor : DEFAULT_PEN_COLOR,
    penSizeMm: Number.isFinite(r.penSizeMm) ? (r.penSizeMm as number) : DEFAULT_PEN_SIZE_MM,
    pages,
  };
}

/** "notes-2026-10-01_15-42-07" in LOCAL time (what the clock on the wall says). */
export function timestampName(d: Date, prefix = 'notes'): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${prefix}-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Board page -> letter page (PDF export)
// ---------------------------------------------------------------------------

/** US Letter in inches. */
export const LETTER_IN = { w: 8.5, h: 11 };

/**
 * Where a board page lands on a letter page, in inches.
 * The board (0.885 or 1.129 aspect) and letter (0.773 / 1.294) don't have the
 * same shape, so we scale UNIFORMLY to fill the page's width (portrait) or
 * height (landscape) and center it. Stretching instead would make every
 * circle you draw an egg.
 */
export function letterPlacement(o: Orientation): {
  pageW: number;
  pageH: number;
  x: number;
  y: number;
  w: number;
  h: number;
  inchesPerMeter: number;
} {
  const pageW = o === 'portrait' ? LETTER_IN.w : LETTER_IN.h;
  const pageH = o === 'portrait' ? LETTER_IN.h : LETTER_IN.w;
  const b = boardSize(o);
  const k = Math.min(pageW / b.w, pageH / b.h);
  const w = b.w * k;
  const h = b.h * k;
  return { pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h, inchesPerMeter: k };
}
