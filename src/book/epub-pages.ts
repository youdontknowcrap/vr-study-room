/**
 * EpubPages — paints parsed EPUB pages onto the same small textures the
 * book already uses for PDFs. Pages are drawn lazily, and only a window
 * around the open spread stays on the GPU.
 */
import { CanvasTexture, SRGBColorSpace, type Texture } from '@iwsdk/core';
import { textureBytes, type BookPages, type PageStats } from './book-pages.js';
import {
  EPUB_ASPECT,
  EPUB_FONTS,
  EPUB_PAGE_H,
  EPUB_PAGE_W,
  paginateEpub,
  parseEpub,
  type EpubLaidPage,
  type EpubOp,
} from './epub-document.js';

const CACHE_RADIUS = 6;

export type EpubSource = { url: string } | { data: Uint8Array | ArrayBuffer };

type Decoded = ImageBitmap | HTMLImageElement;

export class EpubPages implements BookPages {
  readonly aspect = EPUB_ASPECT;
  pageCount = 0;
  title = '';
  id = '';
  onPageReady: (index: number) => void = () => {};

  private laid: EpubLaidPage[] = [];
  private images = new Map<string, Uint8Array>();
  private decoded = new Map<string, Decoded | null>();
  private textures = new Map<number, Texture>();
  private pending = new Set<number>();
  /** Pages that failed to paint. They must not block turning forever. */
  private failed = new Set<number>();
  private lastRenderMs = 0;

  static async load(source: EpubSource, titleFallback: string): Promise<EpubPages> {
    const data = 'url' in source ? new Uint8Array(await (await fetch(source.url)).arrayBuffer()) : toBytes(source.data);
    const parsed = await parseEpub(data);
    const measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    if (!ctx) throw new Error('This EPUB can’t be laid out in this browser.');
    const pages = paginateEpub(parsed.blocks, (text, font) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    });
    if (pages.length === 0) throw new Error('This EPUB has no readable pages.');
    const book = new EpubPages();
    book.laid = pages;
    book.images = parsed.images;
    book.pageCount = pages.length;
    book.title = parsed.title || titleFallback;
    book.id = parsed.id;
    return book;
  }

  get(index: number): Texture | null {
    if (index < 0 || index >= this.pageCount) return null;
    const tex = this.textures.get(index);
    if (tex) return tex;
    if (!this.failed.has(index)) void this.render(index);
    return null;
  }

  ready(index: number): boolean {
    if (index < 0 || index >= this.pageCount) return true;
    return this.textures.has(index) || this.failed.has(index);
  }

  keepAround(center: number): void {
    // center-3 is the page a back-turn uncovers. Warm it or that turn waits forever.
    for (let i = center - 3; i <= center + 3; i++) this.get(i);
    for (const [i, tex] of this.textures) {
      if (Math.abs(i - center) > CACHE_RADIUS) {
        tex.dispose();
        this.textures.delete(i);
      }
    }
  }

  /** For the Big PDF stats readout: EPUB pages are small, fixed-size canvases. */
  getStats(): PageStats {
    let bytes = 0;
    for (const tex of this.textures.values()) bytes += textureBytes(tex);
    return { lastRenderMs: this.lastRenderMs, cachedPages: this.textures.size, textureBytes: bytes, pending: this.pending.size, cancelled: 0 };
  }

  dispose(): void {
    for (const tex of this.textures.values()) tex.dispose();
    this.textures.clear();
    for (const img of this.decoded.values()) {
      if (img && 'close' in img) img.close();
    }
    this.decoded.clear();
    this.laid = [];
    this.images.clear();
    this.pageCount = 0;
  }

  private async render(index: number): Promise<void> {
    if (this.pending.has(index) || !this.laid[index]) return;
    this.pending.add(index);
    const t0 = performance.now();
    try {
      const page = this.laid[index];
      await this.ensureImages(page.ops);
      if (!this.laid[index]) return;
      const canvas = document.createElement('canvas');
      canvas.width = EPUB_PAGE_W;
      canvas.height = EPUB_PAGE_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#fbf7ee';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#1c1612';
      ctx.textBaseline = 'top';
      for (const op of page.ops) this.paint(ctx, op);
      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      if (!this.laid[index]) {
        tex.dispose();
        return;
      }
      this.textures.set(index, tex);
      this.lastRenderMs = Math.round(performance.now() - t0);
      this.failed.delete(index);
      this.onPageReady(index);
    } catch (err) {
      this.failed.add(index);
      console.warn(`[epub] failed to render page ${index + 1}`, err);
    } finally {
      this.pending.delete(index);
    }
  }

  private paint(ctx: CanvasRenderingContext2D, op: EpubOp): void {
    if (op.kind === 'text') {
      ctx.font = op.font || EPUB_FONTS.p;
      ctx.fillStyle = '#1c1612';
      ctx.fillText(op.text ?? '', op.x, op.y);
      return;
    }
    const img = op.path ? this.decoded.get(op.path) : undefined;
    if (!img || !op.w || !op.h) return;
    ctx.drawImage(img, op.x, op.y, op.w, op.h);
  }

  private async ensureImages(ops: EpubOp[]): Promise<void> {
    for (const op of ops) {
      if (op.kind !== 'image' || !op.path || this.decoded.has(op.path)) continue;
      const bytes = this.images.get(op.path);
      if (!bytes) {
        this.decoded.set(op.path, null);
        continue;
      }
      try {
        this.decoded.set(op.path, await decodeImage(bytes));
      } catch {
        this.decoded.set(op.path, null);
      }
    }
  }
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

async function decodeImage(bytes: Uint8Array): Promise<Decoded> {
  const blob = new Blob([bytes.slice()]);
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
