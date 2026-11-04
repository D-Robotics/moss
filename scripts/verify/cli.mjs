#!/usr/bin/env node
/**
 * The single entry point for moss verification.
 *
 * The gate is deliberately small enough to finish in about a minute, because
 * that is the only way it gets run: static checks, a build, CLI smoke and the
 * embedding examples. Everything heavy (the cross-OS matrix, real terminals,
 * install e2e) lives in the deep workflow, not in this command. See
 * docs/design/ci-and-verify.md for the reasoning and for what the fast gate
 * deliberately does not prove.
 *
 *   npm run verify            # fast gate (target: under 60s)
 *   npm run verify:quick      # static + smoke, for a quick sanity check
 *   npm run check             # static only
 *   npm run smoke             # build + CLI smoke
 *
 * Usage: node scripts/verify/cli.mjs [options]
 *   --stage <list>       comma-separated stage names (default: the fast gate)
 *   --clean              remove dist/ first (build stage)
 *   --budget <seconds>   gate time budget; CI fails above it (0 disables)
 *   --no-deps            run only the named stages (no dependencies)
 *   --dry-run            print the plan without running
 *   --help
 */
import fs from 'node:fs';
import { formatDuration, isGithubActions, annotateError } from './lib/proc.mjs';
import { stage as staticStage } from './stages/static.mjs';
import { stage as buildStage } from './stages/build.mjs';
import { stage as smokeStage } from './stages/smoke.mjs';
import { stage as examplesStage } from './stages/examples.mjs';
import { stage as hooksContractStage } from './stages/hooks-contract.mjs';
import { stage as verificationGateStage } from './stages/verification-gate.mjs';
import { stage as reviewPipelineStage } from './stages/review-pipeline.mjs';
import { stage as compactionHistoryStage } from './stages/compaction-history.mjs';
import { stage as compactionSummaryStage } from './stages/compaction-summary.mjs';
import { stage as readImageStage } from './stages/read-image.mjs';
import { stage as planEndStage } from './stages/plan-end.mjs';
import { stage as rulesActivationStage } from './stages/rules-activation.mjs';
import { stage as subagentPromptStage } from './stages/subagent-prompt-contract.mjs';
import { stage as toolSurfaceStage } from './stages/tool-surface.mjs';
import { stage as imageBudgetStage } from './stages/image-budget.mjs';
import { stage as taskLedgerRevealStage } from './stages/task-ledger-reveal.mjs';
import { stage as loopCommandStage } from './stages/loop-command.mjs';
import { stage as mcpProtocolStage } from './stages/mcp-protocol.mjs';
import { stage as rememberStage } from './stages/remember.mjs';

const STAGES = new Map(
  [
    staticStage,
    buildStage,
    smokeStage,
    examplesStage,
    hooksContractStage,
    verificationGateStage,
    reviewPipelineStage,
    compactionHistoryStage,
    compactionSummaryStage,
    readImageStage,
    planEndStage,
    rulesActivationStage,
    subagentPromptStage,
    toolSurfaceStage,
    imageBudgetStage,
    taskLedgerRevealStage,
    loopCommandStage,
    mcpProtocolStage,
    rememberStage,
  ].map((stage) => [stage.name, stage])
);

const ORDER = [...STAGES.keys()];
const FAST_GATE = [
  'static',
  'smoke',
  'examples',
  'hooks-contract',
  'verification-gate',
  'review-pipeline',
  'compaction-history',
  'compaction-summary',
  'read-image',
  'plan-end',
  'rules-activation',
  'subagent-prompt-contract',
  'tool-surface',
  'image-budget',
  'task-ledger-reveal',
  'loop-command',
  'mcp-protocol',
  'remember',
];
const DEFAULT_BUDGET_SECONDS = 60;

const HELP = `Usage: node scripts/verify/cli.mjs [options]

Default gate: ${FAST_GATE.join(', ')} (plus the build dependency)

Stages: ${ORDER.join(', ')}

Options:
  --stage <list>     comma-separated stage names (default: fast gate)
  --clean            remove dist/ first (build stage)
  --budget <seconds> gate time budget; CI fails above it (0 disables)
  --no-deps          do not add stage dependencies
  --dry-run          print the plan without running
  --help             show this help
`;

function fail(error) {
  console.error(`[verify] ${error}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    stages: null,
    clean: false,
    budget: undefined,
    noDeps: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--clean') {
      options.clean = true;
    } else if (arg === '--no-deps') {
      options.noDeps = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--stage' || arg === '--stages') {
      options.stages = nextValue();
    } else if (arg.startsWith('--stage=') || arg.startsWith('--stages=')) {
      options.stages = arg.slice(arg.indexOf('=') + 1);
    } else if (arg === '--budget') {
      options.budget = parseBudget(nextValue());
    } else if (arg.startsWith('--budget=')) {
      options.budget = parseBudget(arg.slice('--budget='.length));
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseBudget(raw) {
  if (!/^\d+$/.test(raw)) fail('--budget requires a non-negative integer (seconds)');
  return Number(raw);
}

function requestedStages(options) {
  if (options.stages === null) return [...FAST_GATE];
  const names = options.stages
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) fail('--stage needs at least one stage name');
  for (const name of names) {
    if (!STAGES.has(name)) fail(`unknown stage: ${name} (known: ${ORDER.join(', ')})`);
  }
  return names;
}

function resolveStages(names, noDeps) {
  const wanted = new Set(names);
  if (!noDeps) {
    const queue = [...names];
    while (queue.length > 0) {
      const stage = STAGES.get(queue.pop());
      for (const dependency of stage.requires) {
        if (wanted.has(dependency)) continue;
        wanted.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return ORDER.filter((name) => wanted.has(name));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const requested = requestedStages(options);
  const stages = resolveStages(requested, options.noDeps);
  if (options.clean && !stages.includes('build')) {
    fail('--clean only applies to the build stage');
  }

  const isDefaultGate = options.stages === null;
  const budget =
    options.budget ??
    (process.env.VERIFY_BUDGET_SECONDS === undefined
      ? isDefaultGate
        ? DEFAULT_BUDGET_SECONDS
        : 0
      : Number(process.env.VERIFY_BUDGET_SECONDS));

  if (options.dryRun) {
    console.log(`[verify] plan: ${stages.join(', ')}`);
    for (const name of stages) console.log(`[verify] ${name}: ${STAGES.get(name).description}`);
    return 0;
  }

  console.log(`[verify] gate: ${stages.join(', ')}`);
  const results = [];
  const startedAt = Date.now();
  let failed = null;

  for (const name of stages) {
    const stage = STAGES.get(name);
    const context = {
      root: process.cwd(),
      stageName: name,
      clean: options.clean,
    };
    console.log(`[verify] ${name}: ${stage.description}`);
    const stageStartedAt = Date.now();
    let result;
    try {
      result = await stage.run(context);
    } catch (error) {
      result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const durationMs = Date.now() - stageStartedAt;
    results.push({ name, ok: result.ok, durationMs });
    if (!result.ok) {
      failed = { name, durationMs, detail: result.detail };
      console.error(
        `[verify] FAIL ${name} after ${formatDuration(durationMs)}: ${result.detail ?? 'unknown'}`
      );
      annotateError(`verify: ${name} failed`, result.detail ?? `${name} failed`);
      break;
    }
    console.log(`[verify] ok ${name} in ${formatDuration(durationMs)}`);
  }

  const totalMs = Date.now() - startedAt;
  console.log('[verify] summary');
  const summaryLines = [
    '## Verification gate',
    '',
    '| stage | result | duration |',
    '| --- | --- | --- |',
  ];
  for (const name of stages) {
    const result = results.find((entry) => entry.name === name);
    if (result) {
      console.log(
        `  ${name.padEnd(12)} ${result.ok ? 'ok  ' : 'FAIL'} ${formatDuration(result.durationMs)}`
      );
      summaryLines.push(
        `| ${name} | ${result.ok ? 'ok' : 'FAIL'} | ${formatDuration(result.durationMs)} |`
      );
    } else {
      console.log(`  ${name.padEnd(12)} not run`);
      summaryLines.push(`| ${name} | not run | - |`);
    }
  }

  let budgetExceeded = false;
  let budgetNote = 'no budget';
  if (budget > 0) {
    budgetNote = `budget ${budget}s`;
    if (totalMs > budget * 1000) {
      budgetExceeded = true;
      const message = `gate over budget: ${formatDuration(totalMs)} > ${budget}s`;
      if (isGithubActions()) {
        annotateError('verify: over budget', message);
        console.error(`[verify] FAIL ${message}`);
      } else {
        console.warn(`[verify] WARNING ${message} (CI would fail)`);
      }
    } else {
      console.log(`[verify] budget ${budget}s: ok (${formatDuration(totalMs)})`);
    }
  }

  const failedCI = failed !== null || (budgetExceeded && isGithubActions());
  summaryLines.push(
    '',
    `Result: **${failedCI ? 'FAIL' : 'PASS'}** in ${formatDuration(totalMs)} (${budgetNote})`
  );
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) fs.appendFileSync(stepSummary, `${summaryLines.join('\n')}\n`);

  if (failedCI) {
    console.log(
      `[verify] FAIL after ${formatDuration(totalMs)} (${failed ? failed.name : 'budget'})`
    );
    return 1;
  }
  console.log(`[verify] PASS in ${formatDuration(totalMs)}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(
      `[verify] unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : error}`
    );
    annotateError(
      'verify: unexpected failure',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
);
