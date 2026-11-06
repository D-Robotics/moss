#!/usr/bin/env node
/**
 * Unified run ledger probe (offline).
 *
 * Every autonomous run now writes `.moss/runs/<runId>/run.json` with the
 * completion-gate status vocabulary (+ `interrupted` for a paused run), and
 * `moss runs list|show|prune` is the single read path. This locks the storage
 * contract, the defensive parsing, pruning semantics and the CLI JSON shapes
 * without needing a model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const { listRunRecords, pruneRunRecords, readRunRecord, runRecordPath, writeRunRecord } =
  await import(pathToFileURL(path.join(root, 'dist/core/run-ledger.js')).href);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[runs-ledger] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-runs-ledger-'));
const ws = path.join(tmp, 'ws');
await fs.mkdir(ws, { recursive: true });
const configDir = path.join(tmp, 'config');
await fs.mkdir(configDir, { recursive: true });

const record = (overrides) => ({
  version: 1,
  runId: 'run_a',
  kind: 'task',
  status: 'completed',
  exitCode: 0,
  startedAt: 1_000,
  endedAt: 2_000,
  durationMs: 1_000,
  goal: 'do the thing',
  ...overrides,
});

try {
  // 1. Writes normalize the goal and land a readable JSON file.
  await writeRunRecord(ws, record({ runId: 'task_pass', goal: '  create   hello.txt  ' }));
  const passPath = runRecordPath(ws, 'task_pass');
  const onDisk = JSON.parse(await fs.readFile(passPath, 'utf8'));
  assert.equal(onDisk.goal, 'create hello.txt');
  assert.equal(onDisk.version, 1);
  ok('a record lands in .moss/runs/<id>/run.json with a one-line goal');

  // 2. Newest first, and the second record carries failure + next.
  await writeRunRecord(
    ws,
    record({
      runId: 'task_fail',
      status: 'verify_failed',
      exitCode: 1,
      startedAt: 3_000,
      endedAt: 4_000,
      durationMs: 1_000,
      reason: 'acceptance command failed (exit 1)',
      next: 'moss task resume task_fail',
      attempts: 2,
      repairs: 1,
      turns: 3,
      artifacts: { taskEvents: '.moss/task-events.jsonl', evidence: '.moss/evidence.jsonl' },
    })
  );
  await writeRunRecord(
    ws,
    record({
      runId: 'task_paused',
      status: 'interrupted',
      exitCode: 130,
      startedAt: 5_000,
      endedAt: 6_000,
    })
  );
  const all = await listRunRecords(ws);
  assert.deepEqual(
    all.map((item) => item.runId),
    ['task_paused', 'task_fail', 'task_pass']
  );
  assert.equal(all[1].status, 'verify_failed');
  assert.equal(all[1].next, 'moss task resume task_fail');
  assert.equal(all[1].turns, 3);
  ok('list returns newest first with failure reason and next command intact');

  // 3. lookups: latest, exact, missing, traversal.
  assert.equal((await readRunRecord(ws, 'latest'))?.runId, 'task_paused');
  assert.equal((await readRunRecord(ws, 'task_pass'))?.goal, 'create hello.txt');
  assert.equal(await readRunRecord(ws, 'nope'), null);
  assert.equal(await readRunRecord(ws, '../etc'), null, 'path traversal must not read outside');
  await assert.rejects(writeRunRecord(ws, record({ runId: '../escape' })), /invalid run id/);
  ok('lookups are exact, latest works, and ids cannot escape the runs directory');

  // 4. A malformed or truncated record is skipped, never fatal.
  const badDir = path.join(ws, '.moss', 'runs', 'bad');
  await fs.mkdir(badDir, { recursive: true });
  await fs.writeFile(path.join(badDir, 'run.json'), '{"version":1,"runId":', 'utf8');
  await fs.writeFile(path.join(ws, '.moss', 'runs', 'not-a-dir'), 'x', 'utf8');
  assert.equal((await listRunRecords(ws)).length, 3);
  ok('half-written records and stray files are skipped');

  // 5. prune keeps the newest N; --dry-run reports without deleting.
  const dry = await pruneRunRecords(ws, { keep: 2, dryRun: true });
  assert.deepEqual(dry.removed, ['task_pass']);
  assert.equal(dry.kept, 2);
  assert.ok(dry.bytes > 0, 'dry run reports reclaimable bytes');
  assert.equal((await listRunRecords(ws)).length, 3, 'dry run must not delete');
  const pruned = await pruneRunRecords(ws, { keep: 2 });
  assert.deepEqual(pruned.removed, ['task_pass']);
  assert.deepEqual(
    (await listRunRecords(ws)).map((item) => item.runId),
    ['task_paused', 'task_fail']
  );
  ok('prune keeps the newest N, dry-run is read-only');

  // 6. The CLI reads the same ledger without a provider config.
  const env = {
    ...process.env,
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_RDK_DOCS: '1',
    MOSS_NO_TUI: '1',
    MOSS_LANG: 'en',
  };
  const cli = (args) =>
    captureProcess(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
      cwd: ws,
      env,
      timeoutMs: 60_000,
    });
  const listed = await cli(['runs', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const listedJson = JSON.parse(listed.stdout);
  assert.equal(listedJson.version, 1);
  assert.equal(listedJson.total, 2);
  assert.deepEqual(
    listedJson.runs.map((item) => item.runId),
    ['task_paused', 'task_fail']
  );
  assert.equal(listedJson.counts.verify_failed, 1);

  const shown = await cli(['runs', 'show', 'latest', '--json']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).runId, 'task_paused');

  const filtered = await cli(['runs', 'list', '--status', 'fail', '--json']);
  assert.equal(JSON.parse(filtered.stdout).runs.length, 1);
  assert.equal(JSON.parse(filtered.stdout).runs[0].status, 'verify_failed');

  const missing = await cli(['runs', 'show', 'does-not-exist']);
  assert.equal(missing.status, 2);
  const badStatus = await cli(['runs', 'list', '--status', 'nope']);
  assert.equal(badStatus.status, 2);
  ok('moss runs list/show/filter exits 0 and rejects bad input with 2');

  // 6b. export: PR/CI-ready Markdown, JSON, and --out.
  const exported = await cli(['runs', 'export', 'latest']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /^## Run task_paused — interrupted/m);
  assert.match(exported.stdout, /^- kind: task$/m);
  assert.match(exported.stdout, /^- goal: /m);
  assert.match(exported.stdout, /generated by `moss runs export task_paused`/);
  assert.ok(!/^- reason: /m.test(exported.stdout), 'a paused record without reason shows none');

  const failedExport = await cli(['runs', 'export', 'task_fail']);
  assert.equal(failedExport.status, 0, failedExport.stderr);
  assert.match(failedExport.stdout, /^## Run task_fail — verify_failed/m);
  assert.match(failedExport.stdout, /^- reason: acceptance command failed \(exit 1\)/m);
  assert.match(failedExport.stdout, /^- next: `moss task resume task_fail`/m);
  assert.match(failedExport.stdout, /^- artifacts: taskEvents=\.moss\/task-events\.jsonl/m);

  const exportedJson = await cli(['runs', 'export', 'latest', '--format', 'json']);
  assert.equal(exportedJson.status, 0, exportedJson.stderr);
  assert.equal(JSON.parse(exportedJson.stdout).runId, 'task_paused');

  const exportedFile = await cli(['runs', 'export', 'task_fail', '--out', 'out/run.md']);
  assert.equal(exportedFile.status, 0, exportedFile.stderr);
  const written = await fs.readFile(path.join(ws, 'out', 'run.md'), 'utf8');
  assert.match(written, /^## Run task_fail — verify_failed/m);
  assert.match(written, /^- next: `moss task resume task_fail`/m);

  const badFormat = await cli(['runs', 'export', 'latest', '--format', 'xml']);
  assert.equal(badFormat.status, 2);
  const noRun = await cli(['runs', 'export', 'does-not-exist']);
  assert.equal(noRun.status, 2);
  ok('moss runs export renders Markdown/JSON, writes --out, and rejects bad input with 2');

  // 7. prune --json from the CLI (dry run leaves files alone).
  const dryJson = await cli(['runs', 'prune', '--keep', '1', '--dry-run', '--json']);
  assert.equal(dryJson.status, 0, dryJson.stderr);
  const dryResult = JSON.parse(dryJson.stdout);
  assert.deepEqual(dryResult.removed, ['task_fail']);
  assert.equal(dryResult.dryRun, true);
  assert.equal((await listRunRecords(ws)).length, 2);
  ok('moss runs prune --dry-run reports and deletes nothing');

  // 8. --kind narrows the ledger to one engine (B147).
  await fs.mkdir(path.join(ws, '.moss', 'runs', 'loop_demo'), { recursive: true });
  await writeRunRecord(ws, {
    version: 1,
    runId: 'loop_demo',
    kind: 'loop',
    status: 'completed',
    exitCode: 0,
    startedAt: 7_000,
    endedAt: 8_000,
    durationMs: 1_000,
    goal: 'loop until the check passes',
    next: 'moss runs show latest',
    attempts: 1,
    assertions: 1,
  });
  const kindLoop = await cli(['runs', 'list', '--kind', 'loop', '--json']);
  assert.equal(kindLoop.status, 0, kindLoop.stderr);
  const kindLoopJson = JSON.parse(kindLoop.stdout);
  assert.equal(kindLoopJson.total, 1);
  assert.equal(kindLoopJson.kind, 'loop');
  assert.deepEqual(
    kindLoopJson.runs.map((item) => item.runId),
    ['loop_demo']
  );
  const kindTask = JSON.parse((await cli(['runs', 'list', '--kind=task', '--json'])).stdout);
  assert.equal(kindTask.total, 2);
  const combined = JSON.parse(
    (await cli(['runs', 'list', '--status', 'fail', '--kind', 'task', '--json'])).stdout
  );
  assert.equal(combined.total, 1);
  assert.equal(combined.runs[0].runId, 'task_fail');
  // B159: usage rides on the record and shows in both human views.
  const usageRecord = {
    version: 1,
    runId: 'usage_run',
    kind: 'task',
    status: 'completed',
    exitCode: 0,
    startedAt: 9_000,
    endedAt: 10_000,
    durationMs: 1_000,
    goal: 'usage probe',
    usage: { inputTokens: 12_345, outputTokens: 678, cacheReadTokens: 4_000, costUsd: 0.0123 },
    gates: [
      {
        gate: 'verification',
        kind: 'unverified-change',
        reason: 'files were changed but nothing checked the result',
        turn: 1,
      },
    ],
  };
  await writeRunRecord(ws, usageRecord);
  const usageShow = await cli(['runs', 'show', 'usage_run']);
  assert.equal(usageShow.status, 0, usageShow.stderr);
  assert.match(
    usageShow.stdout,
    /usage: 12\.3k in \/ 678 out · cache read 4\.0k · ~\$0\.0123 \(est\.\)/
  );
  assert.match(usageShow.stdout, /gate: verification\/unverified-change — files were changed/);
  const usageMd = await cli(['runs', 'export', 'usage_run']);
  assert.match(usageMd.stdout, /^- usage: 12\.3k in \/ 678 out/m);
  assert.match(usageMd.stdout, /^- gate: verification\/unverified-change — /m);
  const usageJson = JSON.parse((await cli(['runs', 'show', 'usage_run', '--json'])).stdout);
  assert.deepEqual(usageJson.usage, usageRecord.usage);
  assert.deepEqual(usageJson.gates, usageRecord.gates);

  const kindTable = await cli(['runs', 'list', '--kind', 'loop']);
  assert.match(kindTable.stdout, /— kind loop \(1\)/);
  const badKind = await cli(['runs', 'list', '--kind', 'nope']);
  assert.equal(badKind.status, 2);
  assert.match(badKind.stderr, /unknown --kind nope/);
  ok('moss runs list --kind narrows by engine and rejects unknown kinds with 2');

  // 9. --since narrows by recency (duration window or date), combined with kind.
  await writeRunRecord(ws, {
    version: 1,
    runId: 'fresh_run',
    kind: 'task',
    status: 'completed',
    exitCode: 0,
    startedAt: Date.now() - 5_000,
    endedAt: Date.now(),
    durationMs: 5_000,
    goal: 'fresh run',
  });
  const sinceHour = await cli(['runs', 'list', '--since', '1h', '--json']);
  assert.equal(sinceHour.status, 0, sinceHour.stderr);
  const sinceHourJson = JSON.parse(sinceHour.stdout);
  assert.equal(sinceHourJson.total, 1);
  assert.equal(sinceHourJson.runs[0].runId, 'fresh_run');
  assert.ok(sinceHourJson.since);

  const sinceDay = JSON.parse(
    (await cli(['runs', 'list', '--since=24h', '--kind', 'loop', '--json'])).stdout
  );
  assert.equal(sinceDay.total, 0, 'the 1970 loop fixture is older than 24h');

  const sinceDate = await cli(['runs', 'list', '--since', '2100-01-01']);
  assert.equal(sinceDate.status, 0, sinceDate.stderr);
  assert.match(sinceDate.stdout, /no runs match since 2100-01-01/);

  const sinceTable = await cli(['runs', 'list', '--since', '1h']);
  assert.match(sinceTable.stdout, /— since 1h \(1\)/);

  const badSince = await cli(['runs', 'list', '--since', 'nope']);
  assert.equal(badSince.status, 2);
  assert.match(badSince.stderr, /--since must be a duration/);
  ok('moss runs list --since accepts windows/dates and rejects anything else with 2');

  // 10. B162: summary aggregates the same ledger (per kind, tokens, priced cost).
  const summaryJson = JSON.parse((await cli(['runs', 'summary', '--json'])).stdout);
  assert.equal(summaryJson.version, 1);
  assert.equal(summaryJson.totalRuns, summaryJson.total.runs);
  assert.equal(summaryJson.total.withUsage, 1, 'only usage_run carries usage');
  assert.equal(summaryJson.total.withCost, 1);
  assert.equal(summaryJson.total.costUsd, 0.0123);
  assert.equal(summaryJson.total.inputTokens, 12_345);
  const taskKind = summaryJson.kinds.find((entry) => entry.kind === 'task');
  const loopKind = summaryJson.kinds.find((entry) => entry.kind === 'loop');
  assert.equal(taskKind.withUsage, 1);
  assert.equal(loopKind.withUsage, 0);
  assert.equal(summaryJson.kinds.length, 5, 'every kind is reported');

  const summaryLoop = await cli(['runs', 'summary', '--kind', 'loop']);
  assert.equal(summaryLoop.status, 0, summaryLoop.stderr);
  assert.match(summaryLoop.stdout, /loop\s+1 runs/);
  assert.match(summaryLoop.stdout, /total\s+1 runs/);
  assert.match(summaryLoop.stdout, /— kind loop \(1\)/);

  const summaryEmpty = await cli(['runs', 'summary', '--since', '2100-01-01']);
  assert.equal(summaryEmpty.status, 0, summaryEmpty.stderr);
  assert.match(summaryEmpty.stdout, /no runs match since 2100-01-01/);

  const summaryBadKind = await cli(['runs', 'summary', '--kind', 'nope']);
  assert.equal(summaryBadKind.status, 2);
  ok('moss runs summary aggregates runs, tokens and priced cost with the same filters');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[runs-ledger] ${checks}/${checks} checks passed`);
