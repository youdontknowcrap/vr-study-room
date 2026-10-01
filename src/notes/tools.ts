/**
 * The marker and the eraser, built from a handful of three.js primitives.
 *
 * Both are modelled in GRIP SPACE, the pose WebXR reports for "the inside of
 * your fist" (https://immersive-web.github.io/webxr/#dom-xrinputsource-gripspace):
 * origin in the middle of the fist, −Z running along the axis of a stick held
 * in it (out past the thumb and index finger), +Y up off the back of the fist.
 * So holding a tool is just: tool pose = grip pose. No offsets to tune, and
 * no free rotation (spec: always along the grip axis).
 *
 *   MARKER: the barrel lies ALONG the grip axis, tip at −Z, 8.5 cm in front
 *           of the fist, like a marker held in a fist.
 *   ERASER: the block lies ACROSS the grip axis (perpendicular to it); its
 *           felt face looks along −Z, where the Quest controller's top
 *           ring/face is. Push "forward" with the top of your fist to wipe.
 *
 * Draw calls: marker = 2 meshes (white body + one merged colored part whose
 * material follows the selected color), eraser = 1 mesh (vertex colors).
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from '@iwsdk/core';
import { merge } from '../room/geometry-utils.js';

/** A cylinder along Z from z0 to z1 (CylinderGeometry is along Y, so turn it). */
function tube(r0: number, r1: number, z0: number, z1: number, seg = 16): BufferGeometry {
  // CylinderGeometry(radiusTop, radiusBottom): "top" is +Y, which becomes +Z.
  const g = new CylinderGeometry(r1, r0, Math.abs(z1 - z0), seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** Paint every vertex of a geometry one color (for one-mesh, many-color models). */
export function paint(g: BufferGeometry, hex: number): BufferGeometry {
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new Float32BufferAttribute(arr, 3));
  return g;
}

export class Marker {
  readonly root = new Group();
  /** Tip point in grip/marker space: what writes on the board. */
  readonly tipLocal = new Vector3(0, 0, -0.085);
  /** Middle of the marker (for "is my hand near it?"). */
  readonly centerLocal = new Vector3(0, 0, -0.02);
  private readonly colorMat = new MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.45 });

  constructor() {
    this.root.name = 'marker';
    const body = new Mesh(
      merge([tube(0.0085, 0.0085, -0.058, 0.035, 18), tube(0.0085, 0.006, -0.066, -0.058, 18)]),
      new MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.35 }),
    );
    // Cap (back end), a label band, and the felt tip: one mesh, one color.
    const tip = new SphereGeometry(0.0022, 10, 6);
    tip.translate(0, 0, -0.0828);
    const colored = new Mesh(
      merge([
        tube(0.0094, 0.0094, 0.035, 0.052, 18), // cap
        tube(0.0087, 0.0087, -0.012, 0.004, 18), // label band
        tube(0.0045, 0.0022, -0.066, -0.0828, 10), // felt tip cone
        tip,
      ]),
      this.colorMat,
    );
    this.root.add(body, colored);
  }

  setColor(hex: string): void {
    this.colorMat.color.set(hex);
  }
}

export class Eraser {
  readonly root = new Group();
  /** Center of the felt face (what erases), in grip/eraser space. */
  readonly faceLocal = new Vector3(0, 0, -0.0835);
  readonly centerLocal = new Vector3(0, 0, -0.062);

  constructor() {
    this.root.name = 'eraser';
    // 10 cm across the grip axis (X), 4.5 cm tall (Y), 3.5 cm deep (Z, along the axis).
    const block = paint(new BoxGeometry(0.1, 0.045, 0.035), 0x2d4f7c);
    block.translate(0, 0, -0.06);
    const grip = paint(new BoxGeometry(0.07, 0.012, 0.022), 0x1f3757); // finger ridge on top
    grip.translate(0, 0.028, -0.06);
    const felt = paint(new BoxGeometry(0.098, 0.043, 0.006), 0x8d8d8d);
    felt.translate(0, 0, -0.0805);
    this.root.add(
      new Mesh(merge([block, grip, felt]), new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 })),
    );
  }
}
