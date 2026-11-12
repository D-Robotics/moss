import { truncateWithRecoveryPath } from '../../context/tool-output-spill.js';
import { getRootLogger } from '../../logger.js';
import type { LLMMessage } from '../llm/llm-provider.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import {
  executeOneToolCall,
  outcomeToResult,
  type ExecuteToolCallOutcome,
  type ExecuteToolCallDeps,
} from '../tools/execute-tool-call.js';
import { maybeSuppressRedundantWebFetchAfterOpenUrl } from '../tools/open-url-web-fetch-guard.js';
import type { PendingToolAbortStore } from './pending-tool-aborts.js';
import type { AgentLoopMutableState } from './agent-loop-state.js';
import type { Message, ContentBlock } from '../session/session-jsonl.js';
import type { Tool, ToolContext, ToolResultOutcome } from '../tools/tool-types.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import {
  findReplayableToolResultContent,
  stableSerializeToolInput,
} from '../tools/tool-idempotent-replay.js';
import {
  formatToolResultForSsePreview,
  groupToolCallsForExecution,
  syncAssistantToolUseInput,
} from './agent-loop-tool-helpers.js';
import {
  formatToolLoopGuardMessage,
  markFreshObservationUnverified,
  recordFreshObservationOutcome,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
  type ToolLoopGuardState,
} from '../tools/tool-loop-guard.js';
import { buildBackgroundCompletionSystemText } from './background-completion.js';
import { inAcceptanceScope } from '../task/acceptance-commit-scope.js';
import {
  MAX_STRUCTURED_SIZE,
  modelToolResultText,
  structuredContentTruncationNotice,
} from '../tools/message-convert.js';
import {
  FILE_UNCHANGED_STUB,
  FILE_UNCHANGED_TRUNCATED_STUB,
} from '../../contracts/file-read-observation.js';

/** Ceiling for attached image payload (base64 chars) in one tool result. */
const MAX_STRUCTURED_IMAGE_CHARS = 16_000_000;

const log = getRootLogger().child('agent:loop');

export interface AgentLoopToolExecutionMetrics {
  totalToolCalls: number;
  toolErrors: number;
  consecutiveToolErrors: number;
  toolCallsByName: Record<string, number>;
  prepNextTurnParallelMs: number;
}

export interface ExecuteAgentLoopToolCallsParams {
  runId: string;
  sessionKey: string;
  turnIndex: number;
  currentMessages: Message[];
  assistantContent: ContentBlock[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  resolveToolsForRun: () => Tool[];
  toolCtx: ToolContext;
  toolHooks?: ToolHookRegistry;
  abortSignal: AbortSignal;
  toolTimeoutMs: number;
  toolHeartbeatIntervalMs: number;
  skipHeartbeatToolNames: Set<string>;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
    abortSignal: AbortSignal;
    tool?: Tool;
  }) => Promise<{
    approved: boolean;
    decision: string;
    reason?: string;
    updatedInput?: Record<string, unknown>;
  } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  parallelSafeTools: Set<string>;
  loadToolsMetaName?: string;
  toolLoopGuard: ToolLoopGuardState;
  state: AgentLoopMutableState;
  maxToolCalls?: number;
  metrics: AgentLoopToolExecutionMetrics;
  evaluateSteering: () => Message[];
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  pendingToolAborts: PendingToolAbortStore;
}

interface PreflightContext {
  maxToolCalls?: number;
  metrics: AgentLoopToolExecutionMetrics;
  toolLoopGuard: ToolLoopGuardState;
  sessionKey: string;
  historyBeforeAssistant: LLMMessage[];
  requireFreshExecution: boolean;
}

interface OutcomeRecordingContext {
  assistantContent: ContentBlock[];
  /** When set, a truncated result gets a spilled copy so its middle stays readable. */
  workspaceDir?: string;
  /** B70: effective prompt budget, so tiny windows cap the result size. */
  contextWindowTokens?: number;
  push: (event: MiniAgentEvent) => void;
  toolLoopGuard: ToolLoopGuardState;
  metrics: AgentLoopToolExecutionMetrics;
  state: AgentLoopMutableState;
  toolsForRun: Tool[];
  originalInputs: WeakMap<ToolCallRef, string>;
}

type ToolCallRef = { id: string; name: string; input: Record<string, unknown> };

function isFreshObservation(tool: Tool | undefined): boolean {
  const meta = tool?.metadata;
  return (
    meta?.freshObservation === true && meta.noReplay === true && meta.sideEffectClass === 'readonly'
  );
}

function hasRepeatedFreshObservation(calls: ToolCallRef[], tools: Tool[]): boolean {
  const seen = new Set<string>();
  for (const call of calls) {
    if (!isFreshObservation(tools.find((tool) => tool.name === call.name))) continue;
    const signature = `${call.name}:${stableSerializeToolInput(call.input)}`;
    if (seen.has(signature)) return true;
    seen.add(signature);
  }
  return false;
}

export function parallelToolCallsWithinBudget(
  groupSize: number,
  metrics: Pick<AgentLoopToolExecutionMetrics, 'totalToolCalls'>,
  maxToolCalls?: number
): boolean {
  return maxToolCalls === undefined || metrics.totalToolCalls + groupSize <= maxToolCalls;
}

/**
 * The loop's identical-call replay lookup. O122/O128: tools marked
 * `noReplay` (read_file) always execute, so their side state (read scope) is
 * recorded; every other read-only tool still replays.
 */
export function findLoopReplay(
  history: LLMMessage[],
  toolName: string,
  input: Record<string, unknown>,
  toolMeta: Tool['metadata'] | undefined
): string | null {
  if (toolMeta?.noReplay || toolMeta?.canSuspend) return null;
  return findReplayableToolResultContent(history, toolName, input, 32, toolMeta?.sideEffectClass);
}

function preflightToolCall(
  call: ToolCallRef,
  ctx: PreflightContext,
  resolvedTools: Tool[],
  options: { parallelBatch?: boolean } = {}
): ExecuteToolCallOutcome | null {
  if (ctx.maxToolCalls !== undefined && ctx.metrics.totalToolCalls >= ctx.maxToolCalls) {
    return {
      kind: 'completed',
      text: `Tool budget reached (${ctx.maxToolCalls}); answer with the evidence already gathered instead of calling more tools.`,
      isError: true,
      durationMs: 0,
      outcome: 'blocked',
    };
  }

  const tool = resolvedTools.find((item) => item.name === call.name);
  const loopReason = shouldShortCircuitToolCall(ctx.toolLoopGuard, call.name, call.input, {
    ...options,
    freshObservation: isFreshObservation(tool),
  });
  if (loopReason) {
    // The guard routinely short-circuits redundant tool calls (e.g. the model
    // re-requesting the same file in a turn). It's a normal internal event,
    // not a warning — log.info (suppressed by default at level 'warn') so it
    // doesn't clutter the user's terminal. Opt in with MOSS_LOG_LEVEL=info.
    log.info('tool loop guard short-circuited tool call', {
      tool: call.name,
      reason: loopReason,
      sessionKey: ctx.sessionKey,
    });
    const text = formatToolLoopGuardMessage(loopReason, call.name);
    if (
      /fresh-news search is already in progress/i.test(loopReason) ||
      /dated RSS news snapshot/i.test(loopReason)
    ) {
      return {
        kind: 'completed',
        text,
        isError: false,
        durationMs: 0,
        outcome: 'suppressed',
      };
    }
    return { kind: 'pre-blocked', text };
  }

  const fetchSuppressed =
    call.name === 'web_fetch'
      ? maybeSuppressRedundantWebFetchAfterOpenUrl(
          ctx.historyBeforeAssistant,
          String((call.input as Record<string, unknown>)?.url ?? '')
        )
      : null;
  if (fetchSuppressed) {
    log.info('web_fetch suppressed (open_url already opened the page)', {
      url: (call.input as Record<string, unknown>)?.url,
    });
    return {
      kind: 'completed',
      text: fetchSuppressed,
      isError: false,
      durationMs: 0,
      outcome: 'suppressed',
    };
  }

  const toolMeta = tool?.metadata;
  // Verification evidence must describe an actual execution, not a cached read.
  if (ctx.requireFreshExecution) return null;
  const replayed = findLoopReplay(ctx.historyBeforeAssistant, call.name, call.input, toolMeta);
  if (replayed) {
    log.info('tool replay: reusing recent identical-params result', {
      tool: call.name,
    });
    return {
      kind: 'completed',
      text: replayed,
      isError: false,
      durationMs: 0,
      outcome: 'replayed',
    };
  }

  return null;
}

function recordToolOutcome(
  call: ToolCallRef,
  outcome: ExecuteToolCallOutcome,
  ctx: OutcomeRecordingContext,
  toolResults: ContentBlock[]
): void {
  syncAssistantToolUseInput(ctx.assistantContent, call);
  if (outcome.kind !== 'completed') {
    ctx.push({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.input,
    });
  }

  const {
    text: result,
    isError,
    structuredContent: rawStructuredContent,
    error,
    protectedPathChanges,
  } = outcomeToResult(outcome);
  const toolOutcome: ToolResultOutcome =
    outcome.kind === 'completed'
      ? (outcome.outcome ?? (isError ? 'error' : 'ok'))
      : outcome.kind === 'denied'
        ? 'denied'
        : 'blocked';
  const durationMs = outcome.kind === 'completed' ? outcome.durationMs : 0;
  let structuredContent = rawStructuredContent;
  let structuredContentTruncated: number | undefined;
  if (structuredContent && structuredContent.length > 0) {
    // Images are exempt from the text metadata budget: base64 grows ~1.37× the
    // file, so a normal screenshot would always exceed MAX_STRUCTURED_SIZE and
    // be replaced by a notice — silently dropping the picture the tool just read.
    // The tool that produced the image owns its size limit (read_image: 3 MB);
    // this bound is only a last-resort ceiling against a pathological result.
    const imageBlocks = structuredContent.filter((block) => block.type === 'image');
    const textBlocks = structuredContent.filter((block) => block.type !== 'image');
    const imageChars = imageBlocks.reduce((sum, block) => sum + (block.data?.length ?? 0), 0);
    const keptImages = imageChars > MAX_STRUCTURED_IMAGE_CHARS ? [] : imageBlocks;
    let keptText = textBlocks;
    if (textBlocks.length > 0) {
      const serialized = JSON.stringify(textBlocks);
      if (serialized.length > MAX_STRUCTURED_SIZE) {
        structuredContentTruncated = serialized.length;
        keptText = textBlocks.every((block) => block.type === 'text')
          ? []
          : [{ type: 'text', text: structuredContentTruncationNotice(serialized.length) }];
      }
    }
    if (imageBlocks.length > 0 && keptImages.length === 0) {
      keptText = [
        ...keptText,
        {
          type: 'text',
          text: `[image attachment dropped: ${imageChars} base64 chars exceeded ${MAX_STRUCTURED_IMAGE_CHARS}]`,
        },
      ];
    }
    const combined = [...keptText, ...keptImages];
    structuredContent = combined.length > 0 ? combined : undefined;
  }

  const truncatedResult = truncateWithRecoveryPath({
    toolName: call.name,
    input: call.input,
    text: result,
    workspaceDir: ctx.workspaceDir,
    ...(ctx.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: ctx.contextWindowTokens }),
  });
  const originalInput = ctx.originalInputs.get(call);
  if (
    isFreshObservation(ctx.toolsForRun.find((tool) => tool.name === call.name)) &&
    originalInput !== undefined
  ) {
    if (
      outcome.kind === 'completed' &&
      !isError &&
      !outcome.aborted &&
      (outcome.outcome === undefined || outcome.outcome === 'ok') &&
      originalInput === stableSerializeToolInput(call.input)
    ) {
      recordFreshObservationOutcome(
        ctx.toolLoopGuard,
        call.name,
        call.input,
        modelToolResultText(truncatedResult, structuredContent, structuredContentTruncated),
        {
          unchanged:
            call.name === 'read_file' &&
            !rawStructuredContent &&
            (result === FILE_UNCHANGED_STUB || result === FILE_UNCHANGED_TRUNCATED_STUB),
        }
      );
    } else {
      markFreshObservationUnverified(ctx.toolLoopGuard, call.name, originalInput);
    }
  }
  ctx.metrics.totalToolCalls++;
  ctx.metrics.toolCallsByName[call.name] = (ctx.metrics.toolCallsByName[call.name] ?? 0) + 1;
  if (isError) {
    ctx.metrics.toolErrors++;
    ctx.metrics.consecutiveToolErrors++;
  } else {
    ctx.metrics.consecutiveToolErrors = 0;
  }

  recordToolLoopOutcome(ctx.toolLoopGuard, call.name, isError, result, call.input);
  recordFailingVerifyStreak(ctx.state, call.name, call.input, result, isError);

  const preview =
    outcome.kind === 'hook-blocked' || outcome.kind === 'denied'
      ? truncatedResult
      : formatToolResultForSsePreview(truncatedResult, isError);

  ctx.push({
    type: 'tool_execution_end',
    toolCallId: call.id,
    toolName: call.name,
    result: preview,
    isError,
    args: call.input,
    outcome: toolOutcome,
    durationMs,
    content: truncatedResult,
    ...(outcome.kind === 'completed' && outcome.aborted ? { aborted: outcome.aborted } : {}),
    ...(structuredContent ? { structuredContent } : {}),
    ...(error ? { error } : {}),
    ...(protectedPathChanges ? { protectedPathChanges } : {}),
  });
  toolResults.push({
    type: 'tool_result',
    tool_use_id: call.id,
    name: call.name,
    content: truncatedResult,
    is_error: isError,
    outcome: toolOutcome,
    durationMs,
    ...(outcome.kind === 'completed' && outcome.aborted ? { aborted: outcome.aborted } : {}),
    ...(structuredContent ? { structuredContent } : {}),
    ...(structuredContentTruncated !== undefined
      ? { _structuredContentTruncated: structuredContentTruncated }
      : {}),
  });
}

export async function executeAgentLoopToolCalls(
  params: ExecuteAgentLoopToolCallsParams
): Promise<{ pendingMessages: Message[] }> {
  const {
    runId,
    sessionKey,
    turnIndex,
    state,
    currentMessages,
    assistantContent,
    toolCalls,
    resolveToolsForRun,
    toolCtx,
    toolHooks,
    abortSignal,
    toolTimeoutMs,
    toolHeartbeatIntervalMs,
    skipHeartbeatToolNames,
    checkToolApproval,
    toolAbortSignalFor,
    enrichToolContext,
    parallelSafeTools,
    loadToolsMetaName,
    toolLoopGuard,
    maxToolCalls,
    metrics,
    evaluateSteering,
    appendMessage,
    push,
  } = params;

  const toolResults: ContentBlock[] = [];

  // Message[] -> LLMMessage[]: the two types are structurally compatible but TS cannot
  // infer it because Message is the session-jsonl persistence format and LLMMessage is
  // the LLM provider input format. This takes messages before the assistant turn for
  // preflight checks (replay/web_fetch suppression).
  const historyBeforeAssistant = currentMessages.slice(0, -1) as unknown as LLMMessage[];

  const preflightCtx: PreflightContext = {
    maxToolCalls,
    metrics,
    toolLoopGuard,
    sessionKey,
    historyBeforeAssistant,
    requireFreshExecution: toolCtx.agentId === 'subagent:verify',
  };
  const toolsForRun = resolveToolsForRun();
  const originalInputs = new WeakMap<ToolCallRef, string>();
  for (const call of toolCalls) originalInputs.set(call, stableSerializeToolInput(call.input));
  const recordCtx: OutcomeRecordingContext = {
    assistantContent,
    workspaceDir: toolCtx.workspaceDir,
    ...(toolCtx.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: toolCtx.contextWindowTokens }),
    push,
    toolLoopGuard,
    metrics,
    state,
    toolsForRun,
    originalInputs,
  };

  const readonlyToolNames = new Set(
    toolsForRun
      .filter((t) => t.metadata?.sideEffectClass === 'readonly' && !t.metadata.canSuspend)
      .map((t) => t.name)
  );
  const requestedParallelSafe = parallelSafeTools.size > 0 ? parallelSafeTools : readonlyToolNames;
  const effectiveParallelSafeTools = new Set(
    [...requestedParallelSafe].filter((name) => readonlyToolNames.has(name))
  );
  const toolCallDeps = (
    call: ToolCallRef,
    onBeforeStartEmit?: (input: Record<string, unknown>) => void
  ): ExecuteToolCallDeps => {
    const perToolTimeout = toolsForRun.find((tool) => tool.name === call.name)?.metadata?.timeoutMs;
    return {
      toolsForRun,
      toolCtx,
      runId,
      sessionKey,
      turnIndex,
      toolHooks,
      abortSignal,
      toolTimeoutMs: perToolTimeout ?? toolTimeoutMs,
      enableHeartbeat: true,
      heartbeatIntervalMs: toolHeartbeatIntervalMs,
      skipHeartbeatToolNames,
      checkToolApproval,
      toolAbortSignalFor,
      enrichToolContext,
      push,
      ...(onBeforeStartEmit ? { onBeforeStartEmit } : {}),
    };
  };
  const toolGroups = groupToolCallsForExecution(
    toolCalls,
    effectiveParallelSafeTools,
    loadToolsMetaName
  );
  const executeScoped = async (
    call: ToolCallRef,
    deps: ExecuteToolCallDeps
  ): Promise<ExecuteToolCallOutcome> => {
    const executed = await inAcceptanceScope(toolCtx.workspaceDir, () =>
      executeOneToolCall(call, deps)
    );
    if (executed.committed) {
      state.taskAcceptanceCommitted = true;
      state.finalText = executed.committed.detail;
    }
    return executed.value;
  };
  const skipRemainingToolCalls = (calls: ToolCallRef[]): void => {
    for (const skipped of calls) {
      push({ type: 'tool_skipped', toolCallId: skipped.id, toolName: skipped.name });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: skipped.id,
        name: skipped.name,
        content: 'Task acceptance committed; skipped remaining tool call.',
        is_error: true,
      });
    }
  };

  // Finish every call this assistant message already made. Steering (the
  // extended tool-loop nudge included) is attached after the batch and guides
  // the next turn — it does not skip or error the rest of the batch.
  for (const group of toolGroups) {
    if (state.suspendedTool) {
      for (const call of group.calls) {
        recordToolOutcome(
          call,
          {
            kind: 'pre-blocked',
            text: 'Not executed: another tool suspended this turn. Request again after continuation if still needed.',
          },
          recordCtx,
          toolResults
        );
      }
      continue;
    }
    if (state.taskAcceptanceCommitted) {
      skipRemainingToolCalls(group.calls);
      continue;
    }
    if (
      group.parallel &&
      group.calls.length > 1 &&
      !hasRepeatedFreshObservation(group.calls, toolsForRun) &&
      parallelToolCallsWithinBudget(group.calls.length, metrics, maxToolCalls)
    ) {
      const settled = await Promise.allSettled(
        group.calls.map((call) => {
          const execCall = {
            id: call.id,
            name: call.name,
            input: { ...call.input },
          };
          const preflight = preflightToolCall(execCall, preflightCtx, toolsForRun, {
            parallelBatch: true,
          });
          const deps = toolCallDeps(execCall, (input) => {
            execCall.input = input;
            syncAssistantToolUseInput(assistantContent, execCall);
          });
          if (preflight) return preflight;
          return executeScoped(execCall, deps).then((outcome) => {
            call.input = execCall.input;
            return outcome;
          });
        })
      );
      for (let j = 0; j < group.calls.length; j++) {
        const call = group.calls[j];
        const s = settled[j];
        const outcome: ExecuteToolCallOutcome =
          s.status === 'fulfilled'
            ? s.value
            : {
                kind: 'pre-blocked',
                text: `Execution error: ${String((s as PromiseRejectedResult).reason)}`,
              };
        recordToolOutcome(call, outcome, recordCtx, toolResults);
      }
    } else {
      for (let gi = 0; gi < group.calls.length; gi++) {
        const call = group.calls[gi];
        const preflight = preflightToolCall(call, preflightCtx, toolsForRun);
        if (preflight) {
          recordToolOutcome(call, preflight, recordCtx, toolResults);
          continue;
        }

        const outcome = await executeScoped(
          call,
          toolCallDeps(call, (input) => {
            syncAssistantToolUseInput(assistantContent, { ...call, input });
          })
        );
        if (outcome.kind === 'completed' && outcome.suspendedTool) {
          state.suspendedTool = outcome.suspendedTool;
          const block = assistantContent.find((b) => b.type === 'tool_use' && b.id === call.id);
          if (!block) throw new Error('Suspended tool has no persisted assistant call');
          block.continuation = {
            continuationId: outcome.suspendedTool.continuationId,
            ...(outcome.suspendedTool.payload ? { payload: outcome.suspendedTool.payload } : {}),
          };
          for (const skipped of group.calls.slice(gi + 1)) {
            recordToolOutcome(
              skipped,
              { kind: 'pre-blocked', text: 'Not executed: tool turn suspended.' },
              recordCtx,
              toolResults
            );
          }
          break;
        }
        recordToolOutcome(call, outcome, recordCtx, toolResults);
        if (state.taskAcceptanceCommitted) {
          skipRemainingToolCalls(group.calls.slice(gi + 1));
          break;
        }
      }
    }
  }

  // Grok-style: surface background completions on the same tool-result turn
  // so the model does not need a pure wait-and-poll cycle after starting a
  // long test/build with run_in_background.
  const bgReminder = buildBackgroundCompletionSystemText();
  if (bgReminder) {
    toolResults.push({ type: 'text', text: bgReminder });
  }

  const resultMsg: Message = {
    role: 'user',
    content: toolResults,
    timestamp: Date.now(),
  };

  if (state.suspendedTool) {
    if (toolResults.length > 0) {
      await appendMessage(sessionKey, resultMsg);
      currentMessages.push(resultMsg);
    }
    return { pendingMessages: [] };
  }

  if (abortSignal.aborted) {
    // Persist results for tools that already completed/skipped, so the next
    // run (resume) sees them instead of synthetic abort results for ALL tools.
    // Only the tool calls that never produced a result get noted as
    // pending-aborted (consumed on resume as synthetic abort tool_results).
    if (toolResults.length > 0) {
      try {
        await appendMessage(sessionKey, {
          role: 'user',
          content: toolResults,
          timestamp: Date.now(),
        });
      } catch {
        // best-effort — if persistence fails, all tools get abort results (previous behavior)
      }
    }
    const completedIds = new Set(
      toolResults.map((r: any) => r.tool_use_id ?? r.toolCallId).filter(Boolean)
    );
    const unfinishedCalls = toolCalls.filter((c) => !completedIds.has(c.id));
    if (unfinishedCalls.length > 0) {
      params.pendingToolAborts.note(
        sessionKey,
        unfinishedCalls.map((c) => ({ id: c.id, name: c.name }))
      );
    }
    return { pendingMessages: [] };
  }

  let toolResultMsgPersisted = false;
  let newSteering: Message[] = [];
  try {
    const parallelStartMs = Date.now();
    await appendMessage(sessionKey, resultMsg);
    toolResultMsgPersisted = true;

    newSteering = state.taskAcceptanceCommitted ? [] : evaluateSteering();
    metrics.prepNextTurnParallelMs += Date.now() - parallelStartMs;
  } finally {
    if (abortSignal.aborted && !toolResultMsgPersisted) {
      params.pendingToolAborts.note(
        sessionKey,
        toolCalls.map((c) => ({ id: c.id, name: c.name }))
      );
    }
  }

  currentMessages.push(resultMsg);

  return { pendingMessages: newSteering };
}

// ── best-of-n trigger telemetry (v0.10 W2) ──────────────────────────────────

const TEST_COMMAND_RE =
  /(?:npm\s+(?:run\s+)?test|node\s+--test|node\s+\S*test\S*\.(?:mjs|js|ts)|jest|vitest|pytest|go\s+test|cargo\s+test)/i;

function effectiveVerifyCommand(name: string, input: Record<string, unknown>): string | null {
  if (name === 'run_tests') {
    const file = typeof input.file === 'string' && input.file.trim() ? input.file.trim() : '';
    if (file) return `node --test ${file}`;
    const cmd =
      typeof input.command === 'string' && input.command.trim() ? input.command.trim() : '';
    return cmd || 'npm test';
  }
  if (name === 'exec') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    return TEST_COMMAND_RE.test(cmd) ? cmd : null;
  }
  return null;
}

/**
 * Track consecutive failures of the same verification command. The streak
 * drives the best-of-n escalation (2 consecutive failures = stuck); a pass
 * or a different command resets it.
 */
export function recordFailingVerifyStreak(
  state: AgentLoopMutableState,
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  isError: boolean
): void {
  const command = effectiveVerifyCommand(toolName, input);
  if (!command) return;
  const looksFailing =
    isError || /\b(?:FAIL|failing|tests?\s+failed|exit[_ ]code:?\s*[1-9]|✖|not ok\b)/i.test(result);
  const outputTail = result.slice(-2_000);
  if (looksFailing) {
    const streak = state.failingVerifyStreak;
    state.failingVerifyStreak =
      streak && streak.command === command
        ? { command, outputTail, count: streak.count + 1 }
        : { command, outputTail, count: 1 };
  } else {
    state.failingVerifyStreak = undefined;
  }
}
