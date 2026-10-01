/**
 * Build the multi-page PDF from already-rendered page images.
 *
 * Split in two on purpose:
 *  - THIS file only knows pdf-lib (MIT): PNG bytes in, PDF bytes out. It runs
 *    in Node, so scripts/unit-notes.mjs can count the pages and check they
 *    are US Letter without a browser.
 *  - notes-export.ts does the browser part: draw each page onto a canvas at
 *    EXPORT_DPI, turn it into PNG bytes, call this, download the file.
 */
import { PDFDocument } from 'pdf-lib';

/** PDF units are points: 72 per inch. Letter = 8.5 x 11 in = 612 x 792 pt. */
export const LETTER_PT = { w: 612, h: 792 };

export interface PdfPageImage {
  png: Uint8Array;
  landscape: boolean;
}

export async function buildNotesPdf(pages: readonly PdfPageImage[], title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('VR Study Room');
  doc.setCreationDate(new Date());
  for (const p of pages) {
    const w = p.landscape ? LETTER_PT.h : LETTER_PT.w;
    const h = p.landscape ? LETTER_PT.w : LETTER_PT.h;
    const page = doc.addPage([w, h]);
    const img = await doc.embedPng(p.png);
    // The image already IS the full letter page (white margins included),
    // so it simply covers the page edge to edge.
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}
