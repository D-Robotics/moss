#!/usr/bin/env node
/**
 * Deterministic probe for the tool-output spill path (backlog B09).
 *
 * Truncation keeps head+tail to protect the context window, so the elided middle
 * used to be unrecoverable for every tool except exec. Now a truncated result of
 * any tool is spilled to `.moss/runtime/tool-output/` and the model is pointed at
 * the file; tools that wrote their own spill are left alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const spill = await import(
  pathToFileURL(path.join(root, 'dist/context/tool-output-spill.js')).href
);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[tool-output-spill] ok ${name}`);
}

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moss-spill-'));
// The runtime .gitignore is only written inside a git work tree (workspace rule).
const git = await runProcess('git', ['init', '-q'], { cwd: dir });
assert.equal(git.status, 0, 'git init for the runtime ignore check');
try {
  // ── 1. A large result gets a file and a pointer ─────────────────────────

  const lines = [];
  for (let i = 0; i < 12_000; i += 1) lines.push(`line ${i}: boot log entry for the robot`);
  const big = lines.join('\n');
  const recovered = spill.truncateWithRecoveryPath({
    toolName: 'read_file',
    input: { path: 'boot.log' },
    text: big,
    workspaceDir: dir,
  });
  assert.ok(recovered.length < big.length, 'the context copy must be truncated');
  const pointer = recovered.match(/\[full output saved to (\S+) —/);
  assert.ok(pointer, 'truncated result must name the recovery file');
  const recoveryPath = path.join(dir, pointer[1]);
  assert.ok(fs.existsSync(recoveryPath), 'the recovery file must exist');
  const written = fs.readFileSync(recoveryPath, 'utf8');
  assert.equal(written, big, 'the recovery file holds the full presented text');
  assert.ok(written.includes('line 6000'), 'the elided middle is readable from the file');
  assert.match(recovered, /the middle of this result was elided/);
  ok('a truncated read_file result keeps its full copy on disk and points at it');

  // ── 2. The runtime directory is gitignored ─────────────────────────────

  assert.ok(fs.existsSync(path.join(dir, '.moss', '.gitignore')));
  assert.match(fs.readFileSync(path.join(dir, '.moss', '.gitignore'), 'utf8'), /runtime/);
  ok('the spill directory carries a runtime .gitignore');

  // ── 3. A small result is untouched (no file, same string) ──────────────

  const small = 'ok';
  const untouched = spill.truncateWithRecoveryPath({
    toolName: 'read_file',
    input: { path: 'ok.txt' },
    text: small,
    workspaceDir: dir,
  });
  assert.equal(untouched, small);
  ok('short results are returned unchanged, so ordinary turns write no spill');

  // ── 4. A tool that spilled already is not spilled twice ─────────────────

  const already = `${big.slice(0, 20_000)}\n\n[full output saved to .moss/runtime/tool-output/exec-1.txt ...]`;
  const secondPass = spill.truncateWithRecoveryPath({
    toolName: 'exec',
    input: { command: 'dmesg' },
    text: already,
    workspaceDir: dir,
  });
  assert.doesNotMatch(secondPass, /full output saved to (?!\.moss\/runtime\/tool-output\/exec-1)/);
  const count = (secondPass.match(/full output saved to/g) ?? []).length;
  assert.equal(count, 1, 'the exec pointer is not duplicated');
  ok('a tool that already spilled is left alone');

  // ── 5. No workspace → plain truncation, never a write ──────────────────

  const noWorkspace = spill.truncateWithRecoveryPath({
    toolName: 'read_file',
    input: { path: 'boot.log' },
    text: big,
    workspaceDir: undefined,
  });
  assert.ok(noWorkspace.length < big.length);
  assert.doesNotMatch(noWorkspace, /full output saved to/);
  ok('without a workspace the result is truncated but no recovery path is promised');

  // ── 6. Oversized spills are refused instead of half-written ────────────

  const huge = 'x'.repeat(spill.SPILL_MAX_BYTES + 1024);
  assert.equal(
    spill.spillToolOutput({ workspaceDir: dir, toolName: 'read_file', text: huge }),
    null
  );
  ok('a spill over the size cap returns null instead of writing a partial file');

  // ── 7. Stale spills are pruned on write ────────────────────────────────

  const spillDir = path.join(dir, '.moss', 'runtime', 'tool-output');
  const stalePath = path.join(spillDir, 'stale.txt');
  fs.writeFileSync(stalePath, 'old');
  const old = Date.now() - spill.SPILL_RETENTION_MS - 60_000;
  fs.utimesSync(stalePath, old / 1000, old / 1000);
  spill.spillToolOutput({ workspaceDir: dir, toolName: 'read_file', text: 'fresh copy' });
  assert.equal(fs.existsSync(stalePath), false, 'spills older than the retention window go away');
  ok('stale spill files are pruned so the directory cannot grow without bound');
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log(`[tool-output-spill] PASS (${checks} checks)`);
