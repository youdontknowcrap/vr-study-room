/**
 * scene.json — the manifest format for CUSTOM SCENES (your own 3D rooms).
 *
 * WHY a manifest instead of TypeScript: a room used to be a hard-coded
 * object in room-config.ts, so adding one meant editing code, rebuilding and
 * committing the (often copyrighted) model into the repo. Now a room is a
 * folder on YOUR server (scenes/<id>/) with a scene.json next to the model.
 * The code stays generic and public; the rooms stay private.
 *
 * WHY this file has NO imports: it runs in three places — the browser (to
 * read a scene), the Vite plugin in Node (to list scenes and catch broken
 * ones early), and the unit test (plain `node --experimental-strip-types`).
 * Pure functions with zero dependencies work everywhere.
 *
 * JSON conventions (chosen for humans editing by hand):
 *  - meters, room space: x right, y up, z toward you (three.js).
 *  - angles in DEGREES (`yawDeg`), because "-90" is easier to reason about
 *    than "-1.5707963". yaw 0 looks toward -z; -90 looks toward +x.
 *  - everything optional has a sensible default (see validateManifest).
 * See scenes/README.md for the full field reference with an example.
 */

/** Built-in room ids. A custom scene folder can't reuse them. */
export const BUILTIN_ROOM_IDS = ['glass'] as const;

/**
 * Folder names that count as scene ids. Letters, digits, `-`, `_`, `.`,
 * not starting with `.` or `_` (those are hidden/disabled, e.g. `_example`).
 * WHY so strict: the id ends up in URLs and localStorage; a boring
 * alphabet means no escaping bugs and no `..` path tricks.
 */
export const SCENE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSceneId(id: string): boolean {
  return SCENE_ID_RE.test(id) && !id.includes('..') && !(BUILTIN_ROOM_IDS as readonly string[]).includes(id);
}

/**
 * A file name inside a scene folder, as written in scene.json
 * ("room.glb", "lite/room.glb"). Relative, forward slashes, no `..`, no
 * leading `/`, no `\`, no `:` (Windows drive letters / URL schemes).
 * WHY check this in the manifest too (the server checks again): defence in
 * depth. A manifest must never be able to point the loader at another
 * scene's or the app's files, even by accident.
 */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes(':') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---- The resolved shape (what the app uses after validation) -------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface SeatSpec {
  x: number;
  z: number;
  /** Radians (converted from `yawDeg`). */
  yaw: number;
}
export interface SurfaceSpec {
  x: number;
  z: number;
  y: number;
  halfW: number;
  halfD: number;
  yaw: number;
}
export interface Placement {
  x: number;
  z: number;
  yaw: number;
}
export interface SceneManifest {
  name: string;
  /** File per quality. With a single `model`, high and lite are the same file. */
  model: { high: string; lite: string };
  scale: number;
  offset: Vec3;
  /** Radians. */
  rotationY: number;
  seat: SeatSpec;
  /**
   * The table the reading stand stands on. If omitted, the app measures it
   * from `stand.node` (the node's bounding-box top) at load time.
   */
  table?: SurfaceSpec;
  /** Where the stand goes: a spot on the table, or a model node to measure. */
  stand: { x?: number; z?: number; node?: string };
  radio?: { x: number; z: number };
  /** Optional spot for a whiteboard / easel (used by the notes feature). */
  whiteboard?: Placement;
  extraSurfaces: SurfaceSpec[];
  /** Book-physics walls. If omitted, measured from the model's bounding box. */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number; height: number };
  light: { color: number; intensity: number; position: Vec3 };
  fixes: {
    fourthWall?: {
      z: number;
      minX: number;
      maxX: number;
      height: number;
      /** Where a TV goes along the wall. No `tvX` = plain wall. */
      tvX?: number;
      color: number;
      trimColor: number;
    };
    ceiling?: { y: number; minX: number; maxX: number; minZ: number; maxZ: number; color: number };
    decalMaterials: string[];
    /** Camera near plane (m) while this scene is shown. See glb-room.ts "Z-FIGHTING". */
    near?: number;
  };
  credit: string;
  license: string;
  source?: string;
}

/** Same light as the room code always used: warm, from above-right. */
export const DEFAULT_LIGHT = { color: 0xfff4e6, intensity: 1.0, position: { x: 1, y: 3, z: 1 } };
export const DEFAULT_WALL_COLOR = 0xe6e0d4;
export const DEFAULT_TRIM_COLOR = 0x4e525e;
export const DEFAULT_CEILING_COLOR = 0xeeeae2;

export type ValidationResult =
  | { ok: true; manifest: SceneManifest; warnings: string[] }
  | { ok: false; errors: string[] };

const DEG = Math.PI / 180;

/**
 * Check a parsed scene.json and fill in defaults.
 *
 * WHY collect ALL errors instead of throwing at the first: rapid iteration.
 * When you hand-edit a manifest you want the whole list ("seat.x missing,
 * scale must be > 0") in one reload, not one error per reload.
 */
export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['scene.json must be a JSON object'] };
  const r = new Reader(raw, errors);

  const name = r.str('name', { required: true }) ?? '';

  // model: "room.glb"  OR  { "high": "room-high.glb", "lite": "room-lite.glb" }
  let model = { high: '', lite: '' };
  const m = raw.model;
  if (typeof m === 'string') {
    model = { high: m, lite: m };
  } else if (isObj(m)) {
    const high = typeof m.high === 'string' ? m.high : undefined;
    const lite = typeof m.lite === 'string' ? m.lite : undefined;
    if (!high && !lite) errors.push('model needs "high" and/or "lite"');
    // Only one variant? Use it for both, so the Quality button still works.
    model = { high: high ?? lite ?? '', lite: lite ?? high ?? '' };
  } else {
    errors.push('model is required: a file name, or {"high": ..., "lite": ...}');
  }
  for (const f of new Set([model.high, model.lite])) {
    if (typeof m === 'string' && !f) errors.push('model must name a file, e.g. "room.glb"');
    else if (f && !isSafeRelativePath(f)) errors.push(`model file "${f}" must be a plain relative path inside the scene folder`);
  }

  const scale = r.num('scale', { def: 1 }) ?? 1;
  if (!(scale > 0)) errors.push('scale must be > 0');
  const offset = r.vec3('offset') ?? { x: 0, y: 0, z: 0 };
  const rotationY = (r.num('rotationYDeg', { def: 0 }) ?? 0) * DEG;

  const seatRaw = r.obj('seat', true);
  const seat: SeatSpec = { x: 0, z: 0, yaw: 0 };
  if (seatRaw) {
    const s = r.sub(seatRaw, 'seat');
    seat.x = s.num('x', { required: true }) ?? 0;
    seat.z = s.num('z', { required: true }) ?? 0;
    seat.yaw = (s.num('yawDeg', { def: 0 }) ?? 0) * DEG;
  }

  const table = raw.table === undefined ? undefined : r.surface(raw.table, 'table');

  const standRaw = r.obj('stand', false);
  const stand: SceneManifest['stand'] = {};
  if (standRaw) {
    const s = r.sub(standRaw, 'stand');
    stand.x = s.num('x');
    stand.z = s.num('z');
    stand.node = s.str('node');
    if ((stand.x === undefined) !== (stand.z === undefined)) errors.push('stand needs both x and z (or neither)');
  }
  if (!table && !stand.node) errors.push('give a "table" surface, or "stand": {"node": "<model node name>"} to measure one');

  const radioRaw = r.obj('radio', false);
  const radio = radioRaw ? xz(r.sub(radioRaw, 'radio')) : undefined;
  const wbRaw = r.obj('whiteboard', false);
  let whiteboard: Placement | undefined;
  if (wbRaw) {
    const w = r.sub(wbRaw, 'whiteboard');
    const p = xz(w);
    whiteboard = { ...p, yaw: (w.num('yawDeg', { def: 0 }) ?? 0) * DEG };
  }

  const extraSurfaces: SurfaceSpec[] = [];
  if (raw.extraSurfaces !== undefined) {
    if (!Array.isArray(raw.extraSurfaces)) errors.push('extraSurfaces must be a list');
    else raw.extraSurfaces.forEach((s, i) => {
      const v = r.surface(s, `extraSurfaces[${i}]`);
      if (v) extraSurfaces.push(v);
    });
  }

  let bounds: SceneManifest['bounds'];
  const bRaw = r.obj('bounds', false);
  if (bRaw) {
    const b = r.sub(bRaw, 'bounds');
    bounds = {
      minX: b.num('minX', { required: true }) ?? 0,
      maxX: b.num('maxX', { required: true }) ?? 0,
      minZ: b.num('minZ', { required: true }) ?? 0,
      maxZ: b.num('maxZ', { required: true }) ?? 0,
      height: b.num('height', { def: 2.5 }) ?? 2.5,
    };
    if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) errors.push('bounds: min must be < max');
  }

  const light = { ...DEFAULT_LIGHT, position: { ...DEFAULT_LIGHT.position } };
  const lRaw = r.obj('light', false);
  if (lRaw) {
    const l = r.sub(lRaw, 'light');
    light.color = l.color('color') ?? light.color;
    light.intensity = l.num('intensity', { def: light.intensity }) ?? light.intensity;
    light.position = l.vec3('position') ?? light.position;
  }

  const fixes: SceneManifest['fixes'] = { decalMaterials: [] };
  const fRaw = r.obj('fixes', false);
  if (fRaw) {
    const f = r.sub(fRaw, 'fixes');
    const fwRaw = f.obj('fourthWall', false);
    if (fwRaw) {
      const w = f.sub(fwRaw, 'fixes.fourthWall');
      fixes.fourthWall = {
        z: w.num('z', { required: true }) ?? 0,
        minX: w.num('minX', { required: true }) ?? 0,
        maxX: w.num('maxX', { required: true }) ?? 0,
        height: w.num('height', { def: 2.6 }) ?? 2.6,
        tvX: w.num('tvX'),
        color: w.color('color') ?? DEFAULT_WALL_COLOR,
        trimColor: w.color('trimColor') ?? DEFAULT_TRIM_COLOR,
      };
    }
    const cRaw = f.obj('ceiling', false);
    if (cRaw) {
      const c = f.sub(cRaw, 'fixes.ceiling');
      fixes.ceiling = {
        y: c.num('y', { required: true }) ?? 0,
        minX: c.num('minX', { required: true }) ?? 0,
        maxX: c.num('maxX', { required: true }) ?? 0,
        minZ: c.num('minZ', { required: true }) ?? 0,
        maxZ: c.num('maxZ', { required: true }) ?? 0,
        color: c.color('color') ?? DEFAULT_CEILING_COLOR,
      };
    }
    const dm = fRaw.decalMaterials;
    if (dm !== undefined) {
      if (Array.isArray(dm) && dm.every((s) => typeof s === 'string')) fixes.decalMaterials = dm as string[];
      else errors.push('fixes.decalMaterials must be a list of material names');
    }
    const near = f.num('near');
    if (near !== undefined) {
      // WHY a range: near too small wrecks depth precision (z-fighting);
      // too big and the book in your hand gets clipped away.
      if (near < 0.01 || near > 0.3) errors.push('fixes.near must be between 0.01 and 0.3 m');
      else fixes.near = near;
    }
  }

  const credit = r.str('credit') ?? '';
  const license = r.str('license') ?? '';
  const source = r.str('source');
  // Not an error: your own scan of your own room needs no credit. But a
  // downloaded model almost always does, so nudge.
  if (!credit) warnings.push('no "credit": add the author/source if you did not make this model yourself');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    manifest: {
      name, model, scale, offset, rotationY, seat, table, stand, radio, whiteboard,
      extraSurfaces, bounds, light, fixes, credit, license, source,
    },
  };
}

// ---- tiny typed reader (keeps validateManifest readable) ------------------

type Obj = Record<string, unknown>;
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function xz(r: Reader): { x: number; z: number } {
  return { x: r.num('x', { required: true }) ?? 0, z: r.num('z', { required: true }) ?? 0 };
}

class Reader {
  private readonly o: Obj;
  private readonly errors: string[];
  private readonly prefix: string;
  constructor(o: Obj, errors: string[], prefix = '') {
    this.o = o;
    this.errors = errors;
    this.prefix = prefix;
  }
  private key(k: string): string {
    return this.prefix ? `${this.prefix}.${k}` : k;
  }
  sub(o: Obj, prefix: string): Reader {
    return new Reader(o, this.errors, prefix);
  }
  num(k: string, opt: { required?: boolean; def?: number } = {}): number | undefined {
    const v = this.o[k];
    if (v === undefined) {
      if (opt.required) this.errors.push(`${this.key(k)} is required (a number)`);
      return opt.def;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.errors.push(`${this.key(k)} must be a number`);
      return opt.def;
    }
    return v;
  }
  str(k: string, opt: { required?: boolean } = {}): string | undefined {
    const v = this.o[k];
    if (v === undefined || v === '') {
      if (opt.required) this.errors.push(`${this.key(k)} is required (text)`);
      return undefined;
    }
    if (typeof v !== 'string') {
      this.errors.push(`${this.key(k)} must be text`);
      return undefined;
    }
    return v;
  }
  obj(k: string, required: boolean): Obj | undefined {
    const v = this.o[k];
    if (v === undefined) {
      if (required) this.errors.push(`${this.key(k)} is required`);
      return undefined;
    }
    if (!isObj(v)) {
      this.errors.push(`${this.key(k)} must be an object`);
      return undefined;
    }
    return v;
  }
  vec3(k: string): Vec3 | undefined {
    const v = this.obj(k, false);
    if (!v) return undefined;
    const s = this.sub(v, this.key(k));
    return { x: s.num('x', { def: 0 }) ?? 0, y: s.num('y', { def: 0 }) ?? 0, z: s.num('z', { def: 0 }) ?? 0 };
  }
  /** "#rrggbb" (CSS style, easy to pick in any color picker) -> 0xrrggbb. */
  color(k: string): number | undefined {
    const v = this.o[k];
    if (v === undefined) return undefined;
    if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return parseInt(v.slice(1), 16);
    this.errors.push(`${this.key(k)} must be a color like "#c8c6ec"`);
    return undefined;
  }
  surface(v: unknown, label: string): SurfaceSpec | undefined {
    if (!isObj(v)) {
      this.errors.push(`${label} must be an object {x, z, y, halfW, halfD}`);
      return undefined;
    }
    const s = this.sub(v, label);
    const out = {
      x: s.num('x', { required: true }) ?? 0,
      z: s.num('z', { required: true }) ?? 0,
      y: s.num('y', { required: true }) ?? 0,
      halfW: s.num('halfW', { required: true }) ?? 0,
      halfD: s.num('halfD', { required: true }) ?? 0,
      yaw: (s.num('yawDeg', { def: 0 }) ?? 0) * DEG,
    };
    if (out.halfW <= 0 || out.halfD <= 0) this.errors.push(`${label}: halfW and halfD must be > 0`);
    return out;
  }
}

// ---- the scene list served at custom-scenes/index.json --------------------

/** One entry of custom-scenes/index.json (built by vite-plugins/local-scenes.ts). */
export interface SceneIndexEntry {
  /** Folder name = id in the menu, the URL (`?room=<id>`) and localStorage. */
  id: string;
  name: string;
  /** Set when scene.json is missing or invalid; the app skips the scene and says why. */
  error?: string;
}
export interface SceneIndex {
  scenes: SceneIndexEntry[];
}
