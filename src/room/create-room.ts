/**
 * Pick and build a room: a custom scene (3D model from the local scenes/
 * folder) if one is chosen and it loads, otherwise the built-in pool room
 * (always works, even offline).
 */
import { app } from '../app.js';
import { GlbRoom } from './glb-room.js';
import { ProceduralRoom } from './procedural-room.js';
import { isBuiltinRoom, type RoomChoice, type RoomQuality } from './room-config.js';
import type { StudyRoom } from './room-types.js';
import { loadSceneConfig, roomNotice } from './scene-loader.js';

/** The near plane from iwsdk.config.json, remembered before any scene changes it. */
let defaultNear: number | null = null;

export async function createRoom(choice: RoomChoice, quality: RoomQuality): Promise<StudyRoom> {
  // ?room=<id> in the URL overrides the saved choice (handy for comparing).
  const forced = new URLSearchParams(location.search).get('room');
  const id = forced ?? choice;
  let room: StudyRoom | null = null;
  if (!isBuiltinRoom(id)) {
    try {
      room = await GlbRoom.load(await loadSceneConfig(id), quality);
      roomNotice.value = '';
    } catch (err) {
      // WHY tell the user in the MENU too: in the headset there is no
      // console. A silent fallback looks like "my room vanished".
      const msg = `Scene "${id}" failed: ${(err as Error).message}. Showing the Pool room.`;
      console.warn(`[room] ${msg}`, err);
      roomNotice.value = msg;
    }
  } else {
    roomNotice.value = '';
  }
  room ??= new ProceduralRoom();
  applyNearPlane((room as Partial<GlbRoom>).near);
  return room;
}

/**
 * Per-scene camera near plane (manifest fixes.near), restored for rooms
 * that don't set one. three.js copies camera.near into the XR session's
 * depthNear every frame, so this works in VR too.
 */
function applyNearPlane(near: number | undefined): void {
  const cam = app.world.camera;
  defaultNear ??= cam.near;
  const want = near ?? defaultNear;
  if (cam.near !== want) {
    cam.near = want;
    cam.updateProjectionMatrix();
  }
}
