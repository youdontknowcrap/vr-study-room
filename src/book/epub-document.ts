/**
 * EPUB → a list of pages of draw operations.
 *
 * An EPUB is a zip of XHTML. We read the spine in order, turn each chapter
 * into paragraphs / headings / images, then flow those into fixed pages.
 * Drawing happens later (epub-pages.ts) so this file stays free of three.js
 * and can be unit-tested in Node.
 *
 * Scripts in the book are never executed. Fonts are ours, not the book's,
 * so obfuscated embedded fonts still leave the text readable.
 */
import { unzipSync } from 'fflate';

export const EPUB_PAGE_W = 480;
export const EPUB_PAGE_H = 680;
export const EPUB_ASPECT = EPUB_PAGE_W / EPUB_PAGE_H;

export const EPUB_FONTS = {
  h1: 'bold 34px Georgia, "Times New Roman", serif',
  h2: 'bold 28px Georgia, "Times New Roman", serif',
  p: '22px Georgia, "Times New Roman", serif',
  li: '22px Georgia, "Times New Roman", serif',
} as const;

const PAD_X = 36;
const PAD_Y = 40;
const LINE = { h1: 46, h2: 40, p: 30, li: 30 } as const;

export interface EpubOp {
  kind: 'text' | 'image';
  x: number;
  y: number;
  font?: string;
  text?: string;
  path?: string;
  w?: number;
  h?: number;
}

export interface EpubLaidPage {
  ops: EpubOp[];
}

type Block =
  | { kind: 'h1' | 'h2' | 'p' | 'li'; text: string }
  | { kind: 'img'; path: string; w: number; h: number }
  | { kind: 'break' };

export interface ParsedEpub {
  id: string;
  title: string;
  blocks: Block[];
  images: Map<string, Uint8Array>;
}

type Measure = (text: string, font: string) => number;

function normPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function decodeXml(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  return String.fromCodePoint(code);
}

function cleanText(raw: string): string {
  return decodeXml(raw).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

function tagText(xml: string, local: string): string {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}>`,
    'i',
  );
  const m = re.exec(xml);
  return m ? cleanText(m[1].replace(/<[^>]+>/g, ' ')) : '';
}

async function sha1Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', data.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function lookup(files: Map<string, Uint8Array>, lower: Map<string, string>, href: string): Uint8Array | undefined {
  let key = href.split('#')[0] ?? '';
  try {
    key = decodeURIComponent(key);
  } catch {
    /* keep the raw path */
  }
  key = normPath(key);
  if (files.has(key)) return files.get(key);
  const real = lower.get(key.toLowerCase());
  return real ? files.get(real) : undefined;
}

function imageSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) break;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const h = (bytes[i + 5] << 8) | bytes[i + 6];
        const w = (bytes[i + 7] << 8) | bytes[i + 8];
        return w > 0 && h > 0 ? { w, h } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}

const SKIP = new Set(['script', 'style', 'svg', 'math']);
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote']);

function blockKind(name: string): 'h1' | 'h2' | 'p' | 'li' {
  if (name === 'h1') return 'h1';
  if (name === 'h2' || name === 'h3' || name === 'h4' || name === 'h5' || name === 'h6') return 'h2';
  if (name === 'li') return 'li';
  return 'p';
}

function resolveHref(baseFile: string, href: string): string {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return '';
  const dir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
  let path = href.split('#')[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it */
  }
  return normPath(dir + path);
}

function htmlBlocks(xhtml: string, baseFile: string, files: Map<string, Uint8Array>, lower: Map<string, string>): Block[] {
  const blocks: Block[] = [];
  let skip = 0;
  let mode: 'loose' | 'h1' | 'h2' | 'p' | 'li' = 'loose';
  let buf = '';

  const flush = (kind: 'h1' | 'h2' | 'p' | 'li' | 'loose') => {
    let text = cleanText(buf);
    buf = '';
    if (!text) return;
    if (kind === 'li') text = `• ${text}`;
    blocks.push({ kind: kind === 'loose' ? 'p' : kind, text });
  };

  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g;
  for (const raw of xhtml.match(token) ?? []) {
    if (raw.startsWith('<!--')) continue;
    if (raw.startsWith('<![CDATA[')) {
      if (skip === 0) buf += raw.slice(9, -3);
      continue;
    }
    if (!raw.startsWith('<')) {
      if (skip === 0) buf += raw;
      continue;
    }
    const head = /^<\s*(\/)?\s*([a-zA-Z0-9:-]+)/.exec(raw);
    if (!head) continue;
    const closing = !!head[1];
    const name = head[2].toLowerCase().replace(/^.*:/, '');
    if (SKIP.has(name)) {
      if (!closing && !raw.endsWith('/>')) skip += closing ? 0 : 1;
      if (closing) skip = Math.max(0, skip - 1);
      if (!closing && !raw.endsWith('/>')) continue;
      if (closing) continue;
    }
    if (skip > 0) continue;
    if (name === 'br' || name === 'hr') {
      flush(mode);
      mode = 'loose';
      continue;
    }
    if (name === 'img' && !closing) {
      flush(mode);
      mode = 'loose';
      const src = attr(raw, 'src');
      const path = src ? resolveHref(baseFile, src) : '';
      const bytes = path ? lookup(files, lower, path) : undefined;
      if (bytes) {
        const size = imageSize(bytes) ?? { w: 800, h: 600 };
        blocks.push({ kind: 'img', path, w: size.w, h: size.h });
      }
      continue;
    }
    if (!BLOCKS.has(name)) continue;
    if (!closing) {
      flush(mode);
      mode = blockKind(name);
      buf = '';
    } else {
      flush(mode === 'loose' ? blockKind(name) : mode);
      mode = 'loose';
    }
  }
  flush(mode);
  return blocks;
}

/** Unzip an EPUB and pull out its reading order. Throws a plain Error on DRM or a broken package. */
export async function parseEpub(data: Uint8Array): Promise<ParsedEpub> {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data);
  } catch {
    throw new Error('This EPUB is damaged and can’t be opened.');
  }
  const files = new Map<string, Uint8Array>();
  const lower = new Map<string, string>();
  for (const [raw, bytes] of Object.entries(unzipped)) {
    const key = normPath(raw);
    if (!key) continue;
    files.set(key, bytes);
    lower.set(key.toLowerCase(), key);
  }

  if (lookup(files, lower, 'META-INF/rights.xml')) {
    throw new Error('This EPUB is DRM-locked and can’t be opened.');
  }
  const encBytes = lookup(files, lower, 'META-INF/encryption.xml');
  if (encBytes) {
    const enc = new TextDecoder().decode(encBytes);
    if (!/idpf\.org\/2008\/embedding/.test(enc)) {
      throw new Error('This EPUB is DRM-locked and can’t be opened.');
    }
  }

  const container = lookup(files, lower, 'META-INF/container.xml');
  if (!container) throw new Error('This EPUB is missing its package.');
  const containerXml = new TextDecoder().decode(container);
  const opfHref = /full-path\s*=\s*["']([^"']+)["']/i.exec(containerXml)?.[1];
  if (!opfHref) throw new Error('This EPUB is missing its package.');
  const opfPath = normPath(opfHref);
  const opfBytes = lookup(files, lower, opfPath);
  if (!opfBytes) throw new Error('This EPUB is missing its package.');
  const opf = new TextDecoder().decode(opfBytes);
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map<string, { href: string; type: string }>();
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (!id || !href) continue;
    manifest.set(id, { href: normPath(opfDir + href), type: (attr(tag, 'media-type') ?? '').toLowerCase() });
  }

  const blocks: Block[] = [];
  const images = new Map<string, Uint8Array>();
  let chapters = 0;
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    if (/linear\s*=\s*["']no["']/i.test(tag)) continue;
    const idref = attr(tag, 'idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (!item) continue;
    const isHtml = /html|xml/.test(item.type) || /\.x?html?$/i.test(item.href);
    if (!isHtml) continue;
    const doc = lookup(files, lower, item.href);
    if (!doc) continue;
    if (chapters > 0) blocks.push({ kind: 'break' });
    chapters++;
    const chapter = htmlBlocks(new TextDecoder().decode(doc), item.href, files, lower);
    for (const block of chapter) {
      if (block.kind === 'img') {
        const bytes = lookup(files, lower, block.path);
        if (bytes && !images.has(block.path)) images.set(block.path, bytes);
      }
      blocks.push(block);
    }
  }
  if (chapters === 0) throw new Error('This EPUB has no readable pages.');

  const title = tagText(opf, 'title');
  const id = `epub:${await sha1Hex(data)}`;
  return { id, title, blocks, images };
}

function wrap(text: string, font: string, maxW: number, measure: Measure): string[] {
  const words = text.split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  const pushWord = (word: string) => {
    if (measure(word, font) <= maxW) {
      line = word;
      return;
    }
    let chunk = '';
    for (const ch of word) {
      const trial = chunk + ch;
      if (chunk && measure(trial, font) > maxW) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk = trial;
      }
    }
    line = chunk;
  };
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (measure(trial, font) <= maxW) line = trial;
    else {
      if (line) lines.push(line);
      pushWord(word);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fit(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const s = Math.min(maxW / w, maxH / h, 1);
  return { w: Math.max(1, w * s), h: Math.max(1, h * s) };
}

/** Flow blocks into pages. `measure` is the width of a string in the given CSS font. */
export function paginateEpub(blocks: Block[], measure: Measure): EpubLaidPage[] {
  const pages: EpubLaidPage[] = [];
  const contentW = EPUB_PAGE_W - PAD_X * 2;
  const maxY = EPUB_PAGE_H - PAD_Y;
  const maxImgH = (EPUB_PAGE_H - PAD_Y * 2) * 0.85;
  let ops: EpubOp[] = [];
  let y = PAD_Y;

  const commit = () => {
    if (ops.length) pages.push({ ops });
    ops = [];
    y = PAD_Y;
  };

  for (const block of blocks) {
    if (block.kind === 'break') {
      if (ops.length) commit();
      continue;
    }
    if (block.kind === 'img') {
      const box = fit(block.w, block.h, contentW, maxImgH);
      if (y > PAD_Y && y + box.h > maxY) commit();
      ops.push({ kind: 'image', path: block.path, x: PAD_X, y, w: box.w, h: box.h });
      y += box.h + 12;
      continue;
    }
    const font = EPUB_FONTS[block.kind];
    const lh = LINE[block.kind];
    for (const line of wrap(block.text, font, contentW, measure)) {
      if (y > PAD_Y && y + lh > maxY) commit();
      ops.push({ kind: 'text', text: line, font, x: PAD_X, y });
      y += lh;
    }
    y += 10;
  }
  if (ops.length) pages.push({ ops });
  return pages;
}
