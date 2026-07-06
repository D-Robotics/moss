







import type { StopReason } from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import type { ContentBlock, Message } from '../session/session-jsonl.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import type { AgentLoopMutableState } from './agent-loop-state.js';
import type { ToolLoopGuardState } from '../tools/tool-loop-guard.js';
import type { LoopControlSignal } from './agent-loop-context-prep.js';
import type { AgentLoopExtensions } from './agent-loop-types.js';
import {
  injectToolCallFromPlanText,
  normalizeAssistantToolCalls,
  isThinkingOnlyAssistantTurn,
  buildVisibleAssistantText,
  extractThinkingTextFromMessage,
  shouldNudgeMissingToolInvocation,
} from './agent-loop-assistant-turn.js';
import { buildNamedWebToolMatcher } from '../../prompts/plan-detection.js';
import { decidePostLlmAction } from './agent-loop-post-llm.js';
import { executeAgentLoopToolCalls } from './agent-loop-tool-execution.js';

const GUARDED_DELTA_CHUNK = 96;
const MAX_COMPLETION_GATE_ATTEMPTS = 2;

function pushGuardedMessageDeltas(push: (event: MiniAgentEvent) => void, text: string): void {
  if (!text) return;
  for (let i = 0; i < text.length; i += GUARDED_DELTA_CHUNK) {
    const delta = text.slice(i, i + GUARDED_DELTA_CHUNK);
    if (delta) push({ type: 'message_delta', delta });
  }
}

function replaceAssistantVisibleText(content: ContentBlock[], text: string): void {
  const next: ContentBlock[] = [];
  let inserted = false;
  for (const block of content) {
    if (block.type !== 'text') {
      next.push(block);
      continue;
    }
    if (!inserted) {
      if (text) next.push({ ...block, text });
      inserted = true;
    }
  }
  if (!inserted && text) {
    next.unshift({ type: 'text', text });
  }
  content.splice(0, content.length, ...next);
}

export interface ProcessLlmResponseParams {
  state: AgentLoopMutableState;
  runId: string;
  assistantContent: ContentBlock[];
  messageThinkingChunks: string[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  turnTextParts: string[];
  streamStopReason: StopReason | undefined;
  maxTurns: number;
  maxOutputContinuations: number;
  abortSignal: AbortSignal;
  isQuiet: boolean;
  sessionKey: string;
  currentMessages: Message[];
  
  assistantBuffer: Message[];
  resolveToolsForRun: () => Tool[];
  toolCtx: ToolContext;
  toolHooks?: ToolHookRegistry;
  toolTimeoutMs: number;
  toolHeartbeatIntervalMs: number;
  skipHeartbeatToolNames: Set<string>;
  parallelSafeTools: Set<string>;
  loadToolsMetaName?: string;
  toolLoopGuard: ToolLoopGuardState;
  maxToolCalls?: number;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string } | null>;
  guardAssistantOutput?: (request: {
    sessionKey: string;
    runId: string;
    turn: number;
    response: string;
    stopReason?: string;
  }) => Promise<
    { approved: true; response?: string } | { approved: false; reason: string; response?: string }
  >;
  completionGate?: AgentLoopExtensions['completionGate'];
  delayedVisibleDeltas?: boolean;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  evaluateSteering: () => Message[];
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  buildCorrectionMessage: (systemText: string) => Message;
}

export interface ProcessLlmResponseResult {
  control: LoopControlSignal;
}



















export async function processLlmResponse(
  params: ProcessLlmResponseParams
): Promise<ProcessLlmResponseResult> {
  const {
    state,
    runId,
    assistantContent,
    messageThinkingChunks,
    toolCalls,
    turnTextParts,
    streamStopReason,
    maxTurns,
    maxOutputContinuations,
    abortSignal,
    isQuiet,
    sessionKey,
    currentMessages,
    assistantBuffer,
    resolveToolsForRun,
    toolCtx,
    toolHooks,
    toolTimeoutMs,
    toolHeartbeatIntervalMs,
    skipHeartbeatToolNames,
    parallelSafeTools,
    loadToolsMetaName,
    toolLoopGuard,
    maxToolCalls,
    checkToolApproval,
    guardAssistantOutput,
    completionGate,
    delayedVisibleDeltas,
    toolAbortSignalFor,
    enrichToolContext,
    evaluateSteering,
    appendMessage,
    push,
    buildCorrectionMessage,
  } = params;
  const pushTurnEnd = (stopReason: StopReason | undefined = streamStopReason) => {
    push({
      type: 'turn_end',
      turn: state.turns,
      ...(stopReason ? { stopReason } : {}),
      totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
    });
  };

  
  const toolsForAssistantTurn = resolveToolsForRun();
  injectToolCallFromPlanText({
    toolCalls,
    assistantContent,
    turnTextParts,
    messageThinkingChunks,
    toolsForRun: toolsForAssistantTurn,
    sessionKey,
    logInfo: !isQuiet
      ? undefined 
      : undefined,
  });

  
  if (toolCalls.length > 0) {
    normalizeAssistantToolCalls({
      toolCalls,
      assistantContent,
      toolsForRun: toolsForAssistantTurn,
      sessionKey,
    });
  }

  
  const turnText = turnTextParts.join('');
  const turnTrim = turnText.trim();

  const hasThinkingOnly = isThinkingOnlyAssistantTurn({
    visibleText: turnText,
    toolCallCount: toolCalls.length,
    thinkingChunks: messageThinkingChunks,
    assistantContent,
  });

  const thinkingFallback =
    turnTrim || hasThinkingOnly
      ? ''
      : extractThinkingTextFromMessage(messageThinkingChunks, assistantContent);

  
  if (
    hasThinkingOnly &&
    state.toolExecutionMetrics.totalToolCalls > 0 &&
    state.postToolThinkingOnlyRetryAttempts < 1 &&
    state.turns < maxTurns &&
    !abortSignal.aborted
  ) {
    state.postToolThinkingOnlyRetryAttempts += 1;
    state.pendingMessages = [
      buildCorrectionMessage(
        '[System] The tools already ran, but your previous assistant turn had no visible answer. ' +
          'Read the latest tool results and produce a concise visible user-facing summary now. ' +
          'Do not call more tools unless absolutely necessary.'
      ),
    ];
    pushTurnEnd();
    state.lastTurnEndMs = Date.now();
    return { control: 'continue' };
  }

  
  
  
  if (hasThinkingOnly) {
    // no-op: thinking-only turns are handled by the retry guard above
    
  }

  
  const assistantMsg: Message = {
    role: 'assistant',
    content: assistantContent,
    timestamp: Date.now(),
    ...(messageThinkingChunks.length > 0 ? { thinking: [...messageThinkingChunks] } : {}),
  };

  
  if (!hasThinkingOnly) {
    assistantBuffer.push(assistantMsg);
  }

  let visibleAssistantText = buildVisibleAssistantText({
    textParts: turnTextParts,
    thinkingFallback,
  });
  if (guardAssistantOutput && !hasThinkingOnly) {
    let decision:
      | { approved: true; response?: string }
      | { approved: false; reason: string; response?: string };
    try {
      decision = await guardAssistantOutput({
        sessionKey,
        runId,
        turn: state.turns,
        response: visibleAssistantText,
        ...(streamStopReason ? { stopReason: streamStopReason } : {}),
      });
    } catch {
      decision = { approved: false, reason: 'output guardrail failed' };
    }
    if (decision.approved) {
      if (typeof decision.response === 'string') {
        visibleAssistantText = decision.response;
      }
    } else {
      visibleAssistantText =
        typeof decision.response === 'string'
          ? decision.response
          : `Output blocked by host policy: ${decision.reason || 'no reason provided'}`;
    }
    replaceAssistantVisibleText(assistantContent, visibleAssistantText);
  }

  
  state.hasMoreToolCalls = toolCalls.length > 0;
  if (!state.hasMoreToolCalls) {
    state.finalText = visibleAssistantText;
  }

  if (
    completionGate &&
    !state.hasMoreToolCalls &&
    state.finalText.trim().length > 0 &&
    !abortSignal.aborted
  ) {
    const decision = await completionGate({
      sessionKey,
      runId,
      turn: state.turns,
      response: state.finalText,
      ...(streamStopReason ? { stopReason: streamStopReason } : {}),
      messages: currentMessages,
      totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
      toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
    });
    if (!decision.ok && state.completionGateAttempts < MAX_COMPLETION_GATE_ATTEMPTS) {
      state.completionGateAttempts += 1;
      state.finalText = '';
      const bufferedIndex = assistantBuffer.lastIndexOf(assistantMsg);
      if (bufferedIndex >= 0) assistantBuffer.splice(bufferedIndex, 1);
      state.pendingMessages = [
        buildCorrectionMessage(
          decision.correction ??
            `[System] Completion rejected: ${decision.reason}. Continue the task and only finish when the required evidence is available.`
        ),
      ];
      pushTurnEnd();
      state.lastTurnEndMs = Date.now();
      return { control: 'continue' };
    }
    if (decision.ok) {
      state.completionGateAttempts = 0;
    } else {
      
      
      
      state.completionGateAttempts = 0;
    }
  }

  if (delayedVisibleDeltas && !hasThinkingOnly) {
    pushGuardedMessageDeltas(push, visibleAssistantText);
  }
  push({ type: 'message_end', message: assistantMsg, text: visibleAssistantText });

  
  const toolsForNudge = resolveToolsForRun();
  const namedWebToolRe = buildNamedWebToolMatcher(toolsForNudge.map((x) => x.name));
  const shouldNudge =
    !state.hasMoreToolCalls &&
    shouldNudgeMissingToolInvocation({
      finalText: state.finalText,
      messageThinkingChunks,
      assistantContent,
      namedWebToolRe,
    });

  // Steering is evaluated inside the tool-execution path (see
  // executeAgentLoopToolCalls), where the guidance is meaningful — the model
  // is still working and the rules detect in-progress patterns (consecutive
  // tool errors, extended tool loops, repeated web searches). Evaluating it
  // again here, after the model has already ended its turn with no tool
  // calls, only produced a spurious extra turn (the model acknowledging the
  // guidance) on simple single-turn answers. So we no longer evaluate
  // steering on the end_turn path; `decidePostLlmAction` no longer takes a
  // hasSteeringMessages signal, and the completion branches above inject
  // correction messages directly when the model failed to answer.

  const postLlmAction = decidePostLlmAction({
    hasThinkingOnly,
    toolCallCount: toolCalls.length,
    postToolThinkingOnlyRetryAttempts: state.postToolThinkingOnlyRetryAttempts,
    totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
    streamStopReason,
    outputContinuationCount: state.outputContinuationCount,
    maxOutputContinuations,
    planToolNudgeAttempts: state.planToolNudgeAttempts,
    finalText: state.finalText,
    maxTurns,
    turns: state.turns,
    shouldNudge,
    abortAborted: abortSignal.aborted,
  });

  
  switch (postLlmAction.kind) {
    case 'thinking_retry':
      
      break;

    case 'thinking_only_complete':
      // The model produced only thinking, no visible answer and no tool calls.
      // The user got nothing. This is a "didn't answer" failure, not a place
      // for steering guidance — telling a model that hasn't answered to "be
      // concise" is nonsensical. Inject a correction that asks for a visible
      // answer (mirroring the post-tool thinking-only retry above). Without
      // this, an empty cachedSteering would leave pendingMessages empty and
      // the loop would exit with no answer returned to the user.
      pushTurnEnd();
      state.lastTurnEndMs = Date.now();
      state.pendingMessages = [
        buildCorrectionMessage(
          '[System] Your previous turn produced only private reasoning with no visible answer. ' +
            'Produce a concise visible user-facing answer now based on what you already worked out.'
        ),
      ];
      return { control: 'continue' };

    case 'continuation':
      state.outputContinuationCount++;
      push({
        type: 'output_continuation',
        attempt: state.outputContinuationCount,
        maxAttempts: maxOutputContinuations,
      });
      state.pendingMessages = [buildCorrectionMessage(postLlmAction.systemText)];
      pushTurnEnd();
      state.lastTurnEndMs = Date.now();
      return { control: 'continue' };

    case 'nudge':
      state.planToolNudgeAttempts += 1;
      push({ type: 'message_delta', delta: postLlmAction.deltaText });
      state.pendingMessages = [buildCorrectionMessage(postLlmAction.systemText)];
      pushTurnEnd();
      state.lastTurnEndMs = Date.now();
      return { control: 'continue' };

    case 'empty_retry':
      // Empty response is a "didn't answer" failure. Inject a correction that
      // asks for an actual answer — not a steering message. Steering guidance
      // like "be concise" is meaningless when there is nothing to be concise
      // about, and prioritizing it over the correction would risk another
      // empty turn.
      state.pendingMessages = [
        buildCorrectionMessage(
          "[System] Your previous response was empty. Please answer the user's question again."
        ),
      ];
      pushTurnEnd();
      state.lastTurnEndMs = Date.now();
      return { control: 'continue' };

    case 'steering_or_complete':
      // The model emitted end_turn with a visible answer and no tool calls.
      // That is the canonical "task complete" signal — the loop must stop
      // here. Injecting a steering message at this point forces a second
      // LLM turn whose only content is the model acknowledging the guidance
      // ("Understood, I'll be concise"), which wastes a round-trip on every
      // single-turn answer. Steering belongs mid-task (the tool_execute path
      // and the retry branches below, where the model is still working); once
      // the model has produced a final answer, respect the end_turn and stop.
      pushTurnEnd();
      state.lastTurnEndMs = Date.now();
      state.pendingMessages = [];
      return { control: 'continue' };

    case 'tool_execute':
      
      break;
  }

  
  
  
  
  
  while (assistantBuffer.length > 0) {
    const msg = assistantBuffer[0]!;
    await appendMessage(sessionKey, msg);
    currentMessages.push(msg);
    assistantBuffer.shift();
  }
  const toolExecution = await executeAgentLoopToolCalls({
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
    metrics: state.toolExecutionMetrics,
    evaluateSteering,
    appendMessage,
    push,
  });

  pushTurnEnd();
  state.lastTurnEndMs = Date.now();
  state.pendingMessages = toolExecution.pendingMessages;

  return { control: 'continue' };
}
