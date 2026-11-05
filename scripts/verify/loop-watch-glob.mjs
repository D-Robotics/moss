#!/usr/bin/env node
/**
 * `moss loop --watch` glob + `--watch-recursive` probe (offline).
 *
 * B101 gave the loop one literal signal path: a file's size/mtime, or a
 * directory's direct children. Real unattended loops wait for artifacts that
 * are nested or pattern-defined (`build/**\/*.txt`, `out/<run>/report.json`),
 * and watching the whole directory wakes on any unrelated file. This locks the
 * pattern interpretation, the literal-compatibility guarantee, and the
 * "no match yet → first match wakes" behaviour without touching the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const {
  parseLoopArgs,
  watchSignature,
  waitForWatchChange,
  globToRegExp,
  hasGlobMeta,
  describeWatchState,
  watchTargetLabel,
} = await load('dist/cli/loop-command.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-watch-glob] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loopglob-'));
const write = async (relative, body) => {
  const absolute = path.join(tmp, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, body);
  return absolute;
};

// --- 1. parser ---------------------------------------------------------------
const defaults = parseLoopArgs(['--until', 'true', 'goal']);
assert.equal(defaults.watchRecursive, undefined);
const globSpace = parseLoopArgs(['--until', 'true', '--watch', 'build/**/*.txt', 'goal']);
assert.equal(globSpace.watch, 'build/**/*.txt');
assert.equal(hasGlobMeta(globSpace.watch), true);
const globEq = parseLoopArgs(['--until=true', '--watch=dist/*.js', '--watch-timeout=2s', 'goal']);
assert.equal(globEq.watch, 'dist/*.js');
assert.equal(globEq.watchTimeoutMs, 2_000);
const recursive = parseLoopArgs(['--until', 'true', '--watch', 'build', '--watch-recursive', 'g']);
assert.equal(recursive.watch, 'build');
assert.equal(recursive.watchRecursive, true);
assert.equal(hasGlobMeta('build/nested/artifact.tar'), false);
assert.throws(() => parseLoopArgs(['--until', 'true', '--watch-recursive', 'goal']));
assert.throws(() =>
  parseLoopArgs(['--until', 'true', '--watch', 'build/**', '--watch-recursive', 'goal'])
);
assert.throws(() => parseLoopArgs(['--until', 'true', '--watch', `${'a'.repeat(600)}*`, 'goal']));
ok('parser: glob --watch, --watch-recursive, and the bad combinations are rejected');

// --- 2. literal paths stay byte-identical to B101 ----------------------------
const literalFile = await write('signal.txt', 'first\n');
const literalBefore = await watchSignature(literalFile);
assert.match(literalBefore.signature, /^file:\d+:[\d.]+$/);
assert.equal(literalBefore.matches, undefined);
assert.equal(literalBefore.pattern, undefined);

const literalDir = path.join(tmp, 'literal');
await write('literal/top.txt', 'a');
await write('literal/deep/nested.txt', 'a');
const literalDirBefore = await watchSignature(literalDir);
assert.match(literalDirBefore.signature, /^dir:/);
assert.match(literalDirBefore.signature, /top\.txt/);
// Direct children only: a nested file rewrite is invisible to a literal dir.
await write('literal/deep/nested.txt', 'b'.repeat(50));
const literalDirAfter = await watchSignature(literalDir);
assert.equal(literalDirAfter.signature, literalDirBefore.signature);
ok('literal file/directory signatures are unchanged and stay direct-child only');

// --- 3. the glob compiler ---------------------------------------------------
const txt = globToRegExp('**/*.txt');
assert.equal(txt.test('root.txt'), true, '**/ matches zero directories');
assert.equal(txt.test('deep/inner/a.txt'), true);
assert.equal(txt.test('deep/inner/a.log'), false);
const zeroDepth = globToRegExp('build/**/*.txt');
assert.equal(zeroDepth.test('build/root.txt'), true, '**/ matches zero directories');
assert.equal(zeroDepth.test('build/deep/root.txt'), true);
assert.equal(zeroDepth.test('build/deep/root.log'), false);
assert.equal(zeroDepth.test('src/root.txt'), false, 'the literal prefix still applies');
const single = globToRegExp('logs/[ab]?.log');
assert.equal(single.test('logs/a1.log'), true);
assert.equal(single.test('logs/c1.log'), false);
assert.equal(single.test('logs/a12.log'), false);
const literalBrackets = globToRegExp('out/report(1).txt');
assert.equal(literalBrackets.test('out/report(1).txt'), true);
assert.equal(literalBrackets.test('out/report1.txt'), false, 'literal text is escaped, not regex');
ok('globToRegExp: * ? [abc] ** zero-depth, and escaped literals');

// --- 4. glob signature reacts, unrelated files do not wake ------------------
const buildDir = path.join(tmp, 'build');
const watched = path.join(buildDir, '**', '*.txt');
await write('build/root.txt', 'x');
await write('build/deep/artifact.txt', 'x');
const globBefore = await watchSignature(watched);
assert.equal(globBefore.matches, 2);
assert.match(globBefore.signature, /^glob:/);
assert.match(globBefore.signature, /:2:/);
assert.ok(globBefore.pattern.endsWith('build/**/*.txt'));
const repeat = await watchSignature(watched);
assert.equal(repeat.signature, globBefore.signature, 'signature is sorted and stable');

await write('build/deep/artifact.txt', 'x'.repeat(40));
const globAfter = await watchSignature(watched);
assert.notEqual(globAfter.signature, globBefore.signature);
assert.match(globAfter.signature, /artifact\.txt:/);

// A non-matching sibling (same tree) must not look like a change.
const quiet = waitForWatchChange(watched, { timeoutMs: 400, pollMs: 25 });
setTimeout(() => {
  write('build/deep/other.log', 'noise').catch(() => {});
}, 60);
const quietResult = await quiet;
assert.equal(quietResult.changed, false, 'an unrelated file does not wake the loop');
assert.ok(quietResult.waitedMs >= 400);
ok('a glob signature tracks nested size/mtime; an unrelated file does not wake it');

// --- 5. missing pattern: first match wakes ----------------------------------
const pending = path.join(tmp, 'out', '**', 'report.json');
const pendingBefore = await watchSignature(pending);
assert.equal(pendingBefore.exists, false);
assert.equal(pendingBefore.matches, 0);
assert.match(pendingBefore.signature, /:0:$/);
const wake = waitForWatchChange(pending, { timeoutMs: 5_000, pollMs: 25 });
setTimeout(() => {
  write('out/run-1/report.json', '{"ok":true}').catch(() => {});
}, 60);
const woken = await wake;
assert.equal(woken.changed, true);
assert.equal(woken.before.matches, 0);
assert.equal(woken.after.exists, true);
assert.equal(woken.after.matches, 1);
assert.ok(woken.waitedMs < 5_000, 'resolves as soon as the first match appears');
ok('a pattern with no match yet wakes on its first match');

// --- 6. --watch-recursive = <dir>/** ----------------------------------------
const recursiveBefore = await watchSignature(literalDir, { recursive: true });
assert.match(recursiveBefore.signature, /^glob:/);
assert.equal(
  recursiveBefore.matches,
  2,
  'depth 0 (top.txt) and depth 1 (deep/nested.txt) both match'
);
assert.match(recursiveBefore.signature, /deep\/nested\.txt:/);
assert.ok(
  describeWatchState(literalDir, recursiveBefore).endsWith('/** (2 files)'),
  describeWatchState(literalDir, recursiveBefore)
);

const deeper = waitForWatchChange(literalDir, { timeoutMs: 5_000, pollMs: 25, recursive: true });
setTimeout(() => {
  write('literal/deep/more/grand.txt', 'g').catch(() => {});
}, 60);
const deeperResult = await deeper;
assert.equal(deeperResult.changed, true);
assert.ok((deeperResult.after.matches ?? 0) >= 3);
// The literal (non-recursive) signature is still blind to that depth.
const stillLiteral = await watchSignature(literalDir);
assert.doesNotMatch(stillLiteral.signature, /grand\.txt/);
// The ledger/report label says what is actually watched.
assert.equal(watchTargetLabel('build', true), 'build/**');
assert.equal(watchTargetLabel('build/', true), 'build/**');
assert.equal(watchTargetLabel('build', false), 'build');
assert.equal(watchTargetLabel('build/**/*.txt', true), 'build/**/*.txt');
ok('--watch-recursive sees children at depth > 1 and names itself <dir>/**');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[loop-watch-glob] ${checks}/6 checks passed`);
