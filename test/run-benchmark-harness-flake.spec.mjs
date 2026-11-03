import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, 'scripts', 'run-benchmark.mjs');
const fakeCli = path.join(root, 'test', 'fixtures', 'bench-harness-flake-cli.mjs');
const resultsRoot = path.join(root, 'bench', 'results');

function runFakeBenchmark(label, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-flake-home-'));
  const childEnv = { ...env };
  if (childEnv.MOSS_HARNESS_FLAKE_CLI_MODE === 'always-error') {
    fs.writeFileSync(path.join(home, '.harness-flake-always'), '1\n');
    delete childEnv.MOSS_HARNESS_FLAKE_CLI_MODE;
  }
  const run = spawnSync(
    process.execPath,
    [runner, '--task', 'single-edit', '--samples', '1', '--temperature', '0', '--label', label],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        LANG: 'C',
        LC_ALL: 'C',
        MOSS_BENCH_API_KEY: 'synthetic-bench-key',
        MOSS_BENCH_MODEL: 'synthetic-model',
        MOSS_BENCH_BASE_URL: 'https://synthetic.invalid/v1',
        MOSS_BENCH_CLI: fakeCli,
        ...childEnv,
      },
    }
  );
  return { run, home };
}

test('benchmark retries a zero-turn harness flake and scores the repaired rerun', (t) => {
  const label = 'moss-harness-flake-retry-test';
  const resultDir = path.join(resultsRoot, label);
  fs.rmSync(resultDir, { recursive: true, force: true });
  const { run, home } = runFakeBenchmark(label);
  t.after(() => {
    fs.rmSync(resultDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /harness_flake/);

  const summary = JSON.parse(fs.readFileSync(path.join(resultDir, 'summary.json'), 'utf8'));
  assert.equal(summary.meta.protocol.harnessFlakeRetryLimit, 2);
  assert.ok(Array.isArray(summary.rows));
  const row = summary.rows[0];
  assert.equal(row.pass, true);
  assert.equal(row.harnessFlake, true);
  assert.equal(row.attempt, 2);
  assert.equal(row.excludedAsHarnessFlake, undefined);
  assert.equal(row.harnessFlakeAttempts.length, 1);
  assert.equal(summary.overall.scoredRuns, 1);
  assert.equal(summary.harnessFlakes.retried, 1);
  assert.equal(summary.harnessFlakes.exhausted, 0);
  assert.equal(summary.perTask[0].scoredSamples, 1);
  assert.ok(fs.existsSync(path.join(resultDir, 'single-edit-01.jsonl')));
  assert.ok(fs.existsSync(path.join(resultDir, 'single-edit-01-attempt-02.jsonl')));
});

test('exhausted zero-turn flakes are excluded from capability scoring and listed separately', (t) => {
  const label = 'moss-harness-flake-exhausted-test';
  const resultDir = path.join(resultsRoot, label);
  fs.rmSync(resultDir, { recursive: true, force: true });
  const { run, home } = runFakeBenchmark(label, {
    MOSS_HARNESS_FLAKE_CLI_MODE: 'always-error',
  });
  t.after(() => {
    fs.rmSync(resultDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(resultDir, 'summary.json'), 'utf8'));
  const row = summary.rows[0];
  assert.equal(row.pass, false);
  assert.equal(row.attempt, 3);
  assert.equal(row.excludedAsHarnessFlake, true);
  assert.equal(summary.overall.scoredRuns, 0);
  assert.equal(summary.overall.passRate, null);
  assert.equal(summary.harnessFlakes.exhausted, 1);
  assert.equal(summary.capability.hardScore, null);
  assert.equal(summary.capability.easyScore, null);
});
