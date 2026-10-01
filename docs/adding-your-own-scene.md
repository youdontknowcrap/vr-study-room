# Adding your own scene

A custom scene is a folder in `scenes/` (gitignored) with a 3D model and a
`scene.json`. This guide goes from "I have a model" to "I'm reading in it on
the Quest". Field reference: [scenes/README.md](../scenes/README.md).

**Rapid-iteration loop:** keep `npm run dev` running, edit `scene.json`,
reload the page (desktop or headset). The scene list is re-scanned on every
reload and nothing is cached, so there are no restarts and no rebuilds.

## 1. Get a glTF model

glTF (`.gltf` + `.bin` + textures, or a single binary `.glb`) is "the JPEG
of 3D": three.js loads it directly. Two common sources:

**Sketchfab.** On a downloadable model choose *Download 3D model →
glTF*. Check the license on the model page first: CC0 and CC BY are fine
for personal use. CC BY means you must credit the author (`credit`
field). "Editorial" or no license: don't redistribute it. Many Sketchfab
models are in centimeters (you'll need `"scale": 0.01`).

**Blender.** *File → Export → glTF 2.0*. Choose *glTF Binary (.glb)*,
tick *Apply Modifiers*, and under *Include* tick *Visible Objects*.
Before exporting:
- Put the **floor at Z = 0** in Blender (Blender's Z-up becomes glTF's Y-up
  automatically). Then `offset` stays 0.
- Use meters (Scene Properties → Units → Unit Scale 1.0). Then `scale` stays 1.
- Give the table/desk you want to read at a clear **object name** (e.g.
  `Desk`). You can then write `"stand": {"node": "Desk"}` instead of measuring.
- Apply transforms (Ctrl+A → All Transforms) so sizes are what they look like.

Look at the result in <https://gltf.report> (drag and drop the file). It
shows node names, materials, triangle count and texture sizes.

## 2. Make it Quest-friendly (gltf-transform + KTX2)

A Quest 2 is a phone GPU. What matters most:

| Budget (rough) | Why |
|---|---|
| < 100 draw calls | one per material per mesh; CPU cost per call is high on Quest |
| < 100k triangles | the room shares the frame with the book and its page textures |
| textures as **KTX2** | KTX2 stays compressed *in video memory* (ASTC on Quest), 4–8× less VRAM than PNG/JPEG, which are unpacked to raw RGBA |

The repo has a one-shot script that does all of it and makes two builds:

```bash
# needs KTX-Software's `ktx`/`toktx` on PATH, plus once:
npm i --no-save @gltf-transform/core@4 @gltf-transform/extensions@4
scripts/optimize-room-model.sh ~/Downloads/my-room/scene.gltf scenes/my-room/room
# -> scenes/my-room/room-high.glb (full-res textures, UASTC)
#    scenes/my-room/room-lite.glb (<= 512 px, ETC1S colors)
```

What it runs ([glTF-Transform](https://gltf-transform.dev) CLI), if you
want to do it by hand:

```bash
npx @gltf-transform/cli metalrough in.gltf mr.glb       # old spec-gloss -> metal-rough (three.js needs it)
npx @gltf-transform/cli optimize mr.glb joined.glb --texture-compress false --compress false --simplify false
npx @gltf-transform/cli resize joined.glb r.glb --width 2048 --height 2048
npx @gltf-transform/cli uastc r.glb room-high.glb --level 2 --rdo 4 --zstd 18
```

`optimize` joins meshes per material (fewer draw calls). Skip Draco/Meshopt
geometry compression: the app's loader isn't set up for them, and textures
are what's big anyway.

## 3. Write scene.json

Start from the example:

```bash
mkdir -p scenes/my-room   # if the script didn't already
cp scenes/_example/scene.json scenes/my-room/
```

Edit `name` and `model`, then:

**Scale and floor.** Reload, pick the room. If the furniture looks huge or
tiny, fix `scale`. If you float above or sink into the floor, set
`offset.y` (negative = move the model down).

**The seat.** Pick a chair/sofa spot on the floor plan. `seat.x`/`seat.z` is
where your *eyes* go (the middle of the seat, not its front edge). `yawDeg`
is the direction you face: 0 = −z, −90 = +x, 90 = −x, 180 = +z.
To read coordinates off the model:
- In Blender, hover over the spot and read the 3D cursor location. Blender
  X = our x, Blender **−Y = our z**, Blender Z = our y (height). Multiply
  by `scale` if it isn't 1.
- Or let the app measure: start with `"stand": {"node": "Desk"}`, load the
  room, and type `app.room.tables[0]` in the browser console. It prints the
  measured table top (`x, z, y, halfW, halfD`). Paste it into `table` and
  adjust by hand (a round table's box is a square, for example).
  `app.room.seat` and `app.room.bounds` work the same way.

**The reading stand.** It stands on `table` (or the table measured from
`stand.node`). By default it's in the table's middle. For a big table, set
`stand.x/z` to a spot on the edge nearest the seat, so the book is within
arm's reach (about 0.3–0.6 m in front of your eyes). The stand turns to
face the seat by itself. Desk height/tilt in the menu move only the stand.

**Fixes, only if you need them:** `fixes.decalMaterials` for flickering
rugs/posters, `fixes.ceiling`/`fixes.fourthWall` for set-like models with
missing walls, `fixes.near` if distant surfaces still shimmer.

**Credit.** Fill in `credit`, `license`, `source`.

## 4. Test

1. Desktop: `npm run dev`, open <https://localhost:8081/?room=my-room>.
   Check the console for `[room] loaded …` or the reason it failed (also
   shown in the menu footer). Press **R** to recenter: you should see the
   stand in front of you.
2. Headset: `npm run dev:usb` (Quest on USB, `adb reverse`) and open
   `http://localhost:8081/?room=my-room` in Quest Browser, or `npm run dev`
   and the network URL over Wi-Fi. Enter VR, sit down, click the thumbstick
   (Recenter). Check:
   - Is the stand at a comfortable height? Try the menu's Desk ▲▼. If the
     default is way off, the `table.y` is probably wrong.
   - Do you face the way you wanted? If not, change `seat.yawDeg`.
   - Does anything flicker? Name its material in `fixes.decalMaterials`.
   - Smooth? If not, use the **Lite** build (menu Quality) or reduce textures.
3. Pick it once from the menu's Room button. The app remembers it.

## Sharing a build

`npm run build` copies your scenes into `dist/`. Before putting `dist/` on a
**public** host, check each model's license allows that, or build with
`LOCAL_SCENES=off npm run build`.
