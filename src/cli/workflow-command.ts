/**
 * D5: `moss workflow run|resume|status|list <plan>` — declarative orchestration.
 *
 * A plan is data, not code: steps with ids, tasks and dependencies. Each step
 * runs as a fresh headless session (no shared conversation state), so a crash
 * or a failed step never corrupts the others; state lives in
 * `.moss/workflows/<runId>/state.json` and resume skips what already passed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseWorkflowPlan,
  planWaves,
  type WorkflowPlan,
  type WorkflowStep,
} from '../core/workflow/workflow-plan.js';
import type { RunRecordUsage } from '../core/run-ledger.js';
import {
  createWorkflowState,
  describeWorkflowStep,
  listWorkflowStates,
  loadWorkflowState,
  runWorkflow,
  saveWorkflowState,
  summarizeWorkflow,
  workflowExitCode,
  type WorkflowState,
  type WorkflowStepRunner,
  type WorkflowStepState,
} from '../core/workflow/workflow-runner.js';
import { ProcessError, runProcess } from '../utils/run-process.js';
import { isZhLocale } from './cli-locale.js';

export interface WorkflowCommandContext {
  workspaceDir: string;
  /** Path of the running CLI entry (child sessions); defaults to process.argv[1]. */
  cliPath?: string;
  zh?: boolean;
  /** Output JSON to stdout instead of the human table. */
  json?: boolean;
  /** Step cap for tests; production uses the child session's own cap. */
  stepTimeoutMs?: number;
  /**
   * Forward `--mock` to every child session: a plan can then be exercised
   * end-to-end with no API key (the mock provider never calls a model).
   */
  mock?: boolean;
}

export const WORKFLOW_STEP_TIMEOUT_MS = 10 * 60_000;

export function renderWorkflowUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss workflow run <plan.json> [--dry-run] [--json]',
      '  moss workflow resume <runId>',
      '  moss workflow status <runId>',
      '  moss workflow list [--json]',
      '',
      '  计划是数据不是代码：每步有 id / task / dependsOn / writePaths / maxTurns。',
      '  每个可运行步骤启动一次全新的 headless 会话（互不共享对话状态）；',
      '  依赖完成才调度；失败步骤的依赖者标 blocked，无关步骤继续；',
      '  状态写入 .moss/workflows/<runId>/state.json，resume 只补未通过的步骤。',
      '',
      '示例：',
      '  moss workflow run .moss/workflows/audit.json --dry-run',
      '  moss workflow run .moss/workflows/audit.json',
      '  moss workflow resume wf-20261105-abc123',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss workflow run <plan.json> [--dry-run] [--json]',
    '  moss workflow resume <runId>',
    '  moss workflow status <runId>',
    '  moss workflow list [--json]',
    '',
    '  A plan is data, not code: steps carry id / task / dependsOn / writePaths / maxTurns.',
    '  Each runnable step starts one fresh headless session (no shared conversation state);',
    '  dependents wait for their dependencies; a failed step blocks only its dependents;',
    '  state lives in .moss/workflows/<runId>/state.json and resume reruns only unfinished steps.',
    '',
    'Examples:',
    '  moss workflow run .moss/workflows/audit.json --dry-run',
    '  moss workflow run .moss/workflows/audit.json',
    '  moss workflow resume wf-20261105-abc123',
  ].join('\n');
}

interface ParsedArgs {
  subcommand: string;
  target?: string;
  dryRun: boolean;
  json: boolean;
  error?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let dryRun = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('-'))
      return { subcommand: '', dryRun, json, error: `unknown flag ${arg}` };
    else positional.push(arg);
  }
  const [subcommand = '', target] = positional;
  return { subcommand, ...(target ? { target } : {}), dryRun, json };
}

function newRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  return `wf-${stamp}-${crypto.randomUUID().slice(0, 6)}`;
}

function resolveCliPath(cliPath?: string): string {
  const entry = cliPath ?? process.argv[1];
  if (entry) return path.resolve(entry);
  return path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'cli.js');
}

function stepPrompt(plan: WorkflowPlan, step: WorkflowStep, state: WorkflowState): string {
  const lines = [
    `You are running one step of the workflow "${plan.name}" (step "${step.id}").`,
    'Complete only this step; other steps run in their own sessions.',
    '',
    `Task: ${step.task}`,
  ];
  if (step.writePaths.length > 0) {
    lines.push(
      '',
      `Write scope for this step: ${step.writePaths.join(', ')}. Do not modify files outside it unless the task cannot be done otherwise, and say so if you must.`
    );
  }
  if (step.dependsOn.length > 0) {
    lines.push('', 'Earlier steps that passed (their tails may contain useful context):');
    for (const dep of step.dependsOn.slice(0, 3)) {
      const entry = state.steps.find((candidate) => candidate.id === dep);
      if (!entry?.outputTail) continue;
      lines.push(`--- ${dep} ---`, entry.outputTail.slice(-1_500));
    }
  }
  lines.push('', 'Finish with a short report: what changed, what you checked, what remains.');
  return lines.join('\n');
}

/** Fresh headless session per step; the child owns its own turn cap and tools. */
export function createChildSessionRunner(options: {
  workspaceDir: string;
  cliPath: string;
  plan: WorkflowPlan;
  state: WorkflowState;
  timeoutMs?: number;
  extraArgs?: string[];
  /** B164: where child `-p` runs drop their usage JSON for aggregation. */
  usageDir?: string;
}): WorkflowStepRunner {
  return async (step) => {
    const sessionKey = `workflow-${options.state.runId}-${step.id}`;
    const args = [
      options.cliPath,
      '-p',
      stepPrompt(options.plan, step, options.state),
      '--session',
      sessionKey,
      ...(options.extraArgs ?? []),
    ];
    const startedMs = Date.now();
    const usageFile = options.usageDir
      ? path.join(options.usageDir, `${step.id}.usage.json`)
      : undefined;
    if (usageFile) fs.rmSync(usageFile, { force: true });
    const readUsage = (): { usage?: RunRecordUsage; model?: string } => {
      if (!usageFile) return {};
      try {
        const raw = JSON.parse(fs.readFileSync(usageFile, 'utf8')) as unknown;
        if (!raw || typeof raw !== 'object') return {};
        const record = raw as { usage?: unknown; model?: unknown };
        // B164 wrote the usage object directly; B177 wraps it with the model id.
        if (record.usage === undefined && typeof (raw as RunRecordUsage).inputTokens === 'number') {
          return { usage: raw as RunRecordUsage };
        }
        return {
          ...(record.usage && typeof record.usage === 'object'
            ? { usage: record.usage as RunRecordUsage }
            : {}),
          ...(typeof record.model === 'string' && record.model.trim()
            ? { model: record.model }
            : {}),
        };
      } catch {
        // A child that died before writing usage yields no numbers, never a guess.
      }
      return {};
    };
    try {
      const result = await runProcess(process.execPath, {
        args,
        cwd: options.workspaceDir,
        // The workflow row covers its steps; a per-step chat row would duplicate it.
        env: {
          ...process.env,
          MOSS_NO_TUI: '1',
          MOSS_NO_RUN_LEDGER: '1',
          ...(usageFile ? { MOSS_USAGE_FILE: usageFile } : {}),
        },
        timeout: options.timeoutMs ?? WORKFLOW_STEP_TIMEOUT_MS,
      });
      const report = readUsage();
      return {
        passed: true,
        output: `${result.stdout}${result.stderr}`.trim(),
        sessionKey,
        durationMs: Date.now() - startedMs,
        exitCode: result.exitCode,
        ...(report.usage ? { usage: report.usage } : {}),
        ...(report.model ? { model: report.model } : {}),
      };
    } catch (err) {
      if (!(err instanceof ProcessError)) throw err;
      const report = readUsage();
      return {
        passed: false,
        output: `${err.stdout}${err.stderr}`.trim(),
        sessionKey,
        durationMs: Date.now() - startedMs,
        ...(err.exitCode !== null ? { exitCode: err.exitCode } : {}),
        ...(report.usage ? { usage: report.usage } : {}),
        ...(report.model ? { model: report.model } : {}),
        error: err.timedOut
          ? `step timed out after ${String(err.timeoutMs ?? options.timeoutMs ?? WORKFLOW_STEP_TIMEOUT_MS)}ms`
          : `step exited ${String(err.exitCode ?? err.signal ?? 'unknown')}`,
      };
    }
  };
}

function printState(state: WorkflowState, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  console.log(`${summarizeWorkflow(state)}`);
  for (const step of state.steps) {
    const duration = step.durationMs === undefined ? '' : ` ${Math.round(step.durationMs / 1000)}s`;
    const suffix = step.error ? ` — ${step.error}` : '';
    console.log(`  ${step.id.padEnd(24)} ${step.status}${duration}${suffix}`);
  }
  console.log(`plan: ${state.planFile}`);
}

function renderDryRun(plan: WorkflowPlan): void {
  console.log(
    `plan "${plan.name}" (${plan.steps.length} step(s), concurrency ${plan.concurrency})`
  );
  const waves = planWaves(plan);
  waves.forEach((wave, index) => {
    console.log(`  wave ${index + 1}: ${wave.map(describeWorkflowStep).join(' | ')}`);
  });
}

async function runPlan(
  file: string,
  context: WorkflowCommandContext,
  options: { dryRun: boolean; state?: WorkflowState; runId?: string }
): Promise<number> {
  const absolute = path.resolve(context.workspaceDir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (err) {
    console.error(
      `[moss] cannot read plan ${file}: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
  const parsed = parseWorkflowPlan(raw);
  if (!parsed.plan) {
    console.error(`[moss] invalid workflow plan ${file}:`);
    for (const issue of parsed.issues) {
      console.error(`  ${issue.step >= 0 ? `step ${String(issue.step)}: ` : ''}${issue.message}`);
    }
    return 1;
  }
  const plan = parsed.plan;
  if (options.dryRun) {
    renderDryRun(plan);
    return 0;
  }
  const state =
    options.state ??
    createWorkflowState({
      runId: options.runId ?? newRunId(),
      plan,
      planFile: absolute,
      workspaceDir: context.workspaceDir,
    });
  state.concurrency = plan.concurrency;
  saveWorkflowState(context.workspaceDir, state);
  console.log(`workflow ${state.runId} (${plan.name}): ${String(plan.steps.length)} step(s)`);
  // B180: in-flight workflow runs are visible while their steps execute.
  try {
    const { writeRunningRecord } = await import('../core/run-ledger.js');
    await writeRunningRecord(context.workspaceDir, {
      runId: state.runId,
      kind: 'workflow',
      goal: `workflow "${plan.name}" — ${String(plan.steps.length)} step(s)`,
      next: `moss workflow status ${state.runId}`,
    });
  } catch {
    /* the workflow state file is the source of truth */
  }
  // B164: one usage file per step under the workflow's own state dir, then
  // aggregated into the single workflow run row.
  const usageDir = path.join(context.workspaceDir, '.moss', 'workflows', state.runId, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  const runner = createChildSessionRunner({
    workspaceDir: context.workspaceDir,
    cliPath: resolveCliPath(context.cliPath),
    plan,
    state,
    usageDir,
    ...(context.stepTimeoutMs !== undefined ? { timeoutMs: context.stepTimeoutMs } : {}),
    ...(context.mock ? { extraArgs: ['--mock'] } : {}),
  });
  const runStartedAt = Date.now();
  const finished = await runWorkflow({
    plan,
    state,
    workspaceDir: context.workspaceDir,
    runner,
    onProgress: (line) => console.log(line),
  });
  printState(finished, context.json ?? false);
  // B129 follow-up: the workflow is an autonomous run; one unified ledger row.
  try {
    const [{ writeRunRecord }, { buildWorkflowRunRecord }] = await Promise.all([
      import('../core/run-ledger.js'),
      import('./workflow-run-record.js'),
    ]);
    await writeRunRecord(
      context.workspaceDir,
      buildWorkflowRunRecord({ state: finished, startedAt: runStartedAt, endedAt: Date.now() })
    );
  } catch (err) {
    console.error(
      `[moss] could not write the run ledger: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return workflowExitCode(finished);
}

export async function runWorkflowCommand(
  argv: readonly string[],
  context: WorkflowCommandContext
): Promise<number> {
  const zh = context.zh ?? isZhLocale();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`${parsed.error}\n\n${renderWorkflowUsage(zh)}`);
    return 2;
  }
  switch (parsed.subcommand) {
    case 'run': {
      if (!parsed.target) {
        console.error(renderWorkflowUsage(zh));
        return 2;
      }
      return runPlan(parsed.target, context, { dryRun: parsed.dryRun });
    }
    case 'resume': {
      if (!parsed.target) {
        console.error(renderWorkflowUsage(zh));
        return 2;
      }
      const state = loadWorkflowState(context.workspaceDir, parsed.target);
      if (!state) {
        console.error(`[moss] no workflow run "${parsed.target}" under .moss/workflows`);
        return 1;
      }
      if (!fs.existsSync(state.planFile)) {
        console.error(`[moss] plan file for ${parsed.target} is gone: ${state.planFile}`);
        return 1;
      }
      return runPlan(
        state.planFile,
        { ...context, json: context.json ?? parsed.json },
        {
          dryRun: false,
          state,
          runId: state.runId,
        }
      );
    }
    case 'status': {
      if (!parsed.target) {
        console.error(renderWorkflowUsage(zh));
        return 2;
      }
      const state = loadWorkflowState(context.workspaceDir, parsed.target);
      if (!state) {
        console.error(`[moss] no workflow run "${parsed.target}" under .moss/workflows`);
        return 1;
      }
      printState(state, context.json ?? parsed.json);
      return 0;
    }
    case 'list': {
      const states = listWorkflowStates(context.workspaceDir);
      if (context.json ?? parsed.json) {
        process.stdout.write(
          `${JSON.stringify({ schema: 'moss_workflows.v1', runs: states }, null, 2)}\n`
        );
        return 0;
      }
      if (states.length === 0) {
        console.log('no workflow runs in .moss/workflows yet');
        return 0;
      }
      for (const state of states) {
        const passed = state.steps.filter((step) => step.status === 'passed').length;
        console.log(
          `${state.runId.padEnd(28)} ${state.name.padEnd(20)} ${String(passed)}/${String(state.steps.length)} passed  ${state.createdAt}`
        );
      }
      return 0;
    }
    case '':
    case 'help':
    case '--help':
      console.log(renderWorkflowUsage(zh));
      return 0;
    default:
      console.error(
        `unknown workflow subcommand "${parsed.subcommand}"\n\n${renderWorkflowUsage(zh)}`
      );
      return 2;
  }
}

export type { WorkflowStepState };
