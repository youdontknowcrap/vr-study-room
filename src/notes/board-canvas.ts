/**
 * BoardCanvas — the whiteboard's pixels.
 *
 * Each page is drawn on its own 2D canvas ("per-page canvas") at PX_PER_M,
 * and the canvas is the image of a three.js CanvasTexture on the board mesh.
 *
 * Three performance rules, because a Quest 2 has little GPU time to spare:
 *
 * 1. DIRTY RECTS. While you write, only a few pixels change per frame. A
 *    normal `texture.needsUpdate = true` re-uploads the WHOLE 1219 x 1377
 *    canvas (6.7 MB) every frame. Instead we remember the rectangle that
 *    changed and upload just that with WebGL2 texSubImage2D (UNPACK_SKIP_*
 *    pick the sub-rectangle out of the canvas). Usually a few KB per frame.
 * 2. AT MOST ONCE PER FRAME. Drawing marks the rect dirty; flush() is called
 *    once from NotesSystem.update() (the XR frame), which uploads it.
 *    (Remember: Quest pauses window.requestAnimationFrame in VR, so nothing
 *    here may wait for it.)
 * 3. BOUNDED MEMORY. A canvas per page forever would eat ~7 MB of (GPU-backed)
 *    canvas memory per page. We keep the last CACHE_PAGES canvases and simply
 *    redraw an evicted page from its strokes when you come back to it. The
 *    strokes are the real data; canvases are just a cache.
 *
 * If the sub-rectangle upload ever fails (GL error on the first try), we fall
 * back to full uploads for the rest of the session, still at most once per frame.
 */
import {
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  type WebGLRenderer,
} from '@iwsdk/core';
import { boardSize, type Orientation, type Page, type Rect, type Stroke } from './notes-model.js';
import { drawFinish, drawPage, drawPiece, type RasterTransform } from './notes-raster.js';

/** Board resolution: 800 px per meter = 1.25 mm per pixel. */
export const PX_PER_M = 800;
/** How many page canvases stay in memory (current + neighbours). */
const CACHE_PAGES = 3;

const T: RasterTransform = { scale: PX_PER_M, ox: 0, oy: 0 };

function canvasSize(o: Orientation): { w: number; h: number } {
  const b = boardSize(o);
  return { w: Math.round(b.w * PX_PER_M), h: Math.round(b.h * PX_PER_M) };
}

export class BoardCanvas {
  /** One texture per orientation (their sizes differ, and GPU textures can't change size). */
  readonly textures: Record<Orientation, CanvasTexture>;
  private cache: { page: Page; canvas: HTMLCanvasElement }[] = [];
  private page: Page | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private dirty: Rect | null = null;
  private subUploadOk = true;
  private checkedSubUpload = false;
  /** Stats for tests/debugging: how uploads went. */
  readonly stats = { full: 0, partial: 0, partialPixels: 0 };

  constructor() {
    const make = (o: Orientation) => {
      const c = document.createElement('canvas');
      const s = canvasSize(o);
      c.width = s.w;
      c.height = s.h;
      const t = new CanvasTexture(c);
      t.colorSpace = SRGBColorSpace;
      // flipY off: canvas row 0 goes to texture row 0. texSubImage2D offsets
      // then match canvas pixels 1:1 (the board's UVs are flipped instead).
      t.flipY = false;
      // No mipmaps: they'd be rebuilt for the whole texture on every upload,
      // and the board is never far enough away to need them.
      t.generateMipmaps = false;
      t.minFilter = LinearFilter;
      t.magFilter = LinearFilter;
      return t;
    };
    this.textures = { portrait: make('portrait'), landscape: make('landscape') };
  }

  get texture(): CanvasTexture {
    return this.textures[this.page?.orientation ?? 'portrait'];
  }

  /** Show `page` (draws it from its strokes if it isn't cached). */
  show(page: Page): void {
    let entry = this.cache.find((e) => e.page === page);
    const size = canvasSize(page.orientation);
    if (entry && (entry.canvas.width !== size.w || entry.canvas.height !== size.h)) {
      // Page was rotated since it was cached: redraw at the new shape.
      this.paint(entry.canvas, page);
    }
    if (!entry) {
      // Reuse the oldest canvas when the cache is full (no new allocation).
      const canvas = this.cache.length >= CACHE_PAGES ? this.cache.shift()!.canvas : document.createElement('canvas');
      this.paint(canvas, page);
      entry = { page, canvas };
    } else {
      this.cache.splice(this.cache.indexOf(entry), 1);
    }
    this.cache.push(entry); // most recently used at the end
    this.page = page;
    this.canvas = entry.canvas;
    const tex = this.textures[page.orientation];
    tex.image = entry.canvas;
    tex.needsUpdate = true; // a different page: one full upload is right
    this.stats.full++;
    this.dirty = null;
  }

  /** Redraw the current page from scratch (after Load, or to be safe). */
  repaint(): void {
    if (!this.page || !this.canvas) return;
    this.paint(this.canvas, this.page);
    this.texture.needsUpdate = true;
    this.stats.full++;
    this.dirty = null;
  }

  /** Forget all cached canvases (a different notebook was loaded). */
  clearCache(): void {
    this.cache = this.cache.filter((e) => e.canvas === this.canvas);
  }

  private paint(canvas: HTMLCanvasElement, page: Page): void {
    const s = canvasSize(page.orientation);
    canvas.width = s.w;
    canvas.height = s.h;
    drawPage(canvas.getContext('2d')!, page.strokes, T, s.w, s.h);
  }

  /** Draw the piece point `k` added to `stroke` (live writing). */
  drawPiece(stroke: Stroke, k: number): void {
    if (!this.canvas) return;
    drawPiece(this.canvas.getContext('2d')!, stroke, k, T);
    this.markStroke(stroke, Math.max(0, k - 2), k + 1);
  }

  /** Close a stroke (the short straight bit to its last point). */
  finish(stroke: Stroke): void {
    if (!this.canvas) return;
    const n = stroke.points.length / 2;
    drawFinish(this.canvas.getContext('2d')!, stroke, T);
    this.markStroke(stroke, n - 2, n);
  }

  private markStroke(stroke: Stroke, from: number, to: number): void {
    const p = stroke.points;
    const pad = stroke.radius + 2 / PX_PER_M; // line half-width + 2 px antialiasing
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = Math.max(0, from); i < to; i++) {
      x0 = Math.min(x0, p[i * 2]);
      x1 = Math.max(x1, p[i * 2]);
      y0 = Math.min(y0, p[i * 2 + 1]);
      y1 = Math.max(y1, p[i * 2 + 1]);
    }
    if (!Number.isFinite(x0)) return;
    const r = { x0: (x0 - pad) * PX_PER_M, y0: (y0 - pad) * PX_PER_M, x1: (x1 + pad) * PX_PER_M, y1: (y1 + pad) * PX_PER_M };
    const d = this.dirty;
    this.dirty = d
      ? { x0: Math.min(d.x0, r.x0), y0: Math.min(d.y0, r.y0), x1: Math.max(d.x1, r.x1), y1: Math.max(d.y1, r.y1) }
      : r;
  }

  /** Upload what changed this frame. Call once per frame, from the XR frame. */
  flush(renderer: WebGLRenderer): void {
    const d = this.dirty;
    if (!d || !this.canvas) return;
    this.dirty = null;
    const c = this.canvas;
    const x = Math.max(0, Math.floor(d.x0));
    const y = Math.max(0, Math.floor(d.y0));
    const w = Math.min(c.width, Math.ceil(d.x1)) - x;
    const h = Math.min(c.height, Math.ceil(d.y1)) - y;
    if (w <= 0 || h <= 0) return;
    const tex = this.texture;
    if (!this.subUploadOk || !this.subUpload(renderer, tex, c, x, y, w, h)) {
      tex.needsUpdate = true;
      this.stats.full++;
    }
  }

  /** texSubImage2D of one rectangle of the canvas. Returns false to ask for a full upload. */
  private subUpload(
    renderer: WebGLRenderer,
    tex: CanvasTexture,
    canvas: HTMLCanvasElement,
    x: number,
    y: number,
    w: number,
    h: number,
  ): boolean {
    const gl = renderer.getContext();
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return false;
    // three.js keeps the GPU handle in its private property map. If the
    // texture hasn't been uploaded at this version yet, a full upload is
    // already queued and will include our pixels: nothing to do.
    const props = renderer.properties.get(tex) as { __webglTexture?: WebGLTexture; __version?: number };
    if (!props.__webglTexture) return false;
    if (props.__version !== tex.version) return true;
    // Bind through three's state cache so it knows what's bound.
    renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); // 0 = the canvas's own width
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    if (!this.checkedSubUpload) {
      // getError() stalls the GPU pipeline, so check only the first time.
      this.checkedSubUpload = true;
      if (gl.getError() !== gl.NO_ERROR) {
        console.warn('[notes] partial texture upload failed; using full uploads');
        this.subUploadOk = false;
        return false;
      }
    }
    this.stats.partial++;
    this.stats.partialPixels += w * h;
    return true;
  }

  /**
   * Debug/test helper: read one texel back from the GPU texture
   * (canvas pixel coordinates). Slow; never call per frame.
   */
  readTexel(renderer: WebGLRenderer, px: number, py: number): number[] | null {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const props = renderer.properties.get(this.texture) as { __webglTexture?: WebGLTexture };
    if (!props.__webglTexture) return null;
    const fb = gl.createFramebuffer();
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, props.__webglTexture, 0);
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    gl.deleteFramebuffer(fb);
    return Array.from(out);
  }
}
