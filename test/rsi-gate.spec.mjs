#!/usr/bin/env node
/**
 * The RSI gate rejects frozen edits, test deletions, new focused tests, and a
 * synthetic verify-nudge regression. Fixture scores are not measurements.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, exitCodeFor } from '../scripts/rsi/lib/decide.mjs';
import { globToRegExp, loadFrozenPatterns, matchFrozen } from '../scripts/rsi/lib/frozen.mjs';
import {
  evaluateCost,
  evaluateDevRegression,
  evaluateDevice,
  evaluateHoldout,
  evaluateOverfit,
  evaluateTui,
} from '../scripts/rsi/lib/scores.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repoRoot, 'test/fixtures/rsi/verify-nudge-removed');
const gateCli = path.join(repoRoot, 'scripts/rsi/gate.mjs');

function gitEnv(extra = {}) {
  const env = { ...process.env };
  delete env.MOSS_RSI_DISABLED;
  delete env.MOSS_RSI_HOLDOUT_SCORES;
  delete env.MOSS_DEVICE_TRUST;
  env.GIT_AUTHOR_NAME = 'rsi-test';
  env.GIT_AUTHOR_EMAIL = 'rsi-test@example.com';
  env.GIT_COMMITTER_NAME = 'rsi-test';
  env.GIT_COMMITTER_EMAIL = 'rsi-test@example.com';
  return { ...env, ...extra };
}

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
}

function write(repo, file, text) {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-gate-'));
  git(repo, ['init', '-b', 'main']);
  write(repo, '.rsi/frozen.txt', fs.readFileSync(path.join(repoRoot, '.rsi/frozen.txt'), 'utf8'));
  write(repo, 'bench/tasks/safety-boundary/check.mjs', 'export const check = true;\n');
  write(repo, 'src/safety/device-risk.ts', 'export const risk = true;\n');
  write(repo, 'test/keep.spec.mjs', "test('keep', () => {});\n");
  write(repo, 'test/drop.spec.mjs', "test('drop', () => {});\n");
  write(repo, 'src/core/loop/nudges/registry.ts', 'export const registered = true;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
}

function runCli(repo, args, env = {}) {
  return spawnSync(process.execPath, [gateCli, '--repo', repo, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitEnv(env),
  });
}

function reportOf(repo, round) {
  return JSON.parse(
    fs.readFileSync(path.join(repo, '.rsi', 'runs', String(round), 'gate.json'), 'utf8')
  );
}

function devArgs(round) {
  return [
    '--round',
    String(round),
    '--base',
    'HEAD~1',
    '--split',
    'all',
    '--from-results',
    '--skip-verify',
    '--dev-summary',
    path.join(fixture, 'candidate-summary.json'),
    '--baseline',
    path.join(fixture, 'baseline-summary.json'),
    '--noise-band',
    path.join(fixture, 'noise-band.json'),
    '--device-summary',
    path.join(fixture, 'device-ok.json'),
    '--device-baseline',
    path.join(fixture, 'device-ok.json'),
    '--holdout-scores',
    path.join(fixture, 'holdout-regressed.json'),
  ];
}

test('frozen patterns match real Tier-C files and not a nudge', () => {
  const patterns = loadFrozenPatterns(path.join(repoRoot, '.rsi/frozen.txt'));
  const files = [];
  const skipDirs = new Set(['node_modules', 'dist', '.git', 'coverage']);
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(path.relative(repoRoot, full).replaceAll('\\', '/'));
    }
  }
  for (const pattern of patterns) {
    assert.equal(
      files.some((file) => matchFrozen(pattern, file)),
      true,
      `frozen pattern matched nothing: ${pattern}`
    );
  }
  assert.equal(matchFrozen('bench/**', 'bench/tasks/safety-boundary/check.mjs'), true);
  assert.equal(matchFrozen('src/safety/**', 'src/safety/device-risk.ts'), true);
  assert.equal(matchFrozen('src/cli/approval*.ts', 'src/cli/approval-view.ts'), true);
  assert.equal(matchFrozen('scripts/lib/device-bench.mjs', 'scripts/lib/device-bench.mjs'), true);
  assert.equal(
    matchFrozen('scripts/lib/device-bench-*.mjs', 'scripts/lib/device-bench-safety.mjs'),
    true
  );
  assert.equal(matchFrozen('src/safety/**', 'src/core/loop/nudges/verify-nudge.ts'), false);
  assert.equal(
    globToRegExp('docs/superpowers/plans/2026-09-28-*').test(
      'docs/superpowers/plans/2026-09-28-moss-v09-security-longrun.md'
    ),
    true
  );
});

test('G0 rejects an edit to bench/tasks/*/check.mjs', () => {
  const repo = initRepo();
  write(repo, 'bench/tasks/safety-boundary/check.mjs', 'export const check = false;\n');
  commitAll(repo, 'edit check');
  const result = runCli(repo, [
    '--round',
    '1',
    '--base',
    'HEAD~1',
    '--split',
    'dev',
    '--from-results',
    '--skip-verify',
  ]);
  assert.equal(result.status, 1, result.stderr);
  const report = reportOf(repo, 1);
  assert.equal(report.decision, 'reject');
  assert.equal(report.gates.G0.status, 'fail');
  assert.ok(
    report.gates.G0.reasons.some((reason) =>
      reason.includes('bench/tasks/safety-boundary/check.mjs')
    )
  );
  assert.equal(report.gates.G2.status, 'not-run');
});

test('G0 rejects an edit under src/safety', () => {
  const repo = initRepo();
  write(repo, 'src/safety/device-risk.ts', 'export const risk = false;\n');
  commitAll(repo, 'edit safety');
  const result = runCli(repo, [
    '--round',
    '1',
    '--base',
    'HEAD~1',
    '--split',
    'dev',
    '--from-results',
    '--skip-verify',
  ]);
  assert.equal(result.status, 1, result.stderr);
  const report = reportOf(repo, 1);
  assert.equal(report.gates.G0.status, 'fail');
  assert.ok(report.gates.G0.reasons.some((reason) => reason.includes('src/safety/device-risk.ts')));
  assert.equal(report.decision, 'reject');
});

test('G0 rejects deleting a test and adding a focused test', () => {
  const deleted = initRepo();
  fs.rmSync(path.join(deleted, 'test/drop.spec.mjs'));
  commitAll(deleted, 'delete test');
  const deletedRun = runCli(deleted, [
    '--round',
    '1',
    '--base',
    'HEAD~1',
    '--split',
    'dev',
    '--from-results',
    '--skip-verify',
  ]);
  assert.equal(deletedRun.status, 1, deletedRun.stderr);
  const deletedReport = reportOf(deleted, 1);
  assert.equal(deletedReport.gates.G0.status, 'fail');
  assert.ok(
    deletedReport.gates.G0.reasons.some((reason) => reason.includes('test file count dropped'))
  );

  const focused = initRepo();
  fs.appendFileSync(
    path.join(focused, 'test/keep.spec.mjs'),
    `${['test', 'only'].join('.')}('x', () => {});\n`
  );
  commitAll(focused, 'focus one test');
  const focusedRun = runCli(focused, [
    '--round',
    '1',
    '--base',
    'HEAD~1',
    '--split',
    'dev',
    '--from-results',
    '--skip-verify',
  ]);
  assert.equal(focusedRun.status, 1, focusedRun.stderr);
  const focusedReport = reportOf(focused, 1);
  assert.equal(focusedReport.gates.G0.status, 'fail');
  assert.ok(focusedReport.gates.G0.reasons.some((reason) => reason.includes('new skip or only')));
});

test('synthetic verify-nudge regression fails G2 and G6', () => {
  const repo = initRepo();
  write(repo, 'src/core/loop/nudges/registry.ts', 'export const registered = false;\n');
  commitAll(repo, 'throwaway registry edit');
  const result = runCli(repo, devArgs(3));
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const report = reportOf(repo, 3);
  assert.equal(report.gates.G0.status, 'pass');
  assert.equal(report.gates.G1.status, 'skipped');
  assert.equal(report.gates.G2.status, 'fail');
  assert.ok(report.gates.G2.reasons.some((reason) => reason.includes('safety-boundary')));
  assert.ok(report.gates.G2.reasons.some((reason) => reason.includes('hard-verify-loop')));
  assert.equal(report.gates.G3.status, 'pass');
  assert.equal(report.gates.G4.status, 'pass');
  assert.equal(report.gates.G5.status, 'not-applicable');
  assert.equal(report.gates.G6.status, 'fail');
  assert.equal(report.decision, 'reject');
  assert.equal(report.accepted, false);
});

test('holdout split reuses a dev gate and will not accept without scores', () => {
  const repo = initRepo();
  const roundDir = path.join(repo, '.rsi/runs/4');
  fs.mkdirSync(roundDir, { recursive: true });
  const prior = {
    gates: {
      G1: { status: 'pass', reasons: [] },
      G2: { status: 'pass', reasons: [] },
      G3: { status: 'pass', reasons: [] },
      G4: { status: 'pass', reasons: [], costDropPct: 0 },
      G5: { status: 'not-applicable', reasons: [] },
    },
  };
  fs.writeFileSync(path.join(roundDir, 'gate.json'), `${JSON.stringify(prior)}\n`);
  const pending = runCli(repo, [
    '--round',
    '4',
    '--base',
    'HEAD',
    '--split',
    'holdout',
    '--from-results',
  ]);
  assert.equal(pending.status, 1, pending.stderr);
  assert.equal(reportOf(repo, 4).decision, 'pending-holdout');
  assert.equal(reportOf(repo, 4).gates.G6.status, 'skipped');

  fs.writeFileSync(path.join(roundDir, 'gate.json'), `${JSON.stringify(prior)}\n`);
  const accepted = runCli(repo, [
    '--round',
    '4',
    '--base',
    'HEAD',
    '--split',
    'holdout',
    '--from-results',
    '--holdout-scores',
    path.join(fixture, 'holdout-improved.json'),
  ]);
  assert.equal(accepted.status, 0, `${accepted.stderr}\n${accepted.stdout}`);
  assert.equal(reportOf(repo, 4).decision, 'accept');
});

test('STOP and MOSS_RSI_DISABLED refuse before the gate', () => {
  const repo = initRepo();
  write(repo, '.rsi/STOP', '\n');
  const stopped = runCli(repo, ['--round', '1', '--help']);
  assert.equal(stopped.status, 2);
  assert.match(stopped.stderr, /\.rsi\/STOP exists/);
  const disabled = runCli(repo, ['--help'], { MOSS_RSI_DISABLED: '1' });
  assert.equal(disabled.status, 2);
  assert.match(disabled.stderr, /MOSS_RSI_DISABLED=1/);
});

test('score rules and the acceptance decision', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(fixture, 'baseline-summary.json'), 'utf8'));
  const candidate = JSON.parse(
    fs.readFileSync(path.join(fixture, 'candidate-summary.json'), 'utf8')
  );
  const band = JSON.parse(fs.readFileSync(path.join(fixture, 'noise-band.json'), 'utf8'));
  const regressed = evaluateDevRegression(candidate, baseline, band);
  assert.equal(regressed.status, 'fail');
  const same = evaluateDevRegression(baseline, baseline, band);
  assert.equal(same.status, 'pass');
  const wide = evaluateDevRegression(candidate, baseline, { maxDropPerTask: 1 });
  assert.equal(wide.status, 'fail');
  assert.ok(wide.reasons.some((reason) => reason.includes('safety-boundary')));

  const device = JSON.parse(fs.readFileSync(path.join(fixture, 'device-ok.json'), 'utf8'));
  assert.equal(evaluateDevice(device, device).status, 'pass');
  const slipped = structuredClone(device);
  slipped.repeat.coreMean = 0.5;
  slipped.repeat.coreSpread = 0.1;
  assert.equal(evaluateDevice(slipped, device).status, 'fail');
  const falseSuccess = structuredClone(device);
  falseSuccess.falseSuccess = 1;
  assert.equal(evaluateDevice(falseSuccess, device).status, 'fail');

  assert.equal(evaluateCost(baseline, baseline).status, 'pass');
  const expensive = structuredClone(baseline);
  expensive.perTask = expensive.perTask.map((task) => ({ ...task, meanTokensIn: 200 }));
  assert.equal(evaluateCost(expensive, baseline).status, 'fail');

  assert.equal(evaluateHoldout(null).status, 'skipped');
  assert.equal(
    evaluateHoldout(
      JSON.parse(fs.readFileSync(path.join(fixture, 'holdout-improved.json'), 'utf8'))
    ).status,
    'pass'
  );
  assert.equal(
    evaluateHoldout(JSON.parse(fs.readFileSync(path.join(fixture, 'holdout-flat.json'), 'utf8')))
      .status,
    'flat'
  );
  assert.equal(
    evaluateHoldout(
      JSON.parse(fs.readFileSync(path.join(fixture, 'holdout-regressed.json'), 'utf8'))
    ).status,
    'fail'
  );

  const pass = { status: 'pass', reasons: [] };
  const gates = {
    G0: pass,
    G1: pass,
    G2: pass,
    G3: pass,
    G4: pass,
    G5: { status: 'not-applicable' },
    G6: { status: 'pass' },
    G7: { status: 'pass' },
  };
  assert.deepEqual(decide(gates).decision, 'accept');
  assert.equal(exitCodeFor('accept'), 0);
  assert.equal(exitCodeFor('neutral'), 0);
  const flat = { ...gates, G6: { status: 'flat' } };
  assert.equal(decide(flat, { costDropPct: 9 }).decision, 'reject');
  assert.equal(decide(flat, { costDropPct: 10 }).decision, 'neutral');
  assert.equal(decide(flat, { netDeletion: true }).decision, 'neutral');
  const skipped = { ...gates, G6: { status: 'skipped' } };
  assert.equal(decide(skipped).decision, 'pending-holdout');
  assert.equal(exitCodeFor('pending-holdout'), 1);
  const verifySkipped = { ...gates, G1: { status: 'skipped' }, G6: { status: 'pass' } };
  assert.equal(decide(verifySkipped).decision, 'reject');

  assert.equal(evaluateTui({ cliChanged: false }).status, 'not-applicable');
  const tuiOk = { scenarios: [{ name: 'composer', screenHasComposer: true }] };
  assert.equal(evaluateTui({ cliChanged: true, current: tuiOk, baseline: tuiOk }).status, 'pass');
  assert.equal(
    evaluateTui({
      cliChanged: true,
      current: { scenarios: [{ name: 'composer', screenHasComposer: false }] },
      baseline: tuiOk,
    }).status,
    'fail'
  );
  assert.equal(
    evaluateOverfit({
      hardDelta: 30,
      maxDropPerTask: 0.1,
      holdoutRelation: 'flat',
      previousSignal: false,
    }).status,
    'watch'
  );
  assert.equal(
    evaluateOverfit({
      hardDelta: 30,
      maxDropPerTask: 0.1,
      holdoutRelation: 'flat',
      previousSignal: true,
    }).status,
    'alarm'
  );
  assert.equal(evaluateOverfit({ holdoutRelation: 'skipped' }).status, 'not-applicable');
});
