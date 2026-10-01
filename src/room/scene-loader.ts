/**
 * Client side of custom scenes: ask the server which scenes it has, and
 * turn one into a GlbRoomConfig.
 *
 * The server part is vite-plugins/local-scenes.ts. It answers
 * custom-scenes/index.json and serves custom-scenes/<id>/<file>.
 *
 * WHY fetch the list at launch (instead of baking it into the JS bundle):
 * the same build then works with ANY scenes folder. A static host without
 * scenes (e.g. GitHub Pages) simply returns 404 for index.json, and the app
 * carries on with the built-in rooms only.
 */
import { signal } from '@iwsdk/core';
import { BUILTIN_ROOMS, type BuiltinRoom, type GlbRoomConfig } from './room-config.js';
import { validateManifest, type SceneIndexEntry } from './scene-manifest.js';

const SCENES_BASE = `${import.meta.env.BASE_URL}custom-scenes/`;

let index: SceneIndexEntry[] = [];
let loading: Promise<SceneIndexEntry[]> | null = null;

/**
 * Message about the room shown in the menu footer (and the console), e.g.
 * "Scene 'my-room' failed: … Showing the Pool room." Empty = all good.
 * WHY a signal: the menu redraws itself when it changes, no extra wiring.
 */
export const roomNotice = signal('');

/** Fetch custom-scenes/index.json once. Never throws: no list = no custom scenes. */
export function loadSceneIndex(): Promise<SceneIndexEntry[]> {
  loading ??= (async () => {
    try {
      const res = await fetch(`${SCENES_BASE}index.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { scenes?: SceneIndexEntry[] };
      index = Array.isArray(data.scenes) ? data.scenes : [];
    } catch (err) {
      console.info('[scenes] no custom scene list on this server; built-in rooms only', err);
      index = [];
    }
    for (const s of index) {
      if (s.error) console.warn(`[scenes] skipping "${s.id}": ${s.error}`);
    }
    const ok = index.filter((s) => !s.error).map((s) => s.id);
    console.info(`[scenes] custom scenes: ${ok.join(', ') || 'none'}`);
    return index;
  })();
  return loading;
}

/** What the menu's Room button cycles through: built-ins first, then working custom scenes. */
export function availableRooms(): BuiltinRoom[] {
  return [...BUILTIN_ROOMS, ...index.filter((s) => !s.error).map((s) => ({ id: s.id, name: s.name }))];
}

/** Index entry for an id (undefined = no such folder on the server). */
export function findScene(id: string): SceneIndexEntry | undefined {
  return index.find((s) => s.id === id);
}

/**
 * Fetch + validate scene.json. Throws an Error with a readable message
 * (it ends up in the menu), the caller falls back to the pool room.
 */
export async function loadSceneConfig(id: string): Promise<GlbRoomConfig> {
  const entry = findScene(id);
  if (!entry) throw new Error(`no folder scenes/${id}/ on this server`);
  if (entry.error) throw new Error(entry.error);
  const baseUrl = `${SCENES_BASE}${encodeURIComponent(id)}/`;
  const res = await fetch(`${baseUrl}scene.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`scene.json: HTTP ${res.status}`);
  const v = validateManifest(await res.json());
  if (!v.ok) throw new Error(v.errors.join('; '));
  for (const w of v.warnings) console.warn(`[scenes] ${id}: ${w}`);
  return { ...v.manifest, baseUrl };
}
