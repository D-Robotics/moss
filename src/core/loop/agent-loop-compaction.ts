import { estimateMessageChars, estimateMessageTokens } from '../../context/tokens.js';
import { describeError } from '../../provider/errors.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import { buildCompactionCheckpointOutline, type CompactHookRegistry } from './compact-hooks.js';
import type { Message } from '../session/session-jsonl.js';
import { summarizeDroppedMessages } from './agent-loop-context-prep.js';
import {
  isCompactionPrepareTimeout,
  resolveCompactionPrepareTimeoutMs,
  runWithCompactionPrepareTimeout,
} from './compaction-timeout.js';
import { notifyReadContextDropped } from '../../context/read-context-events.js';
import type { AgentLoopLlmUsage } from './agent-loop-types.js';

/** Distinct tool names across tool_use blocks (summary quality signal). */
function countDistinctToolNames(messages: Message[]): number {
  const names = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'tool_use' &&
        typeof (block as { name?: unknown }).name === 'string'
      ) {
        names.add((block as { name: string }).name);
      }
    }
  }
  return names.size;
}

export interface AgentLoopPrepareCompaction {
  (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    includeThinking?: boolean;
    /** Retry path only: skip the LLM summarizer and use the local deterministic one. */
    skipLlmCompaction?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
    usage?: AgentLoopLlmUsage[];
  }>;
}

export interface AgentLoopCompactionOutcome {
  attempted: boolean;
  succeeded: boolean;
  retrySameTurn: boolean;
  compactionSummary?: Message;
  /** The LLM summary timed out and a deterministic local summary was used. */
  degraded?: boolean;
}

interface CompactionCoreParams {
  sessionKey: string;
  runId: string;
  currentMessages: Message[];
  prepareCompaction: AgentLoopPrepareCompaction;
  compactHooks?: CompactHookRegistry;
  persistCurrentMessages: (messages?: Message[]) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;

  forceCompaction?: boolean;

  includeThinking?: boolean;

  hookReason: 'proactive' | 'overflow';

  computeStats: (prep: { summary: string; summaryMessage: Message; droppedMessages?: number }) => {
    savedChars: number;
    savedTokens: number;
    droppedMessages: number;
  };

  errorLabel: string;
}

async function runCompactionCore(
  params: CompactionCoreParams
): Promise<AgentLoopCompactionOutcome> {
  const {
    sessionKey,
    runId,
    currentMessages,
    prepareCompaction,
    compactHooks,
    persistCurrentMessages,
    push,
    onWarn,
    abortSignal,
    forceCompaction,
    includeThinking,
    hookReason,
    computeStats,
    errorLabel,
  } = params;

  let preHookRan = false;
  let postHookRan = false;

  try {
    await compactHooks?.runPreHooks({
      sessionKey,
      runId,
      messages: currentMessages,
      reason: hookReason,
    });
    preHookRan = true;

    // B13: a slow summarizer must not leave the context over budget with only a
    // log line. On timeout, retry once with the local deterministic summary
    // (no model call, so it cannot time out the same way) and mark the result
    // as degraded so the transcript says the summary is not the LLM's.
    let degraded = false;
    const prepareStartedAt = Date.now();
    let prep: Awaited<ReturnType<AgentLoopPrepareCompaction>>;
    try {
      prep = await runWithCompactionPrepareTimeout(
        (prepareAbortSignal) =>
          prepareCompaction({
            messages: currentMessages,
            sessionKey,
            runId,
            forceCompaction,
            includeThinking,
            abortSignal: prepareAbortSignal,
          }),
        { abortSignal, label: errorLabel }
      );
    } catch (error) {
      if (!isCompactionPrepareTimeout(error) || abortSignal?.aborted) throw error;
      const timeoutMs = resolveCompactionPrepareTimeoutMs();
      onWarn?.(`${errorLabel} compaction prepare timed out; using the deterministic summary`, {
        phase: errorLabel,
        timeoutMs,
        elapsedMs: Date.now() - prepareStartedAt,
        messages: currentMessages.length,
        runId,
        sessionKey,
      });
      degraded = true;
      prep = await runWithCompactionPrepareTimeout(
        (prepareAbortSignal) =>
          prepareCompaction({
            messages: currentMessages,
            sessionKey,
            runId,
            forceCompaction,
            includeThinking,
            skipLlmCompaction: true,
            abortSignal: prepareAbortSignal,
          }),
        { abortSignal, label: `${errorLabel}-deterministic` }
      );
    }

    const checkpointOutline =
      prep.checkpointOutline ?? buildCompactionCheckpointOutline(prep.summary);
    const droppedFromPrep = Math.max(0, Number(prep.droppedMessages ?? 0));

    await compactHooks?.runPostHooks({
      sessionKey,
      runId,
      summaryChars: prep.summary?.length ?? 0,
      droppedMessages: droppedFromPrep,
      reason: hookReason,
      success: Boolean(prep.summary && prep.summaryMessage),
      ...(checkpointOutline ? { checkpointOutline } : {}),
    });
    postHookRan = true;

    for (const usage of prep.usage ?? []) {
      push({ type: 'llm_usage', ...usage });
    }

    if (!prep.summary || !prep.summaryMessage) {
      return { attempted: true, succeeded: false, retrySameTurn: false };
    }

    let compactionSummary: Message | undefined = prep.summaryMessage;

    if (abortSignal?.aborted) {
      return { attempted: true, succeeded: false, retrySameTurn: false };
    }

    // O2 metrics: measure the context immediately before the splice replaces it.
    const tokensBefore = Math.round(
      currentMessages.reduce((n, m) => n + estimateMessageTokens(m), 0)
    );

    if (prep.messages?.length) {
      await persistCurrentMessages(prep.messages);
      currentMessages.splice(0, currentMessages.length, ...prep.messages);
      compactionSummary = undefined;
    }

    // O86: earlier read bodies are summarized away; no "refer to earlier read".
    notifyReadContextDropped(null);

    const tokensAfter = Math.round(
      currentMessages.reduce((n, m) => n + estimateMessageTokens(m), 0)
    );
    const keptToolNames = countDistinctToolNames(currentMessages);

    push({
      type: 'compaction',
      summaryChars: prep.summary.length,
      droppedMessages: droppedFromPrep,
      ...(checkpointOutline ? { checkpointOutline } : {}),
      tokensBefore,
      tokensAfter,
      keptToolNames,
      ...(degraded ? { degraded: true } : {}),
    });

    const stats = computeStats({
      summary: prep.summary,
      summaryMessage: prep.summaryMessage,
      droppedMessages: prep.droppedMessages,
    });

    push({
      type: 'context_action',
      reason: 'proactive_threshold',
      actions: [
        {
          kind: 'llm_summarize',
          reason: 'proactive_threshold',
          count: 1,
          savedChars: stats.savedChars,
          savedTokens: stats.savedTokens,
        },
      ],
      savedChars: stats.savedChars,
      savedTokens: stats.savedTokens,
    });

    return {
      attempted: true,
      succeeded: true,
      retrySameTurn: true,
      compactionSummary,
      ...(degraded ? { degraded: true } : {}),
    };
  } catch (error) {
    if (preHookRan && !postHookRan) {
      try {
        await compactHooks?.runPostHooks({
          sessionKey,
          runId,
          summaryChars: 0,
          droppedMessages: 0,
          reason: hookReason,
          success: false,
        });
      } catch (hookError) {
        onWarn?.(`${errorLabel} compaction post hook failed`, {
          error: describeError(hookError),
        });
      }
    }
    onWarn?.(`${errorLabel} compaction failed`, {
      error: describeError(error),
    });
    return { attempted: true, succeeded: false, retrySameTurn: false };
  }
}

export async function runProactiveWindowCompaction(params: {
  sessionKey: string;
  runId: string;
  currentMessages: Message[];
  rawTotalChars: number;
  promptUnitsForWindow: number;
  prepareCompaction: AgentLoopPrepareCompaction;
  compactHooks?: CompactHookRegistry;
  persistCurrentMessages: (messages?: Message[]) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
  includeThinking?: boolean;
}): Promise<AgentLoopCompactionOutcome> {
  const { rawTotalChars, promptUnitsForWindow } = params;
  return runCompactionCore({
    ...params,
    // The caller (window economics / hard cap) already decided compaction is
    // due; without force the internal threshold would second-guess it and
    // silently no-op — the "triggered but never compacted" defect.
    forceCompaction: true,
    hookReason: 'proactive',
    errorLabel: 'proactive',
    computeStats: ({ summaryMessage }) => {
      const summaryChars = estimateMessageChars(summaryMessage);
      const summaryTokens = estimateMessageTokens(summaryMessage);
      return {
        savedChars: Math.max(0, rawTotalChars - summaryChars),
        savedTokens: Math.max(0, Math.round(promptUnitsForWindow - summaryTokens)),
        droppedMessages: 0,
      };
    },
  });
}

export async function runPromptPruneCompaction(params: {
  sessionKey: string;
  runId: string;
  currentMessages: Message[];
  droppedMessagesForStats: Message[];
  prepareCompaction: AgentLoopPrepareCompaction;
  compactHooks?: CompactHookRegistry;
  persistCurrentMessages: (messages?: Message[]) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
  includeThinking?: boolean;
}): Promise<AgentLoopCompactionOutcome> {
  const { droppedMessagesForStats } = params;
  return runCompactionCore({
    ...params,
    forceCompaction: true,
    hookReason: 'proactive',
    errorLabel: 'prompt prune',
    computeStats: ({ droppedMessages }) => {
      const droppedStats = summarizeDroppedMessages(droppedMessagesForStats);
      return {
        savedChars: droppedStats.savedChars,
        savedTokens: droppedStats.savedTokens,
        droppedMessages: Math.max(0, Number(droppedMessages ?? droppedMessagesForStats.length)),
      };
    },
  });
}
