/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';

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
  plugins: [plainHttp ? iwsdkDev({ https: false }) : iwsdkDev()],
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
