// O130 UX false-positive control: 10 everyday Linux/macOS commands carrying `$`
// in arguments / reads (never in a write target that cannot be resolved) must
// produce exactly the same number of protected-path prompts as before O130:
// zero. Recorded against main 1705d9ef with the same ctx (see PR body).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findShellProtectedWrites } from '../dist/safety/protected-paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o130c-'));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const cfg = path.join(home, '.config', 'moss');
for (const d of [cfg, path.join(ws, 'src')]) fs.mkdirSync(d, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const env = { HOME: home, USER: 'dev', SHELL: '/bin/bash', PATH: '/usr/bin:/bin' };
const ctx = { cwd: ws, workspaceRoot: ws, configDirs: [cfg], env, home };

export const CONTROL = [
  'echo $HOME',
  'ls $PWD',
  'export PATH=$PATH:/opt/bin',
  'echo "$USER" > whoami.txt',
  'grep -rn "$PATTERN" src',
  'for f in src/*.ts; do wc -l $f; done',
  'cd $HOME && ls',
  'cat $HOME/.bashrc',
  'printf \'%s\\n\' "$SHELL" >> out.log',
  'echo $((1 + 2)) > calc.txt',
];

test('O130 control: 10 `$` commands → 0 prompts (unchanged vs main)', () => {
  const counts = CONTROL.map((c) => findShellProtectedWrites(c, ctx).length);
  assert.equal(CONTROL.length, 10);
  assert.deepEqual(
    counts,
    Array(10).fill(0),
    JSON.stringify(Object.fromEntries(CONTROL.map((c, i) => [c, counts[i]])))
  );
});
