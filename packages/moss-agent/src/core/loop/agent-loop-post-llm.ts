








export type PostLlmAction =
  | { kind: 'thinking_retry'; systemText: string }
  | { kind: 'thinking_only_complete' }
  | { kind: 'continuation'; systemText: string }
  | { kind: 'nudge'; systemText: string; deltaText: string }
  | { kind: 'empty_retry' }
  | { kind: 'steering_or_complete' }
  | { kind: 'tool_execute' };

export interface PostLlmContext {
  hasThinkingOnly: boolean;
  toolCallCount: number;
  postToolThinkingOnlyRetryAttempts: number;
  totalToolCalls: number;
  streamStopReason: string | undefined;
  outputContinuationCount: number;
  maxOutputContinuations: number;
  planToolNudgeAttempts: number;
  finalText: string;
  maxTurns: number;
  turns: number;
  shouldNudge: boolean;
  hasSteeringMessages: boolean;
  abortAborted: boolean;
}

export function decidePostLlmAction(ctx: PostLlmContext): PostLlmAction {
  
  if (
    ctx.hasThinkingOnly &&
    ctx.totalToolCalls > 0 &&
    ctx.postToolThinkingOnlyRetryAttempts < 1 &&
    ctx.turns < ctx.maxTurns &&
    !ctx.abortAborted
  ) {
    return {
      kind: 'thinking_retry',
      systemText:
        '[System] The tools already ran, but your previous assistant turn had no visible answer. ' +
        'Read the latest tool results and produce a concise visible user-facing summary now. ' +
        'Do not call more tools unless absolutely necessary.',
    };
  }

  
  if (ctx.hasThinkingOnly) {
    return { kind: 'thinking_only_complete' };
  }

  
  if (
    ctx.streamStopReason === 'length' &&
    ctx.toolCallCount === 0 &&
    ctx.outputContinuationCount < ctx.maxOutputContinuations &&
    !ctx.abortAborted &&
    !ctx.hasSteeringMessages
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

  
  if (!ctx.finalText.trim() && ctx.turns < ctx.maxTurns - 1) {
    return { kind: 'empty_retry' };
  }

  
  return { kind: 'steering_or_complete' };
}
