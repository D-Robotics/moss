#!/usr/bin/env node
/**
 * `moss loop prune` retention probe (offline, real filesystem).
 *
 * Every `moss loop` run writes `.moss/loops/<runId>.jsonl` and nothing used to
 * delete them: an unattended loop accumulates hundreds and `moss loop list`
 * reads every ledger on each call. Prune keeps the newest N finished runs and
 * deletes older ledgers — but a run that is still alive must never be deleted,
 * because that would truncate the record a user is following.
 *
 * This probe writes real ledgers into a temp workspace and then prunes real
 * files, so the kept/deleted sets are observed on disk, not mocked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { pruneLoopRuns, renderLoopPruneLines, readLoopHistoryCommand, listLoopRuns } = await load(
  'dist/cli/loop-command.js'
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-prune] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loopprune-'));
const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const deadPid = 2_147_483_646;

function recordsFor(runId, at, { pid = deadPid, finished = true } = {}) {
  const records = [
    {
      type: 'start',
      runId,
      at,
      pid,
      until: 'true',
      maxAttempts: 1,
      prompt: 'reply ok',
    },
  ];
  if (finished) {
    records.push({
      type: 'attempt',
      runId,
      attempt: 1,
      at,
      durationMs: 3,
      sessionKey: `${runId}-attempt-1`,
      check: { exitCode: 0, durationMs: 1, stdout: 'ok', stderr: '' },
      passed: true,
    });
    records.push({
      type: 'summary',
      runId,
      at,
      passed: true,
      attempts: 1,
      maxAttempts: 1,
      maxDurationMs: 0,
      totalDurationMs: 3,
      reason: 'passed',
      until: 'true',
    });
  }
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/**
 * Fixtures (8 ledgers):
 *   run-5, run-4 … run-1: finished, newest → oldest (summary times)
 *   run-dead: no summary, dead pid (interrupted = finished for retention)
 *   run-legacy: attempts only, no start record (pre-B100 ledger)
 *   run-live: no summary, live pid (this process) and the oldest mtime, so it
 *             proves a running run survives even outside the --keep window.
 */
const workspaceWithRuns = async (name) => {
  const workspace = path.join(tmp, name);
  const loops = path.join(workspace, '.moss', 'loops');
  await fs.mkdir(loops, { recursive: true });
  const write = async (fileName, content, atMs) => {
    const file = path.join(loops, fileName);
    await fs.writeFile(file, content);
    await fs.utimes(file, new Date(atMs), new Date(atMs));
  };
  for (const index of [1, 2, 3, 4, 5]) {
    const offsetMs = -(600 - index * 100) * 1_000;
    await write(`run-${index}.jsonl`, recordsFor(`run-${index}`, iso(offsetMs)), now + offsetMs);
  }
  await write('run-dead.jsonl', recordsFor('run-dead', iso(-250_000)), now - 250_000);
  // Pre-B100 ledger: attempts only, no start record (interrupted, no pid).
  const legacy = [
    {
      type: 'attempt',
      runId: 'run-legacy',
      attempt: 1,
      at: iso(-600_000),
      durationMs: 3,
      sessionKey: 'run-legacy-attempt-1',
      check: { exitCode: 1, durationMs: 1, stdout: 'no', stderr: '' },
      passed: false,
    },
  ];
  await write(
    'run-legacy.jsonl',
    legacy.map((record) => JSON.stringify(record)).join('\n') + '\n',
    now - 600_000
  );
  await write(
    'run-live.jsonl',
    recordsFor('run-live', iso(-900_000), { pid: process.pid, finished: false }),
    now - 900_000
  );
  return { workspace, loops };
};

const exists = async (file) =>
  fs.stat(file).then(
    () => true,
    () => false
  );

// ── 1. Real prune: finished beyond --keep deleted, newest finished kept ────

const a = await workspaceWithRuns('a');
// run-live is not in the finished set; keep 2 => keep run-5 + run-4.
const pruned = pruneLoopRuns(a.workspace, { keep: 2 });
assert.equal(pruned.dryRun, false);
assert.equal(pruned.total, 8);
assert.equal(pruned.keptFinished, 2);
assert.equal(pruned.keptRunning, 1);
assert.deepEqual(
  pruned.removed.map((entry) => entry.runId),
  ['run-dead', 'run-3', 'run-2', 'run-1', 'run-legacy'],
  'finished runs beyond the keep window are removed, newest finished runs stay'
);
assert.ok(pruned.freedBytes > 0, 'freed byte count comes from the deleted files');
for (const name of ['run-dead', 'run-3', 'run-2', 'run-1', 'run-legacy']) {
  assert.equal(await exists(path.join(a.loops, `${name}.jsonl`)), false, `${name} deleted`);
}
for (const name of ['run-5', 'run-4', 'run-live']) {
  assert.equal(await exists(path.join(a.loops, `${name}.jsonl`)), true, `${name} kept`);
}
ok('deletes finished ledgers beyond --keep and keeps the newest N');

// ── 2. A running run is never deleted (even as the oldest ledger) ──────────

assert.equal(
  pruned.removed.some((entry) => entry.runId === 'run-live'),
  false
);
const survivors = listLoopRuns(a.workspace)
  .map((run) => run.runId)
  .sort();
assert.deepEqual(survivors, ['run-4', 'run-5', 'run-live']);
ok('never deletes a run whose pid is still alive');

// ── 3. --dry-run selects the same ledgers and deletes nothing ─────────────

const b = await workspaceWithRuns('b');
const dry = pruneLoopRuns(b.workspace, { keep: 1, dryRun: true });
assert.equal(dry.dryRun, true);
assert.equal(dry.removed.length, 6, 'keep 1 leaves run-5; everything else finished goes');
assert.ok(dry.freedBytes > 0, 'dry-run still reports reclaimable bytes');
for (const name of [
  'run-dead',
  'run-4',
  'run-3',
  'run-2',
  'run-1',
  'run-legacy',
  'run-5',
  'run-live',
]) {
  assert.equal(await exists(path.join(b.loops, `${name}.jsonl`)), true, `${name} untouched`);
}
const dryLines = renderLoopPruneLines(dry, { zh: false }).join('\n');
assert.match(dryLines, /would prune 6 of 8 run\(s\)/);
assert.match(dryLines, /nothing deleted/);
ok('--dry-run prints what it would delete and leaves every file in place');

// ── 4. --json emits the removed entries with sizes and status ─────────────

const captured = [];
const originalLog = console.log;
let jsonExit;
try {
  console.log = (...args) => captured.push(args.join(' '));
  jsonExit = await readLoopHistoryCommand(['prune', '--keep', '1', '--json'], {
    workspaceDir: b.workspace,
  });
} finally {
  console.log = originalLog;
}
assert.equal(jsonExit, 0);
const payload = JSON.parse(captured.join('\n'));
assert.ok(Array.isArray(payload));
assert.equal(payload.length, 6);
const shape = payload[0];
assert.deepEqual(Object.keys(shape).sort(), ['bytes', 'ledger', 'runId', 'startedAt', 'status']);
assert.equal(typeof shape.runId, 'string');
assert.match(shape.ledger, /^\.moss\/loops\/.+\.jsonl$/);
assert.equal(typeof shape.bytes, 'number');
assert.ok(['passed', 'failed', 'interrupted'].includes(shape.status));
assert.ok(Number.isFinite(Date.parse(shape.startedAt)), 'startedAt is an ISO timestamp');
assert.equal(await exists(path.join(b.loops, 'run-5.jsonl')), true);
assert.equal(await exists(path.join(b.loops, 'run-4.jsonl')), false);
ok('--json prints [{runId, ledger, bytes, status, startedAt}] and deletes for real');

// ── 5. Bad --keep is a usage error (exit 2), never a silent default ───────

for (const argv of [
  ['prune', '--keep', 'abc'],
  ['prune', '--keep', '0'],
  ['prune', '--keep'],
  ['prune', '--bogus'],
]) {
  const code = await readLoopHistoryCommand(argv, { workspaceDir: b.workspace });
  assert.equal(code, 2, `${argv.join(' ')} must exit 2`);
}
ok('bad --keep / unknown flags are usage errors with exit 2');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[loop-prune] ${checks}/5 checks passed`);
