#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listWorkspaceDirectory, readWorkspaceFile } from '../dist/web-ui/web-workspace-browser.js';

test('workspace browser is read-only, bounded, and rejects escapes and secrets', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-web-workspace-'));
  const root = path.join(parent, 'workspace');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=hidden\n');
  await fs.writeFile(path.join(parent, 'outside.txt'), 'outside\n');
  try {
    const tree = await listWorkspaceDirectory(root);
    assert.deepEqual(
      tree.entries.map((entry) => entry.name),
      ['src']
    );
    assert.deepEqual(await readWorkspaceFile(root, 'src/app.ts'), {
      path: 'src/app.ts',
      content: 'export const value = 1;\n',
      size: 24,
    });
    await assert.rejects(() => readWorkspaceFile(root, '.env'), /excluded/);
    await assert.rejects(() => readWorkspaceFile(root, '.git/config'), /excluded/);
    await assert.rejects(() => readWorkspaceFile(root, '../outside.txt'), /escapes/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
