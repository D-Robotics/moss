// O97 follow-up (QA review of #92, §3 suspected 1 + 2):
//   O97a: ln / touch / rm / shred are detected as shell writes and gated on
//         protected paths (code already handled them; these lock it in).
//   O97b: project .moss/config.json is a credential file — the partial-read
//         recovery must not attach its content, size, or first line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  detectShellWriteTargets,
  canonicalPath,
  findProtectedWrite,
} from '../dist/safety/shell-write-detect.js';
import { findProtectedPathHits } from '../dist/safety/protected-paths.js';
import { readFileTool, editFileTool } from '../dist/tools/file-tools.js';

// ─── O97a: detector + locked-file guard ─────────────────────────────────────

const CWD = '/w/proj';
const T = path.join(CWD, 'src/big.ts');

const VERBS = [
  ['ln -s', 'ln -s /tmp/x src/big.ts'],
  ['ln -sf', 'ln -sf /tmp/x src/big.ts'],
  ['touch', 'touch src/big.ts'],
  ['touch -c', 'touch -c src/big.ts'],
  ['rm', 'rm src/big.ts'],
  ['rm -f', 'rm -f src/big.ts'],
  ['shred', 'shred src/big.ts'],
  ['shred -u', 'shred -u src/big.ts'],
];

for (const [name, cmd] of VERBS) {
  test(`O97a detects write: ${name}`, () => {
    const { targets } = detectShellWriteTargets(cmd, CWD);
    assert.ok(targets.includes(T), `${cmd} -> ${JSON.stringify(targets)}`);
  });
  test(`O97a locked file blocks: ${name}`, () => {
    const locked = [canonicalPath(T)];
    assert.equal(findProtectedWrite(cmd, CWD, locked), locked[0], cmd);
  });
}

test('O97a same verbs on a different file are not blocked', () => {
  const locked = [canonicalPath(T)];
  for (const cmd of ['ln -s /tmp/x src/o.ts', 'touch src/o.ts', 'rm src/o.ts', 'shred src/o.ts']) {
    assert.equal(findProtectedWrite(cmd, CWD, locked), null, cmd);
  }
});

// ─── O97a: protected-path gate (O94) for the four verbs ─────────────────────

test('O97a ln/touch/rm/shred on protected paths produce a protected hit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o97a-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, '.moss'), { recursive: true });
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  const ctx = { cwd: ws, home, workspaceRoot: ws, env: { HOME: home } };
  const hits = (command) => findProtectedPathHits('exec', { command }, ctx, false);

  const cases = [
    ['ln -s /tmp/x .git/config', 'git', 'write'],
    ['ln -sf /tmp/k ~/.ssh/authorized_keys', 'ssh', 'write'],
    ['touch .git/hooks/pre-commit', 'git', 'write'],
    ['touch ~/.bashrc', 'shell-rc', 'write'],
    ['rm .env', 'env', 'delete'],
    ['rm -f .moss/config.json', 'moss-config', 'delete'],
    ['shred -u .moss/config.json', 'moss-config', 'delete'],
    ['shred ~/.ssh/id_rsa', 'ssh', 'delete'],
  ];
  for (const [command, category, operation] of cases) {
    const h = hits(command);
    assert.ok(h.length > 0, `${command} must hit a protected path`);
    assert.equal(h[0].category, category, command);
    assert.equal(h[0].operation, operation, command);
  }
  for (const command of ['ln -s a b', 'touch notes.txt', 'rm src/a.ts', 'shred tmp.bin']) {
    assert.deepEqual(hits(command), [], `${command} is not protected`);
  }
});

// ─── O97b: .moss/config.json partial-read recovery does not leak ────────────

test('O97b partial read of .moss/config.json then edit: no secret, size, or first line', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o97b-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.moss'));
  const secret = 'o97b-DISTINCTIVE-secret-9f8e7d6c5b4a';
  await fs.writeFile(
    path.join(dir, '.moss', 'config.json'),
    `{\n  "apiKey": "${secret}",\n  "model": "m1"\n}\n`
  );
  const ctx = { workspaceDir: dir, sessionKey: 'o97b', abortSignal: new AbortController().signal };
  const rel = '.moss/config.json';
  await readFileTool.execute({ path: rel, offset: 3, limit: 1 }, ctx);
  const step = { path: rel, old_string: '"m1"', new_string: '"m2"' };
  const out = await editFileTool.execute(step, ctx);
  assert.match(out, /partial window/);
  assert.match(out, /not attached for credential files/);
  assert.doesNotMatch(out, /\[full file:/);
  assert.ok(!out.includes(secret), 'secret must not be attached');
  assert.doesNotMatch(out, /apiKey|"model"|^\s*\{/m);
  assert.doesNotMatch(out, /\d+\s*(?:chars|bytes|lines)/i);
  assert.doesNotMatch(out, /\[lines /);
  // Still locked: refusal did not count as a full read.
  assert.match(await editFileTool.execute(step, ctx), /partial window/);
  const disk = await fs.readFile(path.join(dir, '.moss', 'config.json'), 'utf8');
  assert.ok(disk.includes('"m1"'), 'file unchanged');
});
