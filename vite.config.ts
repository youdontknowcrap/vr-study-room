/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig, type Plugin } from 'vite';
import { localScenes } from './vite-plugins/local-scenes.ts';

/**
 * pdf.js looks up CMaps, standard fonts, wasm decoders and ICC profiles by
 * URL. Ship the files from node_modules both in `vite` dev and in `dist`,
 * under `pdfjs/<dir>/`, so PDFs that need them can open.
 */
/**
 * Headset debug hook. The app POSTs JSON lines to /__debug/stream.
 * They are appended to debug-stream.log and printed in this terminal.
 */
function streamDebugLog(): Plugin {
  const logFile = path.resolve('debug-stream.log');
  return {
    name: 'stream-debug-log',
    configureServer(server) {
      server.middlewares.use('/__debug/stream', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 404;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 1_000_000) chunks.push(chunk);
        });
        req.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            fs.appendFileSync(logFile, `${line}\n`);
            try {
              const row = JSON.parse(line) as { event?: string; heapMB?: number | null; detail?: unknown };
              const detail = row.detail === undefined ? '' : ` ${JSON.stringify(row.detail)}`;
              server.config.logger.info(`[stream] ${row.event ?? '?'} heap=${row.heapMB ?? '-'}MB${detail}`);
            } catch {
              server.config.logger.info(`[stream] ${line.slice(0, 240)}`);
            }
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

function pdfjsStaticAssets(): Plugin {
  const root = path.resolve('node_modules/pdfjs-dist');
  const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;
  const types: Record<string, string> = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript',
    '.ttf': 'font/ttf',
  };
  const resolveRequest = (url: string): string | null => {
    let pathname = url.split('?')[0] ?? '';
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const marker = '/pdfjs/';
    const at = pathname.indexOf(marker);
    if (at < 0) return null;
    const [dir, ...rest] = pathname.slice(at + marker.length).split('/');
    if (!dirs.includes(dir as (typeof dirs)[number]) || rest.length === 0 || rest.some((p) => p === '..' || p === '')) {
      return null;
    }
    const file = path.resolve(root, dir, ...rest);
    const allowed = path.resolve(root, dir) + path.sep;
    if (!file.startsWith(allowed) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return file;
  };
  return {
    name: 'pdfjs-static-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = resolveRequest(req.url ?? '');
        if (!file) {
          next();
          return;
        }
        res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      const out = path.resolve(options.dir ?? 'dist');
      for (const dir of dirs) {
        fs.cpSync(path.join(root, dir), path.join(out, 'pdfjs', dir), { recursive: true });
      }
    },
  };
}

/**
 * Dev server notes (see README "Testing on Quest"):
 * - By default the IWSDK plugin serves HTTPS with a cached self-signed
 *   certificate. WebXR needs a "secure context": https:// OR http://localhost.
 * - `npm run dev:usb` sets IWSDK_HTTP=1 to serve plain HTTP; combined with
 *   `adb reverse tcp:8081 tcp:8081` the Quest opens http://localhost:8081,
 *   which counts as secure, so there is no certificate warning.
 * - The IWER emulator is injected only on localhost and never in Quest
 *   Browser (it has real WebXR).
 * - `base: './'` makes every URL relative, so the same build works at
 *   https://<user>.github.io/vr-study-room/ and on Vercel's root.
 */
const plainHttp = process.env.IWSDK_HTTP === '1';

export default defineConfig({
  // Keep iwsdkDev() bare in the default case so it reads iwsdk.config.json.
  plugins: [
    plainHttp ? iwsdkDev({ https: false }) : iwsdkDev(),
    pdfjsStaticAssets(),
    streamDebugLog(),
    // Your own rooms from the gitignored scenes/ folder (see scenes/README.md).
    localScenes({ dir: 'scenes' }),
  ],
  server: { host: '0.0.0.0', port: 8081, strictPort: true, open: false },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (three@0.185 vs app super-three@0.181). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
