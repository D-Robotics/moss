#!/usr/bin/env node
/** Aggregate noise stats and the reproducible dev-task sample. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateNoise } from '../scripts/bench-noise.mjs';
import { sampleTaskIds } from '../scripts/run-benchmark.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noiseDir = path.join(repoRoot, 'test/fixtures/rsi/noise-7cd9cc00');

function loadMeasured(name) {
  return JSON.parse(fs.readFileSync(path.join(noiseDir, name), 'utf8'));
}

test('three measured same-SHA runs produce an aggregate band, not only a per-task swing', () => {
  const summaries = ['noise-a.json', 'noise-b.json', 'noise-c.json'].map(loadMeasured);
  const band = aggregateNoise(summaries, ['noise-a', 'noise-b', 'noise-c']);
  assert.equal(band.gitSha, '7cd9cc00');
  assert.equal(band.model, 'deepseek-flash');
  assert.equal(band.temperature, 0);
  assert.equal(band.samplesPerRun, 3);
  assert.deepEqual(
    band.aggregate.passRates.map((rate) => Number(rate.toFixed(3))),
    [0.893, 0.92, 0.92]
  );
  assert.ok(Math.abs(band.maxAggregateSwing - (0.92 - 67 / 75)) < 1e-12);
  assert.ok(Math.abs(band.passRateStd - 0.015396007178390054) < 1e-12);
  assert.ok(band.costSpread > 0.086 && band.costSpread < 0.087);
  assert.equal(band.maxDropPerTask, 0.667);
  assert.ok(band.maxDropPerTask > band.maxAggregateSwing);
  const totals = summaries.map((summary) =>
    Object.values(summary.tokensByModel).reduce((sum, value) => sum + value, 0)
  );
  assert.ok(Math.min(...totals) > 10_500_000);
  assert.ok(Math.max(...totals) < 11_500_000);
});

test('task sampling keeps safety-boundary and repeats for the same seed', () => {
  const ids = [
    'safety-boundary',
    ...Array.from({ length: 24 }, (_unused, index) => `task-${index}`),
  ];
  const first = sampleTaskIds(ids, 15, 'moss-bench');
  const again = sampleTaskIds([...ids].reverse(), 15, 'moss-bench');
  const other = sampleTaskIds(ids, 15, 'other-seed');
  assert.equal(first.length, 15);
  assert.ok(first.includes('safety-boundary'));
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.throws(() => sampleTaskIds(ids, 0), /positive integer/);
  assert.throws(() => sampleTaskIds(ids, 40), /exceeds/);
});
