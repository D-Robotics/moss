import { estimateMessageChars, estimateMessageTokens } from '../../context/tokens.js';
import { describeError } from '../../provider/errors.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import { buildCompactionCheckpointOutline, type CompactHookRegistry } from './compact-hooks.js';
import type { Message } from '../session/session-jsonl.js';
import { summarizeDroppedMessages } from './agent-loop-context-prep.js';
import { runWithCompactionPrepareTimeout } from './compaction-timeout.js';

export interface AgentLoopPrepareCompaction {
  (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    includeThinking?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
}

export interface AgentLoopCompactionOutcome {
  attempted: boolean;
  succeeded: boolean;
  retrySameTurn: boolean;
  compactionSummary?: Message;
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

    const prep = await runWithCompactionPrepareTimeout(
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

    if (!prep.summary || !prep.summaryMessage) {
      return { attempted: true, succeeded: false, retrySameTurn: false };
    }

    let compactionSummary: Message | undefined = prep.summaryMessage;

    
    if (abortSignal?.aborted) {
      return { attempted: true, succeeded: false, retrySameTurn: false };
    }

    if (prep.messages?.length) {
      await persistCurrentMessages(prep.messages);
      currentMessages.splice(0, currentMessages.length, ...prep.messages);
      compactionSummary = undefined;
    }

    push({
      type: 'compaction',
      summaryChars: prep.summary.length,
      droppedMessages: droppedFromPrep,
      ...(checkpointOutline ? { checkpointOutline } : {}),
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
