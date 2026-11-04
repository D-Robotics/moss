#!/usr/bin/env node
/**
 * Deterministic probe for Ctrl+V attachments (backlog B01, last missing input
 * path). The help block promised "attach clipboard image / Finder file / path"
 * while nothing read the clipboard; the image is staged under the gitignored
 * .moss/runtime/attachments and the composer receives an @path that read_image
 * opens.
 *
 * Real clipboard manipulation is opt-in (MOSS_VERIFY_CLIPBOARD=1) so CI does not
 * clobber a developer's clipboard; the parser/staging contract always runs.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const clipboard = await import(
  pathToFileURL(path.join(root, 'dist/cli/clipboard-attachment.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[clipboard-paste] ok ${name}`);
};

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moss-clipboard-probe-'));
// Staging only writes the runtime .gitignore inside a git work tree.
await runProcess('git', ['init', '-q'], { cwd: dir, timeoutMs: 15_000 });
try {
  // ── 1. AppleScript hex payload parses into the real bytes ───────────────

  const sample = PNG_1X1.subarray(0, 8).toString('hex').toUpperCase();
  const decoded = clipboard.decodeAppleScriptImageData(`«data PNGf${sample}»`);
  assert.deepEqual(decoded, PNG_1X1.subarray(0, 8));
  assert.equal(clipboard.decodeAppleScriptImageData('«data PNGfZZZZ»'), null);
  assert.equal(clipboard.decodeAppleScriptImageData('not an image'), null);
  ok('the AppleScript image payload is decoded from hex, and junk is rejected');

  // ── 2. Staging is content-addressed and inside the gitignored runtime ──

  const first = await clipboard.stageClipboardImage({
    workspaceDir: dir,
    bytes: PNG_1X1,
    mimeType: 'image/png',
  });
  assert.equal(first.ok, true);
  assert.match(first.relPath, /^\.moss\/runtime\/attachments\/[0-9a-f]{16}\.png$/);
  assert.equal(clipboard.formatAttachmentMention(first.relPath), `@${first.relPath}`);
  const written = await fsp.readFile(first.absolutePath);
  assert.deepEqual(written, PNG_1X1);
  const again = await clipboard.stageClipboardImage({
    workspaceDir: dir,
    bytes: PNG_1X1,
    mimeType: 'image/png',
  });
  assert.equal(again.relPath, first.relPath, 'the same bytes must share one file');
  assert.match(
    await fsp.readFile(path.join(dir, '.moss', '.gitignore'), 'utf8'),
    /runtime\//,
    'the attachment must be gitignored runtime state'
  );
  ok('an image is staged once under .moss/runtime/attachments and stays gitignored');

  // ── 3. Non-image bytes and oversize payloads are refused ───────────────

  const notImage = await clipboard.stageClipboardImage({
    workspaceDir: dir,
    bytes: Buffer.from('plain text pretending to be a png'),
    mimeType: 'image/png',
  });
  assert.equal(notImage.ok, false);
  assert.match(notImage.reason, /not a PNG\/JPEG\/GIF\/WebP image/);
  const oversize = await clipboard.stageClipboardImage({
    workspaceDir: dir,
    bytes: Buffer.alloc(3 * 1024 * 1024 + 1),
    mimeType: 'image/png',
  });
  assert.equal(oversize.ok, false);
  assert.match(oversize.reason, /over the .* read_image limit/);
  ok('magic bytes and the read_image size budget are enforced before staging');

  // ── 3b. File references: Finder copy, dragged path, browser file URL ───

  assert.equal(
    clipboard.clipboardPathFromText('file:///tmp/probe%20shot.png'),
    '/tmp/probe shot.png',
    'a file:// URL must decode its percent escapes'
  );
  assert.equal(
    clipboard.clipboardPathFromText('"/tmp/probe\\ shot.png"'),
    '/tmp/probe shot.png',
    'a quoted drag-and-drop path must lose its quotes and backslash-space escape'
  );
  assert.equal(clipboard.clipboardPathFromText('hello world'), null, 'plain text is not a path');
  assert.equal(
    clipboard.clipboardPathFromText('C:\\shots\\one.png'),
    'C:\\shots\\one.png',
    'a Windows path keeps its separators'
  );
  ok('a file:// URL, a quoted dragged path and plain text are told apart');

  const pngFile = path.join(dir, 'probe shot.png');
  await fsp.writeFile(pngFile, PNG_1X1);
  const stagedFile = await clipboard.stageClipboardFile({ workspaceDir: dir, filePath: pngFile });
  assert.equal(stagedFile.ok, true);
  assert.equal(stagedFile.relPath, first.relPath, 'the same image bytes share one staged file');
  assert.equal(stagedFile.bytes, PNG_1X1.length);
  assert.equal(stagedFile.mimeType, 'image/png');
  const textFile = path.join(dir, 'notes.txt');
  await fsp.writeFile(textFile, 'not an image');
  const refusedFile = await clipboard.stageClipboardFile({ workspaceDir: dir, filePath: textFile });
  assert.equal(refusedFile.ok, false);
  assert.match(refusedFile.reason, /not a PNG\/JPEG\/GIF\/WebP image/);
  const missingFile = await clipboard.stageClipboardFile({
    workspaceDir: dir,
    filePath: path.join(dir, 'gone.png'),
  });
  assert.equal(missingFile.ok, false);
  assert.match(missingFile.reason, /does not exist/);
  ok('an existing image file is attached, a non-image and a missing file are refused');

  // ── 4. Unsupported platforms explain themselves ────────────────────────

  const unsupported = await clipboard.captureClipboardAttachment({
    workspaceDir: dir,
    platform: 'aix',
  });
  assert.equal(unsupported.kind, 'unsupported');
  assert.match(unsupported.reason, /not implemented on aix/);
  ok('an unsupported platform reports why instead of doing nothing');

  // ── 5. Real clipboard round-trip (opt-in: it overwrites the clipboard) ──

  if (process.env.MOSS_VERIFY_CLIPBOARD === '1' && process.platform === 'darwin') {
    const pngPath = path.join(dir, 'real.png');
    await fsp.writeFile(pngPath, PNG_1X1);
    const setImage = await runProcess(
      'osascript',
      ['-e', `set the clipboard to (read (POSIX file "${pngPath}") as «class PNGf»)`],
      { cwd: dir, timeoutMs: 15_000 }
    );
    assert.equal(setImage.status, 0, `osascript failed: ${setImage.stderr}`);
    const imageCapture = await clipboard.captureClipboardAttachment({ workspaceDir: dir });
    assert.equal(imageCapture.kind, 'image');
    assert.equal(imageCapture.bytes, PNG_1X1.length);
    const stagedBytes = await fsp.readFile(imageCapture.absolutePath);
    assert.equal(stagedBytes.subarray(1, 4).toString('ascii'), 'PNG');
    ok('a real macOS clipboard image is captured and staged');

    // Finder "Copy" leaves a «class furl» file reference and no image/text.
    const finderSet = await runProcess(
      'osascript',
      ['-e', `set the clipboard to POSIX file "${pngPath}"`],
      { cwd: dir, timeoutMs: 15_000 }
    );
    assert.equal(finderSet.status, 0, `osascript failed: ${finderSet.stderr}`);
    const finderCapture = await clipboard.captureClipboardAttachment({ workspaceDir: dir });
    assert.equal(finderCapture.kind, 'image', JSON.stringify(finderCapture));
    assert.equal(finderCapture.bytes, PNG_1X1.length);
    assert.equal(finderCapture.mimeType, 'image/png');
    ok('a real Finder file copy is attached as an image, not reported as empty');

    await runProcess('osascript', ['-e', 'set the clipboard to "probe text"'], {
      cwd: dir,
      timeoutMs: 15_000,
    });
    const textCapture = await clipboard.captureClipboardAttachment({ workspaceDir: dir });
    assert.equal(textCapture.kind, 'text');
    assert.equal(textCapture.text, 'probe text');
    ok('a real macOS text clipboard is captured for insertion');
  } else {
    console.log(
      '[clipboard-paste] skip real clipboard round-trip (set MOSS_VERIFY_CLIPBOARD=1 on macOS)'
    );
  }
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log(`[clipboard-paste] PASS (${checks} checks)`);
