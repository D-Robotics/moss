/**
 * Model Complexity Router — auto-selects the best model for each task.
 *
 * Routes requests to the appropriate model tier based on:
 *   1. Task complexity (simple query → cheap model, complex task → strong model)
 *   2. Cost budget (daily/task token limits, auto-downgrade on budget exhaustion)
 *   3. Latency preference (interactive → fast model, background → powerful model)
 *   4. Subagent type (explore → cheap, verify → strong, read-only → cheap)
 *
 * Configuration via environment variables:
 *   MOSS_MODEL_ROUTING=on|off          Enable/disable (default: on)
 *   MOSS_BUDGET_DAILY=1000000          Daily token budget (default: 1M)
 *   MOSS_BUDGET_TASK=200000            Per-task token budget (default: 200K)
 *   MOSS_CHEAP_MODEL=<model_id>        Fast/cheap model (default: provider's flash model)
 *   MOSS_BALANCED_MODEL=<model_id>     Balanced model (default: provider's default)
 *   MOSS_STRONG_MODEL=<model_id>       Strong model (default: provider's default)
 */

import type { LLMRequestOptions } from '../core/llm/llm-provider.js';

// ── Model Tiers ────────────────────────────────────────────────────────────

export type ModelTier = 'fast' | 'balanced' | 'strong';

export interface ModelTierConfig {
  tier: ModelTier;
  /** Model ID for this tier (provider-specific) */
  modelId: string;
  /** Approximate cost per 1M input tokens */
  costPer1MInput: number;
  /** Approximate cost per 1M output tokens */
  costPer1MOutput: number;
  /** Typical latency tier */
  latency: 'low' | 'medium' | 'high';
}

export interface RoutingConfig {
  enabled: boolean;
  /** Model per tier */
  tiers: Record<ModelTier, ModelTierConfig>;
  /** Daily token budget (0 = unlimited) */
  dailyBudget: number;
  /** Per-task token budget (0 = unlimited) */
  taskBudget: number;
  /** Tokens consumed today */
  dailyConsumed: number;
  /** Default tier when no signals are strong enough */
  defaultTier: ModelTier;
}

// ── Task Complexity Signals ────────────────────────────────────────────────

export interface TaskSignals {
  /** Estimated input token count */
  inputTokens: number;
  /** Number of tools available */
  toolCount: number;
  /** Whether the task involves coding */
  isCoding: boolean;
  /** Whether the task involves multi-step planning */
  isPlanning: boolean;
  /** Whether the task is a subagent */
  isSubagent: boolean;
  /** Subagent scope type */
  subagentScope?: string;
  /** Whether this is an interactive (user-facing) request */
  isInteractive: boolean;
  /** System prompt complexity indicator */
  systemPromptLength: number;
}

// ── Complexity Scoring ─────────────────────────────────────────────────────

const CODING_KEYWORDS = [
  'code', 'function', 'class', 'import', 'export', 'type', 'interface',
  'implement', 'refactor', 'debug', 'fix', 'bug', 'test', 'build',
  'compile', 'deploy', 'api', 'endpoint', 'route', 'component',
  'react', 'vue', 'angular', 'node', 'python', 'rust', 'go', 'java',
  'database', 'sql', 'query', 'migration', 'schema',
];

const PLANNING_KEYWORDS = [
  'plan', 'design', 'architect', 'system', 'structure', 'pattern',
  'strategy', 'approach', 'roadmap', 'migration', 'upgrade',
  'refactor', 'restructure', 'reorganize',
];

/**
 * Score task complexity from 0 (trivial) to 100 (extremely complex).
 */
export function scoreTaskComplexity(signals: TaskSignals): number {
  let score = 0;

  // 1. Input size (0-30 points)
  if (signals.inputTokens > 100_000) score += 30;
  else if (signals.inputTokens > 50_000) score += 25;
  else if (signals.inputTokens > 20_000) score += 20;
  else if (signals.inputTokens > 10_000) score += 15;
  else if (signals.inputTokens > 5_000) score += 10;
  else if (signals.inputTokens > 1_000) score += 5;

  // 2. Tool count (0-20 points) — more tools = more complex
  if (signals.toolCount > 20) score += 20;
  else if (signals.toolCount > 10) score += 15;
  else if (signals.toolCount > 5) score += 10;
  else if (signals.toolCount > 0) score += 5;

  // 3. Task type (0-30 points)
  if (signals.isCoding) score += 15;
  if (signals.isPlanning) score += 15;

  // 4. System prompt complexity (0-10 points)
  if (signals.systemPromptLength > 10_000) score += 10;
  else if (signals.systemPromptLength > 5_000) score += 5;
  else if (signals.systemPromptLength > 2_000) score += 3;

  // 5. Subagent adjustments
  if (signals.isSubagent) {
    // Subagents typically need less power
    if (signals.subagentScope === 'explore' || signals.subagentScope === 'read-only') {
      score = Math.max(0, score - 20);
    } else if (signals.subagentScope === 'verify') {
      score = Math.max(0, score - 10);
    }
    // 'plan' and 'full' subagents keep their score
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Detect task signals from the request content.
 */
export function detectTaskSignals(
  messages: LLMRequestOptions['messages'],
  tools: LLMRequestOptions['tools'],
  systemPrompt?: string,
  subagentScope?: string,
): TaskSignals {
  // Estimate input tokens (rough: 1 token ≈ 4 chars)
  let totalChars = 0;
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    totalChars += content.length;
  }
  const inputTokens = Math.ceil(totalChars / 4);

  const toolCount = tools?.length ?? 0;

  // Check for coding/planning keywords in the last user message
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUserMsg
    ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
    : '';
  const lowerText = userText.toLowerCase();

  const isCoding = CODING_KEYWORDS.some((kw) => lowerText.includes(kw));
  const isPlanning = PLANNING_KEYWORDS.some((kw) => lowerText.includes(kw));

  // If it looks simple AND not coding/planning, it's probably simple
  const isInteractive = true; // CLI is always interactive

  return {
    inputTokens,
    toolCount,
    isCoding,
    isPlanning,
    isSubagent: !!subagentScope,
    subagentScope,
    isInteractive,
    systemPromptLength: systemPrompt?.length ?? 0,
  };
}

// ── Router ─────────────────────────────────────────────────────────────────

export class ModelComplexityRouter {
  private config: RoutingConfig;

  constructor(config?: Partial<RoutingConfig>) {
    this.config = {
      enabled: process.env.MOSS_MODEL_ROUTING !== 'off',
      tiers: {
        fast: {
          tier: 'fast',
          modelId: process.env.MOSS_CHEAP_MODEL || '',
          costPer1MInput: 0.5,
          costPer1MOutput: 2,
          latency: 'low',
        },
        balanced: {
          tier: 'balanced',
          modelId: process.env.MOSS_BALANCED_MODEL || '',
          costPer1MInput: 3,
          costPer1MOutput: 15,
          latency: 'medium',
        },
        strong: {
          tier: 'strong',
          modelId: process.env.MOSS_STRONG_MODEL || '',
          costPer1MInput: 5,
          costPer1MOutput: 25,
          latency: 'high',
        },
      },
      dailyBudget: Number(process.env.MOSS_BUDGET_DAILY) || 1_000_000,
      taskBudget: Number(process.env.MOSS_BUDGET_TASK) || 200_000,
      dailyConsumed: 0,
      defaultTier: 'balanced',
      ...config,
    };
  }

  /**
   * Select the best model tier for a task.
   * Returns the model ID to use.
   */
  selectModel(
    messages: LLMRequestOptions['messages'],
    tools?: LLMRequestOptions['tools'],
    systemPrompt?: string,
    subagentScope?: string,
  ): { modelId: string; tier: ModelTier; reason: string } {
    if (!this.config.enabled) {
      return {
        modelId: this.config.tiers.balanced.modelId,
        tier: 'balanced',
        reason: 'routing disabled',
      };
    }

    const signals = detectTaskSignals(messages, tools, systemPrompt, subagentScope);
    const complexity = scoreTaskComplexity(signals);

    // Budget check — if daily budget exhausted, force cheap model
    if (this.config.dailyBudget > 0 && this.config.dailyConsumed >= this.config.dailyBudget) {
      return {
        modelId: this.config.tiers.fast.modelId,
        tier: 'fast',
        reason: 'daily budget exhausted',
      };
    }

    // Task budget check — large tasks get balanced at minimum
    if (this.config.taskBudget > 0 && signals.inputTokens > this.config.taskBudget * 0.5) {
      return {
        modelId: this.config.tiers.balanced.modelId,
        tier: 'balanced',
        reason: `task size (${signals.inputTokens} tokens) exceeds 50% of task budget`,
      };
    }

    // Complexity-based routing
    let tier: ModelTier;
    let reason: string;

    if (complexity >= 60) {
      tier = 'strong';
      reason = `high complexity (${complexity}/100): ${signals.isCoding ? 'coding' : ''} ${signals.isPlanning ? 'planning' : ''}`.trim();
    } else if (complexity >= 30) {
      tier = 'balanced';
      reason = `moderate complexity (${complexity}/100)`;
    } else if (complexity >= 10) {
      tier = 'balanced';
      reason = `low-moderate complexity (${complexity}/100)`;
    } else {
      tier = 'fast';
      reason = `simple task (${complexity}/100)`;
    }

    // Subagent overrides
    if (signals.isSubagent) {
      if (signals.subagentScope === 'explore' || signals.subagentScope === 'read-only') {
        tier = 'fast';
        reason = `subagent (${signals.subagentScope}) → fast model`;
      } else if (signals.subagentScope === 'verify') {
        tier = 'strong';
        reason = 'verify subagent → strong model';
      }
    }

    // Interactive latency preference
    if (signals.isInteractive && tier === 'strong' && complexity < 80) {
      tier = 'balanced';
      reason = `interactive → balanced (was strong for ${complexity}/100)`;
    }

    const modelId = this.config.tiers[tier].modelId;
    return { modelId: modelId || this.config.tiers.balanced.modelId, tier, reason };
  }

  /**
   * Record token consumption for budget tracking.
   */
  recordConsumption(inputTokens: number, outputTokens: number): void {
    this.config.dailyConsumed += inputTokens + outputTokens;
  }

  /**
   * Reset daily budget counter.
   */
  resetDailyBudget(): void {
    this.config.dailyConsumed = 0;
  }

  /**
   * Get current routing configuration.
   */
  getConfig(): Readonly<RoutingConfig> {
    return this.config;
  }

  /**
   * Get estimated cost for a model tier.
   */
  estimateCost(tier: ModelTier, inputTokens: number, outputTokens: number): number {
    const t = this.config.tiers[tier];
    return (inputTokens / 1_000_000) * t.costPer1MInput + (outputTokens / 1_000_000) * t.costPer1MOutput;
  }
}

/** Global singleton */
export const globalModelRouter = new ModelComplexityRouter();