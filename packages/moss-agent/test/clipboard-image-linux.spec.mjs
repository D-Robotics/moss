#!/usr/bin/env node
/**
 * Linux/Windows clipboard attachment paths (Codex-style Ctrl+V parity).
 * Inject saveClipboardImage / readClipboardPaths so tests don't need a real display.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareClipboardAttachment } from '../dist/cli/clipboard-image.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-clip-img-'));
  try {
    const prepared = await prepareClipboardAttachment({
      runtimeDir,
      cwd: runtimeDir,
      saveClipboardImage: async (dest) => {
        fs.writeFileSync(dest, PNG_1X1);
      },
      readClipboardPaths: async () => [],
    });
    assert.equal(prepared.attachments.length, 1);
    assert.equal(prepared.attachments[0].kind, 'image');
    assert.equal(prepared.blocks.some((b) => b.type === 'image'), true);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-clip-path-'));
  const sample = path.join(runtimeDir, 'note.txt');
  fs.writeFileSync(sample, 'hello attachment\n');
  try {
    const prepared = await prepareClipboardAttachment({
      runtimeDir,
      cwd: runtimeDir,
      saveClipboardImage: async () => {
        throw new Error('no image');
      },
      readClipboardPaths: async () => [sample],
    });
    assert.equal(prepared.attachments.length, 1);
    assert.equal(prepared.attachments[0].kind, 'file');
    assert.match(prepared.blocks.map((b) => ('text' in b ? b.text : '')).join('\n'), /hello attachment/);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

console.log('[PASS] clipboard-image cross-platform prepare paths');
