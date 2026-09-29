#!/usr/bin/env node
// Aggregate same-SHA repeat runs into bench/results/noise-band.json.
// Usage: node scripts/bench-noise.mjs <runLabel1> <runLabel2> [<runLabel3> ...]
// Rule: maxDropPerTask = the largest per-task pass-rate gap observed between
// any two runs — a task that swings across identical code is measurement
// noise; a future drop larger than this is treated as a real regression.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const resultsRoot = path.join(root, 'bench', 'results');
const USAGE =
  'Usage: npm run bench:noise -- <label1> <label2> [...more]\n' +
  'Aggregates same-SHA repeat runs into bench/results/noise-band.json.\n' +
  'Rule: maxDropPerTask = the largest per-task pass-rate gap observed between\n' +
  'any two runs — a future drop larger than this is treated as a real regression.';
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
  const p = path.join(resultsRoot, label, 'summary.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
});
const shas = new Set(summaries.map((s) => s.meta?.gitSha));
if (shas.size > 1) {
  console.error(`[bench-noise] refusing: runs span different SHAs (${[...shas].join(', ')})`);
  process.exit(2);
}
let maxDropPerTask = 0;
const detail = {};
for (const task of summaries[0].perTask ?? []) {
  const id = task.task;
  const rates = summaries.map((s) => {
    const t = (s.perTask ?? []).find((x) => x.task === id);
    return t && t.samples > 0 ? t.passes / t.samples : undefined;
  });
  const valid = rates.filter((r) => r !== undefined);
  if (valid.length < 2) continue;
  const drop = Math.max(...valid) - Math.min(...valid);
  detail[id] = { rates: valid, swing: Number(drop.toFixed(3)) };
  maxDropPerTask = Math.max(maxDropPerTask, drop);
}
const out = {
  computedAt: new Date().toISOString(),
  gitSha: summaries[0].meta?.gitSha,
  runs: labels,
  samplesPerRun: summaries[0].meta?.samples,
  maxDropPerTask: Number(maxDropPerTask.toFixed(3)),
  perTask: detail,
};
fs.writeFileSync(path.join(resultsRoot, 'noise-band.json'), JSON.stringify(out, null, 2));
console.log(`[bench-noise] noise band (max per-task swing): ${(maxDropPerTask * 100).toFixed(0)}%`);
console.log(`[bench-noise] written: ${path.join(resultsRoot, 'noise-band.json')}`);
