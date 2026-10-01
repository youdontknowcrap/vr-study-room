/**
 * Reading progress: remembers the last page you read in EACH book.
 *
 * Stored in localStorage as one small JSON object:
 *   { "fp:3f2a...": { "left": 41, "t": 1767225600000 }, ... }
 * The key is the open book's id (a PDF fingerprint, or a hash of the EPUB).
 * `left` is the page index shown on the left of the open spread (-1 = the
 * inside cover). `t` = when it was saved, so we can forget the oldest books
 * and the store never grows without limit.
 */
const STORAGE_KEY = 'vrStudyRoom.readingProgress';
const MAX_BOOKS = 50;

type Store = Record<string, { left: number; t: number }>;

function readStore(): Store {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {}; // corrupted JSON or storage disabled: start fresh
  }
}

/** Last saved left-page index for this book, or null if never opened. */
export function loadProgress(bookId: string): number | null {
  const entry = readStore()[bookId];
  return entry && Number.isInteger(entry.left) ? entry.left : null;
}

export function saveProgress(bookId: string, left: number): void {
  if (!bookId) return;
  const store = readStore();
  store[bookId] = { left, t: Date.now() };
  // Keep only the most recently read MAX_BOOKS books.
  const ids = Object.keys(store);
  if (ids.length > MAX_BOOKS) {
    ids.sort((a, b) => store[a].t - store[b].t);
    for (const id of ids.slice(0, ids.length - MAX_BOOKS)) delete store[id];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage full / disabled: progress just isn't saved */
  }
}
