/**
 * Pick and build a room: a 3D-model room (GLB) if the choice has one and it
 * loads, otherwise the built-in glass-door room (always works offline).
 */
import { GlbRoom } from './glb-room.js';
import { ProceduralRoom } from './procedural-room.js';
import { GLB_ROOMS, type RoomChoice, type RoomQuality } from './room-config.js';
import type { StudyRoom } from './room-types.js';

export async function createRoom(choice: RoomChoice, quality: RoomQuality): Promise<StudyRoom> {
  // ?room=glass in the URL overrides the saved choice (handy for comparing).
  const forced = new URLSearchParams(location.search).get('room') as RoomChoice | null;
  const cfg = GLB_ROOMS[forced ?? choice];
  if (cfg) {
    try {
      return await GlbRoom.load(cfg, quality);
    } catch (err) {
      console.warn(`[room] ${cfg.name} failed to load; using the glass-door room`, err);
    }
  }
  return new ProceduralRoom();
}
