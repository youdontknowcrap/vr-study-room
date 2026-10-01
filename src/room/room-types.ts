/**
 * Room "plug-in" contract.
 *
 * The app can run in different rooms: the built-in glass-door room
 * (procedural-room.ts, always available = the FALLBACK) or a downloaded 3D
 * model (glb-room.ts, e.g. a sitcom apartment). Every room provides the
 * same few things, so the book, menu and music code never care which room
 * is loaded:
 *
 *   area      - one Group holding the whole room. Recenter moves/turns it.
 *               Its y = 0 is the real floor ("local-floor" in WebXR).
 *   seat      - where your EYES should be, in room space (x, z on the floor
 *               plan + the direction you face). Recenter lines this up
 *               with your real head.
 *   desk      - the READING SURFACE: where the book rests, plus anchors for
 *               the menu tab and the radio. In the glass-door room it's a
 *               drafting desk; in a model room it's a slanted reading stand
 *               standing on a table. Desk height/tilt settings move ONLY it.
 *   bounds    - walls (box in room space) that keep a falling book inside.
 *   tables    - extra flat surfaces a dropped book can land on.
 */
import {
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Quaternion,
  Vector3,
} from '@iwsdk/core';
import { boxFromTo } from './geometry-utils.js';
import { yawOf } from './head-pose.js';

/** The surface the book is read on ("the desk"). */
export interface ReadingSurface {
  /** Tilted pivot; local y = 0 is the surface, +z points toward the reader. */
  readonly top: Object3D;
  /** Where "Bring book back" puts the book (child of `top`). */
  readonly bookHome: Object3D;
  /** Where the small "☰ Menu" tab button sits. */
  readonly menuTabAnchor: Object3D;
  /** Where the radio (music speaker) sits. */
  readonly radioAnchor: Object3D;
  /** Half the size of the top surface (for "did the book land on it?"). */
  readonly halfW: number;
  readonly halfD: number;
  /** Apply height (m above the floor, middle of the top) and tilt (degrees). */
  set(height: number, tiltDeg: number): void;
}

/** A horizontal rectangle (e.g. a table top) in ROOM space. */
export interface FlatSurface {
  x: number;
  z: number;
  /** Height of the surface above the floor. */
  y: number;
  halfW: number;
  halfD: number;
  /** Rotation around y (radians). */
  yaw: number;
}

export interface RoomBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

/** Seated spawn: eye position on the floor plan + facing direction. */
export interface SeatPose {
  x: number;
  z: number;
  /** Radians around y; 0 = facing -z (three.js "forward"). */
  yaw: number;
}

export interface StudyRoom {
  readonly name: string;
  readonly area: Group;
  readonly desk: ReadingSurface;
  readonly radio: Group;
  readonly bounds: RoomBounds;
  readonly seat: SeatPose;
  readonly tables: FlatSurface[];
  setDesk(height: number, tiltDeg: number): void;
  recenter(headPos: Vector3, headQuat: Quaternion): void;
}

/** Shared recenter math for every room. */
export function recenterArea(area: Group, seat: SeatPose, headPos: Vector3, headQuat: Quaternion): void {
  // Turn the room so the seat's facing direction = where your head looks...
  const yaw = yawOf(headQuat, new Vector3()) - seat.yaw;
  area.rotation.set(0, yaw, 0);
  // ...then slide it so the seat lands under your head. Height stays 0:
  // the room's floor IS the real floor.
  const seatWorld = new Vector3(seat.x, 0, seat.z).applyAxisAngle(new Vector3(0, 1, 0), yaw);
  area.position.set(headPos.x - seatWorld.x, 0, headPos.z - seatWorld.z);
  area.updateMatrixWorld(true);
}

/**
 * The little tabletop radio: a box + a cloth-colored front panel, 2 meshes,
 * no textures. Origin = bottom center, front faces +z. Music plays FROM it.
 */
export function makeRadio(): Group {
  const radio = new Group();
  const body = new Mesh(
    boxFromTo(-0.08, 0, -0.035, 0.08, 0.1, 0.035),
    new MeshStandardMaterial({ color: 0x3b2417, roughness: 0.5 }),
  );
  const grille = new Mesh(
    boxFromTo(-0.07, 0.015, 0.035, 0.03, 0.085, 0.039),
    new MeshStandardMaterial({ color: 0xc9b48a, roughness: 1 }),
  );
  radio.add(body, grille);
  return radio;
}
