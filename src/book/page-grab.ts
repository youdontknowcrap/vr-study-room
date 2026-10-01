/**
 * Page-grab rules: pure functions (no three.js, no World), so they can be
 * unit-tested in plain Node (scripts/unit-page-grab.mjs).
 *
 * WHAT EACH PRESS DOES (the rules Joey asked for)
 * -----------------------------------------------
 *   Book held in ONE hand, OTHER ("free") hand:
 *     trigger / pinch on (or aimed at) a page -> GRAB THAT PAGE. Move your
 *         hand and the page swings around the spine, following it. Let go
 *         past halfway -> the page turns; otherwise it falls back.
 *         Right page = forward, left page = back.
 *         A quick tap (short, hand barely moved) just flips the page.
 *     trigger / pinch anywhere else       -> nothing. Never swaps hands.
 *     squeeze (grip) on / at the book     -> swap the book to this hand.
 *   The hand HOLDING the book: its trigger does nothing to the hold (only
 *     letting go of the button that picked it up drops the book).
 *   Book NOT held (on the stand, table, floor):
 *     trigger / pinch on a page           -> grab the page (as above).
 *     trigger / pinch on cover/spine/edge -> pick the book up (from afar
 *         with the ray too, as before).
 *     squeeze                             -> always picks the book up.
 *
 * Coordinates: everything here is in the book's MODEL space (see
 * Book.toModel): x = across the spread (left page x < 0, right x > 0,
 * spine at 0), y = up the page, z = out of the pages toward the reader.
 * The open book is a shallow "V": page surface z = |x| * slope + baseZ.
 */
import type { PressSource } from '../input/actions.js';

export interface PageSurface {
  halfWidth: number;
  halfHeight: number;
  slope: number;
  baseZ: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Strip along the spine (fraction of halfWidth) that is NOT a page: aiming there grabs the book. */
export const SPINE_ZONE = 0.08;
/** A page counts out to this fraction of the page size (the rest is the cover's edge). */
const PAGE_EXTENT = 0.98;
/** Quick tap: released within this many seconds... */
export const TAP_SECONDS = 0.3;
/** ...and the hand moved less than this (meters, in the world). */
export const TAP_MOVE = 0.03;

export type PressIntent = 'pageGrab' | 'pickUp' | 'none';

/**
 * Decide what a fresh press of THIS hand means.
 *  heldByOther: the book is in the other hand.
 *  heldByThis: the book is in this hand (then the press never changes the hold).
 *  onPage / onBook: is the hand at (or aiming at) a page / any part of the book.
 */
export function decidePress(o: {
  via: PressSource;
  heldByThis: boolean;
  heldByOther: boolean;
  onPage: boolean;
  onBook: boolean;
}): PressIntent {
  if (o.heldByThis || o.via === 'none') return 'none';
  if (o.via === 'squeeze') return o.onBook || o.onPage ? 'pickUp' : 'none';
  // trigger / pinch = the "fine" press
  if (o.onPage) return 'pageGrab';
  if (o.heldByOther) return 'none'; // never swap hands with trigger/pinch
  return o.onBook ? 'pickUp' : 'none';
}

/** Which page an x (model units) is on: +1 right (turns forward), -1 left (back), 0 = spine/outside. */
export function pageSideAtX(x: number, s: PageSurface): -1 | 0 | 1 {
  const ax = Math.abs(x);
  if (ax < s.halfWidth * SPINE_ZONE || ax > s.halfWidth * PAGE_EXTENT) return 0;
  return x > 0 ? 1 : -1;
}

/**
 * Hand (grab point) close to a page? `scale` = book size (model units are
 * scaled by it), so the "a few cm above the page" window stays in meters.
 */
export function nearPageSide(p: Vec3Like, s: PageSurface, scale: number): -1 | 0 | 1 {
  if (Math.abs(p.y) > s.halfHeight * PAGE_EXTENT) return 0;
  const above = p.z - (Math.abs(p.x) * s.slope + s.baseZ);
  if (above < -0.03 / scale || above > 0.07 / scale) return 0;
  return pageSideAtX(p.x, s);
}

/**
 * Where a pointing ray (origin + direction, model space) first hits the
 * page surface from the FRONT, or null. The V is two planes:
 *   right page: z = +x*slope + baseZ (x >= 0), left: z = -x*slope + baseZ.
 * For a plane z = k*x + b, the ray point o + t*d is on it when
 *   t = (b + k*o.x - o.z) / (d.z - k*d.x).
 */
export function rayPageHit(o: Vec3Like, d: Vec3Like, s: PageSurface): { x: number; y: number; t: number } | null {
  let best: { x: number; y: number; t: number } | null = null;
  for (const k of [s.slope, -s.slope]) {
    const denom = d.z - k * d.x;
    // Must travel INTO the page's front (normal (-k, 0, 1)): d . n < 0.
    if (denom >= -1e-6) continue;
    const t = (s.baseZ + k * o.x - o.z) / denom;
    if (t <= 0) continue;
    const x = o.x + t * d.x;
    const y = o.y + t * d.y;
    if (k > 0 ? x < 0 : x > 0) continue; // hit the wrong half's extension
    if (Math.abs(y) > s.halfHeight * PAGE_EXTENT) continue;
    if (pageSideAtX(x, s) === 0) continue;
    if (!best || t < best.t) best = { x, y, t };
  }
  return best;
}

/**
 * While dragging with a RAY: where across the spread (x) the ray points,
 * measured on the flat plane through the spine (z = baseZ). null if the ray
 * runs parallel to it (keep the last x then).
 */
export function rayDragX(o: Vec3Like, d: Vec3Like, s: PageSurface): number | null {
  if (Math.abs(d.z) < 1e-4) return null;
  const t = (s.baseZ - o.z) / d.z;
  if (t <= 0) return null;
  return o.x + t * d.x;
}

/** Was this page grab just a quick tap (=> flip the page instead of letting it fall back)? */
export function isQuickTap(seconds: number, movedMeters: number): boolean {
  return seconds < TAP_SECONDS && movedMeters < TAP_MOVE;
}
