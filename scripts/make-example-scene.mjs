/**
 * Writes scenes/_example/room.gltf: a tiny self-made room (CC0) so the
 * scene.json format has a real, freely licensed model to point at.
 *
 *   node scripts/make-example-scene.mjs
 *
 * WHY hand-write glTF instead of exporting from Blender: it's ~60 lines, has
 * no dependencies, and shows what a glTF really is: JSON (nodes, meshes,
 * materials) + one binary buffer of vertex data (here embedded as base64).
 * Everything is ONE unit cube mesh, reused by every node with a different
 * scale/position. Nodes have names ("Desk") the manifest can refer to.
 */
import fs from 'node:fs';

// Unit cube -0.5..0.5: 6 faces x 4 vertices (own normals per face) + 36 indices.
const faces = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
const pos = [], nrm = [], idx = [];
faces.forEach(([n, u, v], f) => {
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    pos.push(...n.map((c, i) => 0.5 * (c + a * u[i] + b * v[i])));
    nrm.push(...n);
  }
  idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
});
const posBuf = Buffer.from(new Float32Array(pos).buffer);
const nrmBuf = Buffer.from(new Float32Array(nrm).buffer);
const idxBuf = Buffer.from(new Uint16Array(idx).buffer);
const bin = Buffer.concat([posBuf, nrmBuf, idxBuf]);

const mat = (name, rgb, roughness = 0.9) => ({ name, pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: roughness } });
const materials = [mat('wall', [0.82, 0.86, 0.8]), mat('floor', [0.45, 0.33, 0.24], 0.7), mat('wood', [0.55, 0.38, 0.22], 0.6), mat('fabric', [0.25, 0.35, 0.5])];
const meshes = materials.map((m, i) => ({ name: `cube-${m.name}`, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: i }] }));
const M = { wall: 0, floor: 1, wood: 2, fabric: 3 };
/** A box from (x0,y0,z0) to (x1,y1,z1) in meters, as a node. */
const box = (name, mesh, [x0, y0, z0], [x1, y1, z1]) => ({
  name, mesh, translation: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], scale: [x1 - x0, y1 - y0, z1 - z0],
});
// A 3 x 3.5 m room, open toward +z (like a stage), 2.5 m tall walls.
const nodes = [
  box('Floor', M.floor, [-1.5, -0.05, -2], [1.5, 0, 1.5]),
  box('BackWall', M.wall, [-1.6, 0, -2.1], [1.6, 2.5, -2]),
  box('LeftWall', M.wall, [-1.6, 0, -2], [-1.5, 2.5, 1.5]),
  box('RightWall', M.wall, [1.5, 0, -2], [1.6, 2.5, 1.5]),
  // The desk: an empty parent node with the top and legs as children, so
  // "stand": {"node": "Desk"} measures the whole thing (top at 0.72 m).
  { name: 'Desk', translation: [0, 0, -0.75], children: [5, 6, 7, 8, 9] },
  box('DeskTop', M.wood, [-0.6, 0.69, -0.35], [0.6, 0.72, 0.35]),
  box('LegA', M.wood, [-0.57, 0, -0.32], [-0.52, 0.69, -0.27]),
  box('LegB', M.wood, [0.52, 0, -0.32], [0.57, 0.69, -0.27]),
  box('LegC', M.wood, [-0.57, 0, 0.27], [-0.52, 0.69, 0.32]),
  box('LegD', M.wood, [0.52, 0, 0.27], [0.57, 0.69, 0.32]),
  box('Rug', M.fabric, [-1, 0, -1.4], [1, 0.004, 0.6]),
];
const gltf = {
  asset: { version: '2.0', generator: 'vr-study-room scripts/make-example-scene.mjs', copyright: 'CC0 1.0 (Joey Martin)' },
  scene: 0,
  scenes: [{ name: 'ExampleRoom', nodes: [0, 1, 2, 3, 4, 10] }],
  nodes,
  meshes,
  materials,
  buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString('base64')}` }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length + nrmBuf.length, byteLength: idxBuf.length, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
  ],
};
fs.writeFileSync('scenes/_example/room.gltf', `${JSON.stringify(gltf, null, 1)}\n`);
console.log('wrote scenes/_example/room.gltf');
