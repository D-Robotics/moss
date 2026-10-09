#!/usr/bin/env node
/**
 * Screen-level TUI layout gate (plan v3 P0): runs scripts/tui-feel/assert-layout.py,
 * which drives dist/cli.js in a PTY through pyte and asserts the cursor, bottom
 * edge, jump-row budget, streaming stability and the MOSS_TUI_DEBUG frame
 * invariant. Missing pyte fails the run (install hint on stderr) unless
 * MOSS_SKIP_PY_LAYOUT=1.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';
import { requirePyLayout } from './helpers/require-pyte.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (requirePyLayout('tui-screen-layout')) {
  const result = spawnSync('python3', [path.join(root, 'scripts/tui-feel/assert-layout.py')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
    // Keep Python's HOME so user-site pyte remains importable; screen.py gives
    // the Moss child its own HOME/config.
    env: isolatedCliEnv({ isolateHome: false }),
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  assert.equal(result.status, 0, 'screen layout assertions failed (see report above)');
  console.log(
    '[PASS] TUI screen layout (cursor, bottom edge, jump budget, scroll, frame invariant)'
  );
}
