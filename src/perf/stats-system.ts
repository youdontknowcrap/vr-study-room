/**
 * StatsSystem — a small on-screen readout for the Big PDF experiments
 * (menu: Big PDF ▸ "Stats: On").
 *
 * Shows: last page render time, pages cached, rough texture memory, the
 * JS heap (when the browser exposes performance.memory: Chrome / Quest
 * Browser do, others don't), and which toggles are active.
 *
 * WHY head-locked (a child of the camera): you want to read the numbers
 * while flipping pages, wherever you look. Head-locked UI is tiring for
 * real content, but for a debug readout it's the simplest thing that works.
 * WHY a canvas texture updated only twice a second: re-uploading a texture
 * every frame would itself cost performance and skew what we're measuring.
 */
import { CanvasTexture, createSystem, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import { app } from '../app.js';
import { pdfCacheSize, pdfPreview, pdfRenderQueue, pdfResolution, pdfStreaming, perfStats } from '../settings.js';
import { pdfKeepCount } from '../book/page-window.js';

const W = 512;
const H = 216;
const UPDATE_EVERY_S = 0.5;
const MB = 1024 * 1024;

/** Chrome-only, non-standard; may be missing everywhere else. */
type MemoryInfo = { usedJSHeapSize: number; jsHeapSizeLimit: number };

export class StatsSystem extends createSystem({}) {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private texture!: CanvasTexture;
  private mesh!: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private sinceUpdate = UPDATE_EVERY_S;
  /** Latest text lines, also exposed on window.app for tests. */
  lines: string[] = [];

  init(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    // 16 cm wide, half a meter away, low-left of your view.
    this.mesh = new Mesh(
      new PlaneGeometry(0.16, (0.16 * H) / W),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.mesh.position.set(-0.11, -0.06, -0.5);
    // depthTest off + late renderOrder = always drawn on top of the room.
    this.mesh.renderOrder = 999;
    this.world.camera.add(this.mesh);
    this.cleanupFuncs.push(
      perfStats.subscribe((on) => {
        this.mesh.visible = on;
        this.sinceUpdate = UPDATE_EVERY_S; // draw right away when shown
      }),
    );
  }

  update(delta: number): void {
    if (!this.mesh.visible) return;
    this.sinceUpdate += delta;
    if (this.sinceUpdate < UPDATE_EVERY_S) return;
    this.sinceUpdate = 0;
    this.draw();
  }

  private draw(): void {
    const s = app.book?.pageSource?.getStats?.();
    const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
    const keep = pdfKeepCount(pdfCacheSize.value, pdfRenderQueue.value);
    const cache = keep === 0 ? 'Old' : String(keep);
    const flag = (v: boolean) => (v ? 'on' : 'off');
    this.lines = [
      `Render: ${s ? s.lastRenderMs : '-'} ms (last page)`,
      `Cached: ${s ? s.cachedPages : '-'} pages · waiting ${s ? s.pending : '-'} · cancelled ${s ? s.cancelled : '-'}`,
      `Textures: ~${s ? (s.textureBytes / MB).toFixed(1) : '-'} MB`,
      mem ? `JS heap: ${(mem.usedJSHeapSize / MB).toFixed(0)} / ${(mem.jsHeapSizeLimit / MB).toFixed(0)} MB` : 'JS heap: n/a in this browser',
      `Stream ${flag(pdfStreaming.value)} · Res ${pdfResolution.value} · Cache ${cache}`,
      `Queue ${flag(pdfRenderQueue.value)} · Blurry 1st ${flag(pdfPreview.value)}`,
    ];
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10, 10, 10, 0.78)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#9cff9c'; // classic "debug overlay" green: obviously not app UI
    g.font = '24px monospace';
    g.textBaseline = 'top';
    this.lines.forEach((line, i) => g.fillText(line, 12, 10 + i * 34, W - 24));
    this.texture.needsUpdate = true;
  }
}
