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
