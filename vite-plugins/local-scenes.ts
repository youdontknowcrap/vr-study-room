/**
 * Vite plugin: serve YOUR scenes from the local, gitignored `scenes/` folder.
 *
 *   scenes/<id>/scene.json  + model files   (one folder per room)
 *        |
 *        +-- dev  (`vite`, `npm run dev`)  -> /custom-scenes/index.json  (fresh scan per request)
 *        |                                    /custom-scenes/<id>/<file> (streamed from disk)
 *        +-- `vite preview`                 -> same middleware
 *        +-- `vite build`                   -> copied into dist/custom-scenes/ + index.json
 *
 * WHY the URL is /custom-scenes/ and not /scenes/: public/scenes/ already
 * holds the IWSDK authored scene (main.iwsdk.scene.json). Two things called
 * "scenes" at one URL would shadow each other.
 *
 * WHY scan on every index.json request in dev (instead of once at startup):
 * rapid iteration. Drop a new folder in scenes/, reload the page in the
 * headset, and it's in the Room menu. No server restart.
 *
 * SECURITY (same idea as pdfjsStaticAssets in vite.config.ts): a URL comes
 * from the network, so never trust it as a path. resolveSceneFile() decodes
 * it, rejects `..`/empty segments/backslashes, checks the scene id, resolves
 * it and then checks the result is still INSIDE scenes/<id>/. The dev server
 * listens on 0.0.0.0 (so the Quest can reach it), so anyone on your Wi-Fi
 * could otherwise ask for /custom-scenes/../../.env.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import { isValidSceneId, validateManifest, type SceneIndex } from '../src/room/scene-manifest.ts';

export const SCENES_URL = '/custom-scenes/';
const MANIFEST = 'scene.json';

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Map a request URL to a file in `root/<id>/...`, or null if it isn't one
 * (or looks like an attack). Pure apart from the existence check, so the
 * unit test can hammer it with nasty URLs.
 */
export function resolveSceneFile(root: string, url: string, checkExists = true): string | null {
  let pathname = url.split(/[?#]/)[0] ?? '';
  try {
    // Decode FIRST, then check: otherwise %2e%2e%2f ("../") slips through.
    pathname = decodeURIComponent(pathname);
  } catch {
    return null; // malformed %-escape
  }
  const at = pathname.indexOf(SCENES_URL);
  if (at < 0) return null;
  const rel = pathname.slice(at + SCENES_URL.length);
  if (rel.includes('\\') || rel.includes('\0')) return null;
  const [id, ...rest] = rel.split('/');
  if (!id || !isValidSceneId(id) || rest.length === 0) return null;
  // No `..`, no `.` and no empty segments ("a//b"), no hidden files (.env).
  if (rest.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return null;
  const sceneDir = path.resolve(root, id);
  const file = path.resolve(sceneDir, ...rest);
  // Belt and braces: whatever happened above, the result must be under scenes/<id>/.
  if (!file.startsWith(sceneDir + path.sep)) return null;
  if (checkExists && (!fs.existsSync(file) || !fs.statSync(file).isFile())) return null;
  return file;
}

/**
 * List scene folders. Broken ones are listed WITH an error so the app can
 * tell you why your room is missing (instead of it silently not showing).
 * Folders starting with `.` or `_` are skipped (`_example`, `_wip-kitchen`).
 */
export function scanScenes(root: string): SceneIndex {
  const scenes: SceneIndex['scenes'] = [];
  if (!fs.existsSync(root)) return { scenes };
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const id = ent.name;
    if (id.startsWith('.') || id.startsWith('_')) continue;
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!isValidSceneId(id)) {
      scenes.push({ id: id.replace(/[^A-Za-z0-9._-]/g, '_'), name: id, error: 'folder name must be letters, digits, - _ . (and not a built-in room id)' });
      continue;
    }
    const mf = path.join(dir, MANIFEST);
    if (!fs.existsSync(mf)) {
      scenes.push({ id, name: id, error: `missing ${MANIFEST}` });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch (err) {
      scenes.push({ id, name: id, error: `${MANIFEST} is not valid JSON: ${(err as Error).message}` });
      continue;
    }
    const v = validateManifest(raw);
    if (!v.ok) {
      scenes.push({ id, name: id, error: v.errors.join('; ') });
      continue;
    }
    // Catch the most common mistake (typo in the model file name) here,
    // where we can see the disk, instead of as a 404 in the headset.
    const missing = [...new Set([v.manifest.model.high, v.manifest.model.lite])].filter(
      (f) => !resolveSceneFile(root, `${SCENES_URL}${id}/${f}`),
    );
    if (missing.length) {
      scenes.push({ id, name: v.manifest.name, error: `model file not found: ${missing.join(', ')}` });
      continue;
    }
    scenes.push({ id, name: v.manifest.name });
  }
  scenes.sort((a, b) => a.name.localeCompare(b.name));
  return { scenes };
}

export function localScenes(opts: { dir?: string } = {}): Plugin {
  const root = path.resolve(opts.dir ?? 'scenes');

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '';
    if (!url.includes(SCENES_URL)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (url.split('?')[0]?.endsWith(`${SCENES_URL}index.json`)) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store'); // always the current folder list
      res.end(JSON.stringify(scanScenes(root)));
      return;
    }
    const file = resolveSceneFile(root, url);
    if (!file) {
      // WHY 404 here instead of next(): Vite's fallback would answer with
      // index.html (200), and GLTFLoader would then choke on HTML with a
      // confusing "Unexpected token <" instead of a clear "not found".
      res.statusCode = 404;
      res.end('scene file not found');
      return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  };

  return {
    name: 'local-scenes',
    configureServer(server) {
      server.middlewares.use(middleware);
      const { scenes } = scanScenes(root);
      server.config.logger.info(`[scenes] ${scenes.length} local scene(s) in ${path.relative(process.cwd(), root) || '.'}/: ${scenes.map((s) => s.id + (s.error ? ' (broken)' : '')).join(', ') || 'none'}`);
    },
    configurePreviewServer(server) {
      // Preview serves dist/, which already has the copied scenes; the live
      // middleware in front means edits show up without rebuilding.
      server.middlewares.use(middleware);
    },
    writeBundle(options) {
      const out = path.join(path.resolve(options.dir ?? 'dist'), SCENES_URL.slice(1, -1));
      // LOCAL_SCENES=off: build without them, e.g. before uploading dist/ to a
      // PUBLIC host. A model's license (or copyright) may not allow that.
      const index = process.env.LOCAL_SCENES === 'off' ? { scenes: [] } : scanScenes(root);
      fs.mkdirSync(out, { recursive: true });
      for (const s of index.scenes) {
        if (s.error) continue;
        fs.cpSync(path.join(root, s.id), path.join(out, s.id), {
          recursive: true,
          filter: (src) => !path.basename(src).startsWith('.'),
        });
      }
      fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
      const ok = index.scenes.filter((s) => !s.error).map((s) => s.id);
      console.info(`[scenes] bundled ${ok.length} local scene(s) into dist/custom-scenes/: ${ok.join(', ') || 'none'}`);
    },
  };
}
