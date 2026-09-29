/**
 * PdfPages — turns PDF pages into small three.js textures using pdf.js.
 *
 * Performance notes (Quest-friendly):
 * - Pages are rendered LAZILY: only when the book is about to show them.
 * - Each page is rendered to a canvas only ~640 px tall. In VR a book page
 *   covers maybe 500-700 screen pixels, so more resolution is wasted memory.
 * - Only a small window of pages around the open spread is kept in GPU
 *   memory; far-away pages are disposed and re-rendered if you come back.
 */
import * as pdfjs from 'pdfjs-dist';
// `?url` asks Vite for the URL of the worker file (bundled + hashed on build).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { CanvasTexture, SRGBColorSpace, type Texture } from '@iwsdk/core';

// pdf.js parses PDFs in a Web Worker so the render loop never stalls.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Pixel height pages are rendered at. Raise for sharper text, lower for speed. */
const PAGE_PIXEL_HEIGHT = 640;
/** How many textures to keep cached around the current spread. */
const CACHE_RADIUS = 6;

export type PdfSource = { url: string } | { data: ArrayBuffer };

export class PdfPages {
  /** width / height of page 1 (used to size the 3D book). */
  aspect = 0.707;
  pageCount = 0;
  title = '';

  private doc: pdfjs.PDFDocumentProxy | null = null;
  private textures = new Map<number, Texture>();
  private pending = new Set<number>();
  /** Called whenever a page texture finishes rendering. */
  onPageReady: (index: number) => void = () => {};

  static async load(source: PdfSource, title: string): Promise<PdfPages> {
    const pages = new PdfPages();
    const task =
      'url' in source
        ? pdfjs.getDocument({ url: source.url })
        : pdfjs.getDocument({ data: new Uint8Array(source.data) });
    pages.doc = await task.promise;
    pages.pageCount = pages.doc.numPages;
    pages.title = title;
    const first = await pages.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    pages.aspect = vp.width / vp.height;
    return pages;
  }

  /**
   * Returns the texture for page `index` (0-based) if it is ready, otherwise
   * null and starts rendering it in the background.
   */
  get(index: number): Texture | null {
    if (index < 0 || index >= this.pageCount) return null;
    const tex = this.textures.get(index);
    if (tex) return tex;
    void this.render(index);
    return null;
  }

  /** Warm up pages around `center` and drop textures far away from it. */
  keepAround(center: number): void {
    for (let i = center - 2; i <= center + 3; i++) this.get(i);
    for (const [i, tex] of this.textures) {
      if (Math.abs(i - center) > CACHE_RADIUS) {
        tex.dispose(); // frees GPU memory
        this.textures.delete(i);
      }
    }
  }

  dispose(): void {
    for (const tex of this.textures.values()) tex.dispose();
    this.textures.clear();
    // loadingTask may be absent depending on pdf.js version / state; guard it.
    const lt = (this.doc as unknown as { loadingTask?: { destroy?: () => void } })?.loadingTask;
    if (lt && typeof lt.destroy === 'function') void lt.destroy();
    this.doc = null;
  }

  private async render(index: number): Promise<void> {
    if (!this.doc || this.pending.has(index)) return;
    this.pending.add(index);
    try {
      const page = await this.doc.getPage(index + 1); // pdf.js is 1-based
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: PAGE_PIXEL_HEIGHT / base.height,
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fbf7ee'; // warm paper color behind transparent PDFs
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace; // PDFs are authored in sRGB
      tex.anisotropy = 4; // keeps text readable when the page is tilted
      if (!this.doc) {
        tex.dispose();
        return;
      }
      this.textures.set(index, tex);
      this.onPageReady(index);
    } catch (err) {
      console.warn(`[pdf] failed to render page ${index + 1}`, err);
    } finally {
      this.pending.delete(index);
    }
  }
}
