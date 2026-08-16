import type { SpawnToolScope } from './spawn-profile.js';
import { resolveSpawnToolSet } from './spawn-profile.js';
import type { MeshEventBus } from '../../mesh/mesh-events.js';
import type { SubagentRunProgress } from '../tools/tool-types.js';
import { errorMessage } from '../../errors.js';

export interface SubAgentConfig {
  runId: string;

  parentRunId: string;

  scope: SpawnToolScope;

  task: string;

  /** Optional exact host allowlist, always intersected with the selected scope. */
  allowedTools?: readonly string[];

  /** Optional model override for this sub-agent (e.g. a cheaper model for
   *  exploration, a stronger model for a critical decision). The runner clones
   *  the parent's modelDef with this id; the provider routes by model id, so
   *  the sub-agent actually runs on the overridden model. Context-window
   *  re-detection for the override is a follow-up (parent's contextTokens is
   *  used as a fallback). */
  model?: string;

  /** Optional per-call system-prompt override. When set, the child agent runs
   *  with this as its system prompt instead of the parent's, used by the
   *  plan-critic to inject its critique prompt without touching parent state.
   *  When set, childSystemPromptParts is undefined (the override is a single
   *  block, not split into stable/dynamic for prefix-cache). */
  systemPromptOverride?: string;

  /** Host-trusted expert instructions appended without replacing base safety policy. */
  expertPrompt?: string;

  /** Optional context-tokens override paired with `model` (the host resolves
   *  the overridden model's context window and injects it here). Falls back to
   *  the parent's contextTokens when unset. */
  contextTokens?: number;

  maxTurns?: number;

  timeoutMs?: number;

  previousStepResult?: {
    runId: string;
    summary: string;
    success: boolean;
  };

  onProgress?: (progress: SubagentRunProgress) => void;
}

export interface SubAgentResult {
  runId: string;
  summary: string;
  toolResults: number;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface FanOutResult {
  results: SubAgentResult[];
  allSucceeded: boolean;
  durationMs: number;

  totalToolResults: number;
  totalTurns: number;
  successCount: number;
  failureCount: number;
}

export interface PipelineResult {
  results: SubAgentResult[];
  allSucceeded: boolean;
  durationMs: number;

  totalToolResults: number;
  totalTurns: number;
  successCount: number;
  failureCount: number;
}

export type SubAgentRunner = (
  config: SubAgentConfig,
  signal: AbortSignal
) => Promise<SubAgentResult>;

function aggregateResults(results: SubAgentResult[]): {
  totalToolResults: number;
  totalTurns: number;
  successCount: number;
  failureCount: number;
} {
  let totalToolResults = 0;
  let totalTurns = 0;
  let successCount = 0;
  let failureCount = 0;
  for (const r of results) {
    totalToolResults += r.toolResults;
    totalTurns += r.turns;
    if (r.success) successCount++;
    else failureCount++;
  }
  return { totalToolResults, totalTurns, successCount, failureCount };
}

async function runSingleChild(
  config: SubAgentConfig,
  runner: SubAgentRunner,
  eventBus: MeshEventBus | undefined,
  parentSignal: AbortSignal | undefined,
  startedAt: number
): Promise<SubAgentResult> {
  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? 120_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`child run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  eventBus?.emit({
    type: 'child_run_started',
    runId: config.runId,
    parentRunId: config.parentRunId,
    scope: config.scope,
    toolSet: [...(resolveSpawnToolSet(config.scope) ?? [])],
    timestamp: Date.now(),
  });

  try {
    const result = await Promise.race([runner(config, controller.signal), timeoutPromise]);

    if (result.success) {
      eventBus?.emit({
        type: 'child_run_completed',
        runId: config.runId,
        summary: result.summary,
        toolResults: result.toolResults,
        turns: result.turns,
        durationMs: result.durationMs,
        timestamp: Date.now(),
      });
    } else {
      eventBus?.emit({
        type: 'child_run_failed',
        runId: config.runId,
        error: result.error ?? 'unknown',
        category: 'execution',
        timestamp: Date.now(),
      });
    }

    return result;
  } catch (err) {
    const errorMsg = errorMessage(err);
    eventBus?.emit({
      type: 'child_run_failed',
      runId: config.runId,
      error: errorMsg,
      category: 'crash',
      timestamp: Date.now(),
    });

    return {
      runId: config.runId,
      summary: '',
      toolResults: 0,
      turns: 0,
      durationMs: Date.now() - startedAt,
      success: false,
      error: errorMsg,
    };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export async function runFanOut(
  configs: SubAgentConfig[],
  runner: SubAgentRunner,
  eventBus?: MeshEventBus,
  parentSignal?: AbortSignal
): Promise<FanOutResult> {
  const started = Date.now();

  const tasks = configs.map((config) =>
    runSingleChild(config, runner, eventBus, parentSignal, started)
  );

  const settled = await Promise.allSettled(tasks);
  const results: SubAgentResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          runId: configs[i].runId,
          summary: '',
          toolResults: 0,
          turns: 0,
          durationMs: Date.now() - started,
          success: false,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        }
  );
  const agg = aggregateResults(results);

  return {
    results,
    allSucceeded: results.every((r) => r.success),
    durationMs: Date.now() - started,
    ...agg,
  };
}

export async function runPipeline(
  configs: SubAgentConfig[],
  runner: SubAgentRunner,
  eventBus?: MeshEventBus,
  parentSignal?: AbortSignal
): Promise<PipelineResult> {
  const started = Date.now();
  const results: SubAgentResult[] = [];
  let previousResult: SubAgentResult | undefined;

  for (const config of configs) {
    if (parentSignal?.aborted) break;

    const augmentedConfig: SubAgentConfig = previousResult
      ? {
          ...config,
          previousStepResult: {
            runId: previousResult.runId,
            summary: previousResult.summary,
            success: previousResult.success,
          },
        }
      : config;

    const result = await runSingleChild(augmentedConfig, runner, eventBus, parentSignal, started);
    results.push(result);
    previousResult = result;

    if (!result.success) break;
  }

  const agg = aggregateResults(results);

  return {
    results,
    allSucceeded: results.length === configs.length && results.every((r) => r.success),
    durationMs: Date.now() - started,
    ...agg,
  };
}
