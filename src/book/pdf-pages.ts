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
import type { BookPages } from './book-pages.js';

// pdf.js parses PDFs in a Web Worker so the render loop never stalls.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Pixel height pages are rendered at. Raise for sharper text, lower for speed. */
const PAGE_PIXEL_HEIGHT = 640;
/** Quest's GPU starts failing canvas allocations well before this. */
const MAX_PAGE_PIXELS = 2048;
/** How many textures to keep cached around the current spread. */
const CACHE_RADIUS = 6;
/** Skip a single embedded image bigger than this rather than crashing the tab. */
const MAX_IMAGE_PIXELS = 16_000_000;

/**
 * CMap, standard-font, wasm and ICC files are copied next to the build
 * (see vite.config.ts). The URL has to be absolute: the worker resolves a
 * relative one against its own script, not the page, and the fetch 404s.
 * Without these, PDFs that use non-embedded fonts, CJK encodings, JPEG2000
 * or a calibrated color space fail while simple embedded-font files open.
 */
function pdfjsAssetDir(name: string): string {
  const relative = `${import.meta.env.BASE_URL}pdfjs/${name}/`;
  if (typeof window === 'undefined') return relative;
  return new URL(relative, window.location.href).href;
}

const PDFJS_ASSETS = {
  cMapUrl: pdfjsAssetDir('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
  wasmUrl: pdfjsAssetDir('wasm'),
  iccUrl: pdfjsAssetDir('iccs'),
  // Fetch only the pages being shown. Auto-fetching a whole large PDF
  // exhausts memory on Quest and the open fails.
  disableAutoFetch: true,
  disableStream: true,
  // Quest's OffscreenCanvas / ImageDecoder path blanks or rejects some files.
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableXfa: true,
  maxImageSize: MAX_IMAGE_PIXELS,
  useSystemFonts: true,
} as const;

export type PdfSource = { url: string; ownedUrl?: string } | { data: ArrayBuffer };

function documentOptions(source: PdfSource) {
  const base = 'url' in source ? { url: source.url } : { data: new Uint8Array(source.data) };
  return { ...base, ...PDFJS_ASSETS };
}

export class PdfPages implements BookPages {
  /** width / height of page 1 (used to size the 3D book). */
  aspect = 0.707;
  pageCount = 0;
  title = '';
  /**
   * A stable ID for this exact PDF file, used to remember your last page.
   * pdf.js computes a "fingerprint" (a hash stored in / derived from the
   * file), so renaming the file still finds your place. If a PDF has none
   * we fall back to name + size + page count.
   */
  id = '';

  private doc: pdfjs.PDFDocumentProxy | null = null;
  /** Blob URL we created for a user file. Revoked on dispose. */
  private ownedUrl: string | null = null;
  private textures = new Map<number, Texture>();
  private pending = new Set<number>();
  /** Called whenever a page texture finishes rendering. */
  onPageReady: (index: number) => void = () => {};

  static async load(source: PdfSource, title: string): Promise<PdfPages> {
    const pages = new PdfPages();
    if ('url' in source && source.ownedUrl) pages.ownedUrl = source.ownedUrl;
    const task = pdfjs.getDocument(documentOptions(source));
    try {
      pages.doc = await task.promise;
      pages.pageCount = pages.doc.numPages;
      pages.title = title;
      const fingerprint = pages.doc.fingerprints?.[0];
      if (fingerprint) {
        pages.id = `fp:${fingerprint}`;
      } else {
        const size = 'data' in source ? source.data.byteLength : (await pages.doc.getDownloadInfo()).length;
        pages.id = `file:${title}|${size}|${pages.pageCount}`;
      }
      const first = await pages.doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      if (vp.height > 0) pages.aspect = vp.width / vp.height;
      return pages;
    } catch (err) {
      pages.dispose();
      throw err;
    }
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
    if (this.ownedUrl) {
      URL.revokeObjectURL(this.ownedUrl);
      this.ownedUrl = null;
    }
  }

  private async render(index: number): Promise<void> {
    if (!this.doc || this.pending.has(index)) return;
    this.pending.add(index);
    try {
      const page = await this.doc.getPage(index + 1); // pdf.js is 1-based
      const base = page.getViewport({ scale: 1 });
      if (base.height <= 0 || base.width <= 0) return;
      let scale = PAGE_PIXEL_HEIGHT / base.height;
      if (base.width * scale > MAX_PAGE_PIXELS) scale = MAX_PAGE_PIXELS / base.width;
      if (base.height * scale > MAX_PAGE_PIXELS) scale = MAX_PAGE_PIXELS / base.height;
      const viewport = page.getViewport({ scale });
      const makeCanvas = (): HTMLCanvasElement => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        return canvas;
      };
      // Pass the canvas alone so pdf.js owns the 2D context. `background`
      // is the paper color behind transparent drawings. If annotations throw
      // (some real-world files), draw the page again without them.
      let painted = makeCanvas();
      try {
        await page.render({ canvas: painted, viewport, background: '#fbf7ee' }).promise;
      } catch (first) {
        console.warn(`[pdf] page ${index + 1} retrying without annotations`, first);
        painted = makeCanvas();
        await page.render({
          canvas: painted,
          viewport,
          background: '#fbf7ee',
          annotationMode: pdfjs.AnnotationMode.DISABLE,
        }).promise;
      }
      try {
        page.cleanup();
      } catch {
        /* the pixels are already on the canvas */
      }

      const tex = new CanvasTexture(painted);
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
