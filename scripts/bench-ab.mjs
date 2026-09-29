#!/usr/bin/env node
// v0.10 W5: per-engine A/B runner. Runs the hard tier twice (engine OFF via
// clean env, engine ON via env), aggregates deltas, and emits a recommendation
// (default-off if the ON run's hard score gain < +5pt — outside-noise rule).
// Usage: node scripts/bench-ab.mjs <engine> [--samples <n>]
//   engine: best-of-n | reasoning-high | cross-review (bench prompt hint)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const USAGE = `Usage: npm run bench:ab -- <engine> [--samples <n>]
  engine: ${Object.keys({
    'best-of-n': 1,
    'reasoning-high': 1,
  }).join(' | ')}
  Runs the hard tier twice (engine OFF on clean env, engine ON via env),
  aggregates deltas, and recommends default-off unless the hard score gains
  >= +5pt (outside-noise rule).`;
const argv = process.argv.slice(2);
const helpFlag = argv.includes('--help') || argv.includes('-h');
const engine = argv.find((a) => !a.startsWith('-'));
const samplesIdx = argv.indexOf('--samples');
const samples = samplesIdx >= 0 ? Number(argv[samplesIdx + 1]) : 3;

const ENGINE_ENV = {
  'best-of-n': { on: { MOSS_BEST_OF_N: '3' }, off: {} },
  'reasoning-high': {
    on: { MOSS_REASONING_BUDGET: 'high' },
    off: { MOSS_REASONING_BUDGET: 'off' },
  },
};
if (helpFlag) {
  console.log(USAGE);
  process.exit(0);
}
if (!ENGINE_ENV[engine]) {
  console.error(USAGE);
  console.error(`unknown engine: ${engine ?? '(none)'}`);
  process.exit(2);
}

function runArm(label, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  const res = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'run-benchmark.mjs'),
      '--task',
      'hard-',
      '--samples',
      String(samples),
      '--label',
      label,
    ],
    { stdio: 'inherit', env }
  );
  if (res.status !== 0) {
    console.error(`[ab] arm ${label} failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bench', 'results', label, 'summary.json'), 'utf8')
  );
}

const stamp = Date.now();
const off = runArm(`ab-${engine}-off-${stamp}`, ENGINE_ENV[engine].off);
const on = runArm(`ab-${engine}-on-${stamp}`, ENGINE_ENV[engine].on);
const offHard = off.capability?.hardScore ?? null;
const onHard = on.capability?.hardScore ?? null;
const offTok = off.perTask.reduce((n, t) => n + (t.meanTokensIn ?? 0), 0);
const onTok = on.perTask.reduce((n, t) => n + (t.meanTokensIn ?? 0), 0);
const costGrowth = offTok > 0 ? ((onTok - offTok) / offTok) * 100 : null;
const delta = onHard !== null && offHard !== null ? onHard - offHard : null;
const recommendation = delta === null ? 'INCONCLUSIVE' : delta >= 5 ? 'DEFAULT-ON' : 'DEFAULT-OFF';

const report = {
  engine,
  samples,
  off: { label: `ab-${engine}-off-${stamp}`, hardScore: offHard, tokensIn: Math.round(offTok) },
  on: { label: `ab-${engine}-on-${stamp}`, hardScore: onHard, tokensIn: Math.round(onTok) },
  hardScoreDelta: delta,
  costGrowthPct: costGrowth === null ? null : Number(costGrowth.toFixed(1)),
  recommendation,
};
fs.writeFileSync(
  path.join(repoRoot, 'bench', 'results', `ab-${engine}-${stamp}.json`),
  JSON.stringify(report, null, 2)
);
console.log(`\n===== A/B: ${engine} =====`);
console.log(`hard score: off=${offHard} on=${onHard} (delta ${delta}pt)`);
console.log(
  `mean tokIn per task: off=${Math.round(offTok / (off.perTask.length || 1))} on=${Math.round(onTok / (on.perTask.length || 1))} (growth ${costGrowth?.toFixed(1)}%)`
);
console.log(`recommendation: ${recommendation} (rule: >= +5pt to stay on by default)`);
