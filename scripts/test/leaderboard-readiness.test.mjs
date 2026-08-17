import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Terminal-Bench manifest and Moss adapter are pinned and credential-safe', () => {
  const manifest = JSON.parse(fs.readFileSync('benchmarks/harbor/manifest.json', 'utf8'));
  const adapter = fs.readFileSync('benchmarks/harbor/moss_agent.py', 'utf8');
  assert.equal(manifest.dataset, 'terminal-bench/terminal-bench-2');
  assert.equal(manifest.requiredTrials, 5);
  assert.equal(manifest.timeoutMultiplier, 1);
  assert.match(manifest.harborRevision, /^[a-f0-9]{40}$/);
  assert.match(manifest.terminalBenchRevision, /^[a-f0-9]{40}$/);
  assert.match(adapter, /require an exact --agent-version/);
  assert.match(adapter, /OPENAI_API_KEY/);
  assert.doesNotMatch(adapter, /sk-[A-Za-z0-9]{12,}/);
  const compile = spawnSync(
    'python3',
    ['-c', "compile(open('benchmarks/harbor/moss_agent.py').read(), 'moss_agent.py', 'exec')"],
    { encoding: 'utf8' }
  );
  assert.equal(compile.status, 0, compile.stderr);
});

test('leaderboard preflight reports credential blockers independently of host tools', () => {
  const env = { ...process.env };
  delete env.MOSS_HARBOR_AGENT_VERSION;
  delete env.MOSS_MODEL;
  delete env.OPENAI_API_KEY;
  const result = spawnSync(process.execPath, ['scripts/check-leaderboard-readiness.mjs'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executionStatus, 'blocked');
  assert.equal(report.submissionStatus, 'closed-pending-new-process');
  assert.ok(report.checks.some(({ id }) => id === 'docker'));
  assert.ok(report.checks.some(({ id, ok }) => id === 'agent-version' && !ok));
  assert.ok(report.checks.some(({ id, ok }) => id === 'model' && !ok));
  assert.ok(report.checks.some(({ id, ok }) => id === 'provider-key' && !ok));
});

test('multi-model review is syntax-valid and reads credentials only from environment', () => {
  const file = 'scripts/demo-multi-model-review.mjs';
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /process\.env\.OPENAI_API_KEY/);
  assert.match(source, /MOSS_REVIEW_MODELS/);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{12,}/);
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
});
