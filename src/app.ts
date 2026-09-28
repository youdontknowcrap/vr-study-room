/**
 * App — the few long-lived objects every system needs, in one place.
 *
 * index.ts fills these in at startup. Systems import `app` and use them.
 * (A bigger project might use ECS components or dependency injection; for a
 * one-room app a plain shared object is the easiest thing to follow.)
 */
import type { World } from '@iwsdk/core';
import type { Music } from './audio/music.js';
import type { Book } from './book/book.js';
import { PdfPages, type PdfSource } from './book/pdf-pages.js';
import type { EnvironmentManager } from './room/environments.js';
import type { Room } from './room/room.js';
import type { LaunchOverlay } from './ui2d/launch-overlay.js';

export const SAMPLE_BOOK_URL = `${import.meta.env.BASE_URL}books/sample-book.pdf`;

export const app = {
  world: null as unknown as World,
  room: null as unknown as Room,
  book: null as unknown as Book,
  music: null as unknown as Music,
  environments: null as unknown as EnvironmentManager,
  overlay: null as unknown as LaunchOverlay,
  /** Name + page count of the open PDF, shown in menus. */
  bookTitle: '',
};

/** Load a PDF (bundled sample or a user file) into the 3D book. */
export async function loadPdf(source: PdfSource, title: string): Promise<void> {
  app.overlay.setStatus(`Loading “${title}”…`);
  try {
    const pages = await PdfPages.load(source, title);
    app.book.setPages(pages);
    app.bookTitle = `${title} (${pages.pageCount} p.)`;
    app.overlay.setStatus(`Open: ${app.bookTitle}`);
  } catch (err) {
    console.error('[pdf] could not open', err);
    app.overlay.setStatus(`Could not open “${title}”. Is it a valid PDF?`);
  }
}

export function loadSampleBook(): Promise<void> {
  return loadPdf({ url: SAMPLE_BOOK_URL }, 'Sample booklet');
}

/**
 * "Open PDF…" / "Add music…" from INSIDE VR.
 *
 * WebXR immersive sessions cannot show normal web page dialogs, and a file
 * picker may only open in direct response to a click on the 2D page. So we
 * leave VR, show a big button on the 2D page, and the user taps it (that tap
 * is the required "user gesture"), picks files, and presses Enter VR again.
 * Music keeps playing throughout.
 */
export function requestPicker(kind: 'pdf' | 'music'): void {
  if (app.world.session) {
    app.world.exitXR();
    app.overlay.promptPicker(kind);
  } else {
    // Already on the 2D page and (usually) inside a click handler: open now.
    app.overlay.openPicker(kind);
  }
}
