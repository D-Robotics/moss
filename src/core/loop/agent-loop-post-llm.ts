import { isOutputLimitStopReason } from './output-limit.js';
import { isNudgeDisabled } from './nudges/disable.js';

export type OutputLimitContinuationMode = 'text' | 'thinking' | 'tool';

export type PostLlmAction =
  | { kind: 'thinking_retry'; systemText: string }
  | { kind: 'thinking_only_complete' }
  | { kind: 'continuation'; systemText: string; mode: OutputLimitContinuationMode }
  | { kind: 'output_limit_exhausted' }
  | { kind: 'nudge'; systemText: string; deltaText: string }
  | { kind: 'empty_retry' }
  | { kind: 'empty_complete' }
  | { kind: 'steering_or_complete' }
  | { kind: 'tool_execute' };

export interface PostLlmContext {
  hasThinkingOnly: boolean;
  toolCallCount: number;
  postToolThinkingOnlyRetryAttempts: number;
  emptyResponseRetryAttempts: number;
  totalToolCalls: number;
  streamStopReason: string | undefined;
  /** Set when an output-limit stop discarded a partial tool call. */
  truncatedToolCall?: boolean;
  outputContinuationCount: number;
  maxOutputContinuations: number;
  missingToolNudgeAttempts: number;
  finalText: string;
  maxTurns: number;
  turns: number;
  shouldNudge: boolean;
  abortAborted: boolean;
}

/** Consecutive reasoning-only turns that get another chance before the run stops. */
export const THINKING_ONLY_RETRY_BUDGET = 1;

export function nextThinkingOnlyRetryAttempts(action: PostLlmAction, current: number): number {
  if (action.kind === 'thinking_retry') return current + 1;
  if (action.kind === 'thinking_only_complete') return current;
  return 0;
}

const TEXT_CONTINUATION =
  '[System] Your previous response was truncated due to max_tokens. ' +
  'Continue from where you left off without repeating already-output content.';

const THINKING_CONTINUATION =
  '[System] Your previous turn used the entire output budget on private reasoning and was cut off before a visible answer or tool call. ' +
  'Stop deliberating and act now: call the next tool, or write a short visible answer.';

const TOOL_CONTINUATION =
  '[System] Your previous tool call was cut off before its arguments finished, so it was discarded and not executed. ' +
  'Continue the task with a smaller tool call, or write the visible answer. Do not repeat the truncated arguments.';

export function decidePostLlmAction(ctx: PostLlmContext): PostLlmAction {
  // Output-limit truncation is checked before "reasoning only". A thinking-only
  // reply whose stop reason is length/max_tokens ran out of tokens; it is not
  // a model that refused to act. Exhausting the recovery budget ends the turn
  // (output_limit_exhausted) instead of reporting the fragment as success.
  if (isOutputLimitStopReason(ctx.streamStopReason)) {
    const truncatedTool = ctx.truncatedToolCall === true || ctx.toolCallCount > 0;
    const canContinue =
      !isNudgeDisabled('output-continuation') &&
      ctx.outputContinuationCount < ctx.maxOutputContinuations &&
      !ctx.abortAborted;
    if (canContinue) {
      if (truncatedTool) {
        return { kind: 'continuation', mode: 'tool', systemText: TOOL_CONTINUATION };
      }
      if (ctx.hasThinkingOnly) {
        return { kind: 'continuation', mode: 'thinking', systemText: THINKING_CONTINUATION };
      }
      return { kind: 'continuation', mode: 'text', systemText: TEXT_CONTINUATION };
    }
    if (
      ctx.outputContinuationCount >= ctx.maxOutputContinuations ||
      ctx.hasThinkingOnly ||
      truncatedTool
    ) {
      return { kind: 'output_limit_exhausted' };
    }
  }

  if (ctx.hasThinkingOnly) {
    if (
      !isNudgeDisabled('reasoning-only') &&
      ctx.postToolThinkingOnlyRetryAttempts < THINKING_ONLY_RETRY_BUDGET &&
      ctx.turns < ctx.maxTurns &&
      !ctx.abortAborted
    ) {
      return {
        kind: 'thinking_retry',
        systemText:
          ctx.totalToolCalls > 0
            ? '[System] Your previous turn produced only private reasoning and no tool call. ' +
              'Continue the task now: call the next tool, or write the visible answer if the task is done.'
            : '[System] Your previous turn produced only private reasoning with no visible answer. ' +
              'Produce a concise visible user-facing answer now.',
      };
    }
    return { kind: 'thinking_only_complete' };
  }

  if (ctx.toolCallCount > 0) {
    return { kind: 'tool_execute' };
  }

  if (
    !isNudgeDisabled('missing-tool-call') &&
    ctx.missingToolNudgeAttempts < 1 &&
    ctx.turns < ctx.maxTurns &&
    ctx.shouldNudge
  ) {
    return {
      kind: 'nudge',
      systemText:
        '[System] You described using tools or opening a URL in plain text but did not emit any function/tool calls. ' +
        'You MUST invoke the appropriate tool now with valid JSON arguments for that URL/intent. ' +
        'Do not repeat the plan—call the tool immediately.',
      // The correction stays in the model channel. An empty delta keeps the
      // nudge out of the assistant transcript.
      deltaText: '',
    };
  }

  if (!ctx.finalText.trim()) {
    if (
      !isNudgeDisabled('empty-response') &&
      ctx.emptyResponseRetryAttempts < 1 &&
      ctx.turns < ctx.maxTurns &&
      !ctx.abortAborted
    ) {
      return { kind: 'empty_retry' };
    }
    return { kind: 'empty_complete' };
  }

  return { kind: 'steering_or_complete' };
}
