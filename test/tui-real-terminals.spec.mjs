#!/usr/bin/env node
/**
 * Plan v3 P7: real terminals. The script skips each missing terminal on its
 * own (tmux, GNU screen, Terminal.app, iTerm2, VS Code). Windows Terminal and
 * the IME candidate window are manual — see docs/cli-parity/tui-real-terminals.md.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' });
if (python.status !== 0) {
  console.log('[tui-real-terminals] skip: python3 is not available');
} else {
  const result = spawnSync('python3', [path.join(root, 'scripts/tui-feel/real-terminals.py')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  assert.equal(result.status, 0, 'real-terminal checks failed (see report above)');
  console.log('[PASS] real-terminal script exited 0');
}
