/**
 * User settings that survive page reloads, stored in localStorage.
 * (localStorage = a tiny key/value store the browser keeps per website.)
 */
import { signal } from '@iwsdk/core';
import { ENVIRONMENT_IDS, type EnvironmentId } from './room/environments.js';

/** Which hand holds the book. 'desk' = the book floats over the desk instead. */
export type BookHand = 'left' | 'right' | 'desk';
export type { EnvironmentId };

const KEY_HAND = 'vrStudyRoom.bookHand';
const KEY_ENV = 'vrStudyRoom.environment';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback; // e.g. storage disabled in private mode
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/**
 * Signals are observable values: anything can `.subscribe()` and gets called
 * when `.value` changes. The menu, 2D page and book all stay in sync this way.
 */
export const bookHand = signal<BookHand>(
  read<BookHand>(KEY_HAND, ['left', 'right', 'desk'], 'left'),
);
bookHand.subscribe((v) => write(KEY_HAND, v));

export const environmentId = signal<EnvironmentId>(
  read<EnvironmentId>(KEY_ENV, ENVIRONMENT_IDS, 'fireplace'),
);
environmentId.subscribe((v) => write(KEY_ENV, v));

export function cycleBookHand(): void {
  const order: BookHand[] = ['left', 'right', 'desk'];
  bookHand.value = order[(order.indexOf(bookHand.value) + 1) % order.length];
}
export function cycleEnvironment(): void {
  const i = ENVIRONMENT_IDS.indexOf(environmentId.value);
  environmentId.value = ENVIRONMENT_IDS[(i + 1) % ENVIRONMENT_IDS.length];
}

export const BOOK_HAND_LABEL: Record<BookHand, string> = {
  left: 'Left hand',
  right: 'Right hand',
  desk: 'On desk',
};
