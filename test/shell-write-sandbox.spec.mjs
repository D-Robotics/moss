#!/usr/bin/env node
/**
 * Shell-write sandbox (v0.9 W1) — escape battery + zero-false-positive set.
 *
 * The escape battery locks every statically-detectable shell write technique
 * that historically bypassed the workspace-write boundary (the defect the
 * bench first day caught: `printf x > /abs/path` wrote anywhere while file
 * tools were confined). The negative set locks that ordinary in-workspace
 * work is not blocked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import {
  extractShellWriteTargets,
  findShellWriteEscape,
} from '../dist/safety/shell-write-sandbox.js';
import { execTool } from '../dist/tools/builtin.js';

const ws = mkdtempSync(join(os.tmpdir(), 'ws-'));
const outside = mkdtempSync(join(os.tmpdir(), 'canary-'));
function join(...p) {
  return path.join(...p);
}

// ─── extractor unit battery ──────────────────────────────────────────────────

test('extractor: redirection family', () => {
  assert.deepEqual(extractShellWriteTargets(`printf x > ${outside}/a.txt`), [`${outside}/a.txt`]);
  assert.deepEqual(extractShellWriteTargets(`echo x >> ${outside}/a.txt`), [`${outside}/a.txt`]);
  assert.deepEqual(extractShellWriteTargets(`cmd 2> ${outside}/err.txt`), [`${outside}/err.txt`]);
  assert.deepEqual(extractShellWriteTargets(`cmd &> ${outside}/all.txt`), [`${outside}/all.txt`]);
  assert.deepEqual(extractShellWriteTargets(`cmd <> ${outside}/rw.txt`), [`${outside}/rw.txt`]);
  assert.deepEqual(extractShellWriteTargets(`echo x > "${outside}/sp ace.txt"`), [
    `${outside}/sp ace.txt`,
  ]);
  // /dev/null is extracted as a target but allow-listed at the assert layer;
  // descriptor duplication (>&1) is never a target
  assert.deepEqual(extractShellWriteTargets('cmd > /dev/null 2>&1'), ['/dev/null']);
});

test('extractor: write-tool operands', () => {
  assert.ok(extractShellWriteTargets(`echo x | tee ${outside}/t.txt`).includes(`${outside}/t.txt`));
  assert.ok(extractShellWriteTargets(`tee -a ${outside}/t.txt`).includes(`${outside}/t.txt`));
  assert.ok(extractShellWriteTargets(`cp a ${outside}/c.txt`).includes(`${outside}/c.txt`));
  assert.ok(extractShellWriteTargets(`mv a ${outside}/m.txt`).includes(`${outside}/m.txt`));
  assert.ok(extractShellWriteTargets(`install a ${outside}/i.txt`).includes(`${outside}/i.txt`));
  assert.ok(
    extractShellWriteTargets(`dd of=${outside}/d.bin if=/dev/zero`).includes(`${outside}/d.bin`)
  );
  assert.ok(extractShellWriteTargets(`mkdir -p ${outside}/dir`).includes(`${outside}/dir`));
  assert.ok(extractShellWriteTargets(`rm ${outside}/file`).includes(`${outside}/file`));
  assert.ok(extractShellWriteTargets(`sed -i s/a/b/ ${outside}/f`).includes(`${outside}/f`));
  assert.ok(extractShellWriteTargets(`truncate -s 0 ${outside}/log`).includes(`${outside}/log`));
  // sed WITHOUT -i reads only
  assert.deepEqual(extractShellWriteTargets(`sed s/a/b/ ${outside}/f`), []);
});

test('extractor: windows drive-letter targets are not remote-ish', () => {
  const backslash = 'C:\\Users\\runner\\canary.txt';
  assert.ok(extractShellWriteTargets(`cp a ${backslash}`).includes(backslash));
  const mixed = 'c:/Temp/x/canary.txt';
  assert.ok(extractShellWriteTargets(`mv a ${mixed}`).includes(mixed));
  // true scp-style remotes stay out of scope
  assert.deepEqual(extractShellWriteTargets('rsync a host:/srv/x'), []);
});

// ─── escape battery via the probe (must all be BLOCKED) ─────────────────────

const escapes = [
  ['redirect >', `printf x > ${outside}/a.txt`],
  ['redirect >>', `echo x >> ${outside}/a.txt`],
  ['stderr 2>', `sh -c 'echo x' 2> ${outside}/e.txt`],
  ['both &>', `sh -c 'echo x' &> ${outside}/b.txt`],
  ['tee', `echo x | tee ${outside}/t.txt`],
  ['tee -a', `echo x | tee -a ${outside}/t.txt`],
  ['dd of=', `dd if=/dev/zero of=${outside}/d.bin bs=1 count=1`],
  ['cp out', `cp inside.txt ${outside}/c.txt`],
  ['mv out', `mv inside.txt ${outside}/m.txt`],
  ['install out', `install inside.txt ${outside}/i.txt`],
  ['rsync out', `rsync inside.txt ${outside}/r.txt`],
  ['mkdir out', `mkdir -p ${outside}/sub/dir`],
  ['rm out', `rm ${outside}/something.txt`],
  ['sed -i out', `sed -i s/a/b/ ${outside}/config.txt`],
  ['truncate out', `truncate -s 0 ${outside}/log.txt`],
  ['heredoc+redirect', `cat <<'EOF' > ${outside}/h.txt\nhello\nEOF`],
  ['process substitution', `echo x > >(tee ${outside}/ps.txt)`],
  ['env-var target', `echo x > $HOME/.moss-escape-canary`],
  ['chained after &&', `echo ok > inside-ok.txt && printf y > ${outside}/chain.txt`],
];

for (const [name, command] of escapes) {
  test(`escape blocked: ${name}`, async () => {
    const violation = await findShellWriteEscape(command, { cwd: ws, roots: [ws] });
    assert.ok(violation, `must be blocked: ${command}`);
  });
}

// ─── zero-false-positive set (must all be ALLOWED) ──────────────────────────

const benign = [
  ['plain read', 'ls -la'],
  ['abs read', `cat /etc/hostname`],
  ['pipe to grep', 'cat inside.txt | grep x'],
  ['relative write', 'echo hi > inside.txt'],
  ['abs write inside ws', `echo hi > ${ws}/abs-inside.txt`],
  ['dev/null', 'cmd > /dev/null 2>&1'],
  ['stderr to stdout', 'npm test 2>&1 | tail -5'],
  ['tee inside', 'echo x | tee inside-tee.txt'],
  ['cp inside ws', 'cp a.txt b.txt'],
  ['mkdir inside', 'mkdir build'],
  ['sed -i inside', 'sed -i s/a/b/ local.txt'],
  ['rm inside', 'rm local.txt'],
];

for (const [name, command] of benign) {
  test(`benign allowed: ${name}`, async () => {
    const violation = await findShellWriteEscape(command, { cwd: ws, roots: [ws] });
    assert.equal(violation, null, `must be allowed: ${command}`);
  });
}

// ─── symlink pivot: write through an in-workspace symlink pointing outside ──

test('symlink pivot blocked by realpath defense', async () => {
  const link = path.join(ws, 'pivot-link');
  try {
    fs.symlinkSync(outside, link);
    const violation = await findShellWriteEscape(`echo x > ${link}/file.txt`, {
      cwd: ws,
      roots: [ws],
    });
    assert.ok(violation, 'writing through a symlink that escapes must be blocked');
  } finally {
    fs.rmSync(link, { force: true });
  }
});

// ─── integration through the real exec tool ──────────────────────────────────

const ctx = {
  workspaceDir: ws,
  runId: 't',
  sessionKey: 't',
  abortSignal: new AbortController().signal,
  execWriteRoots: [ws],
};

test('exec tool: blocked escape leaves no canary file', async () => {
  const canary = path.join(outside, 'exec-canary.txt');
  const out = await execTool.execute({ command: `printf pwned > ${canary}` }, ctx);
  assert.match(String(out), /Command blocked: shell write escapes/, 'blocked message');
  assert.equal(existsSync(canary), false, 'no file created outside the workspace');
});

test('exec tool: in-workspace write executes normally', async () => {
  const inside = path.join(ws, 'inside-real.txt');
  const out = await execTool.execute({ command: `printf ok > ${inside}` }, ctx);
  assert.doesNotMatch(String(out), /Command blocked/, 'not blocked');
  assert.equal(fs.readFileSync(inside, 'utf8'), 'ok', 'file written');
});

test('exec tool: unconstrained when execWriteRoots is unset (full-access hosts)', async () => {
  const freeCtx = { ...ctx };
  delete freeCtx.execWriteRoots;
  const target = path.join(outside, 'free-write.txt');
  const out = await execTool.execute({ command: `printf free > ${target}` }, freeCtx);
  assert.doesNotMatch(String(out), /Command blocked/, 'full-access leaves shell unconstrained');
  assert.equal(existsSync(target), true, 'write happened');
  fs.rmSync(target, { force: true });
});

// cleanup
test('cleanup fixtures', () => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

console.log('[PASS] shell-write sandbox escape suite');
