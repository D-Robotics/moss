#!/usr/bin/env node
/**
 * Plan v3 P7: moss inside a private tmux server (mouse off → inline, mouse on →
 * fullscreen) and GNU screen (inline). Skips when tmux, screen, or dist/cli.js
 * is missing. Does not start iTerm2, Terminal.app, VS Code, or Windows Terminal.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `screen -v` prints its version and exits 1, so presence is `which`, not status.
const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' });
const screen = spawnSync('which', ['screen'], { encoding: 'utf8' });
if (tmux.status !== 0 || screen.status !== 0) {
  console.log('[tui-real-terminals] skip: tmux or screen is not available');
} else {
  const result = spawnSync('python3', [path.join(root, 'scripts/tui-feel/real-terminals.py')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  assert.equal(result.status, 0, 'real-terminal checks failed (see report above)');
  console.log('[PASS] tmux (mouse on/off) and GNU screen show the composer and the answer');
}
