/**
 * 360-degree photo environments (Poly Haven, CC0 - see ATTRIBUTION.md).
 *
 * Instead of modelling a whole room (lots of triangles + textures), we wrap
 * a single panoramic photo around the viewer. three.js' GroundedSkybox
 * projects it onto a dome with a FLAT floor, so the floor in the photo
 * appears at the right height instead of "infinitely far away".
 * Cost: 1 mesh, 1 texture (2048x1024 JPG, ~300 KB download).
 */
import {
  EquirectangularReflectionMapping,
  SRGBColorSpace,
  TextureLoader,
  type Scene,
  type Texture,
} from '@iwsdk/core';
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js';

interface EnvDef {
  label: string;
  /** Poly Haven asset id (https://polyhaven.com/a/<id>) - see ATTRIBUTION.md */
  polyHavenId: string;
  /** Height (m) the photo was taken at. Makes the floor feel the right distance. */
  cameraHeight: number;
  /** Radius (m) of the dome. Bigger = room feels bigger. */
  radius: number;
  /** Extra rotation (degrees) so the nicest part of the photo is in front of you. */
  yawDeg: number;
}

/**
 * All environments ship as 2048x1024 JPGs (~250-380 KB each, ~2.4 MB total)
 * in public/environments/<id>_2k.jpg. Only the selected one is downloaded
 * and kept in GPU memory. To add one: pick an indoor HDRI on polyhaven.com,
 * download its "Tonemapped JPG", resize to 2048x1024 (see README), add a row
 * here + in ATTRIBUTION.md.
 */
export const ENVIRONMENTS = {
  fireplace: { label: 'Fireplace den', polyHavenId: 'fireplace', cameraHeight: 1.2, radius: 6, yawDeg: 0 },
  'reading-room': { label: 'Reading room', polyHavenId: 'reading_room', cameraHeight: 1.3, radius: 9, yawDeg: 0 },
  'lythwood-lounge': { label: 'Lounge', polyHavenId: 'lythwood_lounge', cameraHeight: 1.3, radius: 9, yawDeg: 0 },
  'wooden-lounge': { label: 'Wooden lounge', polyHavenId: 'wooden_lounge', cameraHeight: 1.3, radius: 9, yawDeg: 0 },
  'pine-attic': { label: 'Pine attic', polyHavenId: 'pine_attic', cameraHeight: 1.3, radius: 8, yawDeg: 0 },
  glasshouse: { label: 'Glasshouse cabin', polyHavenId: 'glasshouse_interior', cameraHeight: 1.3, radius: 8, yawDeg: 0 },
  'victorian-room': { label: 'Victorian room', polyHavenId: 'combination_room', cameraHeight: 1.3, radius: 7, yawDeg: 0 },
  'old-room': { label: 'Old room', polyHavenId: 'old_room', cameraHeight: 1.4, radius: 8, yawDeg: 0 },
} satisfies Record<string, EnvDef>;

export type EnvironmentId = keyof typeof ENVIRONMENTS;
export const ENVIRONMENT_IDS = Object.keys(ENVIRONMENTS) as EnvironmentId[];

/** Rotation that puts the CENTER of the photo straight ahead (-z). */
const BASE_YAW = Math.PI / 2;

export class EnvironmentManager {
  private skybox: GroundedSkybox | null = null;
  private loader = new TextureLoader();
  private loadToken = 0;

  constructor(private scene: Scene) {}

  async show(id: EnvironmentId): Promise<void> {
    const def: EnvDef = ENVIRONMENTS[id];
    const token = ++this.loadToken;
    let tex: Texture | null = null;
    try {
      tex = await this.loader.loadAsync(
        `${import.meta.env.BASE_URL}environments/${def.polyHavenId}_2k.jpg`,
      );
    } catch (e) {
      // Keep previous environment on failure (offline / bad asset path).
      return;
    }
    if (token !== this.loadToken) {
      tex.dispose(); // a newer request won the race
      return;
    }
    tex.mapping = EquirectangularReflectionMapping;
    tex.colorSpace = SRGBColorSpace;

    const old = this.skybox;
    // 48 segments instead of the default 128: plenty for a smooth dome.
    const sky = new GroundedSkybox(tex, def.cameraHeight, def.radius, 48);
    // Photos are already "finished" images: skip tone mapping so colors
    // match the JPG, and put the floor of the dome at y = 0.
    sky.material.toneMapped = false;
    sky.position.y = def.cameraHeight - 0.01;
    sky.rotation.y = (def.yawDeg * Math.PI) / 180 + BASE_YAW;
    sky.renderOrder = -1;
    this.scene.add(sky);
    this.skybox = sky;

    if (old) {
      this.scene.remove(old);
      old.geometry.dispose();
      old.material.map?.dispose();
      old.material.dispose();
    }
  }
}
