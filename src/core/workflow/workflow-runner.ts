/**
 * Deterministic workflow executor. The runner is injected: the CLI supplies one
 * that starts a fresh headless session per step, while probes supply a fake.
 * Persistence lives here so a resume, a crash, and a failed step all see the
 * same state file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { planWaves, type WorkflowPlan, type WorkflowStep } from './workflow-plan.js';
import type { RunRecordUsage } from '../run-ledger.js';

export type WorkflowStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked';

export interface WorkflowStepState {
  id: string;
  status: WorkflowStepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  sessionKey?: string;
  /** Last part of the child output; bounded so the state file stays small. */
  outputTail?: string;
  error?: string;
  /** B164: usage of the child session, aggregated into the workflow run record. */
  usage?: RunRecordUsage;
  /** B177: model the child ran on, when it reported one. */
  model?: string;
}

export interface WorkflowState {
  schema: 'moss_workflow.v1';
  runId: string;
  name: string;
  /** Absolute path of the plan file (resume does not need the user to repeat it). */
  planFile: string;
  workspaceDir: string;
  createdAt: string;
  updatedAt: string;
  concurrency: number;
  steps: WorkflowStepState[];
}

export interface WorkflowStepResult {
  passed: boolean;
  output: string;
  exitCode?: number;
  sessionKey?: string;
  durationMs?: number;
  error?: string;
  usage?: RunRecordUsage;
  model?: string;
}

export type WorkflowStepRunner = (step: WorkflowStep) => Promise<WorkflowStepResult>;

const OUTPUT_TAIL_CHARS = 4_000;

export function workflowStateDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.moss', 'workflows');
}

export function workflowStatePath(workspaceDir: string, runId: string): string {
  return path.join(workflowStateDir(workspaceDir), runId, 'state.json');
}

export function createWorkflowState(options: {
  runId: string;
  plan: WorkflowPlan;
  planFile: string;
  workspaceDir: string;
}): WorkflowState {
  const now = new Date().toISOString();
  return {
    schema: 'moss_workflow.v1',
    runId: options.runId,
    name: options.plan.name,
    planFile: options.planFile,
    workspaceDir: options.workspaceDir,
    createdAt: now,
    updatedAt: now,
    concurrency: options.plan.concurrency,
    steps: options.plan.steps.map((step) => ({ id: step.id, status: 'pending' as const })),
  };
}

export function saveWorkflowState(workspaceDir: string, state: WorkflowState): void {
  state.updatedAt = new Date().toISOString();
  const file = workflowStatePath(workspaceDir, state.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function loadWorkflowState(workspaceDir: string, runId: string): WorkflowState | undefined {
  const file = workflowStatePath(workspaceDir, runId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowState;
  } catch {
    return undefined;
  }
}

export function listWorkflowStates(workspaceDir: string): WorkflowState[] {
  const dir = workflowStateDir(workspaceDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => loadWorkflowState(workspaceDir, name))
    .filter((state): state is WorkflowState => state !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(-OUTPUT_TAIL_CHARS)}`;
}

export interface RunWorkflowOptions {
  plan: WorkflowPlan;
  state: WorkflowState;
  workspaceDir: string;
  runner: WorkflowStepRunner;
  /** Progress line for the CLI (stderr so `--json` stdout stays clean). */
  onProgress?: (line: string) => void;
}

/**
 * Execute (or resume) a plan. Steps already `passed` in the state are skipped
 * but still satisfy dependencies. A failed step marks its dependents `blocked`;
 * independent steps in the same or later waves still run.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowState> {
  const { plan, state, workspaceDir, runner, onProgress } = options;
  const stepState = new Map(state.steps.map((entry) => [entry.id, entry]));
  const passed = new Set(
    [...stepState.values()].filter((entry) => entry.status === 'passed').map((entry) => entry.id)
  );
  // Failures are re-evaluated on every run (resume retries `failed` and
  // `blocked` steps), so this set starts empty: a step that failed in a
  // previous run but passes now must not keep its dependents blocked.
  const failedOrBlocked = new Set<string>();
  const waves = planWaves(plan, new Set(passed));

  for (const wave of waves) {
    const runnable: WorkflowStep[] = [];
    for (const step of wave) {
      const blockedBy = step.dependsOn.filter((dep) => failedOrBlocked.has(dep));
      if (blockedBy.length > 0) {
        const entry = stepState.get(step.id);
        if (entry) {
          entry.status = 'blocked';
          entry.error = `blocked by failed step(s): ${blockedBy.join(', ')}`;
        }
        failedOrBlocked.add(step.id);
        onProgress?.(`  ${step.id}: blocked (${blockedBy.join(', ')} failed)`);
        continue;
      }
      runnable.push(step);
    }
    // Bounded concurrency inside a wave.
    const concurrency = Math.max(1, Math.min(state.concurrency, runnable.length || 1));
    for (let index = 0; index < runnable.length; index += concurrency) {
      const batch = runnable.slice(index, index + concurrency);
      const results = await Promise.all(
        batch.map(async (step) => {
          const entry = stepState.get(step.id);
          if (!entry) return undefined;
          entry.status = 'running';
          entry.startedAt = new Date().toISOString();
          saveWorkflowState(workspaceDir, state);
          onProgress?.(`  ${step.id}: running`);
          const startedMs = Date.now();
          try {
            const result = await runner(step);
            entry.finishedAt = new Date().toISOString();
            entry.durationMs = result.durationMs ?? Date.now() - startedMs;
            entry.exitCode = result.exitCode;
            entry.outputTail = tail(result.output);
            if (result.sessionKey) entry.sessionKey = result.sessionKey;
            if (result.usage) entry.usage = result.usage;
            if (result.model) entry.model = result.model;
            if (result.passed) {
              entry.status = 'passed';
              delete entry.error;
              failedOrBlocked.delete(step.id);
            } else {
              entry.status = 'failed';
              entry.error = result.error ?? 'step failed';
              failedOrBlocked.add(step.id);
            }
            onProgress?.(`  ${step.id}: ${entry.status}`);
          } catch (err) {
            entry.finishedAt = new Date().toISOString();
            entry.durationMs = Date.now() - startedMs;
            entry.status = 'failed';
            entry.error = err instanceof Error ? err.message : String(err);
            failedOrBlocked.add(step.id);
            onProgress?.(`  ${step.id}: failed (${entry.error})`);
          }
          saveWorkflowState(workspaceDir, state);
          return entry;
        })
      );
      if (results.length === 0) continue;
    }
  }
  // Anything still pending after the waves (should not happen) is reported, not hidden.
  for (const entry of state.steps) {
    if (entry.status === 'pending') {
      entry.status = 'blocked';
      entry.error = entry.error ?? 'dependency never satisfied';
    }
  }
  saveWorkflowState(workspaceDir, state);
  return state;
}

export function workflowExitCode(state: WorkflowState): number {
  return state.steps.every((entry) => entry.status === 'passed') ? 0 : 1;
}

export function summarizeWorkflow(state: WorkflowState): string {
  const counts = new Map<WorkflowStepStatus, number>();
  for (const entry of state.steps) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([status, count]) => `${String(count)} ${status}`);
  return `${state.name} (${state.runId}): ${parts.join(', ')}`;
}

export function describeWorkflowStep(step: WorkflowStep): string {
  const deps = step.dependsOn.length > 0 ? ` after ${step.dependsOn.join(',')}` : '';
  const write = step.writePaths.length > 0 ? ` write ${step.writePaths.join(',')}` : '';
  return `${step.id}${deps}${write}`;
}
