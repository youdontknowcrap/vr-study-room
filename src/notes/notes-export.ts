/**
 * Export the notebook as one multi-page US Letter PDF, downloaded by the
 * browser as notes-YYYY-MM-DD_HH-MM-SS.pdf.
 *
 * Each page is drawn again FROM THE STROKE DATA (not copied from the live
 * board texture) at EXPORT_DPI on a white background, so the PDF is sharper
 * than the board in the headset and doesn't depend on which pages happen to
 * be cached.
 *
 * Quest notes:
 *  - One page at a time on ONE reused canvas: a 150 dpi letter page is
 *    1275 x 1650 px (8 MB of pixels); holding all pages at once could run a
 *    Quest 2 out of memory on a long notebook.
 *  - canvas.toBlob and pdf-lib are promise/callback based, not
 *    requestAnimationFrame based, so they keep working during an immersive
 *    session (where Quest pauses window.requestAnimationFrame).
 */
import { letterPlacement, type Notebook } from './notes-model.js';
import { buildNotesPdf, type PdfPageImage } from './notes-pdf.js';
import { drawPage } from './notes-raster.js';

/** 150 dpi: crisp printed text, and quick enough to encode on a Quest 2. */
export const EXPORT_DPI = 150;

let canvas: HTMLCanvasElement | null = null;

/** Render every page to PNG and build the PDF bytes. */
export async function renderNotebookPdf(nb: Notebook, title: string): Promise<{ bytes: Uint8Array; pages: number }> {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const images: PdfPageImage[] = [];
  for (const page of nb.pages) {
    const L = letterPlacement(page.orientation);
    const wPx = Math.round(L.pageW * EXPORT_DPI);
    const hPx = Math.round(L.pageH * EXPORT_DPI);
    canvas.width = wPx; // setting the size also clears the canvas
    canvas.height = hPx;
    const scale = L.inchesPerMeter * EXPORT_DPI; // meters -> pixels
    const ox = L.x * EXPORT_DPI;
    const oy = L.y * EXPORT_DPI;
    // White page, then clip to the board's rectangle so ink that is off the
    // board (e.g. after rotating a page) doesn't spill into the margins.
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, wPx, hPx);
    ctx.beginPath();
    ctx.rect(ox, oy, L.w * EXPORT_DPI, L.h * EXPORT_DPI);
    ctx.clip();
    drawPage(ctx, page.strokes, { scale, ox, oy }, wPx, hPx);
    ctx.restore();
    images.push({ png: await canvasPng(canvas), landscape: page.orientation === 'landscape' });
  }
  return { bytes: await buildNotesPdf(images, title), pages: images.length };
}

function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (!blob) return reject(new Error('canvas.toBlob failed'));
      blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    }, 'image/png');
  });
}

/** Hand the bytes to the browser as a file download. */
export function downloadBytes(bytes: Uint8Array, filename: string, type = 'application/pdf'): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start reading the blob before freeing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
