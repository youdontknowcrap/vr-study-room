/**
 * What the 3D book needs from a document, whether it came from a PDF or an EPUB.
 * Page indexes are 0-based. `get` may return null while a page is still painting.
 */
import type { Texture } from '@iwsdk/core';

export interface BookPages {
  readonly id: string;
  readonly title: string;
  readonly pageCount: number;
  /** width / height of a page. */
  readonly aspect: number;
  onPageReady: (index: number) => void;
  get(index: number): Texture | null;
  keepAround(center: number): void;
  dispose(): void;
}
