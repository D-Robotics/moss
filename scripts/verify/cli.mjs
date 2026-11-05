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
import { stage as clipboardPasteStage } from './stages/clipboard-paste.mjs';
import { stage as compactionHistoryStage } from './stages/compaction-history.mjs';
import { stage as compactionSummaryStage } from './stages/compaction-summary.mjs';
import { stage as compactionTimeoutFallbackStage } from './stages/compaction-timeout-fallback.mjs';
import { stage as compactionWindowClampStage } from './stages/compaction-window-clamp.mjs';
import { stage as windowEconomicsStage } from './stages/window-economics.mjs';
import { stage as tinyWindowSurfaceStage } from './stages/tiny-window-surface.mjs';
import { stage as tinyWindowCliBootStage } from './stages/tiny-window-cli-boot.mjs';
import { stage as tinyWindowDiagnosticsStage } from './stages/tiny-window-diagnostics.mjs';
import { stage as tinyWindowTuiNoticeStage } from './stages/tiny-window-tui-notice.mjs';
import { stage as readImageStage } from './stages/read-image.mjs';
import { stage as readPdfStage } from './stages/read-pdf.mjs';
import { stage as osSandboxStage } from './stages/os-sandbox.mjs';
import { stage as orgPolicyStage } from './stages/org-policy.mjs';
import { stage as outputStyleStage } from './stages/output-style.mjs';
import { stage as planEndStage } from './stages/plan-end.mjs';
import { stage as rulesActivationStage } from './stages/rules-activation.mjs';
import { stage as subagentResumeStage } from './stages/subagent-resume.mjs';
import { stage as subagentPromptStage } from './stages/subagent-prompt-contract.mjs';
import { stage as toolSurfaceStage } from './stages/tool-surface.mjs';
import { stage as imageBudgetStage } from './stages/image-budget.mjs';
import { stage as taskLedgerRevealStage } from './stages/task-ledger-reveal.mjs';
import { stage as skillCatalogUsageStage } from './stages/skill-catalog-usage.mjs';
import { stage as toolOutputSpillStage } from './stages/tool-output-spill.mjs';
import { stage as loopCommandStage } from './stages/loop-command.mjs';
import { stage as mcpProtocolStage } from './stages/mcp-protocol.mjs';
import { stage as rememberStage } from './stages/remember.mjs';
import { stage as startupTimingStage } from './stages/startup-timing.mjs';
import { stage as skillForkStage } from './stages/skill-fork.mjs';
import { stage as skillPolicyStage } from './stages/skill-policy.mjs';
import { stage as pluginsStage } from './stages/plugins.mjs';
import { stage as workflowStage } from './stages/workflow.mjs';
import { stage as toolLeanStage } from './stages/tool-lean.mjs';
import { stage as skillBackgroundStage } from './stages/skill-background.mjs';
import { stage as skillHooksStage } from './stages/skill-hooks.mjs';
import { stage as skillModelInvocationStage } from './stages/skill-model-invocation.mjs';
import { stage as skillCatalogBudgetStage } from './stages/skill-catalog-budget.mjs';
import { stage as mcpResourceMentionsStage } from './stages/mcp-resource-mentions.mjs';
import { stage as skillHookOnceStage } from './stages/skill-hook-once.mjs';
import { stage as cliToolRulesStage } from './stages/cli-tool-rules.mjs';
import { stage as addDirStage } from './stages/add-dir.mjs';
import { stage as checkpointPersistStage } from './stages/checkpoint-persist.mjs';
import { stage as rewindConversationStage } from './stages/rewind-conversation.mjs';
import { stage as loopLedgerStage } from './stages/loop-ledger.mjs';
import { stage as goalPauseStage } from './stages/goal-pause.mjs';
import { stage as goalRunsStage } from './stages/goal-runs.mjs';
import { stage as acceptanceBlockedStage } from './stages/acceptance-blocked.mjs';
import { stage as goalResumeArgsStage } from './stages/goal-resume-args.mjs';
import { stage as loopHistoryStage } from './stages/loop-history.mjs';
import { stage as loopWatchStage } from './stages/loop-watch.mjs';
import { stage as reviewVerdictStage } from './stages/review-verdict.mjs';
import { stage as loopStatusStage } from './stages/loop-status.mjs';
import { stage as loopPruneStage } from './stages/loop-prune.mjs';
import { stage as loopFollowStage } from './stages/loop-follow.mjs';
import { stage as loopCheckTimeoutStage } from './stages/loop-check-timeout.mjs';
import { stage as loopHealthStage } from './stages/loop-health.mjs';
import { stage as runTestsVerdictStage } from './stages/run-tests-verdict.mjs';
import { stage as mcpPromptSlashStage } from './stages/mcp-prompt-slash.mjs';
import { stage as contextSurfaceStage } from './stages/context-surface.mjs';
import { stage as replInterruptStage } from './stages/repl-interrupt.mjs';
import { stage as helpSurfaceStage } from './stages/help-surface.mjs';
import { stage as slashDispatchStage } from './stages/slash-dispatch.mjs';
import { stage as todosViewStage } from './stages/todos-view.mjs';
import { stage as doctorBehaviorStage } from './stages/doctor-behavior.mjs';
import { stage as diagnosticsStage } from './stages/diagnostics.mjs';

const STAGES = new Map(
  [
    staticStage,
    buildStage,
    smokeStage,
    examplesStage,
    hooksContractStage,
    verificationGateStage,
    reviewPipelineStage,
    clipboardPasteStage,
    compactionHistoryStage,
    compactionSummaryStage,
    compactionTimeoutFallbackStage,
    compactionWindowClampStage,
    windowEconomicsStage,
    tinyWindowSurfaceStage,
    tinyWindowCliBootStage,
    tinyWindowDiagnosticsStage,
    tinyWindowTuiNoticeStage,
    readImageStage,
    readPdfStage,
    osSandboxStage,
    orgPolicyStage,
    outputStyleStage,
    planEndStage,
    rulesActivationStage,
    subagentPromptStage,
    subagentResumeStage,
    toolSurfaceStage,
    imageBudgetStage,
    taskLedgerRevealStage,
    skillCatalogUsageStage,
    toolOutputSpillStage,
    loopCommandStage,
    mcpProtocolStage,
    rememberStage,
    startupTimingStage,
    skillForkStage,
    skillPolicyStage,
    pluginsStage,
    workflowStage,
    toolLeanStage,
    skillBackgroundStage,
    skillHooksStage,
    skillModelInvocationStage,
    skillCatalogBudgetStage,
    mcpResourceMentionsStage,
    skillHookOnceStage,
    cliToolRulesStage,
    addDirStage,
    checkpointPersistStage,
    rewindConversationStage,
    loopLedgerStage,
    goalPauseStage,
    goalRunsStage,
    acceptanceBlockedStage,
    goalResumeArgsStage,
    loopHistoryStage,
    loopWatchStage,
    reviewVerdictStage,
    loopStatusStage,
    loopPruneStage,
    loopFollowStage,
    loopCheckTimeoutStage,
    loopHealthStage,
    runTestsVerdictStage,
    mcpPromptSlashStage,
    contextSurfaceStage,
    replInterruptStage,
    helpSurfaceStage,
    slashDispatchStage,
    todosViewStage,
    doctorBehaviorStage,
    diagnosticsStage,
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
  'clipboard-paste',
  'compaction-history',
  'compaction-summary',
  'compaction-timeout-fallback',
  'compaction-window-clamp',
  'window-economics',
  'tiny-window-surface',
  'tiny-window-cli-boot',
  'tiny-window-diagnostics',
  'tiny-window-tui-notice',
  'read-image',
  'read-pdf',
  'os-sandbox',
  'org-policy',
  'output-style',
  'plan-end',
  'rules-activation',
  'subagent-prompt-contract',
  'subagent-resume',
  'tool-surface',
  'image-budget',
  'task-ledger-reveal',
  'goal-runs',
  'acceptance-blocked',
  'goal-resume-args',
  'loop-history',
  'loop-watch',
  'review-verdict',
  'loop-status',
  'loop-prune',
  'loop-follow',
  'loop-check-timeout',
  'loop-health',
  'skill-catalog-usage',
  'tool-output-spill',
  'loop-command',
  'loop-ledger',
  'mcp-protocol',
  'remember',
  'startup-timing',
  'skill-fork',
  'skill-policy',
  'plugins',
  'workflow',
  'tool-lean',
  'skill-background',
  'skill-hooks',
  'run-tests-verdict',
  'mcp-prompt-slash',
  'context-surface',
  'goal-pause',
  'repl-interrupt',
  'help-surface',
  'slash-dispatch',
  'todos-view',
  'doctor-behavior',
  'diagnostics',
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

/** How many independent stages may run at once (VERIFY_CONCURRENCY overrides). */
function resolveConcurrency(raw) {
  const parsed = raw === undefined ? 4 : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 4;
  return Math.max(1, Math.floor(parsed));
}

/**
 * The startup-timing stage asserts millisecond thresholds, so it runs alone: a
 * busy pool would make its measurement depend on who else is compiling. Other
 * process-starting stages (smoke drives a PTY but checks version/help output)
 * share the pool.
 */
const EXCLUSIVE_STAGES = new Set(['startup-timing']);

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

  // Scheduler: a stage starts as soon as its `requires` are done. `static` and
  // `build` are independent (one reads sources, the other writes dist/), so they
  // overlap; after build the probe stages run in a small pool instead of one by
  // one. Timing/PTY stages stay exclusive. A failure stops new launches and lets
  // the in-flight stages finish, so the summary never shows a half-run stage as ok.
  const concurrency = resolveConcurrency(process.env.VERIFY_CONCURRENCY);
  const pending = [...stages];
  const completed = new Set();
  const running = new Map();

  const launch = (name) => {
    const stage = STAGES.get(name);
    const context = {
      root: process.cwd(),
      stageName: name,
      clean: options.clean,
    };
    console.log(`[verify] ${name}: ${stage.description}`);
    const stageStartedAt = Date.now();
    const promise = (async () => {
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
      } else {
        console.log(`[verify] ok ${name} in ${formatDuration(durationMs)}`);
      }
      completed.add(name);
      running.delete(name);
    })();
    running.set(name, promise);
  };

  while (pending.length > 0 || running.size > 0) {
    if (!failed) {
      for (;;) {
        const index = pending.findIndex((name) =>
          STAGES.get(name).requires.every((dependency) => completed.has(dependency))
        );
        if (index === -1) break;
        const name = pending[index];
        if (EXCLUSIVE_STAGES.has(name)) {
          if (running.size > 0) break;
          pending.splice(index, 1);
          launch(name);
          break;
        }
        if (running.size >= concurrency) break;
        pending.splice(index, 1);
        launch(name);
      }
    }
    if (running.size === 0) {
      if (failed) break;
      // Only reachable when a stage names a dependency that is not in this run.
      const stuck = pending[0];
      failed = {
        name: stuck,
        durationMs: 0,
        detail: `dependency was not scheduled for ${stuck}`,
      };
      console.error(`[verify] FAIL ${failed.detail}`);
      break;
    }
    await Promise.race([...running.values()]);
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
