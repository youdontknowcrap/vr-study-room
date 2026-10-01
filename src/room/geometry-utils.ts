/**
 * Tiny helpers for building low-poly furniture out of boxes.
 *
 * DRAW CALLS matter a lot on Quest 2 (aim for well under ~80 per frame).
 * Every separate Mesh is (at least) one draw call. So instead of 12 little
 * meshes for a desk frame, we build 12 box GEOMETRIES, MERGE them into one
 * geometry, and draw them as ONE mesh with one material.
 */
import { BoxGeometry, type BufferGeometry } from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A box of size w x h x d whose CENTER is at (x, y, z). */
export function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** A box given by its min/max corners (handy for walls and frames). */
export function boxFromTo(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): BoxGeometry {
  return box(
    Math.abs(x1 - x0),
    Math.abs(y1 - y0),
    Math.abs(z1 - z0),
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    (z0 + z1) / 2,
  );
}

/** Merge many geometries into one (and free the originals). */
export function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('mergeGeometries failed (mismatched attributes?)');
  return merged;
}
