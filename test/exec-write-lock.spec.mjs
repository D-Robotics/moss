// O97: after the edit tools refuse a file (read scope or edit thrash), an
// exec that writes the same file is blocked by the loop guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createToolLoopGuardState,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
  formatToolLoopGuardMessage,
} from '../dist/core/tools/tool-loop-guard.js';

const PARTIAL =
  'Error: You only read a partial window of src/big.ts (1:5). Call read_file again without offset/limit (full file) before edit_file/multi_edit/apply_patch, so old_string can match anywhere in the file. The file is too large to attach here (130000 chars).';

async function workspace(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o97-lock-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src/big.ts'), 'x');
  return dir;
}

function locked(dir) {
  const s = createToolLoopGuardState({ workspaceDir: dir });
  recordToolLoopOutcome(s, 'edit_file', true, PARTIAL, { path: 'src/big.ts', old_string: 'a' });
  return s;
}

const exec = (s, command) => shouldShortCircuitToolCall(s, 'exec', { command });

test('read-scope refusal: shell writes to that file are blocked with 已拦截', async (t) => {
  const s = locked(await workspace(t));
  for (const command of [
    `node -e "require('fs').writeFileSync('src/big.ts','x')"`,
    `sed -i 's/a/b/' src/big.ts`,
    `printf x > ./src/big.ts`,
    `bash -c "cat p >> src/big.ts"`,
    `python3 -c "import m; m.go('src/big.ts')"`,
  ]) {
    const reason = exec(s, command);
    assert.match(reason ?? '', /shell write to edit-locked file src\/big\.ts/, command);
    const msg = formatToolLoopGuardMessage(reason, 'exec');
    assert.match(msg, /^已拦截/);
    assert.match(msg, /read_file on src\/big\.ts without offset\/limit/);
  }
});

test('after a refusal, reads and writes to other files are still allowed', async (t) => {
  const s = locked(await workspace(t));
  for (const command of [
    'cat src/big.ts',
    'grep -n foo src/big.ts 2>&1',
    'grep -n foo src/big.ts > /tmp/out.txt',
    `sed -i 's/a/b/' src/other.ts`,
    'echo x > src/other.ts',
    'python fix.py',
    'npm test',
  ]) {
    assert.equal(exec(s, command), null, command);
  }
});

test('full read_file unlocks; partial read does not', async (t) => {
  const s = locked(await workspace(t));
  recordToolLoopOutcome(s, 'read_file', false, '1\tx', { path: 'src/big.ts', offset: 1, limit: 5 });
  assert.ok(exec(s, 'echo y > src/big.ts'));
  recordToolLoopOutcome(s, 'read_file', false, '1\tx', { path: 'src/big.ts' });
  assert.equal(exec(s, 'echo y > src/big.ts'), null);
});

test('successful edit unlocks', async (t) => {
  const s = locked(await workspace(t));
  recordToolLoopOutcome(s, 'edit_file', false, 'Edited src/big.ts', { path: 'src/big.ts' });
  assert.equal(exec(s, 'echo y > src/big.ts'), null);
});

test('a new session (fresh guard state) does not inherit the lock', async (t) => {
  const dir = await workspace(t);
  locked(dir);
  const fresh = createToolLoopGuardState({ workspaceDir: dir });
  assert.equal(exec(fresh, 'echo y > src/big.ts'), null);
});

test('O128: refusal that attached the full file still locks until a real full read', async (t) => {
  const dir = await workspace(t);
  const s = createToolLoopGuardState({ workspaceDir: dir });
  recordToolLoopOutcome(s, 'edit_file', true, `${PARTIAL}\n[full file: src/big.ts]\n 1\tx`, {
    path: 'src/big.ts',
  });
  assert.match(exec(s, 'echo y > src/big.ts') ?? '', /shell write to edit-locked file/);
  recordToolLoopOutcome(s, 'read_file', false, 'x', { path: 'src/big.ts' });
  assert.equal(exec(s, 'echo y > src/big.ts'), null);
});

test('loop guard (edit thrash): edit tool and shell writes to that file blocked', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'src/Hot.ts'), 'x');
  const s = createToolLoopGuardState({ workspaceDir: dir });
  const input = { path: 'src/Hot.ts', old_string: 'nope', new_string: 'x' };
  for (let i = 0; i < 3; i++) {
    recordToolLoopOutcome(s, 'edit_file', true, 'Error: old_string not found', input);
  }
  assert.match(shouldShortCircuitToolCall(s, 'edit_file', input) ?? '', /edit thrash/);
  const reason = exec(s, `node -e "require('fs').writeFileSync('src/Hot.ts','x')"`);
  assert.match(reason ?? '', /shell write to edit-locked file src\/Hot\.ts/);
  assert.match(formatToolLoopGuardMessage(reason, 'exec'), /^已拦截/);
  assert.equal(exec(s, 'npm test'), null);
  assert.equal(exec(s, 'echo y > src/other.ts'), null);
});
