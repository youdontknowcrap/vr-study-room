/**
 * EPUB parse + pagination. No browser, no three.js.
 *   node --experimental-strip-types scripts/unit-epub.mjs
 */
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { paginateEpub, parseEpub } from '../src/book/epub-document.ts';

let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log('  ✔', name);
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

function epub(files) {
  return zipSync(files);
}

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opf(title, extra = '') {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="pic.png" media-type="image/png"/>
    <item id="skip" href="notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="skip" linear="no"/>
  </spine>
</package>${extra}`;
}

const ch1 = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Chapter One</h1>
  <p>Fish &amp; Chips</p>
  <p><img src="pic.png" alt=""/></p>
  <script>throw new Error('ran')</script>
</body></html>`;

const ch2 = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Chapter Two</h1>
  <p>${'word '.repeat(500)}</p>
</body></html>`;

const notes = `<html><body><p>NOT IN THE BOOK</p></body></html>`;

function pack() {
  return epub({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'OEBPS/book.opf': strToU8(opf('Harbor Lights')),
    'OEBPS/c1.xhtml': strToU8(ch1),
    'OEBPS/c2.xhtml': strToU8(ch2),
    'OEBPS/notes.xhtml': strToU8(notes),
    'OEBPS/pic.png': new Uint8Array(PNG),
  });
}

const measure = (text) => text.length * 10;

await test('reads the title, skips scripts and non-linear docs, pages chapters apart', async () => {
  const parsed = await parseEpub(pack());
  assert.equal(parsed.title, 'Harbor Lights');
  assert.ok(parsed.id.startsWith('epub:') && parsed.id.length > 10);
  const pages = paginateEpub(parsed.blocks, measure);
  const texts = pages.flatMap((p) => p.ops.filter((o) => o.kind === 'text').map((o) => o.text));
  assert.ok(texts.includes('Fish & Chips'), 'entity decoded');
  assert.ok(texts.includes('Chapter Two'));
  assert.ok(!texts.some((t) => t.includes('NOT IN THE BOOK')));
  assert.ok(!texts.some((t) => t.includes('ran')));
  const image = pages.flatMap((p) => p.ops).find((o) => o.kind === 'image');
  assert.ok(image && image.w === 1 && image.h === 1, 'png size');
  const two = pages.findIndex((p) => p.ops.some((o) => o.text === 'Chapter Two'));
  assert.ok(two > 0, 'second chapter starts a later page');
  assert.ok(!pages[two].ops.some((o) => o.text === 'Fish & Chips'));
  assert.ok(pages.length >= 3, `long chapter paginates (${pages.length})`);
});

await test('font-obfuscation encryption is still readable; a rights file is DRM', async () => {
  const obfuscated = epub({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'META-INF/encryption.xml': strToU8(
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">http://www.idpf.org/2008/embedding</EncryptedData></encryption>',
    ),
    'OEBPS/book.opf': strToU8(opf('Still Readable')),
    'OEBPS/c1.xhtml': strToU8('<html><body><p>Hello</p></body></html>'),
    'OEBPS/c2.xhtml': strToU8('<html><body><p>There</p></body></html>'),
  });
  const parsed = await parseEpub(obfuscated);
  assert.equal(parsed.title, 'Still Readable');

  const locked = epub({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'META-INF/rights.xml': strToU8('<rights/>'),
    'OEBPS/book.opf': strToU8(opf('Locked')),
    'OEBPS/c1.xhtml': strToU8('<html><body><p>Secret</p></body></html>'),
    'OEBPS/c2.xhtml': strToU8('<html><body><p>Secret</p></body></html>'),
  });
  await assert.rejects(parseEpub(locked), /DRM/);
});

await test('a random zip is not an EPUB package', async () => {
  await assert.rejects(parseEpub(epub({ 'readme.txt': strToU8('hi') })), /package/);
});

console.log(`OK: ${n} epub checks passed`);
