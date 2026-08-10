import type { ChatResult, MossAgentEvent } from '../core/index.js';
import { estimateLLMCost } from '../observability/llm-usage.js';
import { redactSensitiveData } from '../observability/redact.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import type { SkillCompositionTrace } from '../skills/skill-composition-trace.js';
import { MossError, mossErrorToOutcome, type MossErrorOutcome } from '../errors.js';

export type HeadlessOutputFormat = 'text' | 'json' | 'stream-json';

export type HeadlessSystemInitEvent = {
  type: 'system';
  subtype: 'init';
  cwd: string;
  tools: string[];
  session_id: string;
  model?: string;
};

export type HeadlessBackgroundProcessSummary = {
  id: string;
  command: string;
  label?: string;
  started_at: number;
  running_for_ms: number;
};

/** Emitted when oneshot exits while background processes are still running. */
export type HeadlessSystemBackgroundStillRunningEvent = {
  type: 'system';
  subtype: 'background_still_running';
  session_id: string;
  message: string;
  processes: HeadlessBackgroundProcessSummary[];
  will_monitor_after_exit: false;
};

export type HeadlessTextBlock = { type: 'text'; text: string };
export type HeadlessToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type HeadlessAssistantContentBlock = HeadlessTextBlock | HeadlessToolUseBlock;

export type HeadlessAssistantEvent = {
  type: 'assistant';
  message: {
    type: 'message';
    id: string;
    role: 'assistant';
    model?: string;
    stop_reason: string | null;
    content: HeadlessAssistantContentBlock[];
    usage?: ChatResult['usage'];
  };
  session_id: string;
};

export type HeadlessToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  structured_content?: unknown;
};

export type HeadlessUserEvent = {
  type: 'user';
  message: {
    role: 'user';
    content: HeadlessToolResultBlock[];
  };
  session_id: string;
};

export type HeadlessLlmUsageEvent = {
  type: 'llm_usage';
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  context_tokens?: number;
};

export type HeadlessCacheMetricsEvent = {
  type: 'cache_metrics';
  session_id: string;
  prompt_cache_enabled: boolean;
  prompt_cache_debug: boolean;
  stable_chars: number;
  dynamic_chars: number;
  eligible: boolean;
  eligibility_reason: string;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

/** Machine-readable skill plan telemetry for eval and host integrations. */
export type HeadlessSkillCompositionEvent = {
  type: 'skill_composition';
  subtype: 'active' | 'shadow';
  session_id: string;
  trace: SkillCompositionTrace;
};

export type HeadlessResultSubtype = 'success' | 'error_max_turns' | 'error_during_execution';

export type HeadlessResultEvent = {
  type: 'result';
  subtype: HeadlessResultSubtype;
  is_error: boolean;
  result: string;
  duration_ms: number;
  num_turns: number;
  session_id: string;
  total_cost_usd: number | null;
  cost_unavailable: boolean;
  usage?: ChatResult['usage'];
  error?: string;
  error_code?: MossErrorOutcome['code'];
  recoverable?: boolean;
  structured_output?: unknown;
  /** Present when oneshot exits while background processes are still running. */
  background_still_running?: {
    message: string;
    processes: HeadlessBackgroundProcessSummary[];
    will_monitor_after_exit: false;
  };
};

export type HeadlessStreamEvent =
  | HeadlessSystemInitEvent
  | HeadlessSystemBackgroundStillRunningEvent
  | HeadlessAssistantEvent
  | HeadlessUserEvent
  | HeadlessLlmUsageEvent
  | HeadlessCacheMetricsEvent
  | HeadlessSkillCompositionEvent
  | HeadlessResultEvent;

export interface HeadlessInitInput {
  cwd: string;
  model?: string;
  tools: string[];
  sessionId: string;
}

export interface HeadlessPrintState {
  readonly sessionId: string;
  readonly model?: string;
  readonly startTime: number;
  pendingAssistantText: string;
  pendingToolUses: HeadlessToolUseBlock[];
  assistantSeq: number;
  finalText: string;
  numTurns: number;
  lastError?: string;
  lastErrorDetails?: MossErrorOutcome;
  resultEmitted: boolean;
  structuredOutputRequested: boolean;
}

export interface HeadlessPrintStateInput {
  sessionId: string;
  model?: string;
  startTime?: number;
}

export interface HeadlessJsonWriter {
  write(chunk: string): unknown;
}

export function createHeadlessPrintState(input: HeadlessPrintStateInput): HeadlessPrintState {
  return {
    sessionId: input.sessionId,
    model: input.model,
    startTime: input.startTime ?? Date.now(),
    pendingAssistantText: '',
    pendingToolUses: [],
    assistantSeq: 0,
    finalText: '',
    numTurns: 0,
    resultEmitted: false,
    structuredOutputRequested: false,
  };
}

export function formatHeadlessInitEvent(input: HeadlessInitInput): HeadlessSystemInitEvent {
  const event: HeadlessSystemInitEvent = {
    type: 'system',
    subtype: 'init',
    cwd: input.cwd,
    tools: input.tools,
    session_id: input.sessionId,
  };
  if (input.model) event.model = input.model;
  return event;
}

export function formatHeadlessBackgroundStillRunningEvent(input: {
  sessionId: string;
  message: string;
  processes: ReadonlyArray<{
    id: string;
    command: string;
    label?: string;
    startedAt: number;
  }>;
  now?: number;
}): HeadlessSystemBackgroundStillRunningEvent {
  const now = input.now ?? Date.now();
  return {
    type: 'system',
    subtype: 'background_still_running',
    session_id: input.sessionId,
    message: input.message,
    will_monitor_after_exit: false,
    processes: input.processes.map((p) => ({
      id: p.id,
      command: p.command,
      ...(p.label ? { label: p.label } : {}),
      started_at: p.startedAt,
      running_for_ms: Math.max(0, now - p.startedAt),
    })),
  };
}

export function formatHeadlessSkillCompositionEvent(input: {
  sessionId: string;
  kind: 'active' | 'shadow';
  trace: SkillCompositionTrace;
}): HeadlessSkillCompositionEvent {
  return {
    type: 'skill_composition',
    subtype: input.kind,
    session_id: input.sessionId,
    trace: redactValue(input.trace),
  };
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; errorMessage?: unknown };
    if (typeof record.errorMessage === 'string') return record.errorMessage;
    if (typeof record.message === 'string') return record.message;
  }
  return String(error);
}

function redactText(value: string): string {
  return sanitizeSecrets(value);
}

function redactValue<T>(value: T): T {
  const redacted = redactSensitiveData(value, { skipFileContentHeuristic: true });
  const sanitizeNestedStrings = (current: unknown): unknown => {
    if (typeof current === 'string') return redactText(current);
    if (Array.isArray(current)) return current.map(sanitizeNestedStrings);
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>).map(([key, nested]) => [
          key,
          sanitizeNestedStrings(nested),
        ])
      );
    }
    return current;
  };
  return sanitizeNestedStrings(redacted) as T;
}

function isMaxTurnsStopReason(stopReason: string | undefined): boolean {
  return stopReason === 'max_turns_reached' || stopReason === 'tool_followup_cap_reached';
}

function isErrorStopReason(stopReason: string | undefined): boolean {
  return (
    stopReason === 'error' ||
    stopReason === 'aborted_by_user' ||
    stopReason === 'tool_budget_reached' ||
    isMaxTurnsStopReason(stopReason)
  );
}

function parseStructuredOutput(response: string): unknown | undefined {
  const fenced = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i)?.[1];
  const candidate = (fenced ?? response).trim();
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function flushAssistant(
  state: HeadlessPrintState,
  stopReason: string | null = null
): HeadlessAssistantEvent[] {
  const content: HeadlessAssistantContentBlock[] = [];
  if (state.pendingAssistantText)
    content.push({ type: 'text', text: redactText(state.pendingAssistantText) });
  content.push(
    ...state.pendingToolUses.map((toolUse) => ({
      ...toolUse,
      input: redactValue(toolUse.input),
    }))
  );
  if (content.length === 0) return [];
  state.pendingAssistantText = '';
  state.pendingToolUses = [];
  state.assistantSeq += 1;
  const message: HeadlessAssistantEvent['message'] = {
    type: 'message',
    id: `msg_${state.sessionId}_${state.assistantSeq}`,
    role: 'assistant',
    stop_reason: stopReason,
    content,
  };
  if (state.model) message.model = state.model;
  return [{ type: 'assistant', message, session_id: state.sessionId }];
}

function formatResult(
  state: HeadlessPrintState,
  result: ChatResult | undefined,
  error?: string
): HeadlessResultEvent {
  const resultText = redactText(result?.response ?? state.finalText);
  const errorMessage =
    error ??
    state.lastError ??
    (result?.stopReason === 'tool_budget_reached'
      ? 'Tool budget reached before the requested work completed.'
      : undefined);
  const maxTurns = isMaxTurnsStopReason(result?.stopReason);
  const isError = Boolean(errorMessage) || isErrorStopReason(result?.stopReason);
  const usage = result?.usage;
  const hasCacheUsage = Boolean(usage?.cacheReadTokens || usage?.cacheCreationTokens);
  const estimatedCost =
    state.model && usage && !hasCacheUsage
      ? estimateLLMCost(state.model, usage.inputTokens, usage.outputTokens)
      : undefined;
  const normalizedCost =
    estimatedCost === undefined ? undefined : Number(estimatedCost.toFixed(12));
  const subtype: HeadlessResultSubtype = !isError
    ? 'success'
    : maxTurns
      ? 'error_max_turns'
      : 'error_during_execution';
  const event: HeadlessResultEvent = {
    type: 'result',
    subtype,
    is_error: isError,
    result: resultText,
    duration_ms: Math.max(0, Date.now() - state.startTime),
    num_turns: state.numTurns,
    session_id: state.sessionId,
    total_cost_usd: normalizedCost ?? null,
    cost_unavailable: normalizedCost === undefined,
  };
  if (result?.usage) event.usage = result.usage;
  if (errorMessage) event.error = redactText(errorMessage);
  if (state.lastErrorDetails) {
    event.error_code = state.lastErrorDetails.code;
    event.recoverable = state.lastErrorDetails.recoverable;
  }
  if (!isError && state.structuredOutputRequested) {
    const structuredOutput = parseStructuredOutput(resultText);
    if (structuredOutput !== undefined) {
      event.structured_output = redactValue(structuredOutput);
    }
  }
  state.resultEmitted = true;
  return event;
}

export function formatHeadlessStreamEvent(
  state: HeadlessPrintState,
  event: MossAgentEvent
): HeadlessStreamEvent[] {
  switch (event.type) {
    case 'text_delta':
      state.pendingAssistantText += event.delta;
      state.finalText += event.delta;
      return [];
    case 'tool_start':
      if (event.toolName === 'generate_structured' && event.input.validateOnly !== true) {
        state.structuredOutputRequested = true;
      }

      state.pendingToolUses.push({
        type: 'tool_use',
        id: event.toolCallId,
        name: event.toolName,
        input: redactValue(event.input),
      });
      return [];
    case 'tool_end': {
      const assistant = flushAssistant(state);
      const toolResult: HeadlessToolResultBlock = {
        type: 'tool_result',
        tool_use_id: event.toolCallId,
        content: redactText(event.result),
      };
      if (event.isError) toolResult.is_error = true;
      if (event.structuredContent)
        toolResult.structured_content = redactValue(event.structuredContent);
      const userEvent: HeadlessUserEvent = {
        type: 'user',
        message: { role: 'user', content: [toolResult] },
        session_id: state.sessionId,
      };
      return [...assistant, userEvent];
    }
    case 'turn_start':
      state.numTurns = Math.max(state.numTurns, event.turn);
      return [];
    case 'turn_end':
      state.numTurns = Math.max(state.numTurns, event.turn);
      return flushAssistant(state);
    case 'error':
      state.lastError = redactText(event.error);
      state.lastErrorDetails = event.errorDetails;
      return [];
    case 'done':
      return [...flushAssistant(state), formatResult(state, event.result)];
    case 'llm_usage': {
      const usage: HeadlessLlmUsageEvent = {
        type: 'llm_usage',
        session_id: state.sessionId,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
      };
      if (event.cacheReadTokens !== undefined) usage.cache_read_tokens = event.cacheReadTokens;
      if (event.cacheCreationTokens !== undefined) {
        usage.cache_creation_tokens = event.cacheCreationTokens;
      }
      if (event.contextTokens !== undefined) usage.context_tokens = event.contextTokens;
      return [usage];
    }
    case 'cache_metrics':
      return [
        {
          type: 'cache_metrics',
          session_id: state.sessionId,
          prompt_cache_enabled: event.promptCacheEnabled,
          prompt_cache_debug: event.promptCacheDebug,
          stable_chars: event.stableChars,
          dynamic_chars: event.dynamicChars,
          eligible: event.eligible,
          eligibility_reason: event.eligibilityReason,
          cache_read_tokens: event.cacheReadTokens,
          cache_creation_tokens: event.cacheCreationTokens,
        },
      ];
    case 'thinking_delta':
    case 'compaction':
    case 'working_context_checkpoint':
    case 'microcompact':
    case 'retry':
      return [];
  }
}

export function formatHeadlessThrownError(
  state: HeadlessPrintState,
  error: unknown
): HeadlessStreamEvent[] {
  if (state.resultEmitted) return [];
  if (error instanceof MossError) state.lastErrorDetails = mossErrorToOutcome(error);
  return [...flushAssistant(state), formatResult(state, undefined, normalizeError(error))];
}

export function isHeadlessResultError(event: HeadlessResultEvent): boolean {
  return event.is_error;
}

function safeJson(value: unknown, state?: HeadlessPrintState): string {
  try {
    return JSON.stringify(value);
  } catch {
    const fallbackResult = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: state?.finalText ?? '',
      duration_ms: state ? Math.max(0, Date.now() - state.startTime) : 0,
      num_turns: state?.numTurns ?? 0,
      session_id: state?.sessionId ?? 'unknown',
      total_cost_usd: null,
      cost_unavailable: true,
      error: 'failed to serialize event to JSON',
    };
    return JSON.stringify(fallbackResult);
  }
}

export function writeHeadlessJson(writer: HeadlessJsonWriter, event: HeadlessStreamEvent): void {
  writer.write(`${safeJson(event)}\n`);
}
