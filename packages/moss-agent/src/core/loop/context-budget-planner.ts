import type { MicroCompactConfig } from '../../context/microcompact.js';
import {
  getContextWarningThreshold,
  getProactiveCompactThreshold,
} from '../../context/window-economics.js';

export type ContextBudgetActionKind =
  | 'invalidate_stale_reads'
  | 'snip_tail_tool_results'
  | 'microcompact'
  | 'llm_summarize'
  | 'compaction_fuse'
  | 'emergency_truncate';

export type ContextBudgetActionReason =
  | 'first_turn'
  | 'tool_followup_round'
  | 'baseline_hygiene'
  | 'warning_threshold'
  | 'proactive_threshold'
  | 'overflow_recovery';

export interface ContextBudgetAction {
  kind: ContextBudgetActionKind;
  reason: ContextBudgetActionReason;
  microcompactConfig?: Partial<MicroCompactConfig>;
}

export interface ContextBudgetPlannerInput {
  estimatedPromptTokens: number;
  effectiveContextWindowTokens: number;
  isToolFollowUpRound: boolean;
  turn: number;
}

export interface ContextBudgetPlan {
  actions: ContextBudgetAction[];
  reason: ContextBudgetActionReason;
  warningThreshold: number;
  proactiveThreshold: number;
}

export function planContextBudgetActions(input: ContextBudgetPlannerInput): ContextBudgetPlan {
  const warningThreshold = getContextWarningThreshold(input.effectiveContextWindowTokens);
  const proactiveThreshold = getProactiveCompactThreshold(input.effectiveContextWindowTokens);

  if (input.turn <= 1) {
    return {
      actions: [],
      reason: 'first_turn',
      warningThreshold,
      proactiveThreshold,
    };
  }

  if (input.isToolFollowUpRound) {
    return {
      actions: [{ kind: 'invalidate_stale_reads', reason: 'tool_followup_round' }],
      reason: 'tool_followup_round',
      warningThreshold,
      proactiveThreshold,
    };
  }

  const actions: ContextBudgetAction[] = [
    { kind: 'invalidate_stale_reads', reason: 'baseline_hygiene' },
  ];

  const pressureReason: ContextBudgetActionReason =
    input.estimatedPromptTokens >= proactiveThreshold - 2_500
      ? 'proactive_threshold'
      : input.estimatedPromptTokens >= warningThreshold
        ? 'warning_threshold'
        : 'baseline_hygiene';

  if (input.estimatedPromptTokens >= warningThreshold) {
    actions.push({
      kind: 'snip_tail_tool_results',
      reason:
        pressureReason === 'proactive_threshold' ? 'proactive_threshold' : 'warning_threshold',
    });
  }

  if (pressureReason === 'warning_threshold' || pressureReason === 'proactive_threshold') {
    actions.push({
      kind: 'microcompact',
      reason: pressureReason,
      microcompactConfig:
        pressureReason === 'proactive_threshold'
          ? { keepRecentResults: 2, minContentLength: 50 }
          : { keepRecentResults: 4, minContentLength: 100 },
    });
  }

  return {
    actions,
    reason: pressureReason,
    warningThreshold,
    proactiveThreshold,
  };
}
