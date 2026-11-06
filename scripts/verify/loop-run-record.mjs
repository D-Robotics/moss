#!/usr/bin/env node
/**
 * Loop run-record mapping probe (offline, B132).
 *
 * `moss loop` is an autonomous run, so it must appear in the unified ledger with
 * the same status vocabulary: passed -> completed, a check that never passes ->
 * verify_failed, and a hung/silent external signal -> incomplete (the loop
 * stopped without burning attempts, which is not a failed repair).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { buildLoopRunRecord } = await load('dist/cli/loop-run-record.js');
const { writeRunRecord, listRunRecords, readRunRecord } = await load('dist/core/run-ledger.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-run-record] ok ${name}`);
};

const base = {
  runId: 'loop_abc',
  passed: true,
  reason: 'passed',
  attempts: 1,
  prompt: 'fix the thing',
  startedAt: 1_000,
  endedAt: 6_000,
  until: 'npm test',
  lastCheckExitCode: 0,
  ledgerPath: '.moss/loops/loop_abc.jsonl',
};

// 1. A passing loop is completed: exit 0, no reason/next, artifacts kept.
{
  const record = buildLoopRunRecord(base);
  assert.equal(record.kind, 'loop');
  assert.equal(record.status, 'completed');
  assert.equal(record.exitCode, 0);
  assert.equal(record.reason, undefined);
  assert.equal(record.next, undefined);
  assert.equal(record.durationMs, 5_000);
  assert.equal(record.artifacts.loopLedger, '.moss/loops/loop_abc.jsonl');
  ok('a passing loop is completed with its ledger path and no failure fields');
}

// 2. Attempts exhausted is a real failed verification, with the exit code.
{
  const record = buildLoopRunRecord({
    ...base,
    passed: false,
    reason: 'attempts_exhausted',
    attempts: 3,
    lastCheckExitCode: 1,
  });
  assert.equal(record.status, 'verify_failed');
  assert.equal(record.exitCode, 1);
  assert.match(record.reason, /`npm test` still exited 1 after 3 attempt\(s\)/);
  assert.equal(record.next, 'moss loop show loop_abc');
  ok('exhausted attempts read as verify_failed with the check exit code and next command');
}

// 3. Wall-clock budget exhaustion is also verify_failed.
{
  const record = buildLoopRunRecord({
    ...base,
    passed: false,
    reason: 'budget_exhausted',
    attempts: 2,
  });
  assert.equal(record.status, 'verify_failed');
  assert.match(record.reason, /wall-clock budget exhausted after 2 attempt\(s\)/);
  ok('a wall-clock budget stop is verify_failed, not a pass');
}

// 4. A hung check or a silent watch is incomplete, not a failure.
for (const reason of ['check_timeout', 'watch_timeout']) {
  const record = buildLoopRunRecord({ ...base, passed: false, reason, attempts: 1 });
  assert.equal(record.status, 'incomplete', reason);
  assert.equal(record.exitCode, 1);
  assert.match(record.reason, /hung|--watch-timeout/);
  ok(`\`${reason}\` is incomplete (stopped, no attempts burned) with an explanatory reason`);
}

// 5. The record round-trips through the real ledger and lists beside task runs.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loop-run-'));
  const ws = path.join(tmp, 'ws');
  await fs.mkdir(ws, { recursive: true });
  try {
    await writeRunRecord(ws, { ...buildLoopRunRecord(base), runId: 'loop_old' });
    await writeRunRecord(
      ws,
      buildLoopRunRecord({
        ...base,
        runId: 'loop_new',
        passed: false,
        reason: 'check_timeout',
        startedAt: 9_000,
        endedAt: 10_000,
      })
    );
    const records = await listRunRecords(ws);
    assert.deepEqual(
      records.map((record) => [record.runId, record.kind, record.status]),
      [
        ['loop_new', 'loop', 'incomplete'],
        ['loop_old', 'loop', 'completed'],
      ]
    );
    assert.equal((await readRunRecord(ws, 'loop_new'))?.status, 'incomplete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  ok('loop records round-trip through .moss/runs and list newest first');
}

// B163: the loop row carries usage summed over all attempts, and no per-attempt
// chat row is written for those attempts.
{
  const withUsage = buildLoopRunRecord({
    ...base,
    usage: { inputTokens: 12_000, outputTokens: 900, cacheReadTokens: 5_000, costUsd: 0.0021 },
  });
  assert.deepEqual(withUsage.usage, {
    inputTokens: 12_000,
    outputTokens: 900,
    cacheReadTokens: 5_000,
    costUsd: 0.0021,
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-loop-usage-'));
  await writeRunRecord(dir, withUsage);
  const stored = await readRunRecord(dir, 'loop_abc');
  assert.deepEqual(stored?.usage, withUsage.usage);
  await fs.rm(dir, { recursive: true, force: true });
}
ok('a loop record carries summed usage');

console.log(`[loop-run-record] ${checks}/${checks} checks passed`);
