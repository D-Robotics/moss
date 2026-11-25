export {
  runAgentLoop,
  lastMessageNeedsToolFollowUpLlm,
  resolveEffectiveCaps,
} from './agent-loop.js';
export type {
  AgentLoopDeps,
  AgentLoopExtensions,
  AgentLoopHardCaps,
  AgentLoopIdentity,
  AgentLoopParams,
  AgentLoopPlatformConfig,
  AgentLoopPolicy,
  AgentLoopPromptInput,
  AgentLoopProviderInput,
  AgentLoopToolInput,
} from './agent-loop.js';
export { resolveRoutedModel } from './agent-loop-types.js';
export type { ModelTiers, AgentLoopEventObserver } from './agent-loop-types.js';
export { PendingToolAbortStore } from './pending-tool-aborts.js';
export { CompactHookRegistry, buildCompactionCheckpointOutline } from './compact-hooks.js';
export type {
  CompactReason,
  PreCompactContext,
  PostCompactContext,
  PreCompactHook,
  PostCompactHook,
} from './compact-hooks.js';
export { planContextBudgetActions } from './context-budget-planner.js';
export type {
  ContextBudgetAction,
  ContextBudgetActionKind,
  ContextBudgetActionReason,
  ContextBudgetPlan,
  ContextBudgetPlannerInput,
} from './context-budget-planner.js';
export {
  lastMessageNeedsToolFollowUp,
  hasToolResultAfterLastAssistant,
} from '../../provider/reasoning-policy.js';
