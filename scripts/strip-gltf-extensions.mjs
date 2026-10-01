/**
 * Removes material extensions that would make three.js use the more expensive
 * MeshPhysicalMaterial (Quest 2 perf), and lights baked into the file.
 * Used by optimize-room-model.sh.
 *   node scripts/strip-gltf-extensions.mjs in.glb out.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/strip-gltf-extensions.mjs in.glb out.glb');
  process.exit(1);
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
for (const ext of doc.getRoot().listExtensionsUsed()) {
  if (['KHR_materials_specular', 'KHR_materials_ior', 'KHR_lights_punctual'].includes(ext.extensionName)) ext.dispose();
}
await io.write(output, doc);
console.log(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName));
