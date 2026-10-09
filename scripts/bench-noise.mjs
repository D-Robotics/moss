#!/usr/bin/env node
// Aggregate same-SHA repeat runs into bench/results/noise-band.json.
// Usage: node scripts/bench-noise.mjs <runLabel1> <runLabel2> [<runLabel3> ...]
// The selection threshold is the aggregate band: the largest pairwise gap in
// overall pass rate, plus the relative token-cost spread. maxDropPerTask stays
// in the file for reporting only — with 3 samples one task can swing 0→1,
// which is not a unit you can compare to an aggregate gain.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { noiseFromRates } from './rsi/lib/rule.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const resultsRoot = path.join(root, 'bench', 'results');
const USAGE =
  'Usage: npm run bench:noise -- <label1> <label2> [...more]\n' +
  'Aggregates same-SHA repeat runs into bench/results/noise-band.json.\n' +
  'Emits maxAggregateSwing (max pairwise aggregate passRate gap), passRateStd,\n' +
  'and costSpread. maxDropPerTask is kept for reporting only.';

function scoredTasks(summary) {
  return (summary?.perTask ?? []).filter(
    (task) =>
      Number.isInteger(task?.samples) &&
      task.samples > 0 &&
      Number.isInteger(task?.passes) &&
      task.passes >= 0 &&
      task.passes <= task.samples
  );
}

function aggregatePassRate(summary) {
  const tasks = scoredTasks(summary);
  if (tasks.length === 0) return null;
  return tasks.reduce((sum, task) => sum + task.passes / task.samples, 0) / tasks.length;
}

function aggregateTokenMean(summary) {
  const tasks = scoredTasks(summary).filter(
    (task) =>
      Number.isFinite(task.meanTokensIn) &&
      task.meanTokensIn >= 0 &&
      Number.isFinite(task.meanTokensOut) &&
      task.meanTokensOut >= 0
  );
  if (tasks.length !== scoredTasks(summary).length || tasks.length === 0) return null;
  return (
    tasks.reduce((sum, task) => sum + task.meanTokensIn + task.meanTokensOut, 0) / tasks.length
  );
}

export function aggregateNoise(summaries, labels = []) {
  if (!Array.isArray(summaries) || summaries.length < 2) {
    throw new Error('need at least two summaries');
  }
  const passRates = [];
  const tokenMeans = [];
  for (const summary of summaries) {
    const rate = aggregatePassRate(summary);
    const tokens = aggregateTokenMean(summary);
    if (rate === null || tokens === null) {
      throw new Error('each run needs scored tasks with pass rates and token means');
    }
    passRates.push(rate);
    tokenMeans.push(tokens);
  }
  let maxDropPerTask = 0;
  const detail = {};
  for (const task of summaries[0].perTask ?? []) {
    const id = task.task;
    const rates = summaries.map((summary) => {
      const row = (summary.perTask ?? []).find((item) => item.task === id);
      return row && row.samples > 0 ? row.passes / row.samples : undefined;
    });
    const valid = rates.filter((rate) => rate !== undefined);
    if (valid.length < 2) continue;
    const drop = Math.max(...valid) - Math.min(...valid);
    detail[id] = { rates: valid, swing: Number(drop.toFixed(3)) };
    maxDropPerTask = Math.max(maxDropPerTask, drop);
  }
  const stats = noiseFromRates(passRates, tokenMeans);
  return {
    gitSha: summaries[0].meta?.gitSha,
    model: summaries[0].meta?.model,
    temperature: summaries[0].meta?.temperature,
    runs: labels,
    samplesPerRun: summaries[0].meta?.samples,
    maxDropPerTask: Number(maxDropPerTask.toFixed(3)),
    maxAggregateSwing: stats.maxAggregateSwing,
    passRateStd: stats.passRateStd,
    costSpread: stats.costSpread,
    aggregate: { passRates, tokenMeans },
    perTask: detail,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const labels = argv;
  if (labels.length < 2) {
    console.error(USAGE);
    process.exit(2);
  }
  const summaries = labels.map((label) => {
    const file = path.join(resultsRoot, label, 'summary.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  });
  const shas = new Set(summaries.map((summary) => summary.meta?.gitSha));
  const models = new Set(summaries.map((summary) => summary.meta?.model));
  const samples = new Set(summaries.map((summary) => summary.meta?.samples));
  const temperatures = new Set(summaries.map((summary) => summary.meta?.temperature));
  if (shas.size !== 1 || models.size !== 1 || samples.size !== 1 || temperatures.size !== 1) {
    console.error('[bench-noise] refusing: runs must share SHA, model, samples, and temperature');
    process.exit(2);
  }
  let out;
  try {
    out = aggregateNoise(summaries, labels);
  } catch (error) {
    console.error(`[bench-noise] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  out.computedAt = new Date().toISOString();
  fs.mkdirSync(resultsRoot, { recursive: true });
  fs.writeFileSync(path.join(resultsRoot, 'noise-band.json'), JSON.stringify(out, null, 2));
  const swing = (out.maxAggregateSwing * 100).toFixed(1);
  const std = (out.passRateStd * 100).toFixed(1);
  const cost = (out.costSpread * 100).toFixed(1);
  console.log(`[bench-noise] aggregate band (max pairwise passRate): ${swing}%`);
  console.log(`[bench-noise] passRate sample std: ${std}%`);
  console.log(`[bench-noise] token cost spread: ${cost}%`);
  console.log(
    `[bench-noise] per-task max swing (reporting only): ${(out.maxDropPerTask * 100).toFixed(0)}%`
  );
  console.log(`[bench-noise] written: ${path.join(resultsRoot, 'noise-band.json')}`);
}

function isDirect() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirect()) main();
