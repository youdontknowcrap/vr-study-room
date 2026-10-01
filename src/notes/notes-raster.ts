/**
 * Drawing strokes onto a 2D canvas. Used by BOTH the live whiteboard
 * (board-canvas.ts, 800 px per meter) and the PDF export (150 dpi), so what
 * you export is exactly what you saw.
 *
 * Smooth curves: between kept points we draw quadratic Bézier curves from
 * midpoint to midpoint, with the real point as the control point:
 *
 *      p0 ---- m01 ~~~~ m12 ~~~~ m23 ---- p3      (m = midpoint)
 *                  p1       p2                     (control points)
 *
 * Each curve starts in the direction the previous one ended, so the line has
 * no corners even though the points are a few mm apart.
 *
 * Erasing = painting the board color. WHY not "destination-out" (cutting a
 * hole)? The board is opaque white anyway, the PDF needs a white background
 * too, and painting keeps stroke ORDER meaningful: ink written after an
 * erase stays visible.
 */
import { BOARD_COLOR, type Stroke } from './notes-model.js';

/** Canvas transform: meters -> pixels (scale) plus a pixel offset. */
export interface RasterTransform {
  scale: number;
  ox: number;
  oy: number;
}

function begin(ctx: CanvasRenderingContext2D, s: Stroke, t: RasterTransform): void {
  ctx.setTransform(t.scale, 0, 0, t.scale, t.ox, t.oy);
  const color = s.tool === 'erase' ? BOARD_COLOR : s.color;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = s.radius * 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

/** A one-point stroke (a tap) is a dot. */
function dot(ctx: CanvasRenderingContext2D, s: Stroke): void {
  ctx.beginPath();
  ctx.arc(s.points[0], s.points[1], s.radius, 0, Math.PI * 2);
  ctx.fill();
}

/** Draw a whole finished stroke as one path. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, t: RasterTransform): void {
  const p = s.points;
  const n = p.length / 2;
  if (n === 0) return;
  begin(ctx, s, t);
  if (n === 1) return dot(ctx, s);
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.lineTo((p[0] + p[2]) / 2, (p[1] + p[3]) / 2);
  for (let k = 2; k < n; k++) {
    ctx.quadraticCurveTo(p[k * 2 - 2], p[k * 2 - 1], (p[k * 2 - 2] + p[k * 2]) / 2, (p[k * 2 - 1] + p[k * 2 + 1]) / 2);
  }
  ctx.lineTo(p[n * 2 - 2], p[n * 2 - 1]);
  ctx.stroke();
}

/**
 * Draw only the piece that point `k` (k >= 0) added to a stroke being written.
 * Same curves as drawStroke(), just one at a time, so the live board never
 * redraws the whole stroke (cheap per frame).
 */
export function drawPiece(ctx: CanvasRenderingContext2D, s: Stroke, k: number, t: RasterTransform): void {
  const p = s.points;
  begin(ctx, s, t);
  if (k === 0) return dot(ctx, s); // first touch: a dot right away
  ctx.beginPath();
  if (k === 1) {
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo((p[0] + p[2]) / 2, (p[1] + p[3]) / 2);
  } else {
    ctx.moveTo((p[k * 2 - 4] + p[k * 2 - 2]) / 2, (p[k * 2 - 3] + p[k * 2 - 1]) / 2);
    ctx.quadraticCurveTo(p[k * 2 - 2], p[k * 2 - 1], (p[k * 2 - 2] + p[k * 2]) / 2, (p[k * 2 - 1] + p[k * 2 + 1]) / 2);
  }
  ctx.stroke();
}

/** The last little straight bit from the final midpoint to the final point. */
export function drawFinish(ctx: CanvasRenderingContext2D, s: Stroke, t: RasterTransform): void {
  const p = s.points;
  const n = p.length / 2;
  if (n < 2) return;
  begin(ctx, s, t);
  ctx.beginPath();
  ctx.moveTo((p[n * 2 - 4] + p[n * 2 - 2]) / 2, (p[n * 2 - 3] + p[n * 2 - 1]) / 2);
  ctx.lineTo(p[n * 2 - 2], p[n * 2 - 1]);
  ctx.stroke();
}

/** White background + every stroke of a page. */
export function drawPage(
  ctx: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  t: RasterTransform,
  widthPx: number,
  heightPx: number,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BOARD_COLOR;
  ctx.fillRect(0, 0, widthPx, heightPx);
  for (const s of strokes) drawStroke(ctx, s, t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
