/**
 * User settings that survive page reloads, stored in localStorage.
 * (localStorage = a tiny key/value store the browser keeps per website.)
 *
 * Each setting is a SIGNAL: an observable value. Anything can `.subscribe()`
 * and gets called when `.value` changes. The menu, the room and the book all
 * stay in sync this way, and saving is just one more subscriber.
 */
import { signal } from '@iwsdk/core';
import {
  ROOM_CHOICES,
  ROOM_QUALITIES,
  type RoomChoice,
  type RoomQuality,
} from './room/room-config.js';

const KEY_BOOK_SCALE = 'vrStudyRoom.bookScale';
const KEY_DESK_HEIGHT = 'vrStudyRoom.deskHeight';
const KEY_DESK_TILT = 'vrStudyRoom.deskTilt';
const KEY_ROOM = 'vrStudyRoom.room';
const KEY_ROOM_QUALITY = 'vrStudyRoom.roomQuality';

/** A number setting: default, allowed range and the step the +/- buttons use. */
export interface NumberSetting {
  default: number;
  min: number;
  max: number;
  step: number;
}

/**
 * BOOK SIZE as a multiplier: 1.0 = 100% (an A5-ish book, 21 cm tall pages).
 * 10% steps from 60% to 200%. Applies in your hand and on the desk.
 */
export const BOOK_SCALE: NumberSetting = { default: 1.0, min: 0.6, max: 2.0, step: 0.1 };

/**
 * DESK HEIGHT in meters above the REAL floor, measured at the middle of the
 * (slanted) desktop, where the book lies.
 * Default 0.63 m = 10% lower than the old typical height (eyes at ~1.2 m
 * seated minus 0.5 m = 0.70 m). Step 2 cm.
 */
export const DESK_HEIGHT: NumberSetting = { default: 0.63, min: 0.45, max: 0.95, step: 0.02 };

/**
 * DESK TILT in degrees, like a drafting desk: the edge near you is lower.
 * 0 = flat table. Step 5 degrees.
 */
export const DESK_TILT: NumberSetting = { default: 15, min: 0, max: 40, step: 5 };

function readNumber(key: string, s: NumberSetting): number {
  try {
    const raw = localStorage.getItem(key);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? clampSetting(v, s) : s.default;
  } catch {
    return s.default; // e.g. storage disabled in private mode
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore: settings just won't persist */
  }
}

/** Keep a value inside the setting's range, rounded to a whole step. */
export function clampSetting(v: number, s: NumberSetting): number {
  const clamped = Math.min(s.max, Math.max(s.min, v));
  // Rounding to the step avoids 0.1 + 0.2 = 0.30000000000000004 drift.
  const steps = Math.round((clamped - s.min) / s.step);
  return +(s.min + steps * s.step).toFixed(4);
}

function numberSignal(key: string, s: NumberSetting) {
  const sig = signal(readNumber(key, s));
  sig.subscribe((v) => write(key, String(v)));
  return sig;
}

export const bookScale = numberSignal(KEY_BOOK_SCALE, BOOK_SCALE);
export const deskHeight = numberSignal(KEY_DESK_HEIGHT, DESK_HEIGHT);
export const deskTilt = numberSignal(KEY_DESK_TILT, DESK_TILT);

/** Change a number setting by `dir` steps (+1 / -1), staying in range. */
export function stepSetting(
  sig: { value: number },
  s: NumberSetting,
  dir: 1 | -1,
): void {
  sig.value = clampSetting(sig.value + dir * s.step, s);
}

/**
 * ROOM: "apartment" (the sitcom apartment, the default) or "glass" (the built-in
 * glass-door room, the fallback). The menu's Room button flips it.
 */
function readRoom(): RoomChoice {
  try {
    const raw = localStorage.getItem(KEY_ROOM) as RoomChoice | null;
    return raw && ROOM_CHOICES.includes(raw) ? raw : 'apartment';
  } catch {
    return 'apartment';
  }
}
export const roomChoice = signal<RoomChoice>(readRoom());
roomChoice.subscribe((v) => write(KEY_ROOM, v));

/** QUALITY of model rooms: "high" (full-res textures, default) or "lite". */
function readQuality(): RoomQuality {
  try {
    const raw = localStorage.getItem(KEY_ROOM_QUALITY) as RoomQuality | null;
    return raw && ROOM_QUALITIES.includes(raw) ? raw : 'high';
  } catch {
    return 'high';
  }
}
export const roomQuality = signal<RoomQuality>(readQuality());
roomQuality.subscribe((v) => write(KEY_ROOM_QUALITY, v));

// ---------------------------------------------------------------------------
// BIG PDF / PERFORMANCE toggles (menu: "Big PDF ▸")
// ---------------------------------------------------------------------------
// WHY these exist: a 287 MB scanned book (every page = ~17 megapixels of JPEG
// + JBIG2 layers) freezes a Quest 2. Each toggle below switches ONE fix on or
// off so you can feel/measure what each one buys you in the headset. Each is
// its own localStorage key so you can A/B test them independently.
// RAPID ITERATION NOTE: these are deliberately simple signals. When the
// experiments are done, keep the winners as plain constants and delete the rest.

const KEY_PDF_STREAMING = 'vrStudyRoom.pdfStreaming';
const KEY_PDF_RES = 'vrStudyRoom.pdfResolution';
const KEY_PDF_CACHE = 'vrStudyRoom.pdfCache';
const KEY_PDF_QUEUE = 'vrStudyRoom.pdfRenderQueue';
const KEY_PDF_PREVIEW = 'vrStudyRoom.pdfPreview';
const KEY_PERF_STATS = 'vrStudyRoom.perfStats';

/** A boolean setting stored as "1"/"0". */
function boolSignal(key: string, fallback: boolean) {
  let initial = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1' || raw === '0') initial = raw === '1';
  } catch {
    /* storage disabled: use the default */
  }
  const sig = signal(initial);
  sig.subscribe((v) => write(key, v ? '1' : '0'));
  return sig;
}

/** A setting that must be one of a fixed list of numbers (cycled by -/+ buttons). */
function levelSignal(key: string, levels: readonly number[], fallback: number) {
  let initial = fallback;
  try {
    const raw = localStorage.getItem(key);
    // Careful: Number(null) is 0, and 0 is a real level ("Old" cache), so a
    // missing key must be checked BEFORE converting.
    const v = raw === null ? NaN : Number(raw);
    if (levels.includes(v)) initial = v; // ignore stale/unknown values
  } catch {
    /* ignore */
  }
  const sig = signal(initial);
  sig.subscribe((v) => write(key, String(v)));
  return sig;
}

/** Move a level setting one step through its list (stops at the ends). */
export function stepLevel(sig: { value: number }, levels: readonly number[], dir: 1 | -1): void {
  const i = levels.indexOf(sig.value);
  const next = Math.min(levels.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir));
  sig.value = levels[next];
}

/**
 * 1. STREAMING LOAD. On = pdf.js reads only the byte ranges it needs from the
 * File (File.slice), so a 287 MB file never sits in memory as one big copy.
 * Off = the old way (blob URL, which pdf.js downloads in full).
 * Takes effect the next time a book is opened (menu: "Reopen book").
 */
export const pdfStreaming = boolSignal(KEY_PDF_STREAMING, true);

/**
 * 2. PAGE RESOLUTION CAP: pixels on the page's LONG side.
 * 640 = the old behaviour (pages were rendered 640 px tall).
 * Memory grows with the SQUARE of this: 2048 is ~10x the pixels of 640.
 */
export const PDF_RES_LEVELS = [640, 800, 1200, 1600, 2048] as const;
export const pdfResolution = levelSignal(KEY_PDF_RES, PDF_RES_LEVELS, 1200);

/**
 * 3. PAGE CACHE SIZE: how many rendered pages to keep. 0 = "Old": the
 * original rule (keep anything within 6 pages of the spread, up to 13).
 * 10 = the streaming window (open spread in the middle). With the render
 * queue on, that window stays 10 even if an older saved value was 30 — see
 * pdfKeepCount. The smaller steps still apply when the queue is off.
 * A saved 30 is ignored (it is not in this list) and falls back to 10.
 */
export const PDF_CACHE_LEVELS = [2, 4, 6, 8, 10, 0] as const;
export const pdfCacheSize = levelSignal(KEY_PDF_CACHE, PDF_CACHE_LEVELS, 10);

/** 4. RENDER QUEUE: one render at a time, newest request wins, stale ones cancelled. */
export const pdfRenderQueue = boolSignal(KEY_PDF_QUEUE, true);

/** 5. BLURRY-FIRST PREVIEW: a quick ~360 px pass before the sharp one. */
export const pdfPreview = boolSignal(KEY_PDF_PREVIEW, true);

/** On-screen stats readout (render ms, pages cached, texture MB, JS heap). */
export const perfStats = boolSignal(KEY_PERF_STATS, false);

/**
 * The headset had saved queue off, cache "Old", and blurry-first off.
 * That left the open pages at 360 px and held the loading square.
 * Apply the working set once; the Big PDF menu can still change it after.
 */
function restoreReaderSettings(): void {
  const revKey = 'vrStudyRoom.pdfSettingsRev';
  try {
    if (localStorage.getItem(revKey) === '2') return;
  } catch {
    return;
  }
  pdfStreaming.value = true;
  pdfResolution.value = 1200;
  pdfCacheSize.value = 10;
  pdfRenderQueue.value = true;
  pdfPreview.value = true;
  try {
    localStorage.setItem(revKey, '2');
  } catch {
    /* storage disabled: the values above still apply for this session */
  }
}
restoreReaderSettings();
