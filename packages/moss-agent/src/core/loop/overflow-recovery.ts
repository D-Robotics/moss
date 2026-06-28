















import type { Message } from '../session/session-jsonl.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import { buildCompactionCheckpointOutline, type CompactHookRegistry } from './compact-hooks.js';
import {
  invalidateStaleReadToolResults,
  dedupeUnchangedReadToolResults,
} from '../../context/stale-read-invalidate.js';
import { microcompact } from '../../context/microcompact.js';
import { estimateMessagesChars, estimateMessagesTokens } from '../../context/tokens.js';
import { describeError } from '../../provider/errors.js';
import { getRootLogger } from '../../logger.js';
import { runWithCompactionPrepareTimeout } from './compaction-timeout.js';

const log = getRootLogger().child('agent:overflow');

export type RecoveryState =
  | {
      kind: 'idle';
      level: 0;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available' | 'fused';
    }
  | {
      kind: 'cheap';
      level: 1;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available' | 'fused';
    }
  | {
      kind: 'llm_summarize';
      level: 2;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available' | 'fused';
    }
  | {
      kind: 'truncate';
      level: 3;
      llmCompactionFailureStreak: number;
      llmSummarize: 'available';
    }
  | {
      kind: 'fused';
      level: 3;
      llmCompactionFailureStreak: number;
      llmSummarize: 'fused';
    };

export interface OverflowRecoveryState {
  
  recovery: RecoveryState;
  
  readonly level: RecoveryState['level'];
  
  readonly llmCompactionFailureStreak: number;
  
  readonly skipLlmCompactionOnOverflow: boolean;
  
  overflowRecoveries: number;
  
  contextCompactions: number;
  
  microcompactTotalSavedChars: number;
  




  compactionOverflowRetries: number;
}


const MAX_COMPACTION_OVERFLOW_RETRIES = 2;

export function createOverflowRecoveryState(): OverflowRecoveryState {
  return {
    recovery: createRecoveryState('idle'),
    get level() {
      return this.recovery.level;
    },
    get llmCompactionFailureStreak() {
      return this.recovery.llmCompactionFailureStreak;
    },
    get skipLlmCompactionOnOverflow() {
      return this.recovery.llmSummarize === 'fused';
    },
    overflowRecoveries: 0,
    contextCompactions: 0,
    microcompactTotalSavedChars: 0,
    compactionOverflowRetries: 0,
  };
}

function createRecoveryState(kind: RecoveryState['kind'], previous?: RecoveryState): RecoveryState {
  const llmCompactionFailureStreak = previous?.llmCompactionFailureStreak ?? 0;
  const llmSummarize = previous?.llmSummarize ?? 'available';

  switch (kind) {
    case 'idle':
      return {
        kind,
        level: 0,
        llmCompactionFailureStreak,
        llmSummarize,
      };
    case 'cheap':
      return {
        kind,
        level: 1,
        llmCompactionFailureStreak,
        llmSummarize,
      };
    case 'llm_summarize':
      return {
        kind,
        level: 2,
        llmCompactionFailureStreak,
        llmSummarize,
      };
    case 'truncate':
      return {
        kind,
        level: 3,
        llmCompactionFailureStreak,
        llmSummarize: 'available',
      };
    case 'fused':
      return {
        kind,
        level: 3,
        llmCompactionFailureStreak,
        llmSummarize: 'fused',
      };
  }
}

function advanceRecoveryState(recovery: RecoveryState): RecoveryState | null {
  switch (recovery.kind) {
    case 'idle':
      return createRecoveryState('cheap', recovery);
    case 'cheap':
      return createRecoveryState('llm_summarize', recovery);
    case 'llm_summarize':
      return createRecoveryState('truncate', recovery);
    case 'truncate':
    case 'fused':
      return null;
  }
}

function escalateToLlmSummarize(state: OverflowRecoveryState): void {
  state.recovery = createRecoveryState('llm_summarize', state.recovery);
}

function markLlmCompactionSucceeded(state: OverflowRecoveryState): void {
  state.recovery = {
    kind: 'idle',
    level: 0,
    llmCompactionFailureStreak: 0,
    llmSummarize: 'available',
  };
}

function markLlmCompactionFailed(state: OverflowRecoveryState): number {
  const failureStreak = state.recovery.llmCompactionFailureStreak + 1;
  state.recovery =
    failureStreak >= 2
      ? {
          kind: 'fused',
          level: 3,
          llmCompactionFailureStreak: failureStreak,
          llmSummarize: 'fused',
        }
      : {
          kind: 'truncate',
          level: 3,
          llmCompactionFailureStreak: failureStreak,
          llmSummarize: 'available',
        };
  return failureStreak;
}

function skipFusedLlmSummarize(state: OverflowRecoveryState): void {
  state.recovery = createRecoveryState('fused', state.recovery);
}

export interface OverflowRecoveryParams {
  state: OverflowRecoveryState;
  errorText: string;
  currentMessages: Message[];
  sessionKey: string;
  runId: string;
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  compactHooks?: CompactHookRegistry;
  push: (event: MiniAgentEvent) => void;
  abortSignal?: AbortSignal;
}








export type RecoveryOutcome =
  | {
      kind: 'retry-same-turn';
      replacedSummaryMessage?: Message;
    }
  | { kind: 'rethrow' };











export function findSafeTruncationPoint(messages: Message[], targetKeep: number): number {
  if (messages.length === 0 || targetKeep >= messages.length) return 0;
  if (targetKeep <= 0) return messages.length;

  const cutPoint = messages.length - targetKeep;

  
  const keptToolUseIds = new Set<string>();
  for (let i = cutPoint; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id) {
          keptToolUseIds.add(block.id);
        }
      }
    }
  }

  
  
  
  
  
  let adjustedCut = cutPoint;
  for (let i = cutPoint - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block.type === 'tool_result' &&
          block.tool_use_id &&
          keptToolUseIds.has(block.tool_use_id)
        ) {
          
          adjustedCut = Math.min(adjustedCut, i);
        }
      }
    }
  }

  
  
  
  const keptToolResultIds = new Set<string>();
  for (let i = adjustedCut; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          keptToolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  if (keptToolResultIds.size > 0) {
    for (let i = adjustedCut - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        let hasMatchingToolUse = false;
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id && keptToolResultIds.has(block.id)) {
            hasMatchingToolUse = true;
            break;
          }
        }
        if (hasMatchingToolUse) {
          adjustedCut = Math.min(adjustedCut, i);
        }
      }
    }
  }

  
  
  
  

  return adjustedCut;
}









export async function runOverflowRecovery(
  params: OverflowRecoveryParams
): Promise<RecoveryOutcome> {
  const {
    state,
    errorText,
    currentMessages,
    sessionKey,
    runId,
    prepareCompaction,
    replaceMessages,
    compactHooks,
    push,
    abortSignal,
  } = params;

  const persistMessages = async (messages: Message[]): Promise<void> => {
    if (replaceMessages) {
      await replaceMessages(sessionKey, messages);
    }
  };

  const nextRecovery = advanceRecoveryState(state.recovery);
  if (!nextRecovery) {
    return { kind: 'rethrow' };
  }

  state.recovery = nextRecovery;
  state.overflowRecoveries++;
  push({
    type: 'context_overflow_compact',
    error: errorText,
    recoveryLevel: state.level,
  });

  
  if (state.recovery.kind === 'cheap') {
    let recovered = false;
    let savedChars = 0;
    let savedTokens = 0;
    const actions: Extract<MiniAgentEvent, { type: 'context_action' }>['actions'] = [];

    const staleOv = invalidateStaleReadToolResults(currentMessages);
    if (staleOv.savedChars > 0) {
      await persistMessages(staleOv.messages);
      currentMessages.splice(0, currentMessages.length, ...staleOv.messages);
      state.microcompactTotalSavedChars += staleOv.savedChars;
      savedChars += staleOv.savedChars;
      savedTokens += staleOv.savedTokens;
      actions.push({
        kind: 'invalidate_stale_reads',
        reason: 'overflow_recovery',
        count: staleOv.invalidatedCount,
        savedChars: staleOv.savedChars,
        savedTokens: staleOv.savedTokens,
      });
      recovered = true;
    }

    const dedupOv = dedupeUnchangedReadToolResults(currentMessages);
    if (dedupOv.savedChars > 0) {
      await persistMessages(dedupOv.messages);
      currentMessages.splice(0, currentMessages.length, ...dedupOv.messages);
      state.microcompactTotalSavedChars += dedupOv.savedChars;
      savedChars += dedupOv.savedChars;
      savedTokens += dedupOv.savedTokens;
      actions.push({
        kind: 'invalidate_stale_reads',
        reason: 'overflow_recovery',
        count: dedupOv.invalidatedCount,
        savedChars: dedupOv.savedChars,
        savedTokens: dedupOv.savedTokens,
      });
      recovered = true;
    }

    const mcResult = microcompact(currentMessages, {
      keepRecentResults: 2,
      minContentLength: 50,
    });
    if (mcResult.compressedCount > 0) {
      await persistMessages(mcResult.messages);
      currentMessages.splice(0, currentMessages.length, ...mcResult.messages);
      state.microcompactTotalSavedChars += mcResult.savedChars;
      savedChars += mcResult.savedChars;
      savedTokens += mcResult.savedTokens;
      actions.push({
        kind: 'microcompact',
        reason: 'overflow_recovery',
        count: mcResult.compressedCount,
        savedChars: mcResult.savedChars,
        savedTokens: mcResult.savedTokens,
      });
      recovered = true;
    }

    if (recovered) {
      
      
      
      
      const totalChars = estimateMessagesChars(currentMessages);
      const minRecoveryChars = Math.max(200, totalChars * 0.01);
      if (savedChars < minRecoveryChars) {
        log.info('cheap recovery insufficient — escalating to LLM summarize', {
          savedChars,
          totalChars,
          minRecoveryChars,
        });
        escalateToLlmSummarize(state);
      } else {
        push({
          type: 'context_action',
          reason: 'overflow_recovery',
          actions,
          savedChars,
          savedTokens,
        });
        return { kind: 'retry-same-turn' };
      }
    } else {
      escalateToLlmSummarize(state);
    }
  }

  
  
  if (state.recovery.kind === 'llm_summarize') {
    if (
      state.skipLlmCompactionOnOverflow ||
      state.compactionOverflowRetries >= MAX_COMPACTION_OVERFLOW_RETRIES
    ) {
      if (state.compactionOverflowRetries >= MAX_COMPACTION_OVERFLOW_RETRIES) {
        log.warn('skipping LLM compaction: compaction overflow retry cap reached', {
          compactionOverflowRetries: state.compactionOverflowRetries,
        });
      }
      skipFusedLlmSummarize(state);
    } else {
      state.compactionOverflowRetries++;
      let preHookRan = false;
      let postHookRan = false;
      try {
        await compactHooks?.runPreHooks({
          sessionKey,
          runId,
          messages: currentMessages,
          reason: 'overflow',
        });
        preHookRan = true;
        const overflowPrep = await runWithCompactionPrepareTimeout(
          (prepareAbortSignal) =>
            prepareCompaction({
              messages: currentMessages,
              sessionKey,
              runId,
              forceCompaction: true,
              abortSignal: prepareAbortSignal,
            }),
          { abortSignal, label: 'overflow' }
        );
        const checkpointOutline =
          overflowPrep.checkpointOutline ?? buildCompactionCheckpointOutline(overflowPrep.summary);
        const droppedMessages = Math.max(0, Number(overflowPrep.droppedMessages ?? 0));
        await compactHooks?.runPostHooks({
          sessionKey,
          runId,
          summaryChars: overflowPrep.summary?.length ?? 0,
          droppedMessages,
          reason: 'overflow',
          success: Boolean(overflowPrep.summary && overflowPrep.summaryMessage),
          ...(checkpointOutline ? { checkpointOutline } : {}),
        });
        postHookRan = true;
        if (overflowPrep.summary && overflowPrep.summaryMessage) {
          
          if (abortSignal?.aborted) {
            return { kind: 'rethrow' };
          }
          if (overflowPrep.messages?.length) {
            await persistMessages(overflowPrep.messages);
            currentMessages.splice(0, currentMessages.length, ...overflowPrep.messages);
          }
          state.contextCompactions++;
          markLlmCompactionSucceeded(state);
          push({
            type: 'compaction',
            summaryChars: overflowPrep.summary.length,
            droppedMessages,
            ...(checkpointOutline ? { checkpointOutline } : {}),
          });
          return overflowPrep.messages?.length
            ? { kind: 'retry-same-turn' }
            : { kind: 'retry-same-turn', replacedSummaryMessage: overflowPrep.summaryMessage };
        }
      } catch (compactErr) {
        if (preHookRan && !postHookRan) {
          try {
            await compactHooks?.runPostHooks({
              sessionKey,
              runId,
              summaryChars: 0,
              droppedMessages: 0,
              reason: 'overflow',
              success: false,
            });
          } catch (hookErr) {
            log.warn('post compaction hook failed during overflow recovery', {
              error: describeError(hookErr),
            });
          }
        }
        const failureStreak = markLlmCompactionFailed(state);
        log.warn('prepareCompaction failed during overflow recovery', {
          error: describeError(compactErr),
          failureStreak,
        });
        if (state.skipLlmCompactionOnOverflow) {
          push({
            type: 'context_action',
            reason: 'overflow_recovery',
            actions: [
              {
                kind: 'compaction_fuse',
                reason: 'overflow_recovery',
                count: failureStreak,
                savedChars: 0,
                savedTokens: 0,
              },
            ],
            savedChars: 0,
            savedTokens: 0,
          });
        }
      }
    }
  }

  
  if (state.recovery.kind === 'truncate' || state.recovery.kind === 'fused') {
    let keepCount = Math.min(6, currentMessages.length);
    let dropped = currentMessages.length - keepCount;
    if (dropped === 0 && currentMessages.length > 3) {
      keepCount = Math.min(3, currentMessages.length);
      dropped = currentMessages.length - keepCount;
    }
    if (dropped === 0 && currentMessages.length > 1) {
      keepCount = 1;
      dropped = currentMessages.length - keepCount;
    }
    if (dropped > 0) {
      const safeCut = findSafeTruncationPoint(currentMessages, keepCount);
      const droppedMessages = currentMessages.slice(0, safeCut);
      const savedChars = estimateMessagesChars(droppedMessages);
      const savedTokens = estimateMessagesTokens(droppedMessages);
      const kept = currentMessages.slice(safeCut);
      dropped = safeCut;
      await persistMessages(kept);
      currentMessages.splice(0, currentMessages.length, ...kept);
      push({
        type: 'context_action',
        reason: 'overflow_recovery',
        actions: [
          {
            kind: 'emergency_truncate',
            reason: 'overflow_recovery',
            count: dropped,
            savedChars,
            savedTokens,
          },
        ],
        savedChars,
        savedTokens,
      });
      return { kind: 'retry-same-turn' };
    }
  }

  return { kind: 'rethrow' };
}
