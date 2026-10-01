/**
 * GlbRoom — a room made from a 3D model (glTF / GLB file), described by a
 * custom scene's scene.json (see scene-manifest.ts and scenes/README.md).
 *
 * The model is just scenery. On top of it we add what the app needs:
 *  - a ReadingStand on the configured table (the "desk": book, menu tab),
 *  - the radio on that table, beside the stand,
 *  - one soft light (the scene's image-based light does the rest),
 *  - the seat pose, so Recenter puts YOU in the seat facing the table,
 *  - optional fixes for set-like models: a "fourth wall", a ceiling slab,
 *    decal depth offsets (manifest `fixes`).
 *
 * Performance (Quest 2): keep room models small (tens of thousands of
 * triangles at most). Shadows are off; textures should be GPU-compressed
 * KTX2 (see scripts/optimize-room-model.sh, which makes High and Lite
 * builds). Join meshes per material: every material is one draw call.
 */
import {
  Box3,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Light,
  type Material,
  type Object3D,
  type Quaternion,
} from '@iwsdk/core';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { app } from '../app.js';
import type { GlbRoomConfig, RoomQuality } from './room-config.js';
import type { Placement } from './scene-manifest.js';
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
  /** Camera near plane this scene wants (manifest fixes.near), if any. */
  readonly near?: number;
  /** Optional whiteboard/easel spot from the manifest (room space). */
  readonly whiteboard?: Placement;
  /** Which texture build is showing (menu label). */
  quality: RoomQuality = 'high';

  private constructor(cfg: GlbRoomConfig, model: Group) {
    this.name = cfg.name;
    this.seat = cfg.seat;
    this.near = cfg.fixes.near;
    this.whiteboard = cfg.whiteboard;

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
    if (cfg.fixes.decalMaterials.length) applyDecalOffset(model, cfg.fixes.decalMaterials);
    this.area.add(model);
    // WHY update matrices now: the measurements below (node / model bounding
    // boxes) read world matrices, and three.js only refreshes them at render.
    // `area` is still at the origin, so "world" here = room space.
    this.area.updateMatrixWorld(true);

    // The table: given in the manifest, or measured from a model node.
    const t = cfg.table ?? measureTable(model, cfg.stand.node);
    // Book-physics walls: given, or the model's footprint.
    this.bounds = cfg.bounds ?? measureBounds(model);
    this.tables = [t, ...cfg.extraSurfaces];

    // Reading stand on the table, turned so its near edge faces the seat.
    const at = cfg.stand.x !== undefined && cfg.stand.z !== undefined ? { x: cfg.stand.x, z: cfg.stand.z } : { x: t.x, z: t.z };
    this.desk = new ReadingStand(t.y);
    // SIT_LIFT: measured table tops are rarely exactly the number in the
    // manifest (0.3809 vs 0.38). Without the lift the stand's base plate can
    // sit 1 mm INSIDE the table top, right where props lie (z-fighting bait).
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

    const { fourthWall, ceiling } = cfg.fixes;
    if (fourthWall) this.area.add(buildFourthWall(fourthWall, ceiling?.y));
    if (ceiling) this.area.add(buildCeiling(ceiling));

    const l = cfg.light;
    const light = new DirectionalLight(l.color, l.intensity);
    light.position.set(l.position.x, l.position.y, l.position.z);
    this.area.add(light, light.target);
    console.info(`[room] loaded ${cfg.name}${cfg.credit ? ` (${cfg.credit})` : ''}`);
  }

  /**
   * Download + set up. Throws if the file is missing/broken (caller falls back).
   * Only the file for the chosen quality is fetched.
   */
  static async load(cfg: GlbRoomConfig, quality: RoomQuality): Promise<GlbRoom> {
    const gltf = await gltfLoader().loadAsync(`${cfg.baseUrl}${cfg.model[quality]}`);
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

/**
 * Table from a model node (manifest `"stand": {"node": "Desk"}`): the top
 * of its bounding box, axis-aligned. WHY offer this: reading exact numbers
 * off a model is the fiddliest part of adding a room. A node name from
 * Blender's outliner is usually enough to get started; switch to an explicit
 * `table` later if the box is off (e.g. a round table's box is a square).
 */
function measureTable(model: Object3D, node: string | undefined): FlatSurface {
  const target = node ? model.getObjectByName(node) : undefined;
  if (!target) throw new Error(`stand.node "${node}" not found in the model (check the node names in Blender/gltf.report)`);
  const box = new Box3().setFromObject(target);
  const c = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  return { x: c.x, z: c.z, y: box.max.y, halfW: size.x / 2, halfD: size.z / 2, yaw: 0 };
}

/** Physics walls from the whole model's bounding box (room space). */
function measureBounds(model: Object3D): RoomBounds {
  const box = new Box3().setFromObject(model);
  return { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, height: Math.max(1, box.max.y) };
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
 * What caused the fourth-wall flicker in the first model room (a TV-set
 * model whose manifest now lives in a local scene folder):
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
 *  4. The model's own decals: a rug floating 3.4 mm over the floor, carpet
 *     and tile lying exactly ON the floor, magazines on a table...
 *     Those get polygonOffset (manifest fixes.decalMaterials, below), and
 *     the reading stand / radio sit 2 mm above the table top instead of
 *     1 mm inside it.
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
function buildCeiling(c: NonNullable<GlbRoomConfig['fixes']['ceiling']>): Mesh {
  const ceiling = new Mesh(
    boxFromTo(c.minX, c.y, c.minZ, c.maxX, c.y + 0.08, c.maxZ),
    new MeshStandardMaterial({ color: c.color, roughness: 0.95 }),
  );
  ceiling.name = 'ceiling';
  return ceiling;
}

/**
 * The missing "fourth wall" of a TV-set model: a plain wall (manifest
 * `color` above, `trimColor` wainscot below), optionally with a 90s TV on a
 * low stand facing into the room (`tvX`). 2-4 meshes, no textures.
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
function buildFourthWall(fw: NonNullable<GlbRoomConfig['fixes']['fourthWall']>, ceilingY?: number): Group {
  const g = new Group();
  g.name = 'fourth-wall';
  const z = fw.z; // the wall's inner face; the room is on the -z side
  const top = ceilingY ?? fw.height; // where the crown tucks under
  const wall = new Mesh(
    // From 2 cm under the floor up into the ceiling slab, 10 cm thick.
    boxFromTo(fw.minX, -0.02, z, fw.maxX, Math.max(fw.height, top + OVERLAP), z + 0.1),
    new MeshStandardMaterial({ color: fw.color, roughness: 0.9 }),
  );
  const dark = new MeshStandardMaterial({ color: fw.trimColor, roughness: 0.7 });
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
  g.add(wall, trim);
  if (fw.tvX === undefined) return g;
  const x = fw.tvX;
  // TV stand: 1 cm sunk into the floor, 6 cm in front of the wall.
  const stand = new Mesh(
    boxFromTo(x - 0.5, -0.01, z - 0.5, x + 0.5, 0.45, z - 0.06),
    new MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.6 }),
  );
  // A boxy 90s CRT TV with its glass screen on the front (faces into the room, -z).
  // Body sunk 5 mm into the stand top; screen sunk 1 cm into the body front.
  const tv = new Mesh(
    merge([
      boxFromTo(x - 0.34, 0.445, z - 0.48, x + 0.34, 0.98, z - 0.1), // body
      boxFromTo(x - 0.27, 0.53, z - 0.49, x + 0.21, 0.9, z - 0.47), // screen
    ]),
    new MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.35, metalness: 0.2 }),
  );
  g.add(stand, tv);
  return g;
}
