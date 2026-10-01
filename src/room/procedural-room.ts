/**
 * ProceduralRoom — the built-in "glass door" room, made from boxes in code.
 * It needs no downloads except two small textures, so it is the FALLBACK
 * room whenever a 3D-model room (glb-room.ts) is disabled or fails to load.
 * (It replaces the old 360-degree photo rooms.)
 *
 *   Top view (you sit at "U", looking toward -z):
 *
 *      x=-0.85                                   x=3.72
 *        +----------[ sliding glass door ]----------+  z=-2.15 (front wall)
 *        |              ~~ pool outside ~~          |
 *        |   [desk]                                 |
 *        |     U                                    |
 *        +------------------------------------------+  z=+0.9 (back wall)
 *
 *  - About 10 x 15 ft (3.05 x 4.57 m), 8.5 ft (2.6 m) ceiling.
 *  - You are seated near the back-left corner with the desk in front.
 *  - The front wall has a big sliding glass door; behind it a patio and a
 *    backyard pool (a 360 photo, see outdoor-view.ts).
 *
 * ORIGIN: `area`'s origin is the point on the floor under your eyes, and
 * its y = 0 IS the real floor (IWSDK uses the "local-floor" reference
 * space). Recenter only moves/turns `area` sideways; it never changes its
 * height, so the desk height stays consistent.
 *
 * Performance: walls, trim, door frame, glass, floor, ceiling and patio are
 * each ONE merged mesh -> ~8 draw calls for the whole room. Materials are
 * cheap MeshStandardMaterials without shadows; one floor texture (512 px).
 */
import {
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Vector3,
} from '@iwsdk/core';
import { Desk, TOP_D } from './desk.js';
import { boxFromTo, merge } from './geometry-utils.js';
import { addOutdoorView } from './outdoor-view.js';
import {
  makeRadio,
  recenterArea,
  type FlatSurface,
  type SeatPose,
  type StudyRoom,
} from './room-types.js';

// ---- Room size (meters) ------------------------------------------------
export const ROOM = {
  minX: -0.85,
  maxX: 3.72, // 4.57 m long (15 ft)
  minZ: -2.15,
  maxZ: 0.9, // 3.05 m deep (10 ft)
  height: 2.6, // ~8.5 ft
};
const WALL_T = 0.1;
// Sliding glass door on the front wall.
const DOOR = { x0: -0.35, x1: 1.85, height: 2.05 };
/** Desk front edge distance from your eyes, horizontally. */
const DESK_DISTANCE = 0.3;

export class ProceduralRoom implements StudyRoom {
  readonly name = 'Glass door';
  /** Move this to move the whole room (walls, desk, everything). */
  readonly area = new Group();
  readonly desk = new Desk();
  /** Little tabletop radio. Music plays FROM here. */
  readonly radio = makeRadio();
  readonly bounds = ROOM;
  /** You sit at the room origin, facing -z (toward the desk and the door). */
  readonly seat: SeatPose = { x: 0, z: 0, yaw: 0 };
  /** No extra tables in this room (the desk is handled separately). */
  readonly tables: FlatSurface[] = [];

  constructor() {
    this.buildShell();
    this.buildDoor();

    // Desk: its near edge DESK_DISTANCE in front of you.
    this.desk.group.position.set(0, 0, -(DESK_DISTANCE + TOP_D / 2));
    this.area.add(this.desk.group);

    // Radio on the desk's back ledge.
    this.desk.radioAnchor.add(this.radio);

    // Soft daylight coming in through the glass door (no shadows: cheap).
    // The scene's image-based light (IBLGradient in the scene file) fills in.
    const sun = new DirectionalLight(0xfff1dc, 1.4);
    sun.position.set(0.6, 3.2, -4.5);
    sun.target.position.set(0.5, 0, 0);
    this.area.add(sun, sun.target);

    // Default placement (2D browser / before VR starts): room at the origin.
    this.area.position.set(0, 0, 0);
  }

  /** Floor, ceiling, 4 walls (front wall with a door-sized hole), baseboards. */
  private buildShell(): void {
    const { minX, maxX, minZ, maxZ, height: H } = ROOM;
    const t = WALL_T;
    const wallMat = new MeshStandardMaterial({ color: 0xe6e0d4, roughness: 0.95 });
    const walls = new Mesh(
      merge([
        boxFromTo(minX - t, 0, maxZ, maxX + t, H, maxZ + t), // back
        boxFromTo(minX - t, 0, minZ - t, minX, H, maxZ), // left
        boxFromTo(maxX, 0, minZ - t, maxX + t, H, maxZ), // right
        // front wall = 3 pieces around the door opening
        boxFromTo(minX, 0, minZ - t, DOOR.x0, H, minZ),
        boxFromTo(DOOR.x1, 0, minZ - t, maxX, H, minZ),
        boxFromTo(DOOR.x0, DOOR.height, minZ - t, DOOR.x1, H, minZ),
      ]),
      wallMat,
    );

    // White baseboards (8 cm tall) along the walls, one merged mesh.
    const bb = 0.08;
    const bt = 0.012;
    const trim = new Mesh(
      merge([
        boxFromTo(minX, 0, maxZ - bt, maxX, bb, maxZ),
        boxFromTo(minX, 0, minZ, minX + bt, bb, maxZ),
        boxFromTo(maxX - bt, 0, minZ, maxX, bb, maxZ),
        boxFromTo(minX, 0, minZ, DOOR.x0, bb, minZ + bt),
        boxFromTo(DOOR.x1, 0, minZ, maxX, bb, minZ + bt),
      ]),
      new MeshStandardMaterial({ color: 0xf6f3ec, roughness: 0.6 }),
    );

    // Floor: a CC0 laminate texture (Poly Haven), tiled. One 512 px JPG.
    const floorMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    const w = maxX - minX;
    const d = maxZ - minZ;
    new TextureLoader().load(
      `${import.meta.env.BASE_URL}textures/laminate_floor_02_512.jpg`,
      (tex) => {
        tex.colorSpace = SRGBColorSpace;
        tex.wrapS = tex.wrapT = RepeatWrapping;
        tex.repeat.set(w / 1.7, d / 1.7); // the photo covers 1.7 m of floor
        tex.anisotropy = 4; // keeps the planks crisp at grazing angles
        floorMat.map = tex;
        floorMat.needsUpdate = true;
      },
      undefined,
      () => floorMat.color.set(0x8a6a4c), // no texture? plain wood color
    );
    const floor = new Mesh(new PlaneGeometry(w, d), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);

    const ceiling = new Mesh(
      new PlaneGeometry(w, d),
      new MeshStandardMaterial({ color: 0xf3f0e8, roughness: 1 }),
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set((minX + maxX) / 2, H, (minZ + maxZ) / 2);

    this.area.add(walls, trim, floor, ceiling);
  }

  /** Sliding glass door: frame + two glass panes, a patio, and the pool photo. */
  private buildDoor(): void {
    const z = ROOM.minZ; // inner face of the front wall
    const { x0, x1, height: H } = DOOR;
    const f = 0.05; // frame bar width
    const mid = (x0 + x1) / 2;
    const overlap = 0.03; // the two sliding panels overlap in the middle
    // Panel A (left) runs in the OUTER track, panel B (right) in the INNER.
    const zA = z - 0.07;
    const zB = z - 0.03;
    const panels = [
      { a: x0 + f, b: mid + overlap, z: zA },
      { a: mid - overlap, b: x1 - f, z: zB },
    ];

    const frameParts = [
      // Outer frame: jambs, head, sill (deeper than the wall).
      boxFromTo(x0, 0, z - 0.11, x0 + f, H, z + 0.01),
      boxFromTo(x1 - f, 0, z - 0.11, x1, H, z + 0.01),
      boxFromTo(x0, H - f, z - 0.11, x1, H, z + 0.01),
      boxFromTo(x0, 0, z - 0.11, x1, 0.02, z + 0.01),
    ];
    const glassParts = [];
    for (const p of panels) {
      // Each panel: two stiles + two rails around a glass sheet.
      frameParts.push(
        boxFromTo(p.a, 0.02, p.z - 0.02, p.a + f, H - f, p.z + 0.02),
        boxFromTo(p.b - f, 0.02, p.z - 0.02, p.b, H - f, p.z + 0.02),
        boxFromTo(p.a, 0.02, p.z - 0.02, p.b, 0.02 + 0.08, p.z + 0.02),
        boxFromTo(p.a, H - f - 0.05, p.z - 0.02, p.b, H - f, p.z + 0.02),
      );
      glassParts.push(boxFromTo(p.a + f, 0.1, p.z - 0.004, p.b - f, H - f - 0.05, p.z + 0.004));
    }
    // A small handle on the inner panel.
    frameParts.push(boxFromTo(mid + 0.02, 0.95, zB + 0.02, mid + 0.04, 1.15, zB + 0.045));

    const frame = new Mesh(
      merge(frameParts),
      new MeshStandardMaterial({ color: 0x3d3f42, roughness: 0.45, metalness: 0.3 }),
    );
    // Glass: almost fully transparent with a faint blue-green tint.
    // depthWrite=false so the photo behind is never hidden by the glass.
    const glass = new Mesh(
      merge(glassParts),
      new MeshStandardMaterial({
        color: 0xcfe6ea,
        roughness: 0.05,
        metalness: 0,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }),
    );
    glass.renderOrder = 1; // draw after opaque things

    // Patio slab + pool edge just outside, so the ground near the door is
    // solid 3D (the photo's pool starts beyond it).
    const patio = new Mesh(
      boxFromTo(ROOM.minX - 2, -0.06, z - 1.8, ROOM.maxX + 2, -0.005, z - WALL_T),
      new MeshStandardMaterial({ color: 0xa59c8c, roughness: 0.95 }),
    );
    const coping = new Mesh(
      boxFromTo(ROOM.minX - 2, -0.06, z - 2.1, ROOM.maxX + 2, 0.0, z - 1.8),
      new MeshStandardMaterial({ color: 0xd8d3c8, roughness: 0.8 }),
    );

    this.area.add(frame, glass, patio, coping);
    // The photo dome is centered on your seat so its perspective looks right.
    void addOutdoorView(this.area, 0, 0);
  }

  /** Apply desk height (m) / tilt (deg) settings. */
  setDesk(height: number, tiltDeg: number): void {
    this.desk.set(height, tiltDeg);
  }

  /**
   * Recenter: turn + slide the room so you sit at its seat, facing the desk.
   * The room stays on the floor (y = 0). Get the head pose with
   * getHeadPose() from head-pose.ts, NOT from world.camera (see that file).
   */
  recenter(headPos: Vector3, headQuat: Quaternion): void {
    recenterArea(this.area, this.seat, headPos, headQuat);
  }
}
