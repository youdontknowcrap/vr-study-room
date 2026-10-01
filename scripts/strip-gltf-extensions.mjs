/**
 * Removes material extensions that would make three.js use the more expensive
 * MeshPhysicalMaterial (Quest 2 perf). Used by optimize-room-model.sh.
 * Reads ./room.glb, writes ./room-std.glb.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('room.glb');
for (const ext of doc.getRoot().listExtensionsUsed()) {
  if (['KHR_materials_specular', 'KHR_materials_ior', 'KHR_lights_punctual'].includes(ext.extensionName)) ext.dispose();
}
await io.write('room-std.glb', doc);
console.log(doc.getRoot().listExtensionsUsed().map(e=>e.extensionName));
