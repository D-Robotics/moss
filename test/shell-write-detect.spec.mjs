// O97: standalone shell-write detection (reused by O94).
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

const CWD = path.resolve('/w/proj');
const T = path.join(CWD, 'src/big.ts');
const targets = (cmd) => detectShellWriteTargets(cmd, CWD).targets;

const BLOCKED = [
  ['> redirect', `printf x > src/big.ts`],
  ['>> append', `cat p >> src/big.ts`],
  ['>| clobber', `echo x >| src/big.ts`],
  ['&> redirect', `make &> src/big.ts`],
  ['2> fd redirect', `make 2> src/big.ts`],
  ['heredoc to file', `cat <<'EOF' > src/big.ts\nconst a = 1;\nEOF`],
  ['tee', `echo x | tee -a src/big.ts`],
  ['dd of=', `dd if=/tmp/x of=src/big.ts bs=1`],
  ['install', `install -m 644 /tmp/x src/big.ts`],
  ['rsync', `rsync -a /tmp/x src/big.ts`],
  ['cp into dir', `cp /tmp/big.ts src/`],
  ['mv', `mv /tmp/x src/big.ts`],
  ['sed -i', `sed -i 's/a/b/' src/big.ts`],
  ['sed -i.bak -e', `sed -i.bak -e 's/a/b/' src/big.ts`],
  ['perl -pi -e', `perl -pi -e 's/a/b/' src/big.ts`],
  ['awk -i inplace', `awk -i inplace '{print}' src/big.ts`],
  ['truncate', `truncate -s 0 src/big.ts`],
  ['git checkout --', `git checkout -- src/big.ts`],
  ['bash -c nested', `bash -c "sed -i 's/a/b/' src/big.ts"`],
  ['sh -c nested twice', `sh -c 'bash -c "echo x > src/big.ts"'`],
  ['eval', `eval "echo x > src/big.ts"`],
  ['double-quoted path', `echo x > "src/big.ts"`],
  ['single-quoted path', `sed -i 's/a/b/' 'src/big.ts'`],
  ['./ prefix', `echo x > ./src/big.ts`],
  ['absolute path', `echo x > /w/proj/src/big.ts`],
  ['parent-relative', `cd src && echo x > ../src/big.ts`],
  ['node -e writeFileSync', `node -e "require('fs').writeFileSync('src/big.ts','x')"`],
  ['python -c open w', `python3 -c "open('src/big.ts','w').write('x')"`],
];

for (const [name, cmd] of BLOCKED) {
  test(`detects write: ${name}`, () => {
    assert.ok(targets(cmd).includes(T), `${cmd} -> ${JSON.stringify(targets(cmd))}`);
  });
}

test('read-only and fd-dup forms are not writes', () => {
  for (const cmd of [
    'cat src/big.ts',
    'grep -n foo src/big.ts 2>&1',
    'grep -n foo src/big.ts > /dev/null',
    `sed -n '1,5p' src/big.ts`,
    `awk '{print}' src/big.ts`,
    'cat <<EOF\nsrc/big.ts > nothing\nEOF',
    'git diff -- src/big.ts',
  ]) {
    assert.ok(!targets(cmd).includes(T), cmd);
  }
});

test('uncertain flag: inline code, script files, substitution, git apply', () => {
  const u = (c) => detectShellWriteTargets(c, CWD).uncertain;
  assert.equal(u('python fix.py'), true);
  assert.equal(u(`node -e "console.log(1)"`), true);
  assert.equal(u('git apply p.diff'), true);
  assert.equal(u('echo $(cat x)'), true);
  assert.equal(u('npm test'), false);
  assert.equal(u('sed -i s/a/b/ src/big.ts'), false);
});

test('findProtectedWrite: uncertain AND mentions the locked file -> block', () => {
  const locked = [canonicalPath(T)];
  // Write API not visible statically, but the file is named in inline code.
  assert.equal(
    findProtectedWrite(`python3 -c "import m; m.go('src/big.ts')"`, CWD, locked),
    canonicalPath(T, false)
  );
  assert.equal(
    findProtectedWrite(`eval "$(gen) src/big.ts"`, CWD, locked),
    canonicalPath(T, false)
  );
  assert.equal(
    findProtectedWrite(`node -e "x('./src/big.ts')"`, CWD, locked),
    canonicalPath(T, false)
  );
});

test('findProtectedWrite: uncertain without mention -> allowed (documented limit)', () => {
  const locked = [canonicalPath(T)];
  assert.equal(findProtectedWrite('python fix.py', CWD, locked), null);
  assert.equal(findProtectedWrite(`node -e "x('src/other.ts')"`, CWD, locked), null);
});

test('findProtectedWrite: certain read of the locked file is allowed', () => {
  const locked = [canonicalPath(T)];
  assert.equal(findProtectedWrite('cat src/big.ts', CWD, locked), null);
  assert.equal(findProtectedWrite('sed -i s/a/b/ src/other.ts', CWD, locked), null);
});

test('symlink pointing at the locked file is matched via realpath', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moss-swd-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'locked.ts'), 'x');
  await fs.symlink(path.join(dir, 'locked.ts'), path.join(dir, 'alias.ts'));
  const lockedFile = path.join(dir, 'locked.ts');
  const locked = [canonicalPath(lockedFile)];
  assert.equal(
    findProtectedWrite('echo y > alias.ts', dir, locked),
    canonicalPath(lockedFile, false)
  );
});

// Regression (red main 2026-10-12, macos CI): findProtectedWrite used to
// return the case-folded lock key, so guard messages relativised a
// lower-cased path against the real-case workspace and showed garbage like
// `../../t/moss-o97-lock-x/src/big.ts`. It must return the case-preserving
// canonical path of the command's own target.
test('findProtectedWrite returns a case-preserving path even when the lock key folds', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moss-swd-case-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'MixedCase.ts');
  await fs.writeFile(file, 'x');
  const locked = [canonicalPath(file)];
  const hit = findProtectedWrite(`node -e "x('${file.replace(/\\/g, '/')}')"`, dir, locked);
  assert.ok(hit, 'expected a protected-write hit');
  assert.equal(hit, canonicalPath(file, false));
  assert.ok(hit === file || hit.endsWith(path.sep + 'MixedCase.ts'), `hit=${hit}`);
});

test('canonicalPath: case-insensitive mode lower-cases; non-existent paths resolve', () => {
  assert.equal(
    canonicalPath('/no/such/Dir/A.ts', true),
    path.resolve('/no/such/Dir/A.ts').toLowerCase()
  );
  assert.equal(canonicalPath('/no/such/Dir/A.ts', false), path.resolve('/no/such/Dir/A.ts'));
});
