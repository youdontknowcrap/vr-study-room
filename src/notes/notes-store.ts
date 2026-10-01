/**
 * Saved notebooks in IndexedDB.
 *
 * WHY IndexedDB and not localStorage (where settings live)? localStorage is a
 * few MB of strings and blocks the main thread on every write. A notebook can
 * hold thousands of stroke points; IndexedDB stores structured objects,
 * asynchronously, with far more room. One object store, keyed by name:
 *   "notes-2026-10-01_15-42-07"  -> SavedNotebook (Save button)
 *   "__autosave__"               -> SavedNotebook (quiet crash safety net)
 */
import { deserializeNotebook, type SavedNotebook } from './notes-model.js';

const DB_NAME = 'vrStudyRoom.notes';
const STORE = 'notebooks';
export const AUTOSAVE_KEY = '__autosave__';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    // Runs the first time (or on a version bump): create the store.
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open must not stick forever: try again next time.
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

/** Wrap one request in a promise (IndexedDB predates promises). */
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        // Resolve on COMPLETE (not request success) so a write is really on disk.
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

export function putNotebook(key: string, nb: SavedNotebook): Promise<void> {
  return run('readwrite', (s) => s.put(nb, key)).then(() => undefined);
}

export async function getNotebook(key: string): Promise<SavedNotebook | null> {
  return deserializeNotebook(await run('readonly', (s) => s.get(key)));
}

/** Saved notebooks (not the autosave), newest first. */
export async function listNotebooks(): Promise<{ key: string; name: string; savedAt: number; pages: number }[]> {
  const [keys, values] = await Promise.all([
    run('readonly', (s) => s.getAllKeys()),
    run('readonly', (s) => s.getAll()),
  ]);
  const out: { key: string; name: string; savedAt: number; pages: number }[] = [];
  keys.forEach((k, i) => {
    if (k === AUTOSAVE_KEY) return;
    const v = values[i] as Partial<SavedNotebook> | undefined;
    out.push({
      key: String(k),
      name: v?.name ?? String(k),
      savedAt: v?.savedAt ?? 0,
      pages: Array.isArray(v?.pages) ? v.pages.length : 0,
    });
  });
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
