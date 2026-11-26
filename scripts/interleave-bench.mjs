#!/usr/bin/env node
// Alternate two Moss builds over the same bench tasks, one sample per invocation.
//
//   node scripts/interleave-bench.mjs <cliA> <labelA> <cliB> <labelB> <samplesPerTask> <outDir> <task...>
//   node scripts/interleave-bench.mjs --merge-only <labelA> <labelB> <samplesPerTask> <outDir> <task...>
//
// Each invocation runs scripts/run-benchmark.mjs once with --samples 1, and MOSS_BENCH_CLI points at
// the build under test. Odd samples run A then B, even samples run B then A, so drift in model-service
// latency does not favour either build. Runs land in bench/results/il-<label>-<task>-<n>/ and are
// merged into one summary per arm under <outDir>, which scripts/compare-bench-results.mjs can read.
// A one-sample run records sample 1 every time, so the merge writes the real sample index back.
// --merge-only rebuilds <outDir> from runs that already exist.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(repoRoot, 'bench/results');

const args = process.argv.slice(2);
const mergeOnly = args[0] === '--merge-only';
const rest = mergeOnly ? args.slice(1) : args;
const cliCount = mergeOnly ? 0 : 2;
const [labelA, labelB, samplesText, outDir, ...tasks] = rest.slice(cliCount);
const samples = Number(samplesText);
if (
  !labelA ||
  !labelB ||
  labelA === labelB ||
  !Number.isInteger(samples) ||
  samples < 1 ||
  !outDir ||
  tasks.length === 0
) {
  console.error(
    'usage: interleave-bench.mjs [--merge-only] <cliA> <labelA> <cliB> <labelB> <samplesPerTask> <outDir> <task...>'
  );
  process.exit(2);
}
const arms = [
  { label: labelA, cli: mergeOnly ? null : path.resolve(rest[0]) },
  { label: labelB, cli: mergeOnly ? null : path.resolve(rest[1]) },
];

const summaryPath = (label) => path.join(resultsDir, label, 'summary.json');
const readRun = (label) => JSON.parse(fs.readFileSync(summaryPath(label), 'utf8'));

const problems = [];
if (!mergeOnly) {
  for (const task of tasks) {
    for (let n = 1; n <= samples; n++) {
      const order = n % 2 === 1 ? arms : [...arms].reverse();
      for (const arm of order) {
        const label = `il-${arm.label}-${task}-${n}`;
        const result = spawnSync(
          process.execPath,
          ['scripts/run-benchmark.mjs', '--samples', '1', '--task', task, '--label', label],
          {
            cwd: repoRoot,
            encoding: 'utf8',
            env: { ...process.env, MOSS_BENCH_CLI: arm.cli },
            maxBuffer: 64 * 1024 * 1024,
          }
        );
        if (result.status !== 0 || !fs.existsSync(summaryPath(label))) {
          problems.push(`${label}: runner exited ${result.status}`);
          console.log(`${label}: runner exited ${result.status}`);
          continue;
        }
        const row = readRun(label).rows[0];
        console.log(
          `${label}: ${row.pass ? 'PASS' : 'FAIL'} ${row.numTurns} turns ` +
            `${(row.wallMs / 1000).toFixed(1)}s out=${row.tokensOut}`
        );
        if (row.pass !== true) problems.push(`${label}: check failed`);
      }
    }
  }
}

const ledger = [];
for (const task of tasks) {
  for (let n = 1; n <= samples; n++) {
    const runs = {};
    for (const arm of arms) {
      const label = `il-${arm.label}-${task}-${n}`;
      if (!fs.existsSync(summaryPath(label))) {
        if (!problems.some((problem) => problem.startsWith(label)))
          problems.push(`${label}: missing`);
        continue;
      }
      const summary = readRun(label);
      if (summary.rows.length !== 1) {
        problems.push(`${label}: ${summary.rows.length} rows, expected 1`);
        continue;
      }
      const row = { ...summary.rows[0], sample: n };
      ledger.push({
        task,
        sample: n,
        arm: arm.label,
        label,
        startedAt: summary.meta.startedAt,
        finishedAt: summary.meta.finishedAt,
        row,
      });
      runs[arm.label] = summary;
    }
    if (runs[labelA] && runs[labelB]) {
      const aFirst = runs[labelA].meta.startedAt < runs[labelB].meta.startedAt;
      if (aFirst !== (n % 2 === 1)) problems.push(`${task} #${n}: runs did not alternate`);
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
for (const arm of arms) {
  const mine = ledger.filter((entry) => entry.arm === arm.label);
  if (mine.length === 0) continue;
  const first = readRun(mine[0].label);
  const startedAt = mine.map((entry) => entry.startedAt).sort()[0];
  const finishedAt = mine
    .map((entry) => entry.finishedAt)
    .sort()
    .at(-1);
  const dir = path.join(outDir, arm.label);
  fs.mkdirSync(dir, { recursive: true });
  const rows = mine.map((entry) => entry.row);
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    `${JSON.stringify(
      {
        ...first,
        meta: { ...first.meta, mergedFrom: arm.label, runs: rows.length, startedAt, finishedAt },
        rows,
      },
      null,
      2
    )}\n`
  );
  console.log(`${arm.label}: ${rows.length} rows, ${startedAt} to ${finishedAt}`);
}

const incomplete = ledger.filter(
  (entry) => entry.row.pass === true && entry.row.mossExitCode !== 0
);
fs.writeFileSync(
  path.join(outDir, 'ledger.json'),
  `${JSON.stringify({ arms: arms.map((arm) => arm.label), tasks, samples, ledger }, null, 2)}\n`
);
console.log(`passed runs that still exited non-zero: ${incomplete.length}`);
console.log(`problems: ${problems.length}${problems.length ? ` (${problems.join('; ')})` : ''}`);
process.exit(problems.length ? 1 : 0);
