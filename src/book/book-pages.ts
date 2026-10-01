/**
 * What the 3D book needs from a document, whether it came from a PDF or an EPUB.
 * Page indexes are 0-based. `get` may return null while a page is still painting.
 */
import type { Texture } from '@iwsdk/core';

/**
 * Numbers for the on-screen stats readout (menu: Big PDF ▸ Stats).
 * Optional so a page source that doesn't track them still compiles.
 */
export interface PageStats {
  /** How long the last finished page render took, in milliseconds. */
  lastRenderMs: number;
  /** Rendered pages currently held (each one = a canvas + a GPU texture). */
  cachedPages: number;
  /** Rough GPU memory of those textures in bytes (w x h x 4, +1/3 for mipmaps). */
  textureBytes: number;
  /** Renders still waiting their turn (render queue) or running. */
  pending: number;
  /** Renders cancelled because you flipped past them (render queue). */
  cancelled: number;
}

export interface BookPages {
  readonly id: string;
  readonly title: string;
  readonly pageCount: number;
  /** width / height of a page. */
  readonly aspect: number;
  onPageReady: (index: number) => void;
  get(index: number): Texture | null;
  /**
   * True when a turn may show this page: it already has pixels, the render
   * gave up, or the index isn't a real page (a cover).
   */
  ready(index: number): boolean;
  /** True when this page is already at full reader resolution. */
  fresh?(index: number): boolean;
  keepAround(center: number): void;
  /**
   * Release a cancelled paint that never came back. `dt` is the frame
   * delta in seconds. A multi-second gap is a paused headset, not a hang.
   */
  service?(dt?: number): void;
  dispose(): void;
  getStats?(): PageStats;
}

/**
 * Rough GPU bytes of a canvas texture. WHY x4/3: three.js builds mipmaps
 * (smaller copies used when the page is far away / tilted), which add
 * 1/4 + 1/16 + ... = about one third on top of the full-size image.
 */
export function textureBytes(tex: Texture): number {
  const img = tex.image as { width?: number; height?: number } | undefined;
  return ((img?.width ?? 0) * (img?.height ?? 0) * 4 * 4) / 3;
}
