/**
 * Which rooms exist, and the config a 3D-model room is built from.
 *
 * Two kinds of rooms:
 *  - BUILT-IN rooms ship with the app and are freely licensed. Right now
 *    that's the pool room (procedural-room.ts: boxes in code + two CC0
 *    textures). It is the DEFAULT, and the FALLBACK whenever a custom scene
 *    is missing or broken, because it needs nothing but the app itself.
 *  - CUSTOM scenes live on YOUR server, in the gitignored `scenes/` folder
 *    (one folder per room with a scene.json; see scenes/README.md). They are
 *    discovered at launch from custom-scenes/index.json.
 *
 * WHY custom scenes are not in the repo: a downloaded model has its own
 * license, and a model of a TV/film set may also involve someone else's
 * copyright. Keeping them out of git means the code can be public while
 * each person brings their own rooms.
 *
 * The menu's "Room" button cycles built-ins + custom scenes (saved in
 * localStorage). `?room=<id>` in the URL forces one (`?room=glass` = pool room).
 */
import type { SceneManifest } from './scene-manifest.js';

/** Texture quality of 3D-model rooms (menu "Quality: High / Lite"). */
export type RoomQuality = 'high' | 'lite';
export const ROOM_QUALITIES: readonly RoomQuality[] = ['high', 'lite'];

/**
 * A room id: a built-in id ('glass') or a custom scene's folder name.
 * WHY a plain string instead of a union type: custom scenes are only known
 * at run time (whatever folders your server has), so TypeScript can't list them.
 */
export type RoomChoice = string;

/** A room the app ships with. Its id is never a valid custom-scene folder name. */
export interface BuiltinRoom {
  id: RoomChoice;
  name: string;
}
/**
 * WHY the id stays 'glass' although the menu says "Pool room": it is what
 * older versions saved in localStorage, so existing headsets keep working.
 */
export const BUILTIN_ROOMS: readonly BuiltinRoom[] = [{ id: 'glass', name: 'Pool room' }];
export const DEFAULT_ROOM: RoomChoice = 'glass';

export function isBuiltinRoom(id: RoomChoice): boolean {
  return BUILTIN_ROOMS.some((r) => r.id === id);
}

/**
 * Everything GlbRoom needs: a validated scene.json plus where its files are
 * served from. `baseUrl` ends in '/', e.g. "./custom-scenes/my-room/".
 */
export interface GlbRoomConfig extends SceneManifest {
  baseUrl: string;
}
