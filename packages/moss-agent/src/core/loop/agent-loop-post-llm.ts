export type PostLlmAction =
  | { kind: 'thinking_retry'; systemText: string }
  | { kind: 'thinking_only_complete' }
  | { kind: 'continuation'; systemText: string }
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
  outputContinuationCount: number;
  maxOutputContinuations: number;
  planToolNudgeAttempts: number;
  finalText: string;
  maxTurns: number;
  turns: number;
  shouldNudge: boolean;
  abortAborted: boolean;
}

export function decidePostLlmAction(ctx: PostLlmContext): PostLlmAction {
  if (ctx.hasThinkingOnly) {
    if (
      ctx.postToolThinkingOnlyRetryAttempts < 1 &&
      ctx.turns < ctx.maxTurns &&
      !ctx.abortAborted
    ) {
      return {
        kind: 'thinking_retry',
        systemText:
          ctx.totalToolCalls > 0
            ? '[System] The tools already ran, but your previous assistant turn had no visible answer. ' +
              'Read the latest tool results and produce a concise visible user-facing summary now. ' +
              'Do not call more tools unless absolutely necessary.'
            : '[System] Your previous turn produced only private reasoning with no visible answer. ' +
              'Produce a concise visible user-facing answer now.',
      };
    }
    return { kind: 'thinking_only_complete' };
  }

  // Truncated output (max_tokens) — continue from where we left off. This is
  // independent of steering: a truncated answer must be completed regardless
  // of context pressure. Steering guidance, when relevant, is injected on the
  // tool-execution path where the model is still working.
  if (
    ctx.streamStopReason === 'length' &&
    ctx.toolCallCount === 0 &&
    ctx.outputContinuationCount < ctx.maxOutputContinuations &&
    !ctx.abortAborted
  ) {
    return {
      kind: 'continuation',
      systemText:
        '[System] Your previous response was truncated due to max_tokens. ' +
        'Continue from where you left off without repeating already-output content.',
    };
  }

  if (ctx.toolCallCount > 0) {
    return { kind: 'tool_execute' };
  }

  if (ctx.planToolNudgeAttempts < 1 && ctx.turns < ctx.maxTurns && ctx.shouldNudge) {
    return {
      kind: 'nudge',
      systemText:
        '[System] You described using tools or opening a URL in plain text but did not emit any function/tool calls. ' +
        'You MUST invoke the appropriate tool now with valid JSON arguments for that URL/intent. ' +
        'Do not repeat the plan—call the tool immediately.',
      deltaText:
        '\n\n> （系统）检测到仅说明了工具与链接但未发起实际工具调用，已自动追加一轮对话以执行操作。\n',
    };
  }

  if (!ctx.finalText.trim()) {
    if (ctx.emptyResponseRetryAttempts < 1 && ctx.turns < ctx.maxTurns && !ctx.abortAborted) {
      return { kind: 'empty_retry' };
    }
    return { kind: 'empty_complete' };
  }

  return { kind: 'steering_or_complete' };
}
