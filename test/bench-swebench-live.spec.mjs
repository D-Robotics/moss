import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcessSync } from '../dist/utils/run-process.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts', 'bench-swebench-live.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-swe-live-test-'));

try {
  const dataset = path.join(temp, 'fixture.jsonl');
  const worker = path.join(temp, 'worker.mjs');
  const output = path.join(temp, 'run');
  fs.writeFileSync(
    dataset,
    `${JSON.stringify({
      instance_id: 'sample__project-1',
      synthetic_fixture: true,
      problem_statement: 'Repair the example.',
      hints_text: 'SECRET_HINT_SENTINEL',
      test_patch: 'SECRET_PATCH_SENTINEL',
      FAIL_TO_PASS: ['SECRET_TEST_SENTINEL'],
    })}\n`
  );
  fs.writeFileSync(
    worker,
    `let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (JSON.stringify(Object.keys(request)) !== JSON.stringify(['problem_statement'])) process.exit(41);
if (process.env.MOSS_BENCH_API_KEY) process.exit(42);
process.stdout.write(JSON.stringify({status:'completed',model_patch:'diff --git a/a b/a\\n',trajectory:[{role:'user',content:request.problem_statement}]}));
`
  );
  const result = runProcessSync(
    process.execPath,
    [cli, 'fixture', '--dataset', dataset, '--output', output, '--worker', worker],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, MOSS_BENCH_API_KEY: 'SECRET_API_KEY_SENTINEL' },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const predictions = JSON.parse(fs.readFileSync(path.join(output, 'preds.json'), 'utf8'));
  assert.deepEqual(predictions['sample__project-1'], {
    instance_id: 'sample__project-1',
    model_name_or_path: 'moss-fixture-only',
    model_patch: 'diff --git a/a b/a\n',
  });
  const trajectories = fs.readdirSync(path.join(output, 'trajs'));
  assert.equal(trajectories.length, 1);
  const files = [
    result.stdout,
    result.stderr,
    fs.readFileSync(path.join(output, 'preds.json'), 'utf8'),
    fs.readFileSync(path.join(output, 'summary.json'), 'utf8'),
    fs.readFileSync(path.join(output, 'trajs', trajectories[0]), 'utf8'),
  ].join('\n');
  assert.match(files, /Repair the example/);
  assert.doesNotMatch(files, /SECRET_(HINT|PATCH|TEST|API_KEY)_SENTINEL/);
  console.log('[PASS] SWE-bench-Live fixture input projection and prediction export');

  const failuresDataset = path.join(temp, 'failures.jsonl');
  const failuresWorker = path.join(temp, 'failures-worker.mjs');
  const failuresOutput = path.join(temp, 'failures-run');
  const calls = path.join(temp, 'calls.jsonl');
  const examples = [
    'completed',
    'model_failed',
    'skipped',
    'timeout',
    'invalid_output',
    'worker_error',
  ];
  fs.writeFileSync(
    failuresDataset,
    examples
      .map((value) =>
        JSON.stringify({
          instance_id: `case-${value}`,
          synthetic_fixture: true,
          problem_statement: value,
        })
      )
      .join('\n') + '\n'
  );
  fs.writeFileSync(
    failuresWorker,
    `import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input).problem_statement;
fs.appendFileSync(${JSON.stringify(calls)}, value + '\\n');
if (value === 'timeout') setInterval(() => {}, 1000);
if (value === 'worker_error') { console.error('SECRET_WORKER_ERROR'); process.exit(17); }
if (value === 'invalid_output') { process.stdout.write('bad json'); process.exit(0); }
process.stdout.write(JSON.stringify({status:value,model_patch:value === 'completed' ? 'patch' : '',trajectory:[]}));
`
  );
  const failures = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      failuresDataset,
      '--output',
      failuresOutput,
      '--worker',
      failuresWorker,
      '--timeout-ms',
      '1000',
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(failures.status, 1, failures.stderr);
  const failuresSummary = JSON.parse(
    fs.readFileSync(path.join(failuresOutput, 'summary.json'), 'utf8')
  );
  assert.deepEqual(
    failuresSummary.statuses.map((row) => row.status),
    examples
  );
  const failedPredictions = JSON.parse(
    fs.readFileSync(path.join(failuresOutput, 'preds.json'), 'utf8')
  );
  for (const value of examples.slice(1))
    assert.equal(failedPredictions[`case-${value}`].model_patch, '');
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').sort(), [...examples].sort());
  assert.doesNotMatch(
    failures.stdout + failures.stderr + JSON.stringify(failuresSummary),
    /SECRET_WORKER_ERROR/
  );
  console.log('[PASS] distinct fixture failures and exactly one attempt');

  const evaluator = path.join(temp, 'failed-evaluator.mjs');
  const evaluatorOutput = path.join(temp, 'evaluator-run');
  fs.writeFileSync(evaluator, "console.error('SECRET_EVALUATOR_ERROR'); process.exit(23);\n");
  const evaluation = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      dataset,
      '--output',
      evaluatorOutput,
      '--worker',
      worker,
      '--evaluator',
      evaluator,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(evaluation.status, 1);
  const evaluationSummary = JSON.parse(
    fs.readFileSync(path.join(evaluatorOutput, 'summary.json'), 'utf8')
  );
  assert.equal(evaluationSummary.statuses[0].status, 'completed');
  assert.equal(evaluationSummary.evaluator.status, 'evaluator_error');
  assert.doesNotMatch(
    evaluation.stdout + evaluation.stderr + JSON.stringify(evaluationSummary),
    /SECRET_EVALUATOR_ERROR/
  );
  console.log('[PASS] evaluator failure is distinct from model failure');

  const reportedError = path.join(temp, 'reported-error-evaluator.mjs');
  const reportedOutput = path.join(temp, 'reported-error-run');
  fs.writeFileSync(
    reportedError,
    `let data = '';
for await (const chunk of process.stdin) data += chunk;
const ids = Object.keys(JSON.parse(data));
process.stdout.write(JSON.stringify({submitted_instances: ids.length, submitted_ids: ids, empty_patch_ids: [], resolved_ids: [], unresolved_ids: [], error_ids: ids, incomplete_ids: []}));
`
  );
  const reported = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      dataset,
      '--output',
      reportedOutput,
      '--worker',
      worker,
      '--evaluator',
      reportedError,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(reported.status, 1);
  const reportedSummary = JSON.parse(
    fs.readFileSync(path.join(reportedOutput, 'summary.json'), 'utf8')
  );
  assert.equal(reportedSummary.statuses[0].status, 'completed');
  assert.equal(reportedSummary.evaluator.status, 'evaluator_error');
  assert.deepEqual(reportedSummary.evaluator.error_ids, ['sample__project-1']);
  console.log('[PASS] evaluator-reported errors do not masquerade as success');

  const unresolvedEvaluator = path.join(temp, 'unresolved-evaluator.mjs');
  const unresolvedOutput = path.join(temp, 'unresolved-run');
  fs.writeFileSync(
    unresolvedEvaluator,
    `let data = '';
for await (const chunk of process.stdin) data += chunk;
const ids = Object.keys(JSON.parse(data));
process.stdout.write(JSON.stringify({submitted_instances: ids.length, submitted_ids: ids, empty_patch_ids: [], resolved_ids: [], unresolved_ids: ids, error_ids: [], incomplete_ids: []}));
`
  );
  const unresolved = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      dataset,
      '--output',
      unresolvedOutput,
      '--worker',
      worker,
      '--evaluator',
      unresolvedEvaluator,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(unresolved.status, 0);
  const unresolvedSummary = JSON.parse(
    fs.readFileSync(path.join(unresolvedOutput, 'summary.json'), 'utf8')
  );
  assert.equal(unresolvedSummary.evaluator.status, 'finished');
  assert.deepEqual(unresolvedSummary.evaluator.unresolved_ids, ['sample__project-1']);
  console.log('[PASS] an unresolved patch remains distinct from evaluator failure');

  const duplicateEvaluator = path.join(temp, 'duplicate-evaluator.mjs');
  const duplicateEvaluatorOutput = path.join(temp, 'duplicate-evaluator-run');
  fs.writeFileSync(
    duplicateEvaluator,
    `let data = '';
for await (const chunk of process.stdin) data += chunk;
const ids = Object.keys(JSON.parse(data));
process.stdout.write(JSON.stringify({submitted_instances: ids.length, submitted_ids: [...ids, ...ids], empty_patch_ids: [], resolved_ids: ids, unresolved_ids: [], error_ids: [], incomplete_ids: []}));
`
  );
  const duplicateEvaluation = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      dataset,
      '--output',
      duplicateEvaluatorOutput,
      '--worker',
      worker,
      '--evaluator',
      duplicateEvaluator,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(duplicateEvaluation.status, 1);
  const duplicateEvaluationSummary = JSON.parse(
    fs.readFileSync(path.join(duplicateEvaluatorOutput, 'summary.json'), 'utf8')
  );
  assert.equal(duplicateEvaluationSummary.evaluator.status, 'evaluator_error');
  console.log('[PASS] duplicate submitted IDs invalidate the evaluator report');

  const emptyWorker = path.join(temp, 'empty-worker.mjs');
  const wrongEmptyEvaluator = path.join(temp, 'wrong-empty-evaluator.mjs');
  const wrongEmptyOutput = path.join(temp, 'wrong-empty-run');
  fs.writeFileSync(
    emptyWorker,
    "process.stdin.resume();process.stdout.write(JSON.stringify({status:'completed',model_patch:'',trajectory:[]}));\n"
  );
  fs.writeFileSync(
    wrongEmptyEvaluator,
    `let data = '';
for await (const chunk of process.stdin) data += chunk;
const ids = Object.keys(JSON.parse(data));
process.stdout.write(JSON.stringify({submitted_instances: ids.length, submitted_ids: ids, empty_patch_ids: [], resolved_ids: ids, unresolved_ids: [], error_ids: [], incomplete_ids: []}));
`
  );
  const wrongEmpty = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      dataset,
      '--output',
      wrongEmptyOutput,
      '--worker',
      emptyWorker,
      '--evaluator',
      wrongEmptyEvaluator,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(wrongEmpty.status, 1);
  const wrongEmptySummary = JSON.parse(
    fs.readFileSync(path.join(wrongEmptyOutput, 'summary.json'), 'utf8')
  );
  assert.equal(wrongEmptySummary.evaluator.status, 'evaluator_error');
  console.log('[PASS] empty patches cannot be reported as resolved');

  const correctEmptyEvaluator = path.join(temp, 'correct-empty-evaluator.mjs');
  const correctEmptyOutput = path.join(temp, 'correct-empty-run');
  fs.writeFileSync(
    correctEmptyEvaluator,
    `let data = '';
for await (const chunk of process.stdin) data += chunk;
const ids = Object.keys(JSON.parse(data));
process.stdout.write(JSON.stringify({submitted_instances: ids.length, submitted_ids: ids, empty_patch_ids: ids, resolved_ids: [], unresolved_ids: [], error_ids: [], incomplete_ids: []}));
`
  );
  const correctEmpty = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      dataset,
      '--output',
      correctEmptyOutput,
      '--worker',
      emptyWorker,
      '--evaluator',
      correctEmptyEvaluator,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(correctEmpty.status, 0);
  const correctEmptySummary = JSON.parse(
    fs.readFileSync(path.join(correctEmptyOutput, 'summary.json'), 'utf8')
  );
  assert.deepEqual(correctEmptySummary.evaluator.empty_patch_ids, ['sample__project-1']);
  console.log('[PASS] correctly classified empty patches remain visible');

  const dockerFixture = path.join(temp, 'docker-probe.mjs');
  const dockerCalls = path.join(temp, 'docker-calls.json');
  fs.writeFileSync(
    dockerFixture,
    `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(dockerCalls)}, JSON.stringify({args:process.argv.slice(2), dockerEnvPresent:Boolean(process.env.DOCKER_HOST)}));
console.error('SECRET_DOCKER_ERROR');
process.exit(1);
`
  );
  const envWithoutProvider = { ...process.env };
  delete envWithoutProvider.MOSS_BENCH_API_KEY;
  delete envWithoutProvider.MOSS_BENCH_MODEL;
  delete envWithoutProvider.MOSS_BENCH_BASE_URL;
  envWithoutProvider.DOCKER_HOST = 'SECRET_DOCKER_ENV';
  envWithoutProvider.SSH_AUTH_SOCK = 'SECRET_SSH_SOCKET';
  const preflight = runProcessSync(
    process.execPath,
    [cli, 'preflight', '--docker-fixture', dockerFixture],
    { cwd: root, encoding: 'utf8', timeout: 20_000, env: envWithoutProvider }
  );
  assert.equal(preflight.status, 2);
  const checks = JSON.parse(preflight.stdout);
  assert.equal(checks.status, 'incomplete');
  assert.equal(checks.official_run_enabled, false);
  assert.ok(checks.limitations.includes('ssh_agent_not_forwarded'));
  for (const blocker of [
    'docker_server',
    'model_key',
    'model',
    'budget',
    'dataset_snapshot',
    'full_trajectory',
    'official_evaluator',
    'resource_capacity',
  ]) {
    assert.ok(checks.blockers.includes(blocker), blocker);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(dockerCalls, 'utf8')), {
    args: ['version', '--format', '{{.Server.Version}}'],
    dockerEnvPresent: false,
  });
  assert.doesNotMatch(preflight.stdout + preflight.stderr, /SECRET_DOCKER_(ERROR|ENV)/);
  console.log('[PASS] formal preflight remains incomplete and uses a read-only probe');

  if (process.platform !== 'win32') {
    const fakeDockerDir = path.join(temp, 'fake-docker-bin');
    const fakeDockerCapture = path.join(temp, 'fake-docker-config.json');
    fs.mkdirSync(fakeDockerDir);
    fs.writeFileSync(
      path.join(fakeDockerDir, 'docker'),
      `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(fakeDockerCapture)}, JSON.stringify({config: process.env.DOCKER_CONFIG ?? null, tls: process.env.DOCKER_TLS ?? null, api: process.env.DOCKER_API_VERSION ?? null, sshAgentPresent: Boolean(process.env.SSH_AUTH_SOCK), args: process.argv.slice(2)}));
process.stdout.write('27.0.0');
`,
      { mode: 0o755 }
    );
    const envWithConfig = {
      ...envWithoutProvider,
      PATH: `${fakeDockerDir}${path.delimiter}${process.env.PATH ?? ''}`,
      DOCKER_CONFIG: 'fixture-config-path',
      DOCKER_TLS: '1',
      DOCKER_API_VERSION: '1.41',
    };
    const realProbe = runProcessSync(process.execPath, [cli, 'preflight'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      env: envWithConfig,
    });
    assert.equal(realProbe.status, 2);
    const configProbe = JSON.parse(fs.readFileSync(fakeDockerCapture, 'utf8'));
    assert.deepEqual(configProbe, {
      config: 'fixture-config-path',
      tls: '1',
      api: '1.41',
      sshAgentPresent: false,
      args: ['version', '--format', '{{.Server.Version}}'],
    });
    assert.ok(!JSON.parse(realProbe.stdout).blockers.includes('docker_server'));
    console.log('[PASS] read-only Docker probe honors DOCKER_CONFIG');
  }

  for (const [version, supported] of [
    ['22.15.0', false],
    ['22.16.0', true],
    ['24.0.0', true],
    ['25.0.0', false],
  ]) {
    const bootstrap =
      `Object.defineProperty(process.versions, 'node', {value:${JSON.stringify(version)}});\n` +
      `process.argv = [process.execPath, ${JSON.stringify(cli)}, 'preflight', '--docker-fixture', ${JSON.stringify(dockerFixture)}];\n` +
      `await import(${JSON.stringify(pathToFileURL(cli).href)});`;
    const checked = runProcessSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      env: envWithoutProvider,
    });
    assert.equal(checked.status, 2);
    assert.equal(!JSON.parse(checked.stdout).blockers.includes('node_version'), supported, version);
  }
  console.log('[PASS] preflight observes the supported Node version matrix');

  const unbuiltScripts = path.join(temp, 'unbuilt', 'scripts');
  fs.mkdirSync(unbuiltScripts, { recursive: true });
  const unbuiltCli = path.join(unbuiltScripts, 'bench-swebench-live.mjs');
  fs.copyFileSync(cli, unbuiltCli);
  const unbuilt = runProcessSync(process.execPath, [unbuiltCli, 'preflight'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(unbuilt.status, 2);
  const unbuiltResult = JSON.parse(unbuilt.stdout);
  assert.equal(unbuiltResult.status, 'incomplete');
  assert.ok(unbuiltResult.blockers.includes('moss_build'));
  assert.ok(unbuiltResult.checks_skipped.includes('docker_server'));
  console.log('[PASS] preflight reports a missing build without invoking Docker');

  const duplicateDataset = path.join(temp, 'duplicate.jsonl');
  const duplicateOutput = path.join(temp, 'duplicate-run');
  const duplicate = JSON.stringify({
    instance_id: 'repeated',
    synthetic_fixture: true,
    problem_statement: 'fixture',
  });
  fs.writeFileSync(duplicateDataset, `${duplicate}\n${duplicate}\n`);
  const duplicateResult = runProcessSync(
    process.execPath,
    [
      cli,
      'fixture',
      '--dataset',
      duplicateDataset,
      '--output',
      duplicateOutput,
      '--worker',
      worker,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(duplicateResult.status, 1);
  assert.equal(fs.existsSync(duplicateOutput), false);
  const existingResults = fs.readFileSync(path.join(output, 'preds.json'), 'utf8');
  const overwrite = runProcessSync(
    process.execPath,
    [cli, 'fixture', '--dataset', dataset, '--output', output, '--worker', worker],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(overwrite.status, 1);
  assert.equal(fs.readFileSync(path.join(output, 'preds.json'), 'utf8'), existingResults);
  console.log('[PASS] duplicate instances and output overwrites are rejected');

  const badParquet = path.join(temp, 'bad.parquet');
  const imported = path.join(temp, 'imported');
  fs.writeFileSync(badParquet, 'not the official dataset');
  const badImport = runProcessSync(
    process.execPath,
    [cli, 'prepare', '--parquet', badParquet, '--output', imported, '--python', process.execPath],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(badImport.status, 1);
  assert.match(badImport.stderr, /checksum/i);
  assert.equal(fs.existsSync(imported), false);
  console.log('[PASS] real dataset import rejects a mismatched official checksum');

  const unmarkedDataset = path.join(temp, 'unmarked.jsonl');
  const unmarkedOutput = path.join(temp, 'unmarked-run');
  fs.writeFileSync(
    unmarkedDataset,
    `${JSON.stringify({ instance_id: 'real-like', problem_statement: 'issue' })}\n`
  );
  const unmarked = runProcessSync(
    process.execPath,
    [cli, 'fixture', '--dataset', unmarkedDataset, '--output', unmarkedOutput, '--worker', worker],
    { cwd: root, encoding: 'utf8', timeout: 20_000 }
  );
  assert.equal(unmarked.status, 1);
  assert.equal(fs.existsSync(unmarkedOutput), false);
  console.log('[PASS] fixture runner refuses unmarked datasets');

  const windowsTimeoutProbe = path.join(temp, 'windows-timeout-probe.mjs');
  const boundaryModule = pathToFileURL(path.join(root, 'dist/utils/run-process.js')).href;
  fs.writeFileSync(
    windowsTimeoutProbe,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let cleanupEnv;
let cleanupCommand = '';
childProcess.spawnSync = (command, _args, options) => { cleanupCommand = command; cleanupEnv = options.env; return {status: 0}; };
syncBuiltinESMExports();
Object.defineProperty(process, 'platform', {value:'win32'});
const {runProcess} = await import(${JSON.stringify(boundaryModule)});
let timedOut = false;
try {
  await runProcess(process.execPath, {args:['-e','setInterval(()=>{},1000)'], timeout:250, env:{PATH:process.env.PATH ?? ''}});
} catch (error) { timedOut = Boolean(error.timedOut); }
process.stdout.write(JSON.stringify({timedOut, cleanupCalled:Boolean(cleanupEnv), trustedPath:/^[A-Za-z]:\\\\[^"]*\\\\System32\\\\taskkill\\.exe$/i.test(cleanupCommand), hasSystemRoot:Object.keys(cleanupEnv ?? {}).some((k)=>k.toUpperCase()==='SYSTEMROOT' && Boolean(cleanupEnv[k])), leaked:cleanupEnv?.MOSS_BENCH_API_KEY !== undefined}));
`
  );
  const windowsTimeout = runProcessSync(process.execPath, [windowsTimeoutProbe], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, MOSS_BENCH_API_KEY: 'SECRET_TIMEOUT_SENTINEL' },
  });
  assert.equal(windowsTimeout.status, 0, windowsTimeout.stderr);
  assert.deepEqual(JSON.parse(windowsTimeout.stdout), {
    timedOut: true,
    cleanupCalled: true,
    trustedPath: true,
    hasSystemRoot: true,
    leaked: false,
  });
  console.log('[PASS] Windows timeout cleanup keeps the restricted child environment');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
