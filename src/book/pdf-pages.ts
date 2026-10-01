/**
 * PdfPages — turns PDF pages into three.js textures using pdf.js.
 *
 * Performance notes (Quest-friendly):
 * - Pages are rendered LAZILY: only when the book is about to show them.
 * - Five "Big PDF" experiments can be switched on/off from the in-VR menu
 *   (menu: "Big PDF ▸", settings in settings.ts). Each one is marked below
 *   with  [1 STREAMING] [2 RESOLUTION] [3 CACHE] [4 QUEUE] [5 PREVIEW]
 *   so you can find (and later delete or keep) its code quickly.
 *
 * RAPID-ITERATION CODE: both the "new" and the "old" path live side by side
 * so they can be compared in the headset. Once you've picked winners, the
 * refactor is: delete the losing branch of each `if (setting.value)`.
 */
import * as pdfjs from 'pdfjs-dist';
// `?url` asks Vite for the URL of the worker file (bundled + hashed on build).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { CanvasTexture, SRGBColorSpace, type Texture } from '@iwsdk/core';
import { textureBytes, type BookPages, type PageStats } from './book-pages.js';
import { pdfCacheSize, pdfPreview, pdfRenderQueue, pdfResolution, pdfStreaming } from '../settings.js';

// pdf.js parses PDFs in a Web Worker so the render loop never stalls.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Quest's GPU starts failing canvas allocations well before this. */
const MAX_PAGE_PIXELS = 2048;
/** [3 CACHE] "Old" cache rule: keep textures within this many pages. */
const OLD_CACHE_RADIUS = 6;
/**
 * [5 PREVIEW] Long side of the quick blurry pass. WHY ~360: small enough to
 * paint in a fraction of the time, big enough that you can see the page
 * layout (headings, pictures) while the sharp version renders.
 */
const PREVIEW_PIXELS = 360;
/** Skip a single embedded image bigger than this rather than crashing the tab. */
const MAX_IMAGE_PIXELS = 16_000_000;
/**
 * [1 STREAMING] How many bytes pdf.js asks for at once. WHY 256 KB: a page
 * of the scanned Great Books file is ~250 KB, so one request ~= one page.
 * Smaller = more round trips; bigger = reading bytes you may not need.
 */
const RANGE_CHUNK_BYTES = 256 * 1024;
/** Paper color painted behind transparent page content. */
const PAPER = '#fbf7ee';

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
  rangeChunkSize: RANGE_CHUNK_BYTES,
  // Quest's OffscreenCanvas / ImageDecoder path blanks or rejects some files.
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableXfa: true,
  maxImageSize: MAX_IMAGE_PIXELS,
  useSystemFonts: true,
} as const;

/**
 * Where a PDF comes from:
 * - url:  a normal web URL (the sample book) or a blob: URL of a picked file
 * - data: bytes already in memory
 * - file: a picked File/Blob, read piece by piece  [1 STREAMING]
 */
export type PdfSource = { url: string; ownedUrl?: string } | { data: ArrayBuffer } | { file: Blob };

/**
 * [1 STREAMING] Lets pdf.js read a local File on demand.
 *
 * WHY: a File object is just a handle to bytes on disk. `File.slice(a, b)`
 * reads only bytes a..b. pdf.js normally wants either all the bytes or an
 * http(s) URL it can send "Range:" requests to. It can't do range requests
 * on blob: URLs, so with a blob URL it downloads the WHOLE 287 MB into the
 * worker's memory. PDFDataRangeTransport is pdf.js's official hook for "I'll
 * give you byte ranges myself": pdf.js calls requestDataRange(begin, end),
 * we slice the file and hand the bytes back with onDataRange().
 */
class FileRangeTransport extends pdfjs.PDFDataRangeTransport {
  private aborted = false;
  constructor(
    private file: Blob,
    initial: Uint8Array,
  ) {
    super(file.size, initial);
  }
  override requestDataRange(begin: number, end: number): void {
    this.file
      .slice(begin, end)
      .arrayBuffer()
      .then(
        (buf) => {
          // The book may have been closed while the disk read was running.
          if (!this.aborted) this.onDataRange(begin, new Uint8Array(buf));
        },
        (err) => console.warn('[pdf] range read failed', err),
      );
  }
  override abort(): void {
    this.aborted = true;
  }
}

async function documentOptions(source: PdfSource) {
  if ('file' in source) {
    // Hand pdf.js the first chunk up front so it can check the header
    // without waiting for a first round trip.
    const initial = new Uint8Array(await source.file.slice(0, RANGE_CHUNK_BYTES).arrayBuffer());
    return { range: new FileRangeTransport(source.file, initial), ...PDFJS_ASSETS };
  }
  const base = 'url' in source ? { url: source.url } : { data: new Uint8Array(source.data) };
  return { ...base, ...PDFJS_ASSETS };
}

/** True for pdf.js's "you cancelled this render" error. */
function isCancel(err: unknown): boolean {
  return (
    err instanceof pdfjs.RenderingCancelledException ||
    (err as { name?: string } | null)?.name === 'RenderingCancelledException'
  );
}

/** One rendered page. `px` = the resolution cap it was rendered at. */
interface Entry {
  tex: Texture;
  /** false = blurry preview, a sharp render is still wanted. */
  sharp: boolean;
  px: number;
}

/** [4 QUEUE] The single render that is running right now. */
interface Job {
  index: number;
  task: pdfjs.RenderTask | null;
  cancelled: boolean;
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
  /** Called whenever a page texture finishes rendering. */
  onPageReady: (index: number) => void = () => {};

  /**
   * Counters for tests and the stats readout (window.app.book.pageSource.debug).
   * WHY public: scripts/test-bigpdf.mjs reads them to prove textures get
   * disposed and cancelled renders are never retried.
   */
  readonly debug = { texturesCreated: 0, texturesDisposed: 0, cancelled: 0, retriedWithoutAnnotations: 0, renders: 0 };

  private doc: pdfjs.PDFDocumentProxy | null = null;
  private loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
  /** Blob URL we created for a user file. Revoked on dispose. */
  private ownedUrl: string | null = null;
  private textures = new Map<number, Entry>();
  /** Old (no queue) path: pages being rendered right now, all in parallel. */
  private pending = new Set<number>();
  /** [4 QUEUE] Pages wanted, most important first. */
  private wanted: number[] = [];
  /** [4 QUEUE] The one render in flight. */
  private busy: Job | null = null;
  private lastRenderMs = 0;
  private unsubscribe: (() => void)[] = [];

  static async load(source: PdfSource, title: string): Promise<PdfPages> {
    const pages = new PdfPages();
    if ('url' in source && source.ownedUrl) pages.ownedUrl = source.ownedUrl;
    const task = pdfjs.getDocument(await documentOptions(source));
    pages.loadingTask = task;
    try {
      pages.doc = await task.promise;
      pages.pageCount = pages.doc.numPages;
      pages.title = title;
      const fingerprint = pages.doc.fingerprints?.[0];
      if (fingerprint) {
        pages.id = `fp:${fingerprint}`;
      } else {
        const size =
          'data' in source
            ? source.data.byteLength
            : 'file' in source
              ? source.file.size
              : (await pages.doc.getDownloadInfo()).length;
        pages.id = `file:${title}|${size}|${pages.pageCount}`;
      }
      const first = await pages.doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      if (vp.height > 0) pages.aspect = vp.width / vp.height;
      pages.watchSettings();
      return pages;
    } catch (err) {
      pages.dispose();
      throw err;
    }
  }

  /**
   * Apply menu changes LIVE. `subscribe` fires once immediately with the
   * current value, so `first` skips that call.
   */
  private watchSettings(): void {
    const live = (sig: { subscribe: (fn: () => void) => () => void }, onChange: () => void) => {
      let first = true;
      this.unsubscribe.push(
        sig.subscribe(() => {
          if (first) return void (first = false);
          onChange();
        }),
      );
    };
    // [2 RESOLUTION] New cap: cancel the (now wrong-sized) render and ask the
    // book to refresh. get() then sees every page as "not fresh" and
    // re-renders the spread. The old textures stay visible until replaced,
    // so the page never flashes blank.
    live(pdfResolution, () => {
      this.cancelBusy();
      this.onPageReady(-1);
    });
    // [3 CACHE] [4 QUEUE] Refresh so keepAround() applies the new rule now.
    live(pdfCacheSize, () => this.onPageReady(-1));
    live(pdfRenderQueue, () => {
      // Switching modes: forget the queue. A render already running in
      // either mode just finishes (it can't hurt, it's one page).
      this.wanted = [];
      this.onPageReady(-1);
    });
  }

  /** A page is "fresh" when its sharp render matches the current cap. */
  private isFresh(e: Entry | undefined): boolean {
    return !!e && e.sharp && e.px === pdfResolution.value;
  }

  /**
   * Returns the texture for page `index` (0-based) if one exists (maybe a
   * blurry preview or an older resolution), and makes sure a sharp,
   * current-resolution render is on its way.
   */
  get(index: number): Texture | null {
    if (index < 0 || index >= this.pageCount) return null;
    const entry = this.textures.get(index);
    if (!this.isFresh(entry)) this.request(index);
    return entry?.tex ?? null;
  }

  private request(index: number): void {
    if (pdfRenderQueue.value) {
      // [4 QUEUE] Newest request goes to the FRONT: it's what you look at.
      if (this.busy?.index === index) return;
      this.wanted = [index, ...this.wanted.filter((i) => i !== index)];
      this.pump();
    } else {
      // Old behaviour: start rendering immediately, in parallel with any
      // other page. On a 17-megapixel scan, 4-6 of these at once is what
      // freezes the Quest.
      void this.renderPage(index, null);
    }
  }

  /**
   * Which pages to keep, most important first. center = right page of the
   * open spread, so the spread itself is [center - 1, center].
   */
  private keepList(center: number): number[] {
    const cache = pdfCacheSize.value;
    const inRange = (i: number) => i >= 0 && i < this.pageCount;
    if (cache === 0) {
      // [3 CACHE] "Old": everything within ±6 pages (up to 13 textures).
      const out: number[] = [];
      for (let d = -OLD_CACHE_RADIUS; d <= OLD_CACHE_RADIUS; d++) if (inRange(center + d)) out.push(center + d);
      return out;
    }
    // Current spread, then the NEXT spread (you usually read forward),
    // then the previous spread, then further out on both sides.
    const order = [center - 1, center];
    for (let k = 1; order.length < cache + 8; k++) {
      order.push(center + 2 * k - 1, center + 2 * k, center - 2 * k - 1, center - 2 * k);
    }
    return order.filter(inRange).slice(0, Math.max(2, cache));
  }

  /** Warm up pages around `center` and drop textures outside the cache window. */
  keepAround(center: number): void {
    const keep = this.keepList(center);
    // [3 CACHE] Evict everything outside the window.
    for (const i of [...this.textures.keys()]) if (!keep.includes(i)) this.evict(i);

    // Which pages to pre-render. "Old" cache keeps a wide window but only
    // ever pre-rendered center-2..center+3; keep that so Old == old.
    const warm =
      pdfCacheSize.value === 0
        ? [center - 1, center, center + 1, center + 2, center - 3, center - 2].filter((i) => i >= 0 && i < this.pageCount)
        : keep;

    if (pdfRenderQueue.value) {
      // [4 QUEUE] Replace the whole wish list (latest spread wins) and cancel
      // a render that is no longer wanted, so we never waste seconds painting
      // a page you've already flipped past.
      this.wanted = warm.filter((i) => !this.isFresh(this.textures.get(i)));
      if (this.busy && !warm.includes(this.busy.index)) this.cancelBusy();
      this.pump();
    } else {
      for (const i of warm) this.get(i);
    }
  }

  getStats(): PageStats {
    let bytes = 0;
    for (const e of this.textures.values()) bytes += textureBytes(e.tex);
    return {
      lastRenderMs: this.lastRenderMs,
      cachedPages: this.textures.size,
      textureBytes: bytes,
      pending: this.wanted.length + (this.busy ? 1 : 0) + this.pending.size,
      cancelled: this.debug.cancelled,
    };
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.cancelBusy();
    this.wanted = [];
    for (const i of [...this.textures.keys()]) this.evict(i);
    this.doc = null; // render code checks this and stops / drops results
    // Destroying the loading task terminates this document's pdf.js worker,
    // which is where the file bytes live. WHY it matters: without it a
    // reopened 287 MB book could keep the previous copy alive too.
    void this.loadingTask?.destroy();
    this.loadingTask = null;
    if (this.ownedUrl) {
      URL.revokeObjectURL(this.ownedUrl);
      this.ownedUrl = null;
    }
  }

  /** [3 CACHE] Free a page completely: GPU texture AND canvas pixels. */
  private evict(i: number): void {
    const e = this.textures.get(i);
    if (!e) return;
    this.textures.delete(i);
    this.freeTexture(e.tex);
  }

  /**
   * WHY both steps: texture.dispose() frees the GPU copy, but the canvas
   * (the CPU copy, ~w*h*4 bytes) lives until the garbage collector gets to
   * it, which on Quest can be "much later". Setting width/height to 0
   * releases its pixel buffer right now.
   */
  private freeTexture(tex: Texture): void {
    tex.dispose();
    this.debug.texturesDisposed++;
    const img = tex.image as HTMLCanvasElement | undefined;
    if (img && 'width' in img) img.width = img.height = 0;
  }

  /** [4 QUEUE] Stop the running render (pdf.js throws RenderingCancelledException). */
  private cancelBusy(): void {
    if (!this.busy) return;
    this.busy.cancelled = true;
    this.busy.task?.cancel();
  }

  /** [4 QUEUE] Start the next wanted page if nothing is rendering. */
  private pump(): void {
    if (this.busy || !this.doc) return;
    let index = this.wanted.shift();
    while (index !== undefined && this.isFresh(this.textures.get(index))) index = this.wanted.shift();
    if (index === undefined) return;
    const job: Job = { index, task: null, cancelled: false };
    this.busy = job;
    void this.renderPage(index, job).finally(() => {
      if (this.busy === job) this.busy = null;
      this.pump();
    });
  }

  /**
   * Draw one page at `pixels` on its long side into a new canvas.
   * Throws on cancel, so the caller can stop.
   */
  private async paint(page: pdfjs.PDFPageProxy, pixels: number, job: Job | null): Promise<HTMLCanvasElement | null> {
    const base = page.getViewport({ scale: 1 });
    if (base.height <= 0 || base.width <= 0) return null;
    // [2 RESOLUTION] Scale so the LONG side equals the cap (landscape pages
    // too), and never exceed what Quest can allocate.
    let scale = pixels / Math.max(base.height, base.width);
    if (base.width * scale > MAX_PAGE_PIXELS) scale = MAX_PAGE_PIXELS / base.width;
    if (base.height * scale > MAX_PAGE_PIXELS) scale = MAX_PAGE_PIXELS / base.height;
    const viewport = page.getViewport({ scale });
    const makeCanvas = (): HTMLCanvasElement => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      return canvas;
    };
    // Pass the canvas alone so pdf.js owns the 2D context. If annotations
    // throw (some real-world files), draw the page again without them.
    let painted = makeCanvas();
    try {
      const task = page.render({ canvas: painted, viewport, background: PAPER });
      if (job) job.task = task; // so cancelBusy() can stop it
      await task.promise;
    } catch (first) {
      painted.width = painted.height = 0;
      // BUG FIX (was: every error got retried). A cancel is not a broken
      // annotation, it means "stop". Retrying it re-did the expensive render
      // we just tried to stop. Same when the book was closed under us.
      if (isCancel(first) || !this.doc || job?.cancelled) throw first;
      console.warn('[pdf] retrying without annotations', first);
      this.debug.retriedWithoutAnnotations++;
      painted = makeCanvas();
      const task = page.render({
        canvas: painted,
        viewport,
        background: PAPER,
        annotationMode: pdfjs.AnnotationMode.DISABLE,
      });
      if (job) job.task = task;
      await task.promise;
    }
    return painted;
  }

  /** Wrap a canvas in a texture and show it, freeing whatever it replaces. */
  private publish(index: number, canvas: HTMLCanvasElement, sharp: boolean, px: number): void {
    if (!this.doc) {
      canvas.width = canvas.height = 0;
      return;
    }
    const old = this.textures.get(index);
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace; // PDFs are authored in sRGB
    tex.anisotropy = 4; // keeps text readable when the page is tilted
    this.debug.texturesCreated++;
    this.textures.set(index, { tex, sharp, px });
    // Let the book swap its materials to the new texture FIRST, then free
    // the old one (preview or old resolution). Freeing it first would leave
    // a material pointing at an empty texture for a frame.
    this.onPageReady(index);
    if (old) this.freeTexture(old.tex);
  }

  /**
   * Render one page: optional blurry preview, then the sharp pass.
   * `job` is set in render-queue mode (cancellable), null in the old mode.
   */
  private async renderPage(index: number, job: Job | null): Promise<void> {
    if (!this.doc) return;
    if (!job) {
      // Old mode: one render per page at a time, but pages in parallel.
      if (this.pending.has(index)) return;
      this.pending.add(index);
    }
    const stopped = () => !this.doc || !!job?.cancelled;
    let page: pdfjs.PDFPageProxy | null = null;
    const t0 = performance.now();
    try {
      page = await this.doc.getPage(index + 1); // pdf.js is 1-based
      if (stopped()) return;
      this.debug.renders++;
      // [5 PREVIEW] Only when nothing is shown yet for this page: a quick
      // low-res pass so you see the page right away instead of blank paper.
      if (pdfPreview.value && !this.textures.has(index)) {
        const low = await this.paint(page, PREVIEW_PIXELS, job);
        if (stopped()) {
          if (low) low.width = low.height = 0;
          return;
        }
        if (low) this.publish(index, low, false, PREVIEW_PIXELS);
      }
      // Decoded images stay cached on `page` until cleanup(), so the sharp
      // pass doesn't decode the 17-megapixel scan a second time.
      const px = pdfResolution.value;
      const sharp = await this.paint(page, px, job);
      if (sharp && stopped()) {
        sharp.width = sharp.height = 0;
        return;
      }
      if (sharp) {
        this.lastRenderMs = Math.round(performance.now() - t0);
        this.publish(index, sharp, true, px);
      }
    } catch (err) {
      if (isCancel(err)) {
        // [4 QUEUE] Expected: you flipped past this page. NOT retried.
        this.debug.cancelled++;
      } else if (this.doc) {
        console.warn(`[pdf] failed to render page ${index + 1}`, err);
      }
    } finally {
      if (!job) this.pending.delete(index);
      try {
        page?.cleanup(); // drop decoded images now (big scans = big memory)
      } catch {
        /* the pixels are already on the canvas */
      }
    }
  }
}
