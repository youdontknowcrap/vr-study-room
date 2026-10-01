#!/usr/bin/env bash
# Turn a Sketchfab glTF export into two single-file GLBs for the app:
#   <out>-high.glb : original texture resolution (capped at 2048), KTX2/UASTC
#   <out>-lite.glb : textures <= 512 px, colors KTX2/ETC1S, normals UASTC
#
#   scripts/optimize-room-model.sh path/to/scene.gltf scenes/my-room/room
#   -> scenes/my-room/room-high.glb + scenes/my-room/room-lite.glb
#
# Then in scenes/my-room/scene.json:
#   "model": { "high": "room-high.glb", "lite": "room-lite.glb" }
#
# Needs: node (npx), and KTX-Software's `toktx`/`ktx` on PATH
# (https://github.com/KhronosGroup/KTX-Software/releases), plus for step 3:
#   npm i --no-save @gltf-transform/core@4 @gltf-transform/extensions@4
#
# What the steps do (glTF-Transform, https://gltf-transform.dev):
#  1. metalrough : old "specular-glossiness" materials -> metal/rough (three.js
#                  no longer reads spec-gloss; without it the room is untextured)
#  2. optimize   : dedup, flatten + join meshes per material (fewer draw calls),
#                  weld, prune. No texture changes, no mesh simplification.
#  3. strip      : drop KHR_materials_specular/ior so three.js uses the cheaper
#                  MeshStandardMaterial instead of MeshPhysicalMaterial
#  4. KTX2       : GPU-compressed textures. They stay compressed in video
#                  memory (ASTC/ETC2 on Quest), ~4-8x less VRAM than PNG/JPEG.
#                  UASTC = high quality; ETC1S = small files, some blotchiness.
set -euo pipefail
IN="$1"; OUT="$2"; mkdir -p "$(dirname "$OUT")"; HERE="$(cd "$(dirname "$0")" && pwd)"; TMP="$(mktemp -d)"
G="npx -y @gltf-transform/cli@4"
$G metalrough "$IN" "$TMP/mr.glb"
$G optimize "$TMP/mr.glb" "$TMP/joined.glb" --texture-compress false --compress false --simplify false
node "$HERE/strip-gltf-extensions.mjs" "$TMP/joined.glb" "$TMP/std.glb"
# High
$G resize "$TMP/std.glb" "$TMP/high-r.glb" --width 2048 --height 2048   # only shrinks >2048
$G uastc "$TMP/high-r.glb" "$OUT-high.glb" --level 2 --rdo 4 --zstd 18
# Lite
$G resize "$TMP/std.glb" "$TMP/lite-r.glb" --width 512 --height 512
$G uastc "$TMP/lite-r.glb" "$TMP/lite-n.glb" --slots "{normalTexture,occlusionTexture}" --zstd 18
$G etc1s "$TMP/lite-n.glb" "$OUT-lite.glb" --slots "{baseColorTexture,emissiveTexture,metallicRoughnessTexture}" --quality 192
ls -la "$OUT"-*.glb
