import {
  invalidateStaleReadToolResults,
  dedupeUnchangedReadToolResults,
} from '../../context/stale-read-invalidate.js';
import { snipTailOversizedToolResults } from '../../context/tail-tool-snip.js';
import { elideOldLargeToolResults } from '../../context/tool-result-elision.js';
import {
  foldOlderToolResults,
  TOOL_RESULT_FOLD_HORIZON,
  toolResultFoldMinPromptTokens,
} from '../../context/tool-result-fold.js';
import { microcompact } from '../../context/microcompact.js';
import type { Message } from '../session/session-jsonl.js';
import type { ContextActionSummary, MiniAgentEvent } from '../subagent/agent-events.js';
import {
  planContextBudgetActions,
  type ContextBudgetActionReason,
} from './context-budget-planner.js';

export interface PerTurnContextMgmtParams {
  currentMessages: Message[];
  estPromptTokens: number;
  effectiveContextWindowTokens: number;
  pendingToolResultFollowUp: boolean;
  turns: number;
  /** Run budget. The fold horizon does not use the leftover turn count. */
  maxTurns?: number;
  /** Names with `ToolMetadata.retainResult`. Their results are not folded. */
  retainTools?: ReadonlySet<string>;
  push: (event: MiniAgentEvent) => void;
}

export interface PerTurnContextMgmtResult {
  savedChars: number;
  savedTokens?: number;
  /**
   * Chars that must be written back. Folds and stale-read edits persist.
   * Elision stays in memory, matching main.
   */
  durableChars: number;
}

export function runPerTurnContextManagement(
  params: PerTurnContextMgmtParams
): PerTurnContextMgmtResult {
  const { currentMessages, estPromptTokens, pendingToolResultFollowUp, turns, push } = params;

  if (turns <= 1) {
    return { savedChars: 0, savedTokens: 0, durableChars: 0 };
  }

  const plan = planContextBudgetActions({
    estimatedPromptTokens: estPromptTokens,
    effectiveContextWindowTokens: params.effectiveContextWindowTokens,
    isToolFollowUpRound: pendingToolResultFollowUp,
    turn: turns,
  });

  if (plan.actions.length === 0) {
    return { savedChars: 0, durableChars: 0 };
  }

  let savedChars = 0;
  let savedTokens = 0;
  let durableChars = 0;
  const contextActions: ContextActionSummary[] = [];
  let foldAttempted = false;
  let didFold = false;

  const applyFold = (reason: ContextBudgetActionReason): void => {
    if (foldAttempted) return;
    foldAttempted = true;
    // Below half the window (and the 60k floor) the transcript matches main:
    // elision runs, nothing is folded. MCP and other retainResult tools are
    // skipped inside the fold.
    if (estPromptTokens < toolResultFoldMinPromptTokens(params.effectiveContextWindowTokens)) {
      return;
    }
    // Kind name on the action is historical (public planner union). Folding
    // rewrites the cached prefix from the first folded message onward, so it
    // runs only when the batch and the savings inequality both pass.
    const folded = foldOlderToolResults(currentMessages, {
      remainingRequests: Math.min(turns, TOOL_RESULT_FOLD_HORIZON),
      promptTokens: estPromptTokens,
      contextWindowTokens: params.effectiveContextWindowTokens,
      ...(params.retainTools ? { retainTools: params.retainTools } : {}),
    });
    if (folded.savedChars > 0) {
      didFold = true;
      currentMessages.splice(0, currentMessages.length, ...folded.messages);
      savedChars += folded.savedChars;
      savedTokens += folded.savedTokens;
      durableChars += folded.savedChars;
      contextActions.push({
        kind: 'elide_old_large_tool_results',
        reason,
        count: folded.foldedCount,
        savedChars: folded.savedChars,
        savedTokens: folded.savedTokens,
      });
    }
  };

  const applyElision = (reason: ContextBudgetActionReason): void => {
    if (didFold) return;
    const elided = elideOldLargeToolResults(currentMessages);
    if (elided.savedChars > 0) {
      currentMessages.splice(0, currentMessages.length, ...elided.messages);
      savedChars += elided.savedChars;
      savedTokens += elided.savedTokens;
      contextActions.push({
        kind: 'elide_old_large_tool_results',
        reason,
        count: elided.elidedCount,
        savedChars: elided.savedChars,
        savedTokens: elided.savedTokens,
      });
    }
  };

  for (const action of plan.actions) {
    if (action.kind === 'invalidate_stale_reads') {
      let branchSavedChars = 0;
      let branchSavedTokens = 0;
      let branchCount = 0;
      const staleInv = invalidateStaleReadToolResults(currentMessages);
      if (staleInv.savedChars > 0) {
        currentMessages.splice(0, currentMessages.length, ...staleInv.messages);
        branchSavedChars += staleInv.savedChars;
        branchSavedTokens += staleInv.savedTokens;
        branchCount += staleInv.invalidatedCount;
      }
      // Fold before dedupe. Otherwise dedupe can point "see below" at the only
      // full copy, and the fold then stubs that copy.
      const elide = plan.actions.find((row) => row.kind === 'elide_old_large_tool_results');
      if (elide) applyFold(elide.reason);
      const dedup = dedupeUnchangedReadToolResults(currentMessages);
      if (dedup.savedChars > 0) {
        currentMessages.splice(0, currentMessages.length, ...dedup.messages);
        branchSavedChars += dedup.savedChars;
        branchSavedTokens += dedup.savedTokens;
        branchCount += dedup.invalidatedCount;
      }
      if (branchSavedChars > 0) {
        savedChars += branchSavedChars;
        savedTokens += branchSavedTokens;
        durableChars += branchSavedChars;
        contextActions.push({
          kind: action.kind,
          reason: action.reason,
          count: branchCount,
          savedChars: branchSavedChars,
          savedTokens: branchSavedTokens,
        });
      }
      continue;
    }

    if (action.kind === 'elide_old_large_tool_results') {
      applyFold(action.reason);
      applyElision(action.reason);
      continue;
    }

    if (action.kind !== 'snip_tail_tool_results') continue;
    const tailSnip = snipTailOversizedToolResults(currentMessages);
    if (tailSnip.savedChars > 0) {
      currentMessages.splice(0, currentMessages.length, ...tailSnip.messages);
      savedChars += tailSnip.savedChars;
      savedTokens += tailSnip.savedTokens;
      durableChars += tailSnip.savedChars;
      contextActions.push({
        kind: action.kind,
        reason: action.reason,
        count: tailSnip.snippedCount,
        savedChars: tailSnip.savedChars,
        savedTokens: tailSnip.savedTokens,
      });
    }
  }

  for (const action of plan.actions) {
    if (action.kind !== 'microcompact') continue;
    const mcResult = microcompact(currentMessages, action.microcompactConfig);
    if (mcResult.compressedCount > 0) {
      currentMessages.splice(0, currentMessages.length, ...mcResult.messages);
      savedChars += mcResult.savedChars;
      savedTokens += mcResult.savedTokens;
      durableChars += mcResult.savedChars;
      contextActions.push({
        kind: action.kind,
        reason: action.reason,
        count: mcResult.compressedCount,
        savedChars: mcResult.savedChars,
        savedTokens: mcResult.savedTokens,
      });
    }
  }

  if (contextActions.length > 0) {
    push({
      type: 'context_action',
      reason: plan.reason,
      actions: contextActions,
      savedChars,
      savedTokens,
    });
  }

  return { savedChars, savedTokens, durableChars };
}
