#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const processBoundary = await import('../dist/utils/run-process.js').catch(() => null);
const { ProcessError, runProcess } = processBoundary ?? {};

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !['--dataset', '--output', '--worker', '--timeout-ms', '--evaluator'].includes(flag) ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error('invalid fixture arguments');
    }
    if (Object.hasOwn(options, flag)) throw new Error('duplicate fixture argument');
    options[flag] = value;
  }
  if (!options['--dataset'] || !options['--output'] || !options['--worker']) {
    throw new Error('fixture requires --dataset, --output and --worker');
  }
  return options;
}

function readFixture(dataset, requireSynthetic = false) {
  const lines = fs
    .readFileSync(dataset, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length === 0) throw new Error('fixture dataset is empty');
  const seen = new Set();
  return lines.map((line) => {
    const row = JSON.parse(line);
    if (
      !row ||
      (requireSynthetic && row.synthetic_fixture !== true) ||
      typeof row.instance_id !== 'string' ||
      !/^[a-zA-Z0-9._-]+$/.test(row.instance_id) ||
      typeof row.problem_statement !== 'string' ||
      seen.has(row.instance_id)
    ) {
      throw new Error('invalid or duplicate fixture instance');
    }
    seen.add(row.instance_id);
    return { instanceId: row.instance_id, statement: row.problem_statement };
  });
}

function fixtureEnvironment() {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runWorker(worker, row, output, timeout) {
  let result;
  try {
    result = await runProcess(process.execPath, {
      args: [worker],
      stdin: JSON.stringify({ problem_statement: row.statement }),
      env: fixtureEnvironment(),
      cwd: output,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    return { status: error instanceof ProcessError && error.timedOut ? 'timeout' : 'worker_error' };
  }
  try {
    if (result.stdoutOverflow || result.stdout.length > 4 * 1024 * 1024) throw new Error();
    const reply = JSON.parse(result.stdout);
    if (
      !reply ||
      !['completed', 'model_failed', 'skipped'].includes(reply.status) ||
      typeof reply.model_patch !== 'string' ||
      !Array.isArray(reply.trajectory)
    )
      throw new Error();
    return { status: reply.status, reply };
  } catch {
    return { status: 'invalid_output' };
  }
}

async function runEvaluator(evaluator, predictions, output, timeout) {
  let result;
  try {
    result = await runProcess(process.execPath, {
      args: [path.resolve(evaluator)],
      stdin: JSON.stringify(predictions),
      env: fixtureEnvironment(),
      cwd: output,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    return {
      status:
        error instanceof ProcessError && error.timedOut ? 'evaluator_timeout' : 'evaluator_error',
    };
  }
  try {
    if (result.stdoutOverflow || result.stdout.length > 4 * 1024 * 1024) throw new Error();
    const report = JSON.parse(result.stdout);
    const ids = Object.keys(predictions);
    const fields = [
      'resolved_ids',
      'unresolved_ids',
      'error_ids',
      'incomplete_ids',
      'empty_patch_ids',
    ];
    if (
      !report ||
      report.submitted_instances !== ids.length ||
      !Array.isArray(report.submitted_ids)
    )
      throw new Error();
    const submitted = new Set(report.submitted_ids);
    if (
      report.submitted_ids.length !== ids.length ||
      submitted.size !== ids.length ||
      ids.some((id) => !submitted.has(id))
    )
      throw new Error();
    const graded = new Set();
    const groups = {};
    for (const field of fields) {
      if (!Array.isArray(report[field])) throw new Error();
      groups[field] = [];
      for (const id of report[field]) {
        if (!submitted.has(id) || graded.has(id)) throw new Error();
        graded.add(id);
        groups[field].push(id);
      }
    }
    if (graded.size !== ids.length) throw new Error();
    const emptyIds = new Set(groups.empty_patch_ids);
    if (ids.some((id) => (predictions[id].model_patch === '') !== emptyIds.has(id))) {
      throw new Error();
    }
    return {
      status: groups.error_ids.length
        ? 'evaluator_error'
        : groups.incomplete_ids.length
          ? 'evaluator_incomplete'
          : 'finished',
      ...groups,
    };
  } catch {
    return { status: 'evaluator_error' };
  }
}

async function runFixture(options) {
  const rows = readFixture(options['--dataset'], true);
  const output = path.resolve(options['--output']);
  const worker = path.resolve(options['--worker']);
  const timeout = Number(options['--timeout-ms'] ?? 20_000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 900_000) {
    throw new Error('invalid fixture timeout');
  }
  fs.mkdirSync(output);
  fs.mkdirSync(path.join(output, 'trajs'));
  const predictions = Object.create(null);
  const statuses = [];
  for (const row of rows) {
    const result = await runWorker(worker, row, output, timeout);
    predictions[row.instanceId] = {
      instance_id: row.instanceId,
      model_name_or_path: 'moss-fixture-only',
      model_patch: result.status === 'completed' ? result.reply.model_patch : '',
    };
    statuses.push({ instance_id: row.instanceId, status: result.status });
    const name = createHash('sha256').update(row.instanceId).digest('hex');
    fs.writeFileSync(
      path.join(output, 'trajs', `${name}.json`),
      JSON.stringify(
        { kind: 'synthetic-fixture-only', initial_prompt: row.statement, ...result },
        null,
        2
      )
    );
  }
  fs.writeFileSync(path.join(output, 'preds.json'), JSON.stringify(predictions, null, 2));
  const evaluator = options['--evaluator']
    ? await runEvaluator(options['--evaluator'], predictions, output, timeout)
    : { status: 'not_run' };
  fs.writeFileSync(
    path.join(output, 'summary.json'),
    JSON.stringify(
      { kind: 'synthetic-fixture-only', official: false, statuses, evaluator },
      null,
      2
    )
  );
  console.log(`fixture finished: ${rows.length} synthetic instance(s)`);
  if (
    statuses.some((row) => row.status !== 'completed') ||
    !['not_run', 'finished'].includes(evaluator.status)
  ) {
    process.exitCode = 1;
  }
}

const DATASET_REVISION = '1653fb720eddacf4b16f775c9b4d0bdf3914fbaa';
const DATASET_SHA256 = '7ee0a75c41bfc954fd441b67ce738fc5c1cbae00721c4e30e7db4d893057c9ab';
// These are hashes of this adapter's JSONL v1 export, not hashes published by Hugging Face.
const EVALUATOR_JSONL_SHA256 = '9ae00e2689252f4dcff5fa282f5df8aca8e1988dfde25ab55464e6af80d30858';
const ROLLOUT_JSONL_SHA256 = '67628f054127ae5a4c1a31cf2e93be656f77cb6b81b6a4a7e9beb191d3d81e21';

class UserError extends Error {}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function prepare(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !['--parquet', '--output', '--python'].includes(flag) ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(options, flag)
    ) {
      throw new UserError('prepare requires --parquet, --output and --python');
    }
    options[flag] = value;
  }
  if (!options['--parquet'] || !options['--output'] || !options['--python']) {
    throw new UserError('prepare requires --parquet, --output and --python');
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-swe-live-'));
  try {
    const snapshot = path.join(stage, 'source.parquet');
    fs.copyFileSync(path.resolve(options['--parquet']), snapshot, fs.constants.COPYFILE_EXCL);
    if ((await hashFile(snapshot)) !== DATASET_SHA256)
      throw new UserError('official Lite parquet checksum mismatch');
    const evaluator = path.join(stage, 'evaluator.jsonl');
    const rollout = path.join(stage, 'rollout.jsonl');
    try {
      await runProcess(options['--python'], {
        args: [
          '-I',
          path.join(import.meta.dirname, 'lib', 'swebench-live-export.py'),
          snapshot,
          evaluator,
          rollout,
        ],
        cwd: import.meta.dirname,
        env: fixtureEnvironment(),
        timeout: 120_000,
        maxBuffer: 16_384,
      });
    } catch {
      throw new UserError('dataset conversion failed; use Python >= 3.10 with pyarrow installed');
    }
    if (readFixture(rollout).length !== 300)
      throw new UserError('official Lite row count mismatch');
    const evaluatorHash = await hashFile(evaluator);
    const rolloutHash = await hashFile(rollout);
    if (evaluatorHash !== EVALUATOR_JSONL_SHA256 || rolloutHash !== ROLLOUT_JSONL_SHA256) {
      throw new UserError('dataset export checksum mismatch');
    }
    const output = path.resolve(options['--output']);
    fs.mkdirSync(output, { mode: 0o700 });
    fs.mkdirSync(path.join(output, 'evaluator'), { mode: 0o700 });
    fs.mkdirSync(path.join(output, 'rollout'), { mode: 0o700 });
    for (const [src, dest] of [
      [evaluator, 'evaluator/dataset.jsonl'],
      [rollout, 'rollout/dataset.jsonl'],
    ]) {
      const target = path.join(output, dest);
      fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
    }
    const manifest = {
      dataset: 'SWE-bench-Live/SWE-bench-Live',
      split: 'lite',
      revision: DATASET_REVISION,
      parquet_sha256: DATASET_SHA256,
      rows: 300,
      evaluator_jsonl_sha256: evaluatorHash,
      rollout_jsonl_sha256: rolloutHash,
    };
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function verifyPreparedDataset(directory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    return (
      manifest.dataset === 'SWE-bench-Live/SWE-bench-Live' &&
      manifest.split === 'lite' &&
      manifest.rows === 300 &&
      manifest.revision === DATASET_REVISION &&
      manifest.parquet_sha256 === DATASET_SHA256 &&
      manifest.evaluator_jsonl_sha256 === EVALUATOR_JSONL_SHA256 &&
      manifest.rollout_jsonl_sha256 === ROLLOUT_JSONL_SHA256 &&
      (await hashFile(path.join(directory, 'evaluator', 'dataset.jsonl'))) ===
        EVALUATOR_JSONL_SHA256 &&
      (await hashFile(path.join(directory, 'rollout', 'dataset.jsonl'))) === ROLLOUT_JSONL_SHA256
    );
  } catch {
    return false;
  }
}

async function preflight(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !['--docker-fixture', '--budget-usd', '--dataset'].includes(flag) ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(options, flag)
    ) {
      throw new Error('invalid preflight arguments');
    }
    options[flag] = value;
  }
  const dockerEnv = fixtureEnvironment();
  if (!options['--docker-fixture']) {
    for (const key of [
      'HOME',
      'USERPROFILE',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'DOCKER_CERT_PATH',
      'DOCKER_TLS',
      'DOCKER_TLS_VERIFY',
      'DOCKER_API_VERSION',
    ]) {
      if (process.env[key] !== undefined) dockerEnv[key] = process.env[key];
    }
  }
  let dockerAvailable = false;
  try {
    const fixture = options['--docker-fixture'];
    const result = await runProcess(fixture ? process.execPath : 'docker', {
      args: [
        ...(fixture ? [path.resolve(fixture)] : []),
        'version',
        '--format',
        '{{.Server.Version}}',
      ],
      env: dockerEnv,
      timeout: 5_000,
      maxBuffer: 16_384,
    });
    dockerAvailable = !result.stdoutOverflow && Boolean(result.stdout.trim());
  } catch {
    // Only the probe result is recorded; Docker output may contain sensitive context.
  }
  const blockers = [
    'fixture_only',
    'isolation',
    'temporal_guard',
    'full_trajectory',
    'pricing_estimate',
    'official_evaluator',
    'resource_capacity',
    'provider_reachability',
  ];
  if (!options['--dataset'] || !(await verifyPreparedDataset(path.resolve(options['--dataset'])))) {
    blockers.push('dataset_snapshot');
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if ((major !== 22 && major !== 24) || (major === 22 && minor < 16)) {
    blockers.push('node_version');
  }
  if (!fs.existsSync(path.join(import.meta.dirname, '..', 'dist', 'cli.js')))
    blockers.push('moss_build');
  if (!dockerAvailable) blockers.push('docker_server');
  if (!process.env.MOSS_BENCH_API_KEY?.trim()) blockers.push('model_key');
  if (!process.env.MOSS_BENCH_MODEL?.trim()) blockers.push('model');
  if (!process.env.MOSS_BENCH_BASE_URL?.trim()) blockers.push('model_endpoint');
  const budget = Number(options['--budget-usd']);
  if (!Number.isFinite(budget) || budget <= 0) blockers.push('budget');
  if (options['--docker-fixture']) blockers.push('synthetic_docker_probe');
  console.log(
    JSON.stringify(
      {
        status: 'incomplete',
        official_run_enabled: false,
        blockers,
        limitations: ['ssh_agent_not_forwarded'],
      },
      null,
      2
    )
  );
  process.exitCode = 2;
}

async function main() {
  if (process.argv[2] === 'fixture') return runFixture(parseOptions(process.argv.slice(3)));
  if (process.argv[2] === 'preflight') return preflight(process.argv.slice(3));
  if (process.argv[2] === 'prepare') return prepare(process.argv.slice(3));
  throw new UserError('expected prepare, fixture or preflight command');
}

if (!processBoundary && process.argv[2] === 'preflight') {
  console.log(
    JSON.stringify({
      status: 'incomplete',
      official_run_enabled: false,
      blockers: ['moss_build'],
      checks_skipped: ['dataset_snapshot', 'docker_server', 'provider', 'budget', 'protocol'],
    })
  );
  process.exitCode = 2;
} else if (!processBoundary) {
  console.error('Build Moss before using SWE-bench-Live commands');
  process.exitCode = 1;
} else {
  main().catch((error) => {
    console.error(error instanceof UserError ? error.message : 'SWE-bench-Live command failed');
    process.exitCode = 1;
  });
}
