#!/usr/bin/env node
/**
 * Deterministic probe for the D7 `read_pdf` slice (PDF text reading).
 *
 * RDK work arrives as PDFs (site reports, datasheets, vendor manuals) and the
 * model could not read a single one: read_file sees binary, read_image takes
 * raster images. This probe builds PDFs from raw bytes in a temp dir and pins
 * the whole contract: object/stream scan, FlateDecode, page tree order,
 * `Tj`/`TJ`/`'`/`"` text operators with `Td`/`TD`/`T*`/`ET` line breaks, octal and
 * backslash escapes, WinAnsi high bytes, UTF-16 hex strings, page-range
 * selection, and the honest refusal paths (encrypted, image-only, damaged).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const builtin = await import(pathToFileURL(path.join(root, 'dist/tools/builtin.js')).href);
const pdfModule = await import(pathToFileURL(path.join(root, 'dist/tools/read-pdf.js')).href);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[read-pdf] ok ${name}`);
}

const asLatin1 = (text) => Buffer.from(text, 'latin1');

/**
 * A minimal, real PDF writer. Objects are laid out in numeric order and end with
 * a cross-reference table, so the fixture is a valid PDF and not just bytes the
 * parser happens to like.
 *
 * pages: content-stream sources, one per page.
 * compress: FlateDecode every content stream (alternating name and array form).
 * imageOnly: page 1 paints an image XObject and draws no text at all.
 * corruptStreamIndex: that page's stream claims FlateDecode over corrupt bytes.
 * encrypted: trailer gains /Encrypt <ref> like a password-protected file.
 * cmap: the page font is a Type0/Identity-H font whose /ToUnicode CMap carries
 *       the real characters (how Word/browser exports encode text).
 * indirectResources: pages point at `/Resources N 0 R` (the invoice shape).
 * inheritResources: pages omit /Resources; the /Pages parent carries it.
 */
function buildPdf({
  pages,
  compress = false,
  imageOnly = false,
  corruptStreamIndex = -1,
  encrypted = false,
  cmap = false,
  indirectResources = false,
  inheritResources = false,
}) {
  const pageCount = pages.length;
  const firstContent = 3 + pageCount;
  const fontNumber = firstContent + pageCount;
  const extraNumber = fontNumber + 1;
  const resourcesNumber = fontNumber + 2;
  const objects = new Map();

  objects.set(1, { dict: '<< /Type /Catalog /Pages 2 0 R >>' });
  const kids = pages.map((_, index) => `${3 + index} 0 R`).join(' ');
  const inherited = inheritResources ? ` /Resources << /Font << /F1 ${fontNumber} 0 R >> >>` : '';
  objects.set(2, {
    dict: `<< /Type /Pages /Kids [${kids}] /Count ${pageCount}${inherited} >>`,
  });
  if (indirectResources) {
    objects.set(resourcesNumber, { dict: `<< /Font << /F1 ${fontNumber} 0 R >> >>` });
  }

  pages.forEach((content, index) => {
    const pageNumber = 3 + index;
    const contentNumber = firstContent + index;
    const xobject = imageOnly ? ` /XObject << /Im0 ${extraNumber} 0 R >>` : '';
    const resources = inheritResources
      ? ''
      : indirectResources
        ? ` /Resources ${resourcesNumber} 0 R`
        : ` /Resources << /Font << /F1 ${fontNumber} 0 R >>${xobject} >>`;
    objects.set(pageNumber, {
      dict:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]` +
        `${resources} /Contents ${contentNumber} 0 R >>`,
    });
    if (index === corruptStreamIndex) {
      // A FlateDecode header followed by bytes that are not a deflate stream.
      const corrupt = Buffer.from([0x78, 0x9c, 0x00, 0xff, 0xde, 0xad, 0xbe, 0xef]);
      objects.set(contentNumber, {
        dict: `<< /Length ${corrupt.length} /Filter /FlateDecode >>`,
        data: corrupt,
      });
      return;
    }
    const raw = asLatin1(content);
    if (compress) {
      const deflated = zlib.deflateSync(raw);
      const filter = index % 2 === 0 ? '/Filter /FlateDecode' : '/Filter [/FlateDecode]';
      objects.set(contentNumber, {
        dict: `<< /Length ${deflated.length} ${filter} >>`,
        data: deflated,
      });
      return;
    }
    objects.set(contentNumber, { dict: `<< /Length ${raw.length} >>`, data: raw });
  });

  objects.set(fontNumber, {
    dict: cmap
      ? `<< /Type /Font /Subtype /Type0 /BaseFont /ToUnicodeFixture /Encoding /Identity-H ` +
        `/ToUnicode ${extraNumber} 0 R >>`
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  });
  if (cmap) {
    // 0001→A, 0002→B, 0003→C and 0010–0012→x,y,z through both CMap forms.
    const cmapText = asLatin1(
      [
        '/CIDInit /ProcSet findresource begin',
        '12 dict begin',
        'begincmap',
        '/CMapName /Adobe-Identity-UCS def',
        '/CMapType 2 def',
        '1 begincodespacerange',
        '<0000> <FFFF>',
        'endcodespacerange',
        '4 beginbfchar',
        '<0001> <0041>',
        '<0002> <0042>',
        '<0003> <0043>',
        '<0004> <0044>',
        'endbfchar',
        '1 beginbfrange',
        '<0010> <0012> <0078>',
        'endbfrange',
        'endcmap',
        'end',
        'end',
      ].join('\n')
    );
    const deflated = zlib.deflateSync(cmapText);
    objects.set(extraNumber, {
      dict: `<< /Length ${deflated.length} /Filter /FlateDecode >>`,
      data: deflated,
    });
  }
  if (imageOnly) {
    const pixels = Buffer.from([0x00, 0xff, 0x00, 0xff]);
    objects.set(extraNumber, {
      dict:
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray ' +
        `/BitsPerComponent 8 /Length ${pixels.length} >>`,
      data: pixels,
    });
  }
  let trailerExtra = '';
  if (encrypted) {
    objects.set(extraNumber, {
      dict: '<< /Filter /Standard /V 1 /R 2 /O (stub) /U (stub) /P -1 >>',
    });
    trailerExtra = ` /Encrypt ${extraNumber} 0 R`;
  }

  const parts = [];
  let offset = 0;
  const push = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : asLatin1(value);
    parts.push(buffer);
    offset += buffer.length;
  };
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const offsets = new Map();
  const numbers = [...objects.keys()].sort((left, right) => left - right);
  for (const number of numbers) {
    const object = objects.get(number);
    offsets.set(number, offset);
    push(`${number} 0 obj\n${object.dict}\n`);
    if (object.data) {
      push('stream\n');
      push(object.data);
      push('\nendstream\n');
    }
    push('endobj\n');
  }
  const xrefStart = offset;
  const size = numbers[numbers.length - 1] + 1;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let number = 1; number < size; number += 1) {
    const objectOffset = offsets.get(number);
    if (objectOffset === undefined) {
      push('0000000000 65535 f \n');
      continue;
    }
    push(`${String(objectOffset).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${size} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** Split the tool output into header + `--- page N ---` sections. */
function pageSections(output) {
  const matches = [...output.matchAll(/^--- page (\d+) ---$/gm)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    text: output
      .slice(
        match.index + match[0].length,
        index + 1 < matches.length ? matches[index + 1].index : output.length
      )
      .trim(),
  }));
}

function linesOf(section) {
  return section.text.split('\n').map((line) => line.trim());
}

const tool = builtin.builtinTools.find((candidate) => candidate.name === 'read_pdf');

// ── 1. Registration and side-effect metadata ───────────────────────────────

assert.ok(tool, 'read_pdf must be registered in builtinTools');
assert.equal(tool.metadata?.sideEffectClass, 'readonly');
assert.equal(tool.metadata?.planMode, 'allow');
assert.equal(tool.metadata?.requiresApproval, false);
assert.equal(tool.metadata?.maxResultTokens, 6_000);
assert.ok(tool.metadata?.truncationHint?.length > 20);
assert.equal(tool.metadata?.classification?.singleCallExempt, true);
assert.equal(tool.metadata?.classification?.discovery, true);
assert.deepEqual(tool.inputSchema.required, ['path']);
assert.ok(tool.description.length > 200);
assert.ok(tool.description.includes('read_image') && tool.description.includes('read_file'));
// The tool-surface gate requires a lean tier for any declared description this long.
assert.ok(tool.metadata?.leanDescription, 'long descriptions must ship a lean tier');
assert.ok(tool.metadata.leanDescription.length < tool.description.length);
assert.ok(
  tool.metadata.leanDescription.length <= tool.description.length * 0.6,
  'lean description must stay inside the 60% budget'
);
ok('read_pdf is registered as a readonly, plan-safe tool with capped output');

// ── 2. Text extraction from an uncompressed PDF (operators + escapes) ─────

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-pdf-'));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-pdf-ws-'));
await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
const ctx = { workspaceDir: workspace };

const textPdf = buildPdf({
  pages: [
    [
      'BT',
      '/F1 12 Tf',
      '72 700 Td',
      '(Alpha one) Tj',
      '0 -18 Td',
      '(Second \\(line\\) 100%) Tj',
      '0 -18 Td',
      '(Caf\\351) Tj',
      'ET',
    ].join('\n'),
    [
      'BT',
      '/F1 12 Tf',
      '72 700 Td',
      '[(Beta) -300 (Gamma)] TJ',
      '0 -18 Td',
      '<48656C6C6F> Tj',
      '0 -18 Td',
      '<FEFF00480069> Tj',
      'ET',
    ].join('\n'),
    [
      'BT',
      '/F1 12 Tf',
      '72 700 Td',
      "(Charlie) '",
      '0 -18 Td',
      '0 0 (Delta) "',
      '0 -18 Td',
      '(Echo) Tj',
      'T*',
      '(Foxtrot) Tj',
      'ET',
    ].join('\n'),
  ],
});

try {
  await fs.writeFile(path.join(workspace, 'text.pdf'), textPdf);

  const extracted = await tool.executeStructured({ path: 'text.pdf' }, ctx);
  assert.equal(extracted.isError, undefined, 'a text PDF must succeed');
  const output = extracted.content[0].text;
  const header = output.split('\n')[0];
  assert.match(header, /^\[pdf\] text\.pdf — 3 pages, \d+ chars$/);
  const sections = pageSections(output);
  assert.deepEqual(
    sections.map((section) => section.number),
    [1, 2, 3],
    'every page appears once, in page-tree order'
  );
  assert.deepEqual(linesOf(sections[0]), ['Alpha one', 'Second (line) 100%', 'Café']);
  assert.deepEqual(linesOf(sections[1]), ['Beta Gamma', 'Hello', 'Hi']);
  assert.deepEqual(linesOf(sections[2]), ['Charlie', 'Delta', 'Echo', 'Foxtrot']);
  const reportedChars = Number(/(\d+) chars?$/.exec(header)?.[1]);
  const actualChars = sections.reduce((total, section) => total + section.text.length, 0);
  assert.equal(reportedChars, actualChars, 'the header char count must match the emitted text');
  ok('uncompressed PDF: Tj/TJ/quote ops, escapes and WinAnsi extract exactly');

  // ── 3. FlateDecode streams (name form and array form) ────────────────────

  const flatePdf = buildPdf({
    compress: true,
    pages: [
      ['BT', '/F1 10 Tf', '72 700 Td', '(Compressed Alpha) Tj', 'ET'].join('\n'),
      ['BT', '/F1 10 Tf', '72 700 Td', '(Compressed Beta) Tj', 'ET'].join('\n'),
    ],
  });
  await fs.writeFile(path.join(workspace, 'flate.pdf'), flatePdf);
  const flate = await tool.executeStructured({ path: 'flate.pdf' }, ctx);
  assert.equal(flate.isError, undefined);
  const flateSections = pageSections(flate.content[0].text);
  assert.deepEqual(linesOf(flateSections[0]), ['Compressed Alpha']);
  assert.deepEqual(linesOf(flateSections[1]), ['Compressed Beta']);
  ok('FlateDecode content streams inflate (both /Filter forms)');

  // ── 3b. /ToUnicode CMaps decode CID fonts (the real-world encoding) ─────

  const cmapPdf = buildPdf({
    cmap: true,
    pages: [
      [
        'BT',
        '/F1 12 Tf',
        '72 700 Td',
        '<000100020003001000110012> Tj',
        '0 -18 Td',
        '(\\000\\001\\000\\002\\000\\003) Tj',
        'ET',
      ].join('\n'),
      // Web/CJK exports position each glyph with a one-em `Td`: the extractor
      // must not turn that glyph placement into a space between characters.
      [
        'BT',
        '/F1 26.66 Tf',
        '1 0 0 -1 0 30 Tm',
        '<0001> Tj',
        '26.66 0 Td',
        '<0002> Tj',
        '26.66 0 Td',
        '<0003> Tj',
        'ET',
      ].join('\n'),
      // /ActualText is the author's authoritative string for the glyphs it spans.
      [
        'BT',
        '/F1 26.66 Tf',
        '1 0 0 -1 0 30 Tm',
        '/Span<</ActualText <FEFF74DC> >> BDC',
        '<0001> Tj',
        'EMC',
        '0 -18 Td',
        '<0002> Tj',
        'ET',
      ].join('\n'),
      // One BT/ET block per glyph moved by Tm: same Y keeps the line, new Y breaks.
      [
        'BT',
        '/F1 40 Tf',
        '0.05 0 -0 0.05 90 700 Tm',
        '<0001> Tj',
        'ET',
        'BT',
        '/F1 40 Tf',
        '0.05 0 -0 0.05 110 700 Tm',
        '<0002> Tj',
        'ET',
        'BT',
        '/F1 40 Tf',
        '0.05 0 -0 0.05 90 680 Tm',
        '<0003> Tj',
        'ET',
        'BT',
        '/F1 40 Tf',
        '0.05 0 -0 0.05 110 680 Tm',
        '<0004> Tj',
        'ET',
      ].join('\n'),
    ],
  });
  await fs.writeFile(path.join(workspace, 'cmap.pdf'), cmapPdf);
  const cmap = await tool.executeStructured({ path: 'cmap.pdf' }, ctx);
  assert.equal(cmap.isError, undefined);
  const cmapSections = pageSections(cmap.content[0].text);
  assert.deepEqual(
    linesOf(cmapSections[0]),
    ['ABCxyz', 'ABC'],
    'ToUnicode bfchar/bfrange must decode both hex and literal strings'
  );
  assert.deepEqual(
    linesOf(cmapSections[1]),
    ['ABC'],
    'per-glyph Td placement must not inject spaces between characters'
  );
  assert.deepEqual(
    linesOf(cmapSections[2]),
    ['\u74dc', 'B'],
    '/ActualText must replace the spanned glyph codes with the real characters'
  );
  assert.deepEqual(
    linesOf(cmapSections[3]),
    ['AB', 'CD'],
    'glyph-per-block Tm placement must reassemble lines from the matrix Y'
  );
  ok('/ToUnicode CMaps decode Type0/Identity-H text (hex and literal strings)');

  // ── 3c. Resources through an indirect ref or inherited from /Pages ──────

  const resourcePage = ['BT', '/F1 12 Tf', '72 700 Td', '<000100020003> Tj', 'ET'].join('\n');
  for (const [label, options] of [
    ['indirect /Resources reference', { indirectResources: true }],
    ['/Resources inherited from the Pages node', { inheritResources: true }],
  ]) {
    const fixture = buildPdf({ cmap: true, pages: [resourcePage], ...options });
    await fs.writeFile(path.join(workspace, 'cmap-resources.pdf'), fixture);
    const result = await tool.executeStructured({ path: 'cmap-resources.pdf' }, ctx);
    assert.equal(result.isError, undefined, label);
    assert.deepEqual(linesOf(pageSections(result.content[0].text)[0]), ['ABC'], label);
  }
  ok('fonts resolve through indirect and inherited page /Resources');

  // ── 4. Page-range selection ──────────────────────────────────────────────

  const onlyPage2 = await tool.executeStructured({ path: 'text.pdf', pages: '2' }, ctx);
  assert.equal(onlyPage2.isError, undefined);
  assert.deepEqual(
    pageSections(onlyPage2.content[0].text).map((section) => section.number),
    [2]
  );
  assert.match(onlyPage2.content[0].text, /showing page 2,/);
  assert.doesNotMatch(onlyPage2.content[0].text, /Alpha one/);
  ok('pages "2" returns only page 2 and says so in the header');

  const range = await tool.executeStructured({ path: 'text.pdf', pages: '1-2' }, ctx);
  assert.deepEqual(
    pageSections(range.content[0].text).map((section) => section.number),
    [1, 2]
  );
  assert.match(range.content[0].text, /showing pages 1-2/);
  assert.doesNotMatch(range.content[0].text, /Foxtrot/);
  ok('pages "1-2" selects a contiguous range');

  const openRange = await tool.executeStructured({ path: 'text.pdf', pages: '2-' }, ctx);
  assert.deepEqual(
    pageSections(openRange.content[0].text).map((section) => section.number),
    [2, 3]
  );
  assert.match(openRange.content[0].text, /showing pages 2-3/);
  ok('pages "2-" runs to the last page');

  const sparse = await tool.executeStructured({ path: 'text.pdf', pages: '1, 3' }, ctx);
  assert.deepEqual(
    pageSections(sparse.content[0].text).map((section) => section.number),
    [1, 3]
  );
  assert.match(sparse.content[0].text, /showing pages 1, 3/);
  ok('pages "1, 3" selects non-contiguous pages');

  const outOfRange = await tool.executeStructured({ path: 'text.pdf', pages: '4' }, ctx);
  assert.equal(outOfRange.isError, true);
  assert.match(outOfRange.content[0].text, /has 3 page\(s\); page range "4" is out of range/);
  const invalidRange = await tool.executeStructured({ path: 'text.pdf', pages: 'abc' }, ctx);
  assert.equal(invalidRange.isError, true);
  assert.match(invalidRange.content[0].text, /invalid page range "abc"/);
  const zeroPage = await tool.executeStructured({ path: 'text.pdf', pages: '0' }, ctx);
  assert.equal(zeroPage.isError, true);
  assert.match(zeroPage.content[0].text, /invalid page range "0"/);
  ok('bad page ranges fail with the real page count instead of guessing');

  // ── 5. Image-only PDF: no text layer, honest message ─────────────────────

  const imagePdf = buildPdf({
    imageOnly: true,
    pages: ['q\n100 0 0 100 72 72 cm\n/Im0 Do\nQ'],
  });
  await fs.writeFile(path.join(workspace, 'image-only.pdf'), imagePdf);
  const imageOnly = await tool.executeStructured({ path: 'image-only.pdf' }, ctx);
  assert.equal(imageOnly.isError, true);
  assert.match(imageOnly.content[0].text, /no extractable text/i);
  assert.match(imageOnly.content[0].text, /image-only\/scanned/i);
  assert.match(imageOnly.content[0].text, /read_image/);
  ok('image-only PDFs are refused with the OCR/read_image guidance');

  // ── 6. Encrypted PDF: detected from the trailer, not attempted ───────────

  const encryptedPdf = buildPdf({
    encrypted: true,
    pages: ['BT\n/F1 12 Tf\n72 700 Td\n(secret) Tj\nET'],
  });
  await fs.writeFile(path.join(workspace, 'encrypted.pdf'), encryptedPdf);
  const encrypted = await tool.executeStructured({ path: 'encrypted.pdf' }, ctx);
  assert.equal(encrypted.isError, true);
  assert.match(encrypted.content[0].text, /encrypted/i);
  assert.match(encrypted.content[0].text, /unencrypted copy/i);
  ok('encrypted PDFs are refused clearly instead of emitting garbage');

  // ── 7. Malformed input never throws ──────────────────────────────────────

  const broken = Buffer.concat([
    asLatin1('%PDF-1.4\n'),
    Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x80, 0x13, 0x37]),
  ]);
  await fs.writeFile(path.join(workspace, 'broken.pdf'), broken);
  const brokenResult = await tool.executeStructured({ path: 'broken.pdf' }, ctx);
  assert.equal(brokenResult.isError, true);
  assert.match(brokenResult.content[0].text, /could not be parsed as a PDF/);

  await fs.writeFile(path.join(workspace, 'truncated.pdf'), textPdf.subarray(0, 220));
  const truncatedResult = await tool.executeStructured({ path: 'truncated.pdf' }, ctx);
  assert.equal(typeof truncatedResult.content[0].text, 'string');
  assert.ok(truncatedResult.content[0].text.length > 0, 'a truncated PDF still answers');
  ok('broken and truncated PDF bytes produce a message, never a thrown error');

  // ── 8. A corrupt Flate stream degrades to the pages that do decode ───────

  const corruptPdf = buildPdf({
    corruptStreamIndex: 1,
    pages: [
      ['BT', '/F1 10 Tf', '72 700 Td', '(Good page) Tj', 'ET'].join('\n'),
      ['BT', '/F1 10 Tf', '72 700 Td', '(never decodes) Tj', 'ET'].join('\n'),
    ],
  });
  await fs.writeFile(path.join(workspace, 'corrupt-stream.pdf'), corruptPdf);
  const corrupt = await tool.executeStructured({ path: 'corrupt-stream.pdf' }, ctx);
  assert.equal(corrupt.isError, undefined, 'one corrupt stream must not fail the document');
  const corruptOutput = corrupt.content[0].text;
  assert.match(corruptOutput, /Good page/);
  assert.match(corruptOutput, /could not be decoded/);
  assert.match(corruptOutput, /\(no extractable text on this page\)/);
  ok('a corrupt Flate stream is skipped and reported, other pages still read');

  // ── 9. Path resolution and file guards ───────────────────────────────────

  await fs.copyFile(path.join(workspace, 'text.pdf'), path.join(workspace, 'docs/report.pdf'));
  const relative = await tool.executeStructured({ path: 'docs/report.pdf' }, ctx);
  assert.equal(relative.isError, undefined);
  assert.match(relative.content[0].text, /^\[pdf\] docs\/report\.pdf — 3 pages/);
  ok('workspace-relative paths resolve under the workspace root');

  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-pdf-elsewhere-'));
  const absolute = await tool.executeStructured(
    { path: path.join(workspace, 'docs/report.pdf') },
    { workspaceDir: elsewhere }
  );
  await fs.rm(elsewhere, { recursive: true, force: true });
  assert.equal(absolute.isError, undefined);
  assert.match(absolute.content[0].text, /Alpha one/);
  ok('absolute paths outside the workspace still read (same as read_file)');

  const plainText = path.join(workspace, 'notes.txt');
  await fs.writeFile(plainText, 'just text, not a pdf\n');
  const notPdf = await tool.executeStructured({ path: 'notes.txt' }, ctx);
  assert.equal(notPdf.isError, true);
  assert.match(notPdf.content[0].text, /is not a PDF/);
  ok('a non-PDF file is named as such, not rendered as garbage');

  const missing = await tool.executeStructured({ path: 'nope.pdf' }, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /does not exist/);

  const directory = await tool.executeStructured({ path: 'docs' }, ctx);
  assert.equal(directory.isError, true);
  assert.match(directory.content[0].text, /is a directory/);

  await fs.writeFile(path.join(workspace, 'empty.pdf'), '');
  const empty = await tool.executeStructured({ path: 'empty.pdf' }, ctx);
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /is empty \(0 bytes\)/);

  await fs.writeFile(path.join(workspace, 'huge.pdf'), textPdf);
  await fs.truncate(path.join(workspace, 'huge.pdf'), pdfModule.READ_PDF_MAX_BYTES + 1);
  const huge = await tool.executeStructured({ path: 'huge.pdf' }, ctx);
  assert.equal(huge.isError, true);
  assert.match(huge.content[0].text, /larger than read_pdf loads/);
  ok('missing/directory/empty/non-PDF/oversized inputs each get a precise error');

  // The plain string execute path must agree with the structured one.
  const plain = await tool.execute({ path: 'text.pdf', pages: '1-2' }, ctx);
  assert.equal(typeof plain, 'string');
  assert.match(plain, /^\[pdf\] text\.pdf — 3 pages, showing pages 1-2/);
  assert.match(plain, /--- page 1 ---/);
  ok('the string execute path returns the same page-delimited text');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
}

console.log(`[read-pdf] PASS (${checks} checks)`);
