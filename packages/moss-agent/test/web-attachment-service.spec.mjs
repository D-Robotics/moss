#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MossWebAttachmentService } from '../dist/web-ui/web-attachment-service.js';

test('Web attachments use random server names and resolve bounded text and image prompt blocks', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss attachments 空格 '));
  const service = new MossWebAttachmentService({
    storageDir: path.join(tempDir, '.moss', 'web attachments'),
    workspaceDir: tempDir,
  });
  try {
    const text = await service.upload({
      filename: '../../notes.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('hello attachment').toString('base64'),
    });
    const image = await service.upload({
      filename: 'preview.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    });
    assert.equal(text.filename, 'notes.txt');
    assert.match(text.id, /^attachment-[0-9a-f-]+$/);
    assert.equal(text.downloadUrl, `/api/attachments/${text.id}`);
    const storedNames = await fs.readdir(path.join(tempDir, '.moss', 'web attachments'));
    assert.equal(
      storedNames.some((name) => name.includes('notes.txt')),
      false
    );

    assert.deepEqual(await service.resolveForPrompt([text.id, image.id]), [
      { type: 'text', text: '[Attachment: notes.txt]\nhello attachment' },
      {
        type: 'image',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        mimeType: 'image/png',
        filename: 'preview.png',
      },
    ]);
    await assert.rejects(
      service.upload({
        filename: 'payload.svg',
        mimeType: 'image/svg+xml',
        contentBase64: Buffer.from('<svg/>').toString('base64'),
      }),
      /unsupported attachment type/
    );
    await assert.rejects(service.resolveForPrompt(Array(9).fill(text.id)), /at most 8/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Generated artifact registration enforces real workspace containment before copying', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-artifacts-'));
  const workspace = path.join(tempDir, 'workspace');
  const outside = path.join(tempDir, 'outside.txt');
  await fs.mkdir(path.join(workspace, 'output'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'output', 'report.md'), '# report');
  await fs.writeFile(outside, 'outside');
  const service = new MossWebAttachmentService({
    storageDir: path.join(tempDir, 'attachments'),
    workspaceDir: workspace,
  });
  try {
    const artifact = await service.registerArtifact('output/report.md');
    assert.equal(artifact.kind, 'artifact');
    assert.equal((await service.read(artifact.id)).body.toString('utf8'), '# report');
    await assert.rejects(service.registerArtifact('../outside.txt'), /workspace/);
    await assert.rejects(service.registerArtifact(outside), /relative/);
    if (process.platform !== 'win32') {
      await fs.symlink(outside, path.join(workspace, 'output', 'escape.txt'));
      await assert.rejects(service.registerArtifact('output/escape.txt'), /workspace/);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
