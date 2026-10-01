/**
 * How many PDF pages stay around the open spread, and when a turn is allowed.
 *
 * The open spread sits in the middle: 4 pages before it, the two open pages,
 * and 4 pages after. Near either end of the file the window slides so it
 * still holds 10 pages when the file is that long. A turn is refused while
 * any real page it would show is still painting, so a flip can't land on
 * blank paper. Pages already painted stay turnable.
 */

/** Rendered pages kept around the open spread. */
export const PDF_STREAM_WINDOW = 10;

/**
 * How many pages to hold.
 * `cache === 0` is the old "±6" experiment (the caller handles that).
 * With the render queue on, the window is always 10, centered on the spread.
 * A stored 30 (or 6) does not widen it — 30 full scans stalled the headset
 * after the first page. With the queue off, the stored cache size is the cap.
 */
export function pdfKeepCount(cache: number, queueOn: boolean): number {
  if (cache === 0) return 0;
  if (!queueOn) return Math.max(2, cache);
  return PDF_STREAM_WINDOW;
}

/**
 * Page indexes to keep. `center` is the right-hand page of the open spread,
 * so the spread itself is `[center - 1, center]`.
 */
export function pagesAround(center: number, pageCount: number, size = PDF_STREAM_WINDOW): number[] {
  if (pageCount <= 0 || size <= 0) return [];
  const count = Math.min(size, pageCount);
  // 4 before the left page when count is 10. The two spread pages take the middle.
  const before = Math.floor((count - 2) / 2);
  let start = center - 1 - before;
  let end = start + count;
  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > pageCount) {
    start = Math.max(0, start - (end - pageCount));
    end = pageCount;
  }
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/** Real pages a turn puts on the leaf or uncovers. Covers are included and ignored by `turnAllowed`. */
export function turnNeeds(left: number, dir: 1 | -1): number[] {
  if (dir === 1) return [left + 1, left + 2, left + 3];
  return [left, left - 1, left - 2];
}

/**
 * Forward/back only when every real page that turn would show already has
 * pixels. `hasTexture` is true for a painted page. Out-of-range indexes are
 * covers and do not block.
 */
export function turnAllowed(
  left: number,
  pageCount: number,
  dir: 1 | -1,
  hasTexture: (index: number) => boolean,
): boolean {
  const inBook = dir === 1 ? left + 1 <= pageCount - 1 : left >= 0;
  if (!inBook || pageCount <= 0) return false;
  for (const i of turnNeeds(left, dir)) {
    if (i < 0 || i >= pageCount) continue;
    if (!hasTexture(i)) return false;
  }
  return true;
}
