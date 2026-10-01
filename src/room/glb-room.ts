/**
 * GlbRoom — a room made from a downloaded 3D model (glTF / GLB file).
 *
 * The model is just scenery. On top of it we add what the app needs:
 *  - a ReadingStand on the configured table (the "desk": book, menu tab),
 *  - the radio on that table, beside the stand,
 *  - one soft light (the scene's image-based light does the rest),
 *  - the seat pose, so Recenter puts YOU on the sofa facing the table.
 *
 * Performance (Quest 2): keep room models small (the planned one is ~6.5k
 * triangles). Shadows are off; textures are GPU-compressed KTX2 (see
 * scripts/optimize-room-model.sh; High and Lite builds). Meshes are joined per material, so the
 * apartment costs ~69 draw calls; three.js skips the ones out of view.
 */
import {
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Light,
  type Material,
  type Object3D,
  type Quaternion,
  type Vector3,
} from '@iwsdk/core';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { app } from '../app.js';
import type { GlbRoomConfig, RoomQuality } from './room-config.js';
import { boxFromTo, merge } from './geometry-utils.js';
import { ReadingStand } from './reading-stand.js';
import {
  makeRadio,
  recenterArea,
  type FlatSurface,
  type RoomBounds,
  type SeatPose,
  type StudyRoom,
} from './room-types.js';

/**
 * One GLTFLoader for all model rooms, with a KTX2Loader attached.
 * KTX2 textures are "Basis Universal" data: a small WebAssembly transcoder
 * (public/basis/, copied from three.js so it works offline) turns them into
 * whatever compressed format THIS GPU supports (ASTC/ETC2 on Quest,
 * BC/S3TC on a PC). detectSupport() asks the renderer which ones that is.
 */
let loader: GLTFLoader | null = null;
function gltfLoader(): GLTFLoader {
  if (!loader) {
    const ktx2 = new KTX2Loader()
      .setTranscoderPath(`${import.meta.env.BASE_URL}basis/`)
      .detectSupport(app.world.renderer);
    loader = new GLTFLoader().setKTX2Loader(ktx2);
  }
  return loader;
}

export class GlbRoom implements StudyRoom {
  readonly area = new Group();
  readonly radio = makeRadio();
  readonly desk: ReadingStand;
  readonly name: string;
  readonly seat: SeatPose;
  readonly bounds: RoomBounds;
  readonly tables: FlatSurface[];
  /** Which texture build is showing (menu label). */
  quality: RoomQuality = 'high';

  private constructor(cfg: GlbRoomConfig, model: Group) {
    this.name = cfg.name;
    this.seat = cfg.seat;
    this.bounds = cfg.bounds;
    this.tables = [cfg.table, ...(cfg.extraSurfaces ?? [])];

    // Fit the model: scale to meters, turn, then move its floor to y = 0.
    model.scale.setScalar(cfg.scale);
    model.rotation.y = cfg.rotationY;
    model.position.set(cfg.offset.x, cfg.offset.y, cfg.offset.z);
    const lights: Object3D[] = [];
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
      // Lights baked into the model file would add per-pixel cost; we light the room ourselves.
      if ((o as Light).isLight) lights.push(o);
    });
    for (const l of lights) l.removeFromParent();
    if (cfg.decalMaterials) applyDecalOffset(model, cfg.decalMaterials);
    this.area.add(model);

    // Reading stand on the table, turned so its near edge faces the seat.
    const t = cfg.table;
    const at = cfg.stand ?? { x: t.x, z: t.z };
    this.desk = new ReadingStand(t.y);
    // SIT_LIFT: the measured table top is 0.3809 m, config says 0.38. Without
    // the lift the stand's base plate would sit 1 mm INSIDE the table top,
    // right where the model's coffee-table book lies (z-fighting bait).
    this.desk.group.position.set(at.x, t.y + SIT_LIFT, at.z);
    // atan2(dx, dz) = the yaw that turns local +z (the stand's near edge) toward the seat.
    this.desk.group.rotation.y = Math.atan2(cfg.seat.x - at.x, cfg.seat.z - at.z);
    if (cfg.radio) {
      // On the table itself, turned to face the seat (so it "plays at you").
      this.radio.position.set(cfg.radio.x, t.y + SIT_LIFT, cfg.radio.z);
      this.radio.rotation.y = Math.atan2(cfg.seat.x - cfg.radio.x, cfg.seat.z - cfg.radio.z);
      this.area.add(this.radio);
    } else {
      this.desk.radioAnchor.add(this.radio);
    }
    this.area.add(this.desk.group);

    if (cfg.fourthWall) this.area.add(buildFourthWall(cfg.fourthWall, cfg.ceiling?.y));
    if (cfg.ceiling) this.area.add(buildCeiling(cfg.ceiling));

    const light = new DirectionalLight(0xfff4e6, 1.0);
    light.position.set(1, 3, 1);
    this.area.add(light, light.target);
    console.info(`[room] loaded ${cfg.name} (${cfg.credit})`);
  }

  /**
   * Download + set up. Throws if the file is missing/broken (caller falls back).
   * Only the file for the chosen quality is fetched.
   */
  static async load(cfg: GlbRoomConfig, quality: RoomQuality): Promise<GlbRoom> {
    const gltf = await gltfLoader().loadAsync(`${import.meta.env.BASE_URL}${cfg.urls[quality]}`);
    const room = new GlbRoom(cfg, gltf.scene);
    room.quality = quality;
    return room;
  }

  setDesk(height: number, tiltDeg: number): void {
    this.desk.set(height, tiltDeg);
  }

  recenter(headPos: Vector3, headQuat: Quaternion): void {
    recenterArea(this.area, this.seat, headPos, headQuat);
  }
}

/*
 * ============================================================================
 *  Z-FIGHTING, and how this file avoids it  (read me, Joey!)
 * ============================================================================
 * The GPU draws a scene pixel by pixel. For every pixel it remembers how far
 * away the nearest thing drawn so far is: the DEPTH BUFFER. A new triangle
 * only paints a pixel if it is closer than what's stored ("depth test").
 *
 * The depth buffer has limited precision (a 24-bit, sometimes 16-bit, number
 * per pixel), and it is NOT spread evenly: most of it is spent right in front
 * of the camera's NEAR plane. Roughly, the smallest depth difference it can
 * tell apart at distance d is
 *
 *        step ~= d * d / (near * 2^bits)
 *
 * When two surfaces are in the same plane ("coplanar"), or closer together
 * than that step, the GPU can't decide which one is in front. The answer
 * changes from pixel to pixel and from frame to frame as your head moves
 * (in VR your head ALWAYS moves a little), so the two surfaces shimmer and
 * tear through each other in stripes. That is z-fighting.
 *
 * What caused the fourth-wall flicker here:
 *  1. near = 0.001 m (1 mm!) in iwsdk.config.json. With near that tiny, the
 *     step at 4 m is ~1 mm with 24 bits and ~24 cm (!) with 16 bits, so the
 *     wall, its 2 cm wainscot/trim strips and the model's edges all fought.
 *     Now near = 0.05 m, far = 60 m: 50x more precision everywhere.
 *  2. Our pieces shared planes: the wainscot's back face WAS the wall's
 *     front face, the chair rail sat exactly on the wainscot's top, the
 *     crown's top was exactly the wall's top, the wall's bottom exactly the
 *     floor. Now every piece is pushed 1 cm INTO its neighbour ("overlap,
 *     don't touch"): hidden parts are inside the other solid, so no two
 *     visible faces ever share a plane.
 *  3. The wall face sat 5 mm in front of where the model's floor and side
 *     walls end (z 4.465): nearly coplanar edges. Now it is 2.5 cm inside.
 *  4. The model's own decals: the rug floats 3.4 mm over the floor, carpet
 *     and tile lie exactly ON the floor, magazines on the coffee table...
 *     Those get polygonOffset (below), and the reading stand / radio sit
 *     2 mm above the table top instead of 1 mm inside it.
 *
 * Three tools, in order of preference:
 *  - Don't build coplanar faces: overlap solids by ~1 cm, or leave a few mm
 *    of air (with a sane near plane).
 *  - Sane near/far planes (near as BIG as you can live with, far as small).
 *  - polygonOffset for true decals: it nudges a material's depth toward the
 *    camera by a tiny, slope-aware amount, so it always wins the tie.
 */

/** Lift for props standing on a model's table (m): air instead of overlap. */
const SIT_LIFT = 0.002;
/** How far each solid piece is pushed into its neighbour (m). */
const OVERLAP = 0.01;

/**
 * polygonOffset on decal-like model materials (see the big comment above).
 * factor -1 = scale with the surface's slope (grazing views need more),
 * units -4 = plus 4 smallest depth steps. Negative = toward the camera.
 */
function applyDecalOffset(model: Object3D, names: string[]): void {
  const wanted = new Set(names);
  const found = new Set<Material>();
  model.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!wanted.has(m.name) || found.has(m)) continue;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -4;
      m.needsUpdate = true;
      found.add(m);
    }
  });
  const missing = names.filter((n) => ![...found].some((m) => m.name === n));
  if (missing.length) console.warn(`[room] decal materials not found: ${missing.join(', ')}`);
}

/**
 * The missing ceiling of a TV-set model: one flat slab (1 draw call). It is
 * 8 cm thick and starts just below the model's wall tops, so the walls (and
 * our fourth wall) poke into it: no sky gap, and no shared planes.
 */
function buildCeiling(c: NonNullable<GlbRoomConfig['ceiling']>): Mesh {
  const ceiling = new Mesh(
    boxFromTo(c.minX, c.y, c.minZ, c.maxX, c.y + 0.08, c.maxZ),
    new MeshStandardMaterial({ color: 0xeeeae2, roughness: 0.95 }),
  );
  ceiling.name = 'ceiling';
  return ceiling;
}

/**
 * The missing "fourth wall" of a TV-set model: a plain wall in the room's
 * colors (lavender above, dark gray wainscot below) with a 90s TV on a low
 * stand facing the sofa. 4 meshes, no textures.
 *
 * Every piece OVERLAPS its neighbours by OVERLAP (1 cm) instead of touching
 * them face to face (see "Z-FIGHTING" above). Side view, room on the left:
 *
 *        ceiling slab ==========+===+==
 *                   crown -> [] |   |   <- wall top goes INTO the ceiling slab
 *                               |   |
 *             chair rail -> []  |   |   <- rail overlaps the wainscot top 1 cm
 *               wainscot ->  [| |   |   <- wainscot back sunk 1 cm into the wall
 *        floor =================|___|== <- wall bottom 2 cm below the floor
 */
function buildFourthWall(fw: NonNullable<GlbRoomConfig['fourthWall']>, ceilingY?: number): Group {
  const g = new Group();
  g.name = 'fourth-wall';
  const z = fw.z; // the wall's inner face; the room is on the -z side
  const top = ceilingY ?? fw.height; // where the crown tucks under
  const wall = new Mesh(
    // From 2 cm under the floor up into the ceiling slab, 10 cm thick.
    boxFromTo(fw.minX, -0.02, z, fw.maxX, Math.max(fw.height, top + OVERLAP), z + 0.1),
    new MeshStandardMaterial({ color: 0xc8c6ec, roughness: 0.9 }),
  );
  const dark = new MeshStandardMaterial({ color: 0x4e525e, roughness: 0.7 });
  const x = fw.tvX;
  // Strips stick out of the wall (fronts at z-0.02 / -0.04 / -0.05: all
  // different) and their backs are sunk OVERLAP into it, so none of their
  // faces lies in the wall's front plane.
  const trim = new Mesh(
    merge([
      boxFromTo(fw.minX, -0.01, z - 0.02, fw.maxX, 0.9, z + OVERLAP), // wainscot
      boxFromTo(fw.minX, 0.9 - OVERLAP, z - 0.04, fw.maxX, 0.95, z + OVERLAP), // chair rail
      boxFromTo(fw.minX, top - 0.12, z - 0.05, fw.maxX, top + OVERLAP, z + OVERLAP), // crown
    ]),
    dark,
  );
  // TV stand: 1 cm sunk into the floor, 6 cm in front of the wall.
  const stand = new Mesh(
    boxFromTo(x - 0.5, -0.01, z - 0.5, x + 0.5, 0.45, z - 0.06),
    new MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.6 }),
  );
  // A boxy 90s CRT TV with its glass screen on the front (faces the sofa, -z).
  // Body sunk 5 mm into the stand top; screen sunk 1 cm into the body front.
  const tv = new Mesh(
    merge([
      boxFromTo(x - 0.34, 0.445, z - 0.48, x + 0.34, 0.98, z - 0.1), // body
      boxFromTo(x - 0.27, 0.53, z - 0.49, x + 0.21, 0.9, z - 0.47), // screen
    ]),
    new MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.35, metalness: 0.2 }),
  );
  g.add(wall, trim, stand, tv);
  return g;
}
