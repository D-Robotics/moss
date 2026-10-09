#!/usr/bin/env node
/**
 * Plan v3 P7: real terminals. The script skips each missing terminal on its
 * own (tmux, GNU screen, Terminal.app, iTerm2, VS Code). Windows Terminal and
 * the IME candidate window are manual — see docs/cli-parity/tui-real-terminals.md.
 *
 * Off unless MOSS_REAL_TERMINALS=1. GitHub's test matrix has tmux on Ubuntu
 * and GNU screen on macOS, and both fail the composer check there (no usable
 * screen/osascript permissions on macOS; Windows has neither). The Linux
 * real-terminal job installs the tools and sets the variable.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.MOSS_REAL_TERMINALS !== '1') {
  console.log(
    '[tui-real-terminals] skip: set MOSS_REAL_TERMINALS=1 to run tmux, GNU screen, and macOS terminal checks'
  );
} else {
  const python = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' });
  if (python.status !== 0) {
    console.log('[tui-real-terminals] skip: python3 is not available');
  } else {
    const result = spawnSync('python3', [path.join(root, 'scripts/tui-feel/real-terminals.py')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 600_000,
      env: isolatedCliEnv({
        overrides: { MOSS_REAL_TERMINALS: '1' },
      }),
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);
    assert.equal(result.status, 0, 'real-terminal checks failed (see report above)');
    console.log('[PASS] real-terminal script exited 0');
  }
}
