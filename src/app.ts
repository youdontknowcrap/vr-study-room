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
import type { BookSystem } from './book/book-system.js';
import type { BookPages } from './book/book-pages.js';
import { EpubPages, type EpubSource } from './book/epub-pages.js';
import { PdfPages, type PdfSource } from './book/pdf-pages.js';
import { loadProgress } from './book/reading-progress.js';
import type { StudyRoom } from './room/room-types.js';
import type { LaunchOverlay } from './ui2d/launch-overlay.js';

export const SAMPLE_BOOK_URL = `${import.meta.env.BASE_URL}books/sample-book.pdf`;

/** Bumped on every open so a slow file can't replace the one you picked next. */
let openGeneration = 0;

export const app = {
  world: null as unknown as World,
  room: null as unknown as StudyRoom,
  book: null as unknown as Book,
  music: null as unknown as Music,
  /** Set by BookSystem.init(); lets the menu call bringBack(). */
  bookSystem: null as unknown as BookSystem,
  overlay: null as unknown as LaunchOverlay,
  /** Name + page count of the open PDF, shown in menus. */
  bookTitle: '',
};

/**
 * Load a PDF or EPUB into the 3D book, opening it at the page where you
 * last stopped reading THIS book (reading-progress.ts).
 * Picking MUSIC never calls this.
 */
async function openBook(title: string, load: () => Promise<BookPages>): Promise<void> {
  const generation = ++openGeneration;
  app.overlay.setStatus(`Loading “${title}”…`);
  try {
    const pages = await load();
    if (generation !== openGeneration) {
      pages.dispose();
      return;
    }
    const saved = loadProgress(pages.id);
    app.book.setPages(pages, saved ?? -1);
    const shown = pages.title || title;
    app.bookTitle = `${shown} (${pages.pageCount} p.)`;
    const resumed = saved !== null && saved >= 0 ? ` — resumed at ${app.book.spreadLabel}` : '';
    app.overlay.setStatus(`Open: ${app.bookTitle}${resumed}`);
  } catch (err) {
    if (generation !== openGeneration) return;
    console.error('[book] could not open', err);
    app.overlay.setStatus(openError(title, err));
  }
}

function openError(title: string, err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : '';
  if (name === 'PasswordException' || /password/i.test(message)) {
    return `“${title}” is password-protected.`;
  }
  if (message.startsWith('This EPUB')) return message;
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(message)) {
    return `“${title}” isn’t a valid PDF.`;
  }
  return `Could not open “${title}”. Use a PDF or an EPUB.`;
}

export function loadPdf(source: PdfSource, title: string): Promise<void> {
  return openBook(title, () => PdfPages.load(source, title));
}

export function loadEpub(source: EpubSource, title: string): Promise<void> {
  return openBook(title, () => EpubPages.load(source, title));
}

export function loadSampleBook(): Promise<void> {
  return loadPdf({ url: SAMPLE_BOOK_URL }, 'Sample booklet');
}

/** A file from the page picker. PDFs stream from a blob URL; EPUBs are unzipped here. */
export async function loadBookFile(file: File): Promise<void> {
  const title = file.name.replace(/\.(pdf|epub)$/i, '');
  const kind = await bookKind(file);
  if (kind === 'epub') {
    await loadEpub({ data: new Uint8Array(await file.arrayBuffer()) }, title);
    return;
  }
  if (kind === 'pdf') {
    const url = URL.createObjectURL(file);
    await loadPdf({ url, ownedUrl: url }, title);
    return;
  }
  app.overlay.setStatus(`“${file.name}” isn’t a PDF or an EPUB.`);
}

async function bookKind(file: File): Promise<'pdf' | 'epub' | null> {
  if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') return 'epub';
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return 'pdf';
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) return 'epub';
  return null;
}

/**
 * "Open book…" / "Add music…" from INSIDE VR.
 *
 * WebXR immersive sessions cannot show normal web page dialogs, and a file
 * picker may only open in direct response to a click on the 2D page. So we
 * leave VR, show a big button on the 2D page, and the user taps it (that tap
 * is the required "user gesture"), picks files, and presses Enter VR again.
 * Music keeps playing throughout, and the book keeps its pages and its spot
 * on the desk (it is parented to the desk, see BookSystem).
 */
export type PickerKind = 'book' | 'music';

export function requestPicker(kind: PickerKind): void {
  if (app.world.session) {
    app.world.exitXR();
    app.overlay.promptPicker(kind);
  } else {
    // Already on the 2D page and (usually) inside a click handler: open now.
    app.overlay.openPicker(kind);
  }
}
