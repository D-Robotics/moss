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
const {
  listRunRecords,
  pruneRunRecords,
  readRunRecord,
  runRecordPath,
  writeRunRecord,
  writeRunningRecord,
} = await import(pathToFileURL(path.join(root, 'dist/core/run-ledger.js')).href);

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
  const [summaryRun, summaryLoop, summaryEmpty, summaryBadKind] = await Promise.all([
    cli(['runs', 'summary', '--json']),
    cli(['runs', 'summary', '--kind', 'loop']),
    cli(['runs', 'summary', '--since', '2100-01-01']),
    cli(['runs', 'summary', '--kind', 'nope']),
  ]);
  const summaryJson = JSON.parse(summaryRun.stdout);
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

  assert.equal(summaryLoop.status, 0, summaryLoop.stderr);
  assert.match(summaryLoop.stdout, /loop\s+1 runs/);
  assert.match(summaryLoop.stdout, /total\s+1 runs/);
  assert.match(summaryLoop.stdout, /— kind loop \(1\)/);

  assert.equal(summaryEmpty.status, 0, summaryEmpty.stderr);
  assert.match(summaryEmpty.stdout, /no runs match since 2100-01-01/);

  assert.equal(summaryBadKind.status, 2);
  ok('moss runs summary aggregates runs, tokens and priced cost with the same filters');

  // 11. B166: --by day/week buckets the same filtered runs, newest first.
  const [byDayRun, byDayText] = await Promise.all([
    cli(['runs', 'summary', '--by', 'day', '--json']),
    cli(['runs', 'summary', '--by', 'day', '--kind', 'task']),
  ]);
  const byDayJson = JSON.parse(byDayRun.stdout);
  assert.equal(byDayJson.by, 'day');
  assert.ok(byDayJson.buckets.length >= 1);
  assert.equal(
    byDayJson.buckets.reduce((sum, bucket) => sum + bucket.runs, 0),
    byDayJson.totalRuns,
    'buckets partition the filtered runs'
  );
  assert.equal(
    byDayJson.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0),
    byDayJson.total.inputTokens
  );
  const keys = byDayJson.buckets.map((bucket) => bucket.bucket);
  assert.deepEqual([...keys].sort().reverse(), keys, 'newest bucket first');
  const today = new Date();
  const localDay = `${String(today.getFullYear())}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal(keys[0], localDay, 'the newest bucket is today');

  assert.equal(byDayText.status, 0, byDayText.stderr);
  assert.match(byDayText.stdout, new RegExp(`${localDay}\\s+\\d+ runs`));
  assert.match(byDayText.stdout, /total\s+\d+ runs/);

  const { bucketKeyForRun } = await import(
    pathToFileURL(path.join(root, 'dist/cli/runs-command.js')).href
  );
  const weekKey = bucketKeyForRun(Date.now(), 'week');
  assert.match(weekKey, /^\d{4}-\d{2}-\d{2} \(week\)$/);
  const weekStart = new Date(`${weekKey.slice(0, 10)}T00:00:00Z`);
  assert.equal(weekStart.getUTCDay(), 1, 'ISO week bucket starts on Monday');
  assert.equal(
    bucketKeyForRun(Date.UTC(2026, 10, 2, 12), 'week'),
    bucketKeyForRun(Date.UTC(2026, 10, 8, 12), 'week'),
    'Monday and Sunday share one week bucket'
  );
  assert.notEqual(
    bucketKeyForRun(Date.UTC(2026, 10, 1, 12), 'week'),
    bucketKeyForRun(Date.UTC(2026, 10, 2, 12), 'week'),
    'the previous week is a different bucket'
  );

  const byMonth = await cli(['runs', 'summary', '--by', 'month']);
  assert.equal(byMonth.status, 2);

  // 12. B167: --by model attributes runs to the model they used, unknown included.
  await writeRunRecord(ws, {
    version: 1,
    runId: 'model_a_run',
    kind: 'task',
    status: 'completed',
    exitCode: 0,
    startedAt: Date.now() - 3_000,
    endedAt: Date.now() - 2_000,
    durationMs: 1_000,
    goal: 'model a',
    model: 'model-a',
    usage: { inputTokens: 100, outputTokens: 10 },
    artifacts: {},
  });
  await writeRunRecord(ws, {
    version: 1,
    runId: 'model_b_run',
    kind: 'task',
    status: 'completed',
    exitCode: 0,
    startedAt: Date.now() - 3_000,
    endedAt: Date.now() - 2_000,
    durationMs: 1_000,
    goal: 'model b',
    model: 'model-b',
    usage: { inputTokens: 200, outputTokens: 20 },
    artifacts: {},
  });
  const [byModelRun, modelShow, modelExport] = await Promise.all([
    cli(['runs', 'summary', '--by', 'model', '--json']),
    cli(['runs', 'show', 'model_a_run']),
    cli(['runs', 'export', 'model_a_run']),
  ]);
  assert.equal(modelShow.status, 0, modelShow.stderr);
  assert.match(modelShow.stdout, /^model: model-a$/m);
  assert.equal(modelExport.status, 0, modelExport.stderr);
  assert.match(modelExport.stdout, /^- model: model-a$/m);
  const byModel = JSON.parse(byModelRun.stdout);
  assert.equal(byModel.by, 'model');
  const modelKeys = byModel.buckets.map((bucket) => bucket.bucket);
  assert.ok(modelKeys.includes('model-a') && modelKeys.includes('model-b'));
  assert.ok(modelKeys.includes('unknown'), 'runs without a model are honest unknowns');
  const modelA = byModel.buckets.find((bucket) => bucket.bucket === 'model-a');
  assert.equal(modelA.inputTokens, 100);
  assert.equal(modelA.pass, 1);
  assert.equal(
    byModel.buckets.reduce((sum, bucket) => sum + bucket.runs, 0),
    byModel.totalRuns
  );
  assert.deepEqual(
    byModel.buckets.map((bucket) => bucket.runs),
    [...byModel.buckets.map((bucket) => bucket.runs)].sort((left, right) => right - left),
    'model rows are ordered by runs'
  );
  ok('moss runs summary --by day|week buckets by local day / ISO week');
  ok('moss runs summary --by model attributes runs to models (unknown included)');

  // 12. B178: an in-flight run shows as running (no fake exit code in show).
  await writeRunRecord(ws, {
    version: 1,
    runId: 'running_ticket_row',
    kind: 'superagent',
    status: 'running',
    exitCode: 0,
    startedAt: Date.now() - 1_000,
    endedAt: Date.now() - 1_000,
    durationMs: 0,
    goal: 'a long ticket',
    next: 'moss superagent status',
    artifacts: {},
  });
  const runningList = await cli(['runs', '--status', 'running', '--json']);
  assert.equal(runningList.status, 0, runningList.stderr);
  const runningJson = JSON.parse(runningList.stdout);
  assert.equal(runningJson.total, 1);
  assert.equal(runningJson.runs[0].status, 'running');
  const runningText = await cli(['runs', 'list']);
  assert.match(runningText.stdout, /1 running/);
  const runningShow = await cli(['runs', 'show', 'running_ticket_row']);
  assert.equal(runningShow.status, 0, runningShow.stderr);
  assert.match(runningShow.stdout, /exit: —/);
  assert.doesNotMatch(runningShow.stdout, /duration:/);
  ok('an in-flight record reads as running and hides its not-yet-meaningful exit/duration');

  // 13. B179: a running row whose owner is gone reads as interrupted (paused),
  // not "in progress" forever. Foreign hosts / missing pids stay unknown.
  const baseRunning = {
    version: 1,
    kind: 'superagent',
    exitCode: 0,
    startedAt: Date.now() - 1_000,
    endedAt: Date.now() - 1_000,
    durationMs: 0,
    goal: 'crashed ticket',
    next: 'moss superagent status',
    artifacts: {},
  };
  await writeRunRecord(ws, {
    ...baseRunning,
    runId: 'crashed_ticket_row',
    status: 'running',
    pid: 999_999_999,
    host: os.hostname(),
  });
  await writeRunRecord(ws, {
    ...baseRunning,
    runId: 'live_ticket_row',
    status: 'running',
    pid: process.pid,
    host: os.hostname(),
  });
  await writeRunRecord(ws, {
    ...baseRunning,
    runId: 'foreign_ticket_row',
    status: 'running',
    pid: 999_999_999,
    host: 'not-this-host',
  });
  const crashedShow = await cli(['runs', 'show', 'crashed_ticket_row']);
  assert.equal(crashedShow.status, 0, crashedShow.stderr);
  assert.match(crashedShow.stdout, /paused/);
  assert.match(crashedShow.stdout, /the run process is gone/);
  assert.match(crashedShow.stdout, /exit: 130/);
  const liveShow = await cli(['runs', 'show', 'live_ticket_row']);
  assert.match(liveShow.stdout, /running/);
  assert.match(liveShow.stdout, /exit: —/);
  const foreignShow = await cli(['runs', 'show', 'foreign_ticket_row']);
  assert.match(foreignShow.stdout, /running/, 'a pid from another host is not judged');
  const liveList = await cli(['runs', '--status', 'running', '--json']);
  const liveJson = JSON.parse(liveList.stdout);
  assert.equal(liveJson.total, 3, 'no-pid, live and foreign rows are still running');
  assert.equal(
    liveJson.runs.some((row) => row.runId === 'crashed_ticket_row'),
    false
  );
  ok('a dead owner reconciles a running row to paused; live/foreign/unknown stay running');

  // 14. B180: engines with a known run id publish a running row that the final
  // write overwrites (one row, not two).
  await writeRunningRecord(ws, {
    runId: 'loop_inflight',
    kind: 'loop',
    goal: 'inflight loop',
    next: 'moss loop show loop_inflight',
    acceptanceCommand: 'test -f x',
    model: 'deepseek-flash@latest',
  });
  const inflight = JSON.parse((await cli(['runs', '--status', 'running', '--json'])).stdout);
  const inflightRow = inflight.runs.find((row) => row.runId === 'loop_inflight');
  assert.ok(inflightRow, 'the running row is visible');
  assert.equal(inflightRow.status, 'running');
  assert.equal(typeof inflightRow.pid, 'number');
  await writeRunRecord(ws, {
    version: 1,
    runId: 'loop_inflight',
    kind: 'loop',
    status: 'completed',
    exitCode: 0,
    startedAt: Date.now() - 5_000,
    endedAt: Date.now(),
    durationMs: 5_000,
    goal: 'inflight loop',
    acceptanceCommand: 'test -f x',
    model: 'deepseek-flash@latest',
    artifacts: {},
  });
  const afterInflight = JSON.parse((await cli(['runs', '--status', 'running', '--json'])).stdout);
  assert.equal(
    afterInflight.runs.some((row) => row.runId === 'loop_inflight'),
    false,
    'the final write replaces the running row'
  );
  const allInflight = await cli(['runs', '--json']);
  assert.equal(
    JSON.parse(allInflight.stdout).runs.filter((row) => row.runId === 'loop_inflight').length,
    1
  );
  ok('a running row from writeRunningRecord is replaced by the final record');

  // 15. B182: filtered export is a combined PR/CI report.
  const bulk = await cli(['runs', 'export', '--since', '24h', '--format', 'md']);
  assert.equal(bulk.status, 0, bulk.stderr);
  assert.match(bulk.stdout, /^# Moss runs — since 24h \(\d+\)/);
  assert.match(bulk.stdout, /^## Run /m);
  assert.match(bulk.stdout, /^---$/m);
  const bulkJson = JSON.parse(
    (await cli(['runs', 'export', '--since', '24h', '--kind', 'task', '--limit', '1', '--json']))
      .stdout
  );
  assert.equal(bulkJson.kind, 'task');
  assert.equal(bulkJson.limit, 1);
  assert.equal(bulkJson.runs.length, 1);
  assert.equal(bulkJson.runs[0].kind, 'task');
  assert.ok(bulkJson.ledgerRuns >= bulkJson.total);
  const bulkOut = await cli(['runs', 'export', '--since', '24h', '--out', 'runs-report.md']);
  assert.equal(bulkOut.status, 0, bulkOut.stderr);
  assert.match(await fs.readFile(path.join(ws, 'runs-report.md'), 'utf8'), /^# Moss runs/);
  const emptyBulk = await cli(['runs', 'export', '--since', '2100-01-01', '--format', 'md']);
  assert.equal(emptyBulk.status, 0);
  assert.match(emptyBulk.stdout, /_no runs match_/);
  assert.equal((await cli(['runs', 'export', '--kind', 'nope'])).status, 2);
  assert.equal((await cli(['runs', 'export', 'task_pass', '--since', '24h'])).status, 2);
  ok('a filtered export renders a combined report (md/json/--out) and validates filters');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[runs-ledger] ${checks}/${checks} checks passed`);
