/**
 * Swapping rooms while the app runs (menu "Room: <name> ⇄").
 *
 * Everything that lives IN the room has to move to the new one:
 *  - the music speaker sits inside the radio (Music re-parents it),
 *  - the menu tab sits on the desk/stand,
 *  - the book rests on the desk (BookSystem puts it on the new desk and
 *    re-aligns the room to your head, like Recenter).
 * Those parts register a callback with onRoomChange(); this module does not
 * need to know about them (that keeps imports one-directional).
 * The old room's geometry, materials and textures are disposed so the GPU
 * memory is freed (important on Quest 2).
 */
import type { Material, Mesh, Texture } from '@iwsdk/core';
import { app } from '../app.js';
import { deskHeight, deskTilt, roomQuality } from '../settings.js';
import { createRoom } from './create-room.js';
import type { RoomChoice } from './room-config.js';
import type { StudyRoom } from './room-types.js';

const listeners: Array<(room: StudyRoom) => void> = [];

/** Call `fn` after every room swap (not for the very first room). */
export function onRoomChange(fn: (room: StudyRoom) => void): void {
  listeners.push(fn);
}

let switching: Promise<void> | null = null;

/** Build `choice` (at the saved quality) and swap it in. Ignores clicks while a swap is loading. */
export function switchRoom(choice: RoomChoice): Promise<void> {
  if (switching) return switching;
  switching = (async () => {
    try {
      const next = await createRoom(choice, roomQuality.value);
      const old = app.room;
      app.world.scene.add(next.area);
      next.setDesk(deskHeight.value, deskTilt.value);
      app.room = next;
      for (const fn of listeners) fn(next);
      old.area.removeFromParent();
      disposeTree(old);
      console.info(`[room] switched to ${next.name}`);
    } finally {
      switching = null;
    }
  })();
  return switching;
}

/** Free GPU resources of a room we no longer show. */
function disposeTree(room: StudyRoom): void {
  room.area.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
    for (const m of mats) {
      for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
      m.dispose();
    }
  });
}
