










import { randomUUID } from 'node:crypto';
import type {
  MossAsyncTaskSnapshot,
  MossAsyncTaskStartRequest,
} from '@rdk-moss/core/contracts/async-task';
import type { SubagentRunProgress, Tool, ToolContext } from '../core/tools/tool-types.js';

interface CreateSubagentInput {
  task: string;
  scope?: 'read-only' | 'device-read' | 'full' | 'explore' | 'plan' | 'verify';
  maxTurns?: number;
  timeoutMs?: number;
  background?: boolean;
  /** Override the sub-agent's model (e.g. a cheaper model for exploration, a
   *  stronger one for a critical decision). Omit to use the parent's model. */
  model?: string;
}

interface SubagentStatusInput {
  taskId: string;
  wait?: boolean;
}

interface SubagentStopInput {
  taskId: string;
}

const DEFAULT_SUBAGENT_TIMEOUT_MS = 600_000;   // 10 min — enough for 30+ turns of work
const DEFAULT_FAN_OUT_MAX_TURNS = 30;            // was 4; raised so agents can complete real tasks
const MIN_SUBAGENT_TIMEOUT_MS = 100;
const MAX_SUBAGENT_TIMEOUT_MS = 30 * 60_000;    // 30 min hard cap
const TERMINAL_SUBAGENT_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

function completionMetricLines(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  return [
    typeof record.runId === 'string' ? `runId: ${record.runId}` : '',
    typeof record.turns === 'number' ? `turns: ${record.turns}` : '',
    typeof record.toolResults === 'number' ? `toolResults: ${record.toolResults}` : '',
  ].filter(Boolean);
}

function snapshotProgressLines(snapshot: MossAsyncTaskSnapshot | undefined): string[] {
  if (!snapshot?.progress) return [];
  const progress = snapshot.progress;
  const lines: string[] = [];

  if (progress.phase) {
    lines.push(`phase: ${progress.phase}`);
  }

  if (progress.currentTurn !== undefined) {
    lines.push(
      `turn: ${progress.currentTurn}${progress.maxTurns ? `/${progress.maxTurns}` : ''}`
    );
  }

  if (progress.toolCalls !== undefined) {
    lines.push(`toolCalls: ${progress.toolCalls}`);
  }

  if (progress.lastTool) {
    lines.push(`lastTool: ${progress.lastTool}`);
  }

  return lines.length > 0 ? lines : [];
}

function resolveSubagentTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_SUBAGENT_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SUBAGENT_TIMEOUT_MS,
    Math.max(MIN_SUBAGENT_TIMEOUT_MS, Math.floor(timeoutMs))
  );
}

/** Empty/whitespace summary is never a successful completion (parent must not trust it). */
export function isEmptySubagentSummary(summary: string | undefined | null): boolean {
  const s = String(summary ?? '').trim();
  return !s || s === '(no output)';
}

/**
 * Normalize child success for parent-facing results: an empty summary cannot
 * count as success even if the child loop returned success=true.
 */
export function normalizeSubagentSuccess(success: boolean, summary: string | undefined | null): boolean {
  if (!success) return false;
  if (isEmptySubagentSummary(summary)) return false;
  return true;
}

export const createSubagentTool: Tool<CreateSubagentInput> = {
  name: 'create_subagent',
  description: [
    'Spawn a sub-agent to perform a task independently.',
    'Sub-agents have their own tool scope and context window.',
    'Use for parallel exploration, planning, verification, or bounded implementation slices.',
    'Do not use for quick usage/config/help questions, short-answer requests, or simple read-only summaries.',
    '',
    'Scopes: "explore" (read-only), "plan" (read + plan), "verify" (read + exec for testing), "full" (all tools).',
    'When scope is omitted it is inferred from the task text (fix/implement→full, explore/architecture→explore, verify-only→verify, plan→plan; otherwise full).',
    'maxTurns defaults by scope (explore ~20, plan ~24, verify ~30, full 64) unless you set it. Put acceptance criteria + verification in implement/fix tasks.',
    'Treat empty child output as failure — do not invent success.',
  ].join(' '),
  metadata: {
    sideEffectClass: 'subagent',
    planMode: 'allow',
    requiresApproval: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Task description for the sub-agent',
      },
      scope: {
        type: 'string',
        enum: ['read-only', 'device-read', 'full', 'explore', 'plan', 'verify'],
        description:
          'Tool scope. When omitted, inferred from task text (default full if ambiguous).',
      },
      maxTurns: {
        type: 'number',
        description:
          'Maximum turns (default by scope: explore 20, plan 24, verify 30, full 64)',
      },
      timeoutMs: {
        type: 'number',
        minimum: MIN_SUBAGENT_TIMEOUT_MS,
        maximum: MAX_SUBAGENT_TIMEOUT_MS,
        description:
          'Maximum runtime for the sub-agent in milliseconds (default: 600000 = 10 min, max: 1800000 = 30 min)',
      },
      background: {
        type: 'boolean',
        description:
          'Return immediately with a task handle instead of waiting for the sub-agent to finish',
      },
      model: {
        type: 'string',
        description:
          'Override the sub-agent model (e.g. a cheaper model for read-only exploration, a stronger model for a critical decision). Omit to use the parent agent\'s model. The provider routes by model id, so the override takes effect at the request level.',
      },
    },
    required: ['task'],
  },

  async execute(input: CreateSubagentInput, ctx: ToolContext): Promise<string> {
    if (!ctx.spawnSubagent) {
      return 'Error: sub-agent spawning is not available in this context.';
    }
    if (
      ctx.maxSpawnDepth !== undefined &&
      ctx.currentSpawnDepth !== undefined &&
      ctx.currentSpawnDepth >= ctx.maxSpawnDepth
    ) {
      return `Error: maximum spawn depth (${ctx.maxSpawnDepth}) reached; cannot spawn nested sub-agents.`;
    }

    if (input.background) {
      if (!ctx.asyncTaskRegistry) {
        return 'Error: background sub-agent tasks are not available in this context.';
      }
      const taskId = `${ctx.runId ?? ctx.sessionKey}/sub-${randomUUID().slice(0, 8)}`;
      const scope = inferFanOutScope(input.task, input.scope);
      const maxTurns = input.maxTurns ?? defaultMaxTurnsForScope(scope);
      const timeoutMs = resolveSubagentTimeoutMs(input.timeoutMs);
      const updateProgress = (progress: SubagentRunProgress) => {
        ctx.asyncTaskRegistry?.update(taskId, {
          progress: {
            phase: progress.phase ?? progress.status,
            message: progress.status,
            ...(progress.turn !== undefined ? { currentTurn: progress.turn } : {}),
            ...(progress.maxTurns !== undefined ? { maxTurns: progress.maxTurns } : {}),
            ...(progress.toolResults !== undefined ? { toolCalls: progress.toolResults } : {}),
            ...(progress.lastTool ? { lastTool: progress.lastTool } : {}),
            ...(progress.error ? { lastError: progress.error } : {}),
            ...(progress.summaryPreview ? { summaryPreview: progress.summaryPreview } : {}),
            details: {
              runId: progress.runId,
              scope: progress.scope,
              elapsedMs: progress.elapsedMs,
            },
          },
          ...(progress.error ? { error: progress.error } : {}),
        });
      };
      const handle = ctx.asyncTaskRegistry.start(
        {
          taskId,
          kind: 'subagent',
          label: input.task.slice(0, 80),
          parentRunId: ctx.runId,
          timeoutMs,
          payload: {
            task: input.task,
            scope,
            maxTurns,
            timeoutMs,
          },
        },
        async (_request: MossAsyncTaskStartRequest, signal: AbortSignal) => {
          const result = await ctx.spawnSubagent?.({
            task: input.task,
            scope,
            maxTurns,
            timeoutMs,
            abortSignal: signal,
            onProgress: updateProgress,
            ...(input.model ? { model: input.model } : {}),
          });
          if (!result) {
            return {
              success: false,
              summary: 'Sub-agent spawning is no longer available.',
            };
          }
          const summary =
            result.summary ||
            (result.success ? '(no output)' : 'Sub-agent failed.');
          const ok = normalizeSubagentSuccess(result.success, result.summary);
          return {
            success: ok,
            summary:
              ok || !isEmptySubagentSummary(result.summary)
                ? summary
                : `${summary}\n(empty output treated as failure — do not invent success)`,
            data: {
              runId: result.runId,
              sessionKey: result.sessionKey,
              ...(result.turns !== undefined ? { turns: result.turns } : {}),
              ...(result.toolResults !== undefined ? { toolResults: result.toolResults } : {}),
              ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
              ...(result.error ? { error: result.error } : {}),
              ...(ok ? {} : { normalizedFailure: true }),
            },
          };
        },
        { parentSignal: ctx.abortSignal }
      );
      return [
        `[Sub-agent task ${handle.taskId}] STARTED`,
        '',
        'The sub-agent is running in the background. Its final summary will be available through the host async task registry.',
      ].join('\n');
    }

    const scope = inferFanOutScope(input.task, input.scope);
    const maxTurns = input.maxTurns ?? defaultMaxTurnsForScope(scope);
    const result = await ctx.spawnSubagent({
      task: input.task,
      scope,
      maxTurns,
      timeoutMs: resolveSubagentTimeoutMs(input.timeoutMs),
      ...(input.model ? { model: input.model } : {}),
    });
    const summary = result.summary || '(no output)';
    const ok = normalizeSubagentSuccess(result.success, result.summary);
    const status = ok ? 'SUCCESS' : 'FAILED';
    const emptyNote =
      !ok && isEmptySubagentSummary(result.summary)
        ? '\nNote: empty sub-agent output is treated as failure — do not invent a success summary.'
        : '';
    const metrics = [
      `scope: ${scope}`,
      `turns: ${result.turns ?? 0}`,
      `toolCalls: ${result.toolResults ?? 0}`,
      `elapsed: ${result.durationMs ?? 0} ms`,
    ].join(' | ');
    return [
      `[Sub-agent ${result.runId.slice(0, 8)}] ${status}`,
      `${metrics}`,
      '',
      summary + emptyNote,
    ].join('\n');
  },
};

interface FanOutTaskInput {
  task: string;
  scope?: 'read-only' | 'device-read' | 'full' | 'explore' | 'plan' | 'verify';
  label?: string;
  /** Per-task model override (e.g. a cheap model for exploration, a strong
   *  model for a critical angle). Omit to use the parent's model. */
  model?: string;
}

interface FanOutSubagentsInput {
  tasks: FanOutTaskInput[];
  maxTurns?: number;
  timeoutMs?: number;
}

const MAX_FAN_OUT_TASKS = 8;  // was 6; user requested ≤8 sub-agents

type FanOutScope = NonNullable<FanOutTaskInput['scope']>;

/**
 * Infer a sensible default scope from the task text when the parent omits
 * `scope`. Review/explore stays read-only; implementation/fix verbs upgrade
 * to full/verify so coding slices don't land on explore by accident.
 * Shared by fan_out_subagents and create_subagent.
 * @internal exported for tests
 */
export function inferFanOutScope(task: string, explicit?: FanOutScope): FanOutScope {
  if (explicit) return explicit;
  const t = task.trim();
  // Verify-only / test-only work
  if (
    /(?:\bverify\b|\bvalidate\b|\brun tests?\b|\btypecheck\b|\blint\b|验证|跑测试|类型检查)/iu.test(t) &&
    !/(?:\bfix\b|\bimplement\b|\bedit\b|\bwrite\b|修复|实现|改代码)/iu.test(t)
  ) {
    return 'verify';
  }
  // Implementation / fix / refactor needs write tools
  if (
    /(?:\bfix\b|\bbug\b|\bimplement\b|\brefactor\b|\bedit\b|\bwrite\b|\bpatch\b|\badd\b|\bchange\b|修复|实现|重构|修改|改代码)/iu.test(
      t,
    )
  ) {
    return 'full';
  }
  // Planning
  if (/(?:\bplan\b|\broadmap\b|方案|计划|分阶段)/iu.test(t) && !/(?:\bimplement\b|实现)/iu.test(t)) {
    return 'plan';
  }
  // Open-ended exploration / architecture questions
  if (
    /(?:\bexplore\b|\bhow is\b|\borganized\b|\bstructured\b|\barchitecture\b|\breview\b|\blook for\b|探索|架构|怎么组织|如何组织|审查)/iu.test(
      t,
    )
  ) {
    return 'explore';
  }
  // Ambiguous: caller chooses fallback (create_subagent → full, fan_out → explore).
  return 'full';
}

/** Fan-out default when task text is ambiguous: read-only explore (parallel review). */
export function inferFanOutScopeWithExploreDefault(
  task: string,
  explicit?: FanOutScope,
): FanOutScope {
  if (explicit) return explicit;
  const inferred = inferFanOutScope(task, undefined);
  // When only the generic full default fired (no implement/verify/plan/explore cues),
  // parallel fan-out prefers explore so reviews stay read-only.
  if (inferred === 'full') {
    const t = task.trim();
    const hasWriteCue =
      /(?:\bfix\b|\bbug\b|\bimplement\b|\brefactor\b|\bedit\b|\bwrite\b|\bpatch\b|修复|实现|重构|修改|改代码)/iu.test(
        t,
      );
    if (!hasWriteCue) return 'explore';
  }
  return inferred;
}

/** Default maxTurns by scope — explore/plan lighter than full implementation. */
export function defaultMaxTurnsForScope(scope: FanOutScope): number {
  switch (scope) {
    case 'explore':
    case 'read-only':
    case 'device-read':
      return 20;
    case 'plan':
      return 24;
    case 'verify':
      return 30;
    case 'full':
    default:
      return 64;
  }
}











export const fanOutSubagentsTool: Tool<FanOutSubagentsInput> = {
  name: 'fan_out_subagents',
  description: [
    `Run 2-${MAX_FAN_OUT_TASKS} sub-agents CONCURRENTLY over independent tasks, then return all their summaries aggregated.`,
    'Use for breadth + speed when independent facets can be tackled in parallel — e.g. multi-angle code review',
    '(correctness / security / perf), multi-source exploration, or cross-checking a finding. Each child is',
    'Default scope is inferred from each task text when omitted: review/explore → explore; ' +
    'fix/implement/refactor → full; verify/test-only → verify; plan-only → plan. ' +
    'You may still set scope explicitly. Put acceptance criteria + verification commands in implementation tasks. ' +
    'Empty child output is FAILED. For a single task, use create_subagent instead.',
    'Do not use for quick usage/config/help questions, "answer in N lines" requests, or simple UX impressions;',
    'answer directly or do at most one targeted file read in those cases.',
  ].join(' '),
  metadata: {
    sideEffectClass: 'subagent',
    planMode: 'allow',
    requiresApproval: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 2,
        maxItems: MAX_FAN_OUT_TASKS,
        description: `2-${MAX_FAN_OUT_TASKS} independent tasks to run concurrently.`,
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task / system prompt for this sub-agent' },
            scope: {
              type: 'string',
              enum: ['read-only', 'device-read', 'full', 'explore', 'plan', 'verify'],
              description:
                'Tool scope. When omitted, inferred from task text (explore for review; full for fix/implement; verify for test-only).',
            },
            label: {
              type: 'string',
              description: 'Short angle label, e.g. "correctness" / "security"',
            },
            model: {
              type: 'string',
              description: 'Per-task model override (e.g. a cheap model for exploration, a strong model for a critical angle). Omit to use the parent agent\'s model.',
            },
          },
          required: ['task'],
        },
      },
      maxTurns: {
        type: 'number',
        description: `Max turns per sub-agent (default: ${DEFAULT_FAN_OUT_MAX_TURNS}). Raise to 60+ for deep review tasks; keep at 10-20 for quick exploration.`,
      },
      timeoutMs: {
        type: 'number',
        minimum: MIN_SUBAGENT_TIMEOUT_MS,
        maximum: MAX_SUBAGENT_TIMEOUT_MS,
        description: 'Max runtime per sub-agent in ms (default: 120000, max: 1800000)',
      },
    },
    required: ['tasks'],
  },

  async execute(input: FanOutSubagentsInput, ctx: ToolContext): Promise<string> {
    if (!ctx.spawnSubagent) {
      return 'Error: sub-agent spawning is not available in this context.';
    }
    if (
      ctx.maxSpawnDepth !== undefined &&
      ctx.currentSpawnDepth !== undefined &&
      ctx.currentSpawnDepth >= ctx.maxSpawnDepth
    ) {
      return `Error: maximum spawn depth (${ctx.maxSpawnDepth}) reached; cannot spawn nested sub-agents.`;
    }

    const tasks = (Array.isArray(input.tasks) ? input.tasks : [])
      .filter((t) => t && typeof t.task === 'string' && t.task.trim())
      .slice(0, MAX_FAN_OUT_TASKS);
    if (tasks.length < 2) {
      return 'Error: fan_out_subagents needs at least 2 tasks; use create_subagent for a single task.';
    }

    const maxTurns = input.maxTurns ?? DEFAULT_FAN_OUT_MAX_TURNS;
    const timeoutMs = resolveSubagentTimeoutMs(input.timeoutMs);
    const labelFor = (i: number) => String(tasks[i].label ?? `task ${i + 1}`).slice(0, 40);
    const resolvedScopes = tasks.map((t) =>
      inferFanOutScopeWithExploreDefault(t.task, t.scope),
    );

    const settled = await Promise.allSettled(
      tasks.map((t, i) =>
        ctx.spawnSubagent!({
          task: t.task,
          scope: resolvedScopes[i],
          maxTurns,
          timeoutMs,
          abortSignal: ctx.abortSignal,
          ...(t.model ? { model: t.model } : {}),
        })
      )
    );

    let ok = 0;
    let fail = 0;
    const sections: string[] = [];
    const failedRetries: string[] = [];
    settled.forEach((s, i) => {
      const label = labelFor(i);
      const taskIdx = i + 1;
      const scope = resolvedScopes[i]!;
      const taskText = tasks[i]!.task.trim();
      if (s.status === 'fulfilled' && s.value) {
        const r = s.value;
        const childOk = normalizeSubagentSuccess(r.success, r.summary);
        if (childOk) ok++;
        else fail++;
        const id = String(r.runId ?? '').slice(0, 8);
        const summary = r.summary || '(no output)';
        const emptyNote =
          !childOk && isEmptySubagentSummary(r.summary)
            ? '\n(empty output treated as failure — do not invent success)'
            : '';
        sections.push(
          `### [${label}] ${childOk ? 'SUCCESS' : 'FAILED'} (scope: ${scope})${id ? ` (sub-agent ${id})` : ''}\n${summary}${emptyNote}`
        );
        if (!childOk) {
          failedRetries.push(
            `- label=${JSON.stringify(label)} scope=${scope} task=${JSON.stringify(taskText.slice(0, 200))}`,
          );
        }
      } else {
        fail++;
        const reason = s.status === 'rejected' ? String(s.reason) : 'sub-agent spawning unavailable';
        const errorMsg = [
          `[ERROR: task ${taskIdx} (${label}, scope: ${scope})]`,
          `Status: ${reason}`,
          `Recovery: Check network connection or available resources, then retry fan_out_subagents.`,
        ].join('\n');
        sections.push(`### [${label}] ERROR (scope: ${scope})\n${errorMsg}`);
        failedRetries.push(
          `- label=${JSON.stringify(label)} scope=${scope} task=${JSON.stringify(taskText.slice(0, 200))}`,
        );
      }
    });

    // When any child failed, prefix with Error: so isStringToolFailureResult /
    // is_error / failure-driven completion gates treat the fan-out as a real
    // failure (not a green tool_result with FAILED buried in prose).
    const header =
      fail > 0
        ? `Error: [fan_out_subagents] ${tasks.length} sub-agents ran concurrently — ${ok} ok, ${fail} failed. Do not treat FAILED/empty children as done; merge only successful evidence or re-run failed angles.`
        : `[fan_out_subagents] ${tasks.length} sub-agents ran concurrently — ${ok} ok, ${fail} failed.`;

    const retryBlock =
      failedRetries.length > 0
        ? [
            '',
            '## Retry failed angles (copy into a new fan_out or create_subagent)',
            'Only re-run FAILED children; do not invent success for them.',
            ...failedRetries,
          ].join('\n')
        : '';

    return [header, '', sections.join('\n\n'), retryBlock].filter(Boolean).join('\n');
  },
};

export const subagentStatusTool: Tool<SubagentStatusInput> = {
  name: 'subagent_status',
  description: [
    'Check or wait for a background sub-agent task started by create_subagent with background=true.',
    'Use wait=false for a non-blocking status snapshot, or wait=true when you need the final completion summary.',
  ].join(' '),
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task id returned by create_subagent background mode',
      },
      wait: {
        type: 'boolean',
        description: 'When true, wait until the background task reaches a terminal state',
      },
    },
    required: ['taskId'],
  },

  async execute(input: SubagentStatusInput, ctx: ToolContext): Promise<string> {
    if (!ctx.asyncTaskRegistry) {
      return 'Error: background sub-agent tasks are not available in this context.';
    }

    const taskId = String(input.taskId ?? '').trim();
    if (!taskId) return 'Error: taskId is required.';

    const snapshot = ctx.asyncTaskRegistry.status(taskId);
    if (!snapshot) return `Error: background sub-agent task not found: ${taskId}`;

    const completion = input.wait
      ? await ctx.asyncTaskRegistry.wait(taskId)
      : ctx.asyncTaskRegistry.readCompletion(taskId);

    if (completion) {
      const summary = completion.summary || completion.error || '(no output)';
      const ok = normalizeSubagentSuccess(completion.success, summary);
      const status = ok ? 'SUCCESS' : 'FAILED';
      const emptyNote =
        !ok && isEmptySubagentSummary(summary)
          ? '\n(empty output treated as failure — do not invent success)'
          : '';
      return [
        `[Sub-agent task ${taskId}] ${status}`,
        `status: ${ok ? completion.status : 'failed'}`,
        `durationMs: ${completion.durationMs}`,
        ...completionMetricLines(completion.data),
        '',
        summary + emptyNote,
      ].join('\n');
    }

    return [
      `[Sub-agent task ${taskId}] ${snapshot.status.toUpperCase()}`,
      `kind: ${snapshot.kind}`,
      ...(snapshot.label ? [`label: ${snapshot.label}`] : []),
      ...(snapshot.startedAt ? [`startedAt: ${snapshot.startedAt}`] : []),
      ...snapshotProgressLines(snapshot),
      `updatedAt: ${snapshot.updatedAt}`,
    ].join('\n');
  },
};

export const subagentStopTool: Tool<SubagentStopInput> = {
  name: 'subagent_stop',
  description: [
    'Stop a background sub-agent task started by create_subagent with background=true.',
    'Use when a long-running sub-agent is no longer useful or should yield control back to the parent task.',
  ].join(' '),
  metadata: {
    sideEffectClass: 'subagent',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'Task id returned by create_subagent background mode',
      },
    },
    required: ['taskId'],
  },

  async execute(input: SubagentStopInput, ctx: ToolContext): Promise<string> {
    if (!ctx.asyncTaskRegistry) {
      return 'Error: background sub-agent tasks are not available in this context.';
    }

    const taskId = String(input.taskId ?? '').trim();
    if (!taskId) return 'Error: taskId is required.';

    const snapshot = ctx.asyncTaskRegistry.status(taskId);
    if (!snapshot) return `Error: background sub-agent task not found: ${taskId}`;

    if (TERMINAL_SUBAGENT_TASK_STATUSES.has(snapshot.status)) {
      const completion = ctx.asyncTaskRegistry.readCompletion(taskId);
      return [
        `[Sub-agent task ${taskId}] ALREADY ${snapshot.status.toUpperCase()}`,
        `status: ${snapshot.status}`,
        ...(completion ? ['', completion.summary || completion.error || '(no output)'] : []),
      ].join('\n');
    }

    ctx.asyncTaskRegistry.stop(taskId, 'user_cancelled');
    const completion = ctx.asyncTaskRegistry.readCompletion(taskId);
    if (completion) {
      return [
        `[Sub-agent task ${taskId}] STOPPED`,
        `status: ${completion.status}`,
        '',
        completion.summary || completion.error || 'Task cancelled.',
      ].join('\n');
    }

    return [`[Sub-agent task ${taskId}] STOP REQUESTED`, `previousStatus: ${snapshot.status}`].join(
      '\n'
    );
  },
};
