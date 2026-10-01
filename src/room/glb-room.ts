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
    this.area.add(model);

    // Reading stand on the table, turned so its near edge faces the seat.
    const t = cfg.table;
    const at = cfg.stand ?? { x: t.x, z: t.z };
    this.desk = new ReadingStand(t.y);
    this.desk.group.position.set(at.x, t.y, at.z);
    // atan2(dx, dz) = the yaw that turns local +z (the stand's near edge) toward the seat.
    this.desk.group.rotation.y = Math.atan2(cfg.seat.x - at.x, cfg.seat.z - at.z);
    if (cfg.radio) {
      // On the table itself, turned to face the seat (so it "plays at you").
      this.radio.position.set(cfg.radio.x, t.y, cfg.radio.z);
      this.radio.rotation.y = Math.atan2(cfg.seat.x - cfg.radio.x, cfg.seat.z - cfg.radio.z);
      this.area.add(this.radio);
    } else {
      this.desk.radioAnchor.add(this.radio);
    }
    this.area.add(this.desk.group);

    if (cfg.fourthWall) this.area.add(buildFourthWall(cfg.fourthWall));

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

/**
 * The missing "fourth wall" of a TV-set model: a plain wall in the room's
 * colors (lavender above, dark gray wainscot below) with a 90s TV on a low
 * stand facing the sofa. 4 meshes, no textures.
 */
function buildFourthWall(fw: NonNullable<GlbRoomConfig['fourthWall']>): Group {
  const g = new Group();
  const z = fw.z; // the wall's inner face; the room is on the -z side
  const wall = new Mesh(
    boxFromTo(fw.minX, 0, z, fw.maxX, fw.height, z + 0.1),
    new MeshStandardMaterial({ color: 0xc8c6ec, roughness: 0.9 }),
  );
  const dark = new MeshStandardMaterial({ color: 0x4e525e, roughness: 0.7 });
  const x = fw.tvX;
  const trim = new Mesh(
    merge([
      boxFromTo(fw.minX, 0, z - 0.02, fw.maxX, 0.9, z), // wainscot
      boxFromTo(fw.minX, 0.9, z - 0.04, fw.maxX, 0.95, z), // chair rail
      boxFromTo(fw.minX, fw.height - 0.12, z - 0.05, fw.maxX, fw.height, z), // crown
    ]),
    dark,
  );
  const stand = new Mesh(
    boxFromTo(x - 0.5, 0, z - 0.5, x + 0.5, 0.45, z - 0.06),
    new MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.6 }),
  );
  // A boxy 90s CRT TV with its glass screen on the front (faces the sofa, -z).
  const tv = new Mesh(
    merge([
      boxFromTo(x - 0.34, 0.45, z - 0.48, x + 0.34, 0.98, z - 0.1), // body
      boxFromTo(x - 0.27, 0.53, z - 0.49, x + 0.21, 0.9, z - 0.48), // screen
    ]),
    new MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.35, metalness: 0.2 }),
  );
  g.add(wall, trim, stand, tv);
  return g;
}
