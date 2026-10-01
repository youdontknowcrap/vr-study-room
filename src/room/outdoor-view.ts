/**
 * The view through the sliding glass door: a backyard with a pool.
 *
 * Trick: we do NOT model a backyard. A single 360-degree photo (Poly Haven
 * "Pool", CC0 - see ATTRIBUTION.md) is wrapped around the whole room on a
 * big dome. The room's walls are opaque, so you only see the photo through
 * the glass - like a real window. three.js' GroundedSkybox gives the dome a
 * FLAT floor, so the pool water in the photo appears at a believable height
 * instead of "infinitely far below".
 *
 * Cost: 1 mesh + 1 texture (2048x1024 JPG, ~280 KB). Cheap on Quest 2.
 */
import {
  EquirectangularReflectionMapping,
  SRGBColorSpace,
  TextureLoader,
  type Object3D,
} from '@iwsdk/core';
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js';

const PHOTO_URL = `${import.meta.env.BASE_URL}textures/pool_2k.jpg`;
/** Height (m) the photo was taken at above the water. Bigger = water looks further down. */
const PHOTO_HEIGHT = 1.1;
/** Dome radius (m). Bigger = backyard feels bigger. */
const DOME_RADIUS = 22;
/** Water surface sits a bit below the room floor, like a real pool. */
const WATER_LEVEL = -0.35;
/** Turn the photo so the nicest part (big tree, palms) is behind the door. */
const YAW = Math.PI / 2 + 0.25;

export async function addOutdoorView(parent: Object3D, centerX: number, centerZ: number): Promise<void> {
  let tex;
  try {
    tex = await new TextureLoader().loadAsync(PHOTO_URL);
  } catch (err) {
    // Not fatal: the glass then just shows the plain background color.
    console.warn('[room] outdoor photo failed to load', err);
    return;
  }
  tex.mapping = EquirectangularReflectionMapping;
  tex.colorSpace = SRGBColorSpace;
  // 48 segments instead of the default 128: plenty for a smooth dome.
  const sky = new GroundedSkybox(tex, PHOTO_HEIGHT, DOME_RADIUS, 48);
  // Photos are already "finished" images: skip tone mapping so the colors
  // match the JPG.
  sky.material.toneMapped = false;
  sky.position.set(centerX, WATER_LEVEL + PHOTO_HEIGHT, centerZ);
  sky.rotation.y = YAW;
  sky.renderOrder = -1;
  parent.add(sky);
}
