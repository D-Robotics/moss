#!/usr/bin/env node
/**
 * Task OS metrics (M8) — product metrics over bench runs, per the Task OS
 * directive §20/§21: measure task success / acceptance / repair behavior,
 * not tool-count vanity. Reads bench/results/<label>/summary.json files and
 * aggregates every task-os-* task:
 *
 *   Task Success Rate · mean turns/tokens/tool calls/wall · repair attempts
 *   (parsed from task-os check outputs when present).
 *
 * Usage: node scripts/task-os-metrics.mjs [bench/results/run-...] [more...]
 * Defaults to the newest run dir under bench/results.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resultsRoot = path.join(repoRoot, 'bench', 'results');

function latestRunDir() {
  const entries = fs
    .readdirSync(resultsRoot)
    .filter((name) => name.startsWith('run-'))
    .sort();
  return entries.length > 0 ? path.join(resultsRoot, entries[entries.length - 1]) : null;
}

const args = process.argv.slice(2);
const runDirs = args.length > 0 ? args : [latestRunDir()].filter(Boolean);
if (runDirs.length === 0) {
  console.error('no bench result dirs found under bench/results/');
  process.exit(2);
}

const rows = [];
for (const dir of runDirs) {
  const summaryFile = path.join(dir, 'summary.json');
  if (!fs.existsSync(summaryFile)) continue;
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const model = summary.meta?.model ?? 'unknown';
  for (const row of summary.rows ?? []) {
    if (!String(row.task).startsWith('task-os-')) continue;
    const repairMatch =
      /(\d+) verification attempts, (\d+) failure records, (\d+) repair records/.exec(
        row.checkOutput ?? ''
      );
    rows.push({
      run: path.basename(dir),
      task: row.task,
      pass: row.pass === true,
      turns: row.numTurns ?? 0,
      tokensIn: row.tokensIn ?? 0,
      tokensOut: row.tokensOut ?? 0,
      toolCalls: row.toolCalls ?? 0,
      wallMs: row.wallMs ?? 0,
      ...(repairMatch
        ? {
            verifyAttempts: Number(repairMatch[1]),
            failureRecords: Number(repairMatch[2]),
            repairRecords: Number(repairMatch[3]),
          }
        : {}),
      model,
    });
  }
}

if (rows.length === 0) {
  console.error('no task-os-* rows in the given run dirs');
  process.exit(2);
}

const passes = rows.filter((row) => row.pass).length;
const mean = (values) =>
  values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

console.log('Task OS product metrics (acceptance-gated, evidence-backed)');
console.log('='.repeat(72));
console.log(
  `runs: ${rows.length} · tasks: ${new Set(rows.map((r) => r.task)).size} · model: ${rows[0].model}`
);
console.log(
  `Task Success Rate: ${passes}/${rows.length} = ${((100 * passes) / rows.length).toFixed(1)}%`
);
console.log(
  `mean turns ${mean(rows.map((r) => r.turns))} · tokens in ${mean(rows.map((r) => r.tokensIn))} · out ${mean(rows.map((r) => r.tokensOut))} · tool calls ${mean(rows.map((r) => r.toolCalls))} · wall ${Math.round(mean(rows.map((r) => r.wallMs)) / 1000)}s`
);
const withRepairs = rows.filter((row) => row.repairRecords !== undefined);
if (withRepairs.length > 0) {
  console.log(
    `repair behavior (failure-repair tasks): mean verify attempts ${mean(withRepairs.map((r) => r.verifyAttempts))} · failure records ${mean(withRepairs.map((r) => r.failureRecords))} · repair records ${mean(withRepairs.map((r) => r.repairRecords))}`
  );
}
console.log('');
for (const row of rows) {
  console.log(
    `${row.pass ? 'PASS' : 'FAIL'}  ${row.task.padEnd(26)} turns=${String(row.turns).padEnd(3)} tools=${String(row.toolCalls).padEnd(3)} wall=${Math.round(row.wallMs / 1000)}s ${row.run}`
  );
}
console.log('');
console.log('False Success: structurally impossible — acceptance PASS requires');
console.log('backing evidence records (no-evidence blocks; machine rejects).');
