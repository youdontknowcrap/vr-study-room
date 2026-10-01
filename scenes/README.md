# scenes/: your own rooms (local, not in git)

Each folder in here is one **custom scene**: a 3D room you can read in.
The folder is **gitignored**: only this README and `_example/` are tracked.
Your rooms stay on your machine/server and never end up in the public repo.
That matters because downloaded models come with their own licenses, and a
model of a TV or film set can also involve someone else's copyright.

The built-in **Pool room** always ships with the app. It is the default,
and the fallback when a scene is missing or broken.

```
scenes/
  README.md            (tracked) this file
  _example/            (tracked) a tiny CC0 example. Folders starting with _ are ignored by the app
    scene.json
    room.gltf
  my-room/             (yours, gitignored) one folder per room; the folder name is the scene id
    scene.json         the manifest (below)
    room-high.glb      model file(s): .glb, or .gltf + .bin + textures
    room-lite.glb      optional low-texture build for the Quality button
```

**Try the example:** `cp -r scenes/_example scenes/example`, reload the
page, then open the menu and press **Room** until it shows "Example room"
(or open `https://localhost:8081/?room=example`).

For the step-by-step guide (Blender/Sketchfab export, compression, picking
the seat, testing in the headset) see
[docs/adding-your-own-scene.md](../docs/adding-your-own-scene.md).

## How the app finds scenes

`vite-plugins/local-scenes.ts` (wired up in `vite.config.ts`):

| Where | What happens |
|---|---|
| `npm run dev` / `vite` | `GET custom-scenes/index.json` scans this folder **on every request**, so a new folder shows up after a page reload, with no restart. Files are streamed from `custom-scenes/<id>/<file>`. |
| `npm run preview` | Same live middleware, in front of `dist/`. |
| `npm run build` | Valid scenes are copied to `dist/custom-scenes/` with a generated `index.json`. `LOCAL_SCENES=off npm run build` leaves them out, e.g. before uploading `dist/` to a public host. |
| Static host without scenes (GitHub Pages) | `index.json` is a 404, so the app shows the built-in rooms only. |

The URL is `custom-scenes/`, not `scenes/`, because `public/scenes/` is
already IWSDK's authored scene file.

**Safety:** file requests are checked before touching the disk. URLs are
decoded first, then `..`, `.`, empty and hidden (`.env`) segments,
backslashes and NUL are rejected, the scene id must be a plain folder name,
and the resolved path must still be inside `scenes/<id>/`. Unit-tested in
`scripts/unit-scenes.mjs`. (The dev server listens on your whole network so
the Quest can reach it, so this matters.)

**Rules for folder names:** letters, digits, `-`, `_`, `.`. Must not start
with `.` or `_` (those are skipped, handy for `_wip-kitchen`) and must not be
a built-in id (`glass`).

## When something is wrong

A broken scene never takes the app down. The scan reports it (`[scenes]
skipping "my-room": seat.x is required…` in the browser console and in the
dev server's startup line), the app shows the **Pool room**, and the menu
footer says `⚠ Scene "my-room" failed: … Showing the Pool room.` Your pick
stays saved, so once you fix scene.json and reload, the room comes back.

## scene.json reference

Units: **meters**, room space (x right, y up, z toward you, the three.js
convention). Angles: **degrees** (`yawDeg`). yaw 0 looks toward −z, −90
looks toward +x, 90 toward −x, 180 toward +z. Colors: `"#rrggbb"`.

| Field | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | Shown on the menu's Room button |
| `model` | yes | | `"room.glb"`, or `{"high": "room-high.glb", "lite": "room-lite.glb"}` (menu **Quality**; only the chosen file downloads; one alone is used for both). Paths are relative to the scene folder, no `..` |
| `scale` | | `1` | Model units → meters (many Sketchfab models are cm: `0.01`) |
| `offset` | | `{x:0,y:0,z:0}` | Moves the model so its **floor is at y = 0** |
| `rotationYDeg` | | `0` | Turns the model (applied before `offset`) |
| `seat` | yes | | `{x, z, yawDeg}`: where your **eyes** go on the floor plan, and which way you face. Recenter puts you here |
| `table` | one of these two | | `{x, z, y, halfW, halfD, yawDeg}`: the flat top the reading stand stands on (`y` = height of the top, `halfW/halfD` = half its width/depth) |
| `stand` | one of these two | table centre | `{x, z}`: where on the table the stand goes (keep it within arm's reach of the seat). `{"node": "Desk"}`: measure the table from that model node's bounding box when there is no `table`. Both can be combined |
| `radio` | | on the stand | `{x, z}`: put the music radio on the table instead |
| `whiteboard` | | | `{x, z, yawDeg}`: a spot for a whiteboard/easel (for the notes feature) |
| `extraSurfaces` | | `[]` | More `{x, z, y, halfW, halfD, yawDeg}` tops a dropped book can land on (sofa seat, coffee table) |
| `bounds` | | model's bounding box | `{minX, maxX, minZ, maxZ, height}`: walls that keep a falling book inside |
| `light` | | `#fff4e6`, 1.0, `{1,3,1}` | `{color, intensity, position}` of the one directional light we add (lights inside the model file are removed: they cost frame time on Quest) |
| `fixes.fourthWall` | | | `{z, minX, maxX, height, tvX?, color?, trimColor?}`: a plain wall along `z` for set models that have no fourth wall. `tvX` adds a CRT TV on a stand there |
| `fixes.ceiling` | | | `{y, minX, maxX, minZ, maxZ, color?}`: a ceiling slab for models with none. Put `y` 1–2 cm **below** the wall tops so they overlap (no gap, no z-fighting) |
| `fixes.decalMaterials` | | `[]` | Material names that lie flat on another surface (rugs, posters, magazines). They get polygonOffset so they stop flickering |
| `fixes.near` | | iwsdk.config.json (0.05) | Camera near plane in meters (0.01–0.3) while this scene is shown |
| `credit`, `license`, `source` | | | Who made the model, its license, a URL. Logged when the room loads. Fill them in for anything you didn't make |

Why each fix exists: see the "Z-FIGHTING" comment in `src/room/glb-room.ts`.

### Example (`_example/scene.json`)

```json
{
  "name": "Example room",
  "model": "room.gltf",
  "scale": 1,
  "seat": { "x": 0, "z": 0.05, "yawDeg": 0 },
  "stand": { "node": "Desk", "x": 0, "z": -0.55 },
  "light": { "color": "#fff1dc", "intensity": 1.2, "position": { "x": 0.5, "y": 3, "z": 1 } },
  "fixes": { "decalMaterials": ["fabric"] },
  "credit": "Example room by Joey Martin (made by scripts/make-example-scene.mjs)",
  "license": "CC0 1.0"
}
```

No `table` here: the stand's table is measured from the model node
`Desk` (top at 0.72 m), and the stand sits on its near edge (`z: -0.55`)
instead of the middle. No `bounds`: they come from the model's box.
