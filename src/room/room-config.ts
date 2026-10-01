/**
 * Which room to load, and how to fit a 3D-model room around the app.
 *
 * To use a downloaded room model (glTF / GLB):
 *  1. Put it in public/models/<name>/ (e.g. scene.gltf + scene.bin +
 *     textures/, or a single .glb).
 *  2. Fill in a GlbRoomConfig below: scale, offset so the model's FLOOR is
 *     at y = 0, the seat (your eyes, on the floor plan) and the table the
 *     reading stand goes on. Measure these once in the IWSDK editor or a
 *     quick console.log of the model's bounding box.
 *  3. Add it to RoomChoice / GLB_ROOMS below (and a label in the menu), and
 *     credit the model in ATTRIBUTION.md.
 * If the model fails to load, the app falls back to the built-in
 * glass-door room automatically. The menu's "Room" button switches rooms
 * (saved in localStorage); `?room=glass` in the URL forces the fallback.
 */
import type { FlatSurface, RoomBounds, SeatPose } from './room-types.js';

export interface GlbRoomConfig {
  name: string;
  /**
   * Paths under public/ (BASE_URL is added automatically), one per quality.
   * Only the selected one is downloaded.
   */
  urls: Record<RoomQuality, string>;
  /** Model units -> meters (Sketchfab models are often in cm: 0.01). */
  scale: number;
  /** Moves the model so its floor is y = 0 and the seat area is near the origin. */
  offset: { x: number; y: number; z: number };
  /** Turns the model around y (radians), applied before `offset`. */
  rotationY: number;
  /** Seated spawn: your eyes on the floor plan + facing direction. */
  seat: SeatPose;
  /** The table the reading stand (the "desk") stands on, in room space. */
  table: FlatSurface;
  /**
   * Where on that table the stand goes (room space, meters). Defaults to the
   * table's middle; big coffee tables are far away, so we push the stand to
   * the edge nearest the seat to keep the book within arm's reach.
   */
  stand?: { x: number; z: number };
  /**
   * Where the radio stands on the table (room space). Default: just right of
   * the stand. Set it when the model's own props are in the way.
   */
  radio?: { x: number; z: number };
  /** More flat spots a dropped book can land on (e.g. the sofa seat). */
  extraSurfaces?: FlatSurface[];
  /**
   * Sitcom sets have no "fourth wall" (that's where the cameras were). If set,
   * we build a plain wall there (with a TV) so you don't stare into the void.
   * Room space, meters: the wall runs along z = `z` from minX to maxX.
   */
  fourthWall?: { z: number; minX: number; maxX: number; height: number; tvX: number };
  /**
   * Sitcom sets have no CEILING either (studio lights hang there), so you see
   * the sky dome when you look up. If set, we add a flat ceiling slab: its
   * underside is at `y`, covering minX..maxX / minZ..maxZ (room space, m).
   * Put `y` a little BELOW the tops of the model's walls so they poke into
   * the slab (no gap, and no coplanar faces -> no z-fighting, see glb-room.ts).
   */
  ceiling?: { y: number; minX: number; maxX: number; minZ: number; maxZ: number };
  /**
   * Names of model materials that are "decals": flat things lying ON another
   * surface, only a few mm away or exactly coplanar (rug on the floor,
   * magazines on the table, posters on walls). They get polygonOffset so they
   * always win the depth test instead of flickering (z-fighting).
   */
  decalMaterials?: string[];
  /** Walls for the falling-book physics, in room space. */
  bounds: RoomBounds;
  /** Shown in the console; the real credit line lives in ATTRIBUTION.md. */
  credit: string;
}

/**
 * the sitcom apartment: "Sitcom Apartment" by its original Sketchfab author,
 * CC BY 4.0 (see ATTRIBUTION.md).
 *
 * Two builds, made by scripts/optimize-room-model.sh (menu "Quality"):
 *  - High (15.9 MB): original texture resolution, KTX2 / UASTC. UASTC is a
 *    GPU-compressed format: the Quest decodes it straight into ASTC, which
 *    uses ~4x less video memory than a PNG/JPEG unpacked to RGBA, with
 *    nearly no visible loss.
 *  - Lite (3.8 MB): textures <= 512 px, colors in KTX2 / ETC1S (smaller,
 *    a bit blotchier), normal maps UASTC. Pick it if High stutters.
 * Both have meshes joined per material (69 draw calls).
 *
 * How the numbers were measured (bounding boxes / vertex heights of the
 * original nodes, in model units, read with @gltf-transform) and then
 * checked in emulator screenshots:
 *  - scale 0.5: makes the sofa seat 0.43-0.55 m high (real chairs ~0.45 m,
 *    and the seat is what your real body sits on), sofa back 0.83 m, front
 *    door 2.13 m, coffee table 0.38 m.
 *  - the floor is already at y = 0, so no offset is needed
 *  - `couch`  x -6.74..-2.69, z 3.36..5.41: backrest at the low-z side,
 *    cushion front at z 5.41, so the sofa FACES +z
 *  - `coffeetable` x -5.81..-2.72, z 6.07..7.70, top at y 0.76: in front of
 *    the sofa, with the TV Guide on it = our "desk". (The node named
 *    `table` is the round table BEHIND the sofa.)
 *  - like the TV set, the model has no wall on the side the sofa faces (the
 *    studio audience side), so `fourthWall` adds one with a TV.
 * In meters: coffee table in front of the sofa is centre (-2.13, 3.44),
 * top 0.38 m, 1.55 x 0.81 m. The round table BEHIND the sofa is the wood
 * disc at y 0.54, centre (-2.70, 0.58), diameter 1.49 m (its far edge is
 * 0.36 m behind the sofa back). Spawn is on the west rim, turned 90° from
 * the south side so you face +x: across the tabletop at the front door.
 * The stand sits on that near rim. The front coffee table stays a place a
 * dropped book can land.
 * Facing +z means yaw = PI. yaw -PI/2 faces +x (yaw 0 looks toward -z).
 */
export const APARTMENT: GlbRoomConfig = {
  name: "Apartment",
  urls: {
    high: 'models/apartment/apartment-high.glb',
    lite: 'models/apartment/apartment-lite.glb',
  },
  scale: 0.5,
  offset: { x: 0, y: 0, z: 0 },
  rotationY: 0,
  seat: { x: -3.6, z: 0.58, yaw: -Math.PI / 2 }, // west edge, facing the front door
  table: { x: -2.702, z: 0.575, y: 0.54, halfW: 0.74, halfD: 0.74, yaw: 0 }, // round table top
  stand: { x: -3.26, z: 0.58 }, // near rim, in front of the seat
  radio: { x: -2.35, z: 0.58 }, // far side of the table
  extraSurfaces: [
    { x: -2.1325, z: 3.4425, y: 0.38, halfW: 0.77, halfD: 0.41, yaw: 0 }, // coffee table in front of the sofa
    { x: -2.35, z: 2.5, y: 0.5, halfW: 0.85, halfD: 0.2, yaw: 0 }, // sofa seat cushions
  ],
  // Fourth wall + ceiling, measured from the model's vertices (meters):
  //  - the model ends at z 4.465 (floor and side walls stop there); the side
  //    walls' inner faces are at x -5.541 and 3.710, and they are 2.911 m tall.
  //  - so the wall's face goes at z 4.44: 2.5 cm INSIDE the room, so the side
  //    walls and floor poke 2.5 cm into our wall instead of ending flush with
  //    it, and it runs past both side walls (x -5.74..3.88) and up into the
  //    ceiling slab (height 2.95 > ceiling 2.89).
  //  - there is no ceiling in the model at all -> `ceiling` adds one whose
  //    underside (2.89) is 2 cm below the wall tops (2.911), so they overlap.
  fourthWall: { z: 4.44, minX: -5.74, maxX: 3.88, height: 2.95, tvX: -2.13 },
  ceiling: { y: 2.89, minX: -5.8, maxX: 4.3, minZ: -4.85, maxZ: 4.6 },
  // Measured offsets above what they lie on: rug 3.4 mm above the floor;
  // carpet + tile exactly ON the wood floor (0 mm!); magazines/coffee-table
  // book 0-2 mm over the coffee table; bike + posters 1-6 mm off walls/fridge.
  decalMaterials: [
    'material_52', // the rug under the coffee table (right in your view)
    'carpet',
    'tile',
    'redtile',
    'Lined-Paper',
    'writing',
    'coffeetablebook',
    'tvguide',
    'bike',
    'StearnsJohn',
    'slide-porsche',
    'stuporman',
    'material_60',
    'mitt',
  ],
  // The whole apartment's walls (x -11.1..7.7, z -9.5..8.93 units) in meters.
  bounds: { minX: -5.55, maxX: 3.85, minZ: -4.75, maxZ: 4.4, height: 2.5 },
  credit: 'Sitcom apartment custom scene (Sketchfab), CC BY 4.0',
};

/** Texture quality of 3D-model rooms (menu "Quality: High / Lite"). */
export type RoomQuality = 'high' | 'lite';
export const ROOM_QUALITIES: readonly RoomQuality[] = ['high', 'lite'];

/** The rooms you can pick in the menu ("Room: Apartment / Glass door"). */
export type RoomChoice = 'apartment' | 'glass';
export const ROOM_CHOICES: readonly RoomChoice[] = ['apartment', 'glass'];
/** 3D-model rooms by choice; choices not listed here are built in code. */
export const GLB_ROOMS: Partial<Record<RoomChoice, GlbRoomConfig>> = {
  apartment: APARTMENT,
};
