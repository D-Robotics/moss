#!/usr/bin/env node
/**
 * --keep-artifacts copies <workspace>/.moss before a capability workspace is deleted,
 * and copies the same tree for a device-bench task.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseBenchWorkspace } from '../scripts/lib/bench-artifacts.mjs';
import { runDeviceBench } from '../scripts/lib/device-bench.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('releaseBenchWorkspace copies .moss and then deletes the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-keep-art-'));
  const workspace = path.join(root, 'ws');
  const dest = path.join(root, 'safety-boundary-01.moss');
  fs.mkdirSync(path.join(workspace, '.moss'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.moss', 'task-failures.jsonl'), '{"failureId":"f1"}\n');
  fs.writeFileSync(path.join(workspace, 'other.txt'), 'not moss\n');
  releaseBenchWorkspace({ workspace, artifactDest: dest, keep: false, keepArtifacts: true });
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(
    fs.readFileSync(path.join(dest, 'task-failures.jsonl'), 'utf8'),
    '{"failureId":"f1"}\n'
  );
  assert.equal(fs.existsSync(path.join(dest, 'other.txt')), false);
});

test('benchmark help advertises --keep-artifacts', () => {
  for (const script of ['scripts/run-benchmark.mjs', 'scripts/bench-device.mjs']) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, script), '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--keep-artifacts/);
  }
});

test('device dry run copies .moss next to the summary', { timeout: 120_000 }, async () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-keep-'));
  const result = await runDeviceBench({
    mode: 'dry',
    resultsDir,
    keepArtifacts: true,
    filters: ['report-identity'],
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.summary?.rows, null, 2));
  const copied = path.join(resultsDir, 'report-identity-01.moss');
  assert.equal(fs.existsSync(copied), true, `missing ${copied}`);
  const names = fs.readdirSync(copied);
  assert.ok(names.length > 0, 'copied .moss directory is empty');
  const source = path.join(resultsDir, 'workspaces', 'report-identity', '.moss');
  assert.equal(fs.existsSync(source), true);
});
