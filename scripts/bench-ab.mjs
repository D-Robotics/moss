#!/usr/bin/env node
// Per-engine A/B runner. Two-arm engines run the hard tier OFF/ON and
// recommend default-off unless the hard score gains >= +5pt (outside-noise
// rule). The model-routing engine runs three arms (all-cheap / all-balanced /
// routing on) and gates on BOTH hard score >= cheap+5pt AND cost <= 70% of
// the all-balanced arm (cost = tokens weighted by --price-ratio, default 3).
// Usage: npm run bench:ab -- <engine> [--samples <n>] [--price-ratio <k>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENGINES = {
  'best-of-n': {
    arms: { off: { env: {} }, on: { env: { MOSS_BEST_OF_N: '3' } } },
  },
  'reasoning-high': {
    arms: {
      off: { env: { MOSS_REASONING_BUDGET: 'off' } },
      on: { env: { MOSS_REASONING_BUDGET: 'high' } },
    },
  },
  'goal-loop': {
    // v0.15 S1: acceptance-driven headless runs — after the primary run the
    // agent executes the task's own check.mjs once and gets one continuation
    // turn with the failure evidence when it fails.
    arms: { off: { env: {} }, on: { env: { MOSS_GOAL_VERIFY_LOOP: '1' } } },
  },
  'model-routing': {
    threeArm: true,
    cheapModel: 'deepseek-flash@latest',
    strongModel: 'deepseek-pro@latest',
    arms: {
      cheap: { model: 'deepseek-flash@latest', env: {} },
      balanced: { model: 'deepseek-pro@latest', env: {} },
      routing: {
        model: 'deepseek-flash@latest',
        env: {
          MOSS_MODEL_CHEAP: 'deepseek-flash@latest',
          MOSS_MODEL_STRONG: 'deepseek-pro@latest',
        },
      },
    },
  },
};
const USAGE = `Usage: npm run bench:ab -- <engine> [--samples <n>] [--price-ratio <k>]
  engine: ${Object.keys(ENGINES).join(' | ')}
  Two-arm engines: hard tier OFF (clean env) vs ON (env); default-off unless
  the ON run gains >= +5pt hard score (outside-noise rule).
  model-routing: three arms all-cheap / all-balanced / routing-on; gate is
  routing hard >= cheap +5pt AND routing cost <= 70% of balanced cost, where
  cost = cheap-model tokens + k x other-model tokens (k = --price-ratio).`;
const argv = process.argv.slice(2);
const helpFlag = argv.includes('--help') || argv.includes('-h');
const engine = argv.find((a) => !a.startsWith('-'));
const samplesIdx = argv.indexOf('--samples');
const samples = samplesIdx >= 0 ? Number(argv[samplesIdx + 1]) : 3;
const distIdx = argv.indexOf('--dist');
const distDir = distIdx >= 0 ? argv[distIdx + 1] : null;
if (distDir) process.env.MOSS_BENCH_CLI = path.resolve(distDir, 'cli.js');
const ratioIdx = argv.indexOf('--price-ratio');
const priceRatio = ratioIdx >= 0 ? Number(argv[ratioIdx + 1]) : 3;

if (helpFlag) {
  console.log(USAGE);
  process.exit(0);
}
if (!ENGINES[engine]) {
  console.error(USAGE);
  console.error(`unknown engine: ${engine ?? '(none)'}`);
  process.exit(2);
}

function runArm(label, arm) {
  // MOSS_BENCH_CLI (set via --dist) pins the arms to a snapshot build so a
  // concurrent worktree rebuild cannot corrupt a running A/B.
  const env = { ...process.env, ...arm.env };
  const cliArgs = [
    path.join(repoRoot, 'scripts', 'run-benchmark.mjs'),
    '--task',
    'hard-',
    '--samples',
    String(samples),
    '--label',
    label,
  ];
  if (arm.model) cliArgs.push('--model', arm.model);
  const res = spawnSync(process.execPath, cliArgs, { stdio: 'inherit', env });
  if (res.status !== 0) {
    console.error(`[ab] arm ${label} failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bench', 'results', label, 'summary.json'), 'utf8')
  );
}

function armCost(summary, cheapModel, k) {
  let cost = 0;
  for (const [model, tokens] of Object.entries(summary.tokensByModel ?? {}))
    cost += tokens * (model === cheapModel ? 1 : k);
  return cost;
}

const spec = ENGINES[engine];
const stamp = Date.now();

if (spec.threeArm) {
  const arms = {};
  for (const [name, arm] of Object.entries(spec.arms))
    arms[name] = {
      label: `ab-${engine}-${name}-${stamp}`,
      summary: runArm(`ab-${engine}-${name}-${stamp}`, arm),
    };
  const hard = (a) => a.summary.capability?.hardScore ?? null;
  const cost = (a) => armCost(a.summary, spec.cheapModel, priceRatio);
  const scoreGate =
    hard(arms.routing) !== null && hard(arms.cheap) !== null
      ? hard(arms.routing) - hard(arms.cheap) >= 5
      : null;
  const costGate = cost(arms.balanced) > 0 ? cost(arms.routing) <= 0.7 * cost(arms.balanced) : null;
  const pass = scoreGate === true && costGate === true;
  const report = {
    engine,
    samples,
    priceRatio,
    arms: Object.fromEntries(
      Object.entries(arms).map(([name, a]) => [
        name,
        {
          label: a.label,
          hardScore: hard(a),
          cost: Math.round(cost(a)),
          tokensByModel: a.summary.tokensByModel,
        },
      ])
    ),
    gate: { routingHardGeCheapPlus5: scoreGate, routingCostLe70pctOfBalanced: costGate },
    recommendation:
      scoreGate === null || costGate === null
        ? 'INCONCLUSIVE'
        : pass
          ? 'DEFAULT-ON'
          : 'DEFAULT-OFF',
  };
  fs.writeFileSync(
    path.join(repoRoot, 'bench', 'results', `ab-${engine}-${stamp}.json`),
    JSON.stringify(report, null, 2)
  );
  console.log(`\n===== A/B: ${engine} (three arms, price ratio k=${priceRatio}) =====`);
  for (const [name, a] of Object.entries(arms))
    console.log(
      `${name.padEnd(9)} hard=${hard(a)} cost=${Math.round(cost(a))} tokensByModel=${JSON.stringify(a.summary.tokensByModel)}`
    );
  console.log(
    `gate: hard(routing) >= hard(cheap)+5 → ${scoreGate} ; cost(routing) <= 70% cost(balanced) → ${costGate}`
  );
  console.log(`recommendation: ${report.recommendation}`);
} else {
  const off = runArm(`ab-${engine}-off-${stamp}`, spec.arms.off);
  const on = runArm(`ab-${engine}-on-${stamp}`, spec.arms.on);
  const offHard = off.capability?.hardScore ?? null;
  const onHard = on.capability?.hardScore ?? null;
  const offTok = off.perTask.reduce((n, t) => n + (t.meanTokensIn ?? 0), 0);
  const onTok = on.perTask.reduce((n, t) => n + (t.meanTokensIn ?? 0), 0);
  const costGrowth = offTok > 0 ? ((onTok - offTok) / offTok) * 100 : null;
  const delta = onHard !== null && offHard !== null ? onHard - offHard : null;
  const recommendation =
    delta === null ? 'INCONCLUSIVE' : delta >= 5 ? 'DEFAULT-ON' : 'DEFAULT-OFF';
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
}
