import { truncateToolOutput } from '../../context/tool-output-truncate.js';
import { getRootLogger } from '../../logger.js';
import type { LLMMessage } from '../llm/llm-provider.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import {
  executeOneToolCall,
  outcomeToResult,
  type ExecuteToolCallOutcome,
} from '../tools/execute-tool-call.js';
import { maybeSuppressRedundantWebFetchAfterOpenUrl } from '../tools/open-url-web-fetch-guard.js';
import { notePendingAbortedToolCalls } from './pending-tool-aborts.js';
import type { Message, ContentBlock } from '../session/session-jsonl.js';
import type { Tool, ToolContext, ToolResultOutcome } from '../tools/tool-types.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import { findReplayableToolResultContent } from '../tools/tool-idempotent-replay.js';
import {
  formatToolResultForSsePreview,
  groupToolCallsForExecution,
  skipToolCall,
  syncAssistantToolUseInput,
} from './agent-loop-tool-helpers.js';
import {
  formatToolLoopGuardMessage,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
  type ToolLoopGuardState,
} from '../tools/tool-loop-guard.js';

const log = getRootLogger().child('agent:loop');

/** 超过此长度（字符数）的结构化内容将被截断为提示文本，避免上下文膨胀。 */
const MAX_STRUCTURED_SIZE = 12_000;

export interface AgentLoopToolExecutionMetrics {
  totalToolCalls: number;
  toolErrors: number;
  consecutiveToolErrors: number;
  toolCallsByName: Record<string, number>;
  prepNextTurnParallelMs: number;
}

export interface ExecuteAgentLoopToolCallsParams {
  sessionKey: string;
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
  }) => Promise<{ approved: boolean; decision: string; reason?: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  parallelSafeTools: Set<string>;
  loadToolsMetaName?: string;
  toolLoopGuard: ToolLoopGuardState;
  maxToolCalls?: number;
  metrics: AgentLoopToolExecutionMetrics;
  evaluateSteering: () => Message[];
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
}

interface PreflightContext {
  maxToolCalls?: number;
  metrics: AgentLoopToolExecutionMetrics;
  toolLoopGuard: ToolLoopGuardState;
  sessionKey: string;
  historyBeforeAssistant: LLMMessage[];
}

interface OutcomeRecordingContext {
  assistantContent: ContentBlock[];
  push: (event: MiniAgentEvent) => void;
  toolLoopGuard: ToolLoopGuardState;
  metrics: AgentLoopToolExecutionMetrics;
}

type ToolCallRef = { id: string; name: string; input: Record<string, unknown> };

function preflightToolCall(
  call: ToolCallRef,
  ctx: PreflightContext,
  resolvedTools: Tool[]
): ExecuteToolCallOutcome | null {
  if (ctx.maxToolCalls !== undefined && ctx.metrics.totalToolCalls >= ctx.maxToolCalls) {
    return {
      kind: 'completed',
      text: `Tool budget reached (${ctx.maxToolCalls}); answer with the evidence already gathered instead of calling more tools.`,
      isError: false,
      durationMs: 0,
      outcome: 'suppressed',
    };
  }

  const loopReason = shouldShortCircuitToolCall(ctx.toolLoopGuard, call.name, call.input);
  if (loopReason) {
    log.warn('tool loop guard short-circuited tool call', {
      tool: call.name,
      reason: loopReason,
      sessionKey: ctx.sessionKey,
    });
    return {
      kind: 'pre-blocked',
      text: formatToolLoopGuardMessage(loopReason, call.name),
    };
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

  const toolMeta = resolvedTools.find((t) => t.name === call.name)?.metadata;
  const replayed = findReplayableToolResultContent(
    ctx.historyBeforeAssistant,
    call.name,
    call.input,
    32,
    toolMeta?.sideEffectClass
  );
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
  } = outcomeToResult(outcome);
  const toolOutcome: ToolResultOutcome =
    outcome.kind === 'completed'
      ? (outcome.outcome ?? (isError ? 'error' : 'ok'))
      : outcome.kind === 'denied'
        ? 'denied'
        : 'blocked';
  const durationMs = outcome.kind === 'completed' ? outcome.durationMs : 0;
  let structuredContent = rawStructuredContent;
  if (structuredContent && structuredContent.length > 0) {
    const serialized = JSON.stringify(structuredContent);
    if (serialized.length > MAX_STRUCTURED_SIZE) {
      structuredContent = [
        {
          type: 'text',
          text: `[structured content truncated: ${serialized.length} chars exceeded ${MAX_STRUCTURED_SIZE} limit]`,
        },
      ];
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

  recordToolLoopOutcome(ctx.toolLoopGuard, call.name, isError, result);

  const truncatedResult = truncateToolOutput(call.name, result);
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
  });
}

function checkSteeringAfterCall(
  evaluateSteering: () => Message[],
  skipRemaining: (calls: { id: string; name: string }[]) => void,
  remainingCalls: { id: string; name: string }[]
): Message[] | null {
  const steering = evaluateSteering();
  if (steering.length > 0) {
    skipRemaining(remainingCalls);
    return steering;
  }
  return null;
}

export async function executeAgentLoopToolCalls(
  params: ExecuteAgentLoopToolCallsParams
): Promise<{ pendingMessages: Message[] }> {
  const {
    sessionKey,
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
  let steeringMessages: Message[] | null = null;

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
  };
  const recordCtx: OutcomeRecordingContext = {
    assistantContent,
    push,
    toolLoopGuard,
    metrics,
  };

  const skipRemainingToolCalls = (calls: { id: string; name: string }[]): void => {
    for (const skipped of calls) {
      push({
        type: 'tool_skipped',
        toolCallId: skipped.id,
        toolName: skipped.name,
      });
      toolResults.push(skipToolCall(skipped));
    }
  };

  const toolsForRun = resolveToolsForRun();
  const readonlyToolNames = new Set(
    toolsForRun
      .filter((t) => t.metadata?.sideEffectClass === 'readonly')
      .map((t) => t.name)
  );
  const requestedParallelSafe = parallelSafeTools.size > 0 ? parallelSafeTools : readonlyToolNames;
  const effectiveParallelSafeTools = new Set(
    [...requestedParallelSafe].filter((name) => readonlyToolNames.has(name))
  );
  const toolGroups = groupToolCallsForExecution(
    toolCalls,
    effectiveParallelSafeTools,
    loadToolsMetaName
  );

  for (const group of toolGroups) {
    if (steeringMessages) {
      skipRemainingToolCalls(group.calls);
      continue;
    }

    if (group.parallel && group.calls.length > 1 && maxToolCalls === undefined) {
      const settled = await Promise.allSettled(
        group.calls.map((call) => {
          const execCall = {
            id: call.id,
            name: call.name,
            input: { ...call.input },
          };
          const preflight = preflightToolCall(execCall, preflightCtx, toolsForRun);
          if (preflight) return Promise.resolve(preflight);
          const perToolTimeout = toolsForRun.find((t) => t.name === call.name)?.metadata?.timeoutMs;
          return executeOneToolCall(execCall, {
            toolsForRun,
            toolCtx,
            sessionKey,
            toolHooks,
            abortSignal,
            toolTimeoutMs: perToolTimeout ?? toolTimeoutMs,
            enableHeartbeat: true,
            heartbeatIntervalMs: toolHeartbeatIntervalMs,
            skipHeartbeatToolNames,
            // Pass the host approval hook through to parallel calls too. Parallel
            // groups only contain readonly tools (effectiveParallelSafeTools is
            // filtered to readonly above), whose approval typically resolves to
            // null (no prompt) — so parallelism is preserved. Passing `undefined`
            // here previously made parallel readonly calls invisible to the host:
            // no approval events, no audit, no deny path, asymmetric with serial.
            checkToolApproval,
            toolAbortSignalFor,
            enrichToolContext,
            push,
            onBeforeStartEmit: (input) => {
              execCall.input = input;
              syncAssistantToolUseInput(assistantContent, execCall);
            },
          }).then((outcome) => {
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
      const steering = evaluateSteering();
      if (steering.length > 0) {
        steeringMessages = steering;
      }
    } else {
      for (let gi = 0; gi < group.calls.length; gi++) {
        const call = group.calls[gi];
        const preflight = preflightToolCall(call, preflightCtx, toolsForRun);
        if (preflight) {
          recordToolOutcome(call, preflight, recordCtx, toolResults);
          continue;
        }

        const perToolTimeout = toolsForRun.find((t) => t.name === call.name)?.metadata
          ?.timeoutMs;
        const outcome = await executeOneToolCall(call, {
          toolsForRun,
          toolCtx,
          sessionKey,
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
          onBeforeStartEmit: (input) => {
            syncAssistantToolUseInput(assistantContent, { ...call, input });
          },
        });

        if (outcome.kind === 'hook-blocked') {
          recordToolOutcome(call, outcome, recordCtx, toolResults);
          const steering = checkSteeringAfterCall(evaluateSteering, skipRemainingToolCalls, group.calls.slice(gi + 1));
          if (steering) { steeringMessages = steering; break; }
          continue;
        }

        if (outcome.kind === 'denied') {
          recordToolOutcome(call, outcome, recordCtx, toolResults);
          const steering = checkSteeringAfterCall(evaluateSteering, skipRemainingToolCalls, group.calls.slice(gi + 1));
          if (steering) { steeringMessages = steering; break; }
          continue;
        }

        recordToolOutcome(call, outcome, recordCtx, toolResults);

        const steering = checkSteeringAfterCall(evaluateSteering, skipRemainingToolCalls, group.calls.slice(gi + 1));
        if (steering) { steeringMessages = steering; break; }
      }
    }
  }

  const resultMsg: Message = {
    role: 'user',
    content: toolResults,
    timestamp: Date.now(),
  };

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
      toolResults.map((r: any) => r.tool_use_id ?? r.toolCallId).filter(Boolean),
    );
    const unfinishedCalls = toolCalls.filter((c) => !completedIds.has(c.id));
    if (unfinishedCalls.length > 0) {
      notePendingAbortedToolCalls(
        sessionKey,
        unfinishedCalls.map((c) => ({ id: c.id, name: c.name })),
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

    newSteering = evaluateSteering();
    metrics.prepNextTurnParallelMs += Date.now() - parallelStartMs;
  } finally {
    if (abortSignal.aborted && !toolResultMsgPersisted) {
      notePendingAbortedToolCalls(
        sessionKey,
        toolCalls.map((c) => ({ id: c.id, name: c.name }))
      );
    }
  }

  currentMessages.push(resultMsg);

  return {
    pendingMessages:
      steeringMessages && steeringMessages.length > 0 ? steeringMessages : newSteering,
  };
}
