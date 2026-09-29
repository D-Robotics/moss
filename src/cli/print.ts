import type { ChatResult, MossAgentEvent } from '../core/index.js';
import { redactSensitiveData } from '../safety/redact.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
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
    /** Reasoning deltas for this assistant turn, in order. */
    thinking?: string[];
    usage?: ChatResult['usage'];
  };
  session_id: string;
};

export type HeadlessCompactionEvent = {
  type: 'compaction';
  session_id: string;
  summary_chars: number;
  dropped_messages: number;
  tokens_before?: number;
  tokens_after?: number;
  kept_tool_names?: number;
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
  ttft_ms?: number;
  generation_ms?: number;
  turn_gap_ms?: number;
  model?: string;
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

export type HeadlessResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_budget_exceeded'
  | 'error_during_execution';

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

/**
 * Public headless embedding contract (`moss --output-format stream-json`):
 * one JSON object per line on stdout. Event set: `system/init` (always
 * first), `assistant` (visible text + tool_use blocks + thinking),
 * `user` (tool_result blocks), `llm_usage`, `cache_metrics`, `compaction`,
 * `system/background_still_running`, and `result` (ALWAYS last — errors are
 * carried by `result.is_error`/`subtype`/`error`, never by a bare crash).
 * Evolution is additive-only: new event types and optional fields may be
 * added, existing field names and semantics are stable.
 */
export type HeadlessStreamEvent =
  | HeadlessSystemInitEvent
  | HeadlessSystemBackgroundStillRunningEvent
  | HeadlessAssistantEvent
  | HeadlessUserEvent
  | HeadlessLlmUsageEvent
  | HeadlessCacheMetricsEvent
  | HeadlessCompactionEvent
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
  pendingAssistantThinking: string[];
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
    pendingAssistantThinking: [],
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

function isBudgetStopReason(stopReason: string | undefined): boolean {
  return stopReason?.startsWith('budget_') ?? false;
}

function isErrorStopReason(stopReason: string | undefined): boolean {
  return (
    stopReason === 'error' ||
    stopReason === 'aborted_by_user' ||
    stopReason === 'tool_budget_reached' ||
    isBudgetStopReason(stopReason) ||
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
  if (content.length === 0 && state.pendingAssistantThinking.length === 0) return [];
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
  if (state.pendingAssistantThinking.length > 0) {
    message.thinking = state.pendingAssistantThinking.map(redactText);
    state.pendingAssistantThinking = [];
  }
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
  const subtype: HeadlessResultSubtype = !isError
    ? 'success'
    : isBudgetStopReason(result?.stopReason)
      ? 'error_budget_exceeded'
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
    total_cost_usd: null,
    cost_unavailable: true,
  };
  if (result?.usage) event.usage = result.usage;
  if (errorMessage) event.error = redactText(errorMessage);
  if (subtype === 'error_budget_exceeded' && result?.stopReason) {
    event.error =
      errorMessage ??
      `Run budget exceeded (${result.stopReason.replace(/^budget_/, '').replace(/_reached$/, '')}). ` +
        'Partial output above is the completed work; raise the budget or narrow the task to continue.';
  }
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
      if (event.ttftMs !== undefined) usage.ttft_ms = event.ttftMs;
      if (event.generationMs !== undefined) usage.generation_ms = event.generationMs;
      if (event.turnGapMs !== undefined) usage.turn_gap_ms = event.turnGapMs;
      if (event.model !== undefined) usage.model = event.model;
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
      state.pendingAssistantThinking.push(event.delta);
      return [];
    case 'compaction': {
      const compaction: HeadlessCompactionEvent = {
        type: 'compaction',
        session_id: state.sessionId,
        summary_chars: event.summaryChars,
        dropped_messages: event.droppedMessages,
      };
      if (event.tokensBefore !== undefined) compaction.tokens_before = event.tokensBefore;
      if (event.tokensAfter !== undefined) compaction.tokens_after = event.tokensAfter;
      if (event.keptToolNames !== undefined) compaction.kept_tool_names = event.keptToolNames;
      return [compaction];
    }
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
