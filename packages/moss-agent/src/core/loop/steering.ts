













import type { LLMMessage, LLMContentBlock } from '../llm/llm-provider.js';

export interface SteeringContext {
  messages: LLMMessage[];
  turn: number;
  consecutiveToolErrors: number;
  totalToolCalls: number;
  
  contextUsageRatio: number;
  sessionKey: string;
}

export interface SteeringRule {
  id: string;
  priority: number;
  cooldownTurns: number;
  check(ctx: SteeringContext): string | null;
}

export interface SteeringResult {
  triggered: boolean;
  
  guidances: string[];
  
  firedRules: string[];
}



const CONSECUTIVE_ERROR_THRESHOLD = 3;
const TOOL_LOOP_THRESHOLD = 8;
const CONTEXT_PRESSURE_RATIO = 0.75;

export const BUILTIN_ERROR_RECOVERY_RULE: SteeringRule = {
  id: 'error-recovery',
  priority: 10,
  cooldownTurns: 4,
  check(ctx) {
    if (ctx.consecutiveToolErrors < CONSECUTIVE_ERROR_THRESHOLD) return null;
    return [
      '[Steering] Multiple consecutive tool errors detected.',
      'Stop retrying the same preset tool path. First verify the command/path/arguments, then pivot to an independent evidence source:',
      'available Web tools such as web_fetch for public facts, local files/knowledge for product context, lower-level device commands for board state,',
      'or a simpler diagnostic tool. Ask the user only when the missing decision cannot be inferred.',
    ].join(' ');
  },
};

export const BUILTIN_TOOL_LOOP_RULE: SteeringRule = {
  id: 'tool-loop',
  priority: 20,
  cooldownTurns: 6,
  check(ctx) {
    if (ctx.turn < TOOL_LOOP_THRESHOLD) return null;
    const recentAssistant = ctx.messages.slice(-12).filter((m) => m.role === 'assistant');
    const allToolUse = recentAssistant.every((m) => {
      if (typeof m.content === 'string') return false;
      return (m.content as LLMContentBlock[]).some((b) => b.type === 'tool_use');
    });
    if (!allToolUse || recentAssistant.length < 4) return null;
    return [
      '[Steering] Extended tool loop detected — you have been executing tools for many turns.',
      'Pause the current tool chain and summarize what evidence is already known.',
      'If the preset tool path is not working, switch to a different source of evidence before asking the user how to proceed.',
    ].join(' ');
  },
};

export const BUILTIN_CONTEXT_PRESSURE_RULE: SteeringRule = {
  id: 'context-pressure',
  priority: 30,
  cooldownTurns: 10,
  check(ctx) {
    // Suppress when the ratio exceeds 100%. A ratio > 1.0 means either the
    // context window was not probed (we fell back to the conservative 32k
    // default, so a normal ~40k-token system prompt already reads as "125%
    // full") or the context genuinely overflowed. In both cases "be concise"
    // is the wrong action: the first is a stale estimate that compaction
    // cannot fix by trimming history (the system prompt itself exceeds the
    // reported window), and the second is handled by the overflow/compaction
    // path. Firing steering here wastes a turn on every simple query for
    // users of providers that don't expose context length via /v1/models
    // (e.g. deepseek). Only nudge when the ratio is genuinely high but
    // still within the believable 75–100% band.
    if (ctx.contextUsageRatio < CONTEXT_PRESSURE_RATIO) return null;
    if (ctx.contextUsageRatio > 1) return null;
    const pct = Math.round(ctx.contextUsageRatio * 100);
    return [
      `[Steering] Context window is ${pct}% full.`,
      'Be concise in your responses. Summarize tool outputs instead of echoing them.',
      'Consider completing the current task and providing a summary.',
    ].join(' ');
  },
};










export const BUILTIN_WEB_SEARCH_VARIATION_RULE: SteeringRule = {
  id: 'web-search-variation',
  priority: 15,
  cooldownTurns: 5,
  check(ctx) {
    const recent = ctx.messages.slice(-20);
    const queries: string[] = [];
    for (const m of recent) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type === 'tool_use' && b.name === 'web_search') {
          const q = String(b.input?.query ?? '').trim().toLowerCase();
          if (q) queries.push(q);
        }
      }
    }
    const distinct = new Set(queries);
    if (distinct.size < 3) return null;
    return [
      `[Steering] You have already run web_search ${queries.length} time(s) with ${distinct.size} different queries in this turn.`,
      'If the results were relevant, pick the best URL and call web_fetch on it now.',
      'If the results were irrelevant or empty, do NOT keep trying query variations — instead call web_fetch on a known or likely official URL directly, or answer with what you already know.',
      'Only search again if you need a genuinely different topic, not a rephrase of the same query.',
    ].join(' ');
  },
};

export const BUILTIN_LOCAL_EXPLORATION_LOOP_RULE: SteeringRule = {
  id: 'local-exploration-loop',
  priority: 14,
  cooldownTurns: 5,
  check(ctx) {
    const recent = ctx.messages.slice(-16);
    const paths: string[] = [];
    for (const message of recent) {
      if (message.role !== 'assistant' || typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'search_code' && block.name !== 'list_directory') continue;
        const target = String(block.input?.path ?? '').trim().replace(/\\/g, '/');
        if (target) paths.push(target);
      }
    }
    if (paths.length < 3) return null;
    const counts = new Map<string, number>();
    for (const target of paths) counts.set(target, (counts.get(target) ?? 0) + 1);
    const repeated = [...counts.entries()].find(([, count]) => count >= 3);
    if (!repeated) return null;
    return [
      `[Steering] Repeated local exploration detected: ${repeated[1]} calls targeted the same local path (${repeated[0]}).`,
      'Stop issuing more search_code/list_directory variations on that path.',
      'Summarize what is already known, then use read_file on the exact relevant range, inspect a caller/test, or switch to a different evidence source.',
    ].join(' ');
  },
};

export const DEFAULT_STEERING_RULES: SteeringRule[] = [
  BUILTIN_ERROR_RECOVERY_RULE,
  BUILTIN_LOCAL_EXPLORATION_LOOP_RULE,
  BUILTIN_WEB_SEARCH_VARIATION_RULE,
  BUILTIN_TOOL_LOOP_RULE,
  BUILTIN_CONTEXT_PRESSURE_RULE,
];



export class SteeringEngine {
  private rules: SteeringRule[];
  private lastFiredTurn = new Map<string, number>();

  constructor(rules?: SteeringRule[]) {
    this.rules = [...(rules ?? DEFAULT_STEERING_RULES)].sort((a, b) => a.priority - b.priority);
  }

  addRule(rule: SteeringRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  evaluate(ctx: SteeringContext): SteeringResult {
    const guidances: string[] = [];
    const firedRules: string[] = [];

    for (const rule of this.rules) {
      const lastFired = this.lastFiredTurn.get(rule.id) ?? -Infinity;
      if (ctx.turn - lastFired < rule.cooldownTurns) continue;

      const guidance = rule.check(ctx);
      if (guidance) {
        guidances.push(guidance);
        firedRules.push(rule.id);
        this.lastFiredTurn.set(rule.id, ctx.turn);
      }
    }

    return {
      triggered: guidances.length > 0,
      guidances,
      firedRules,
    };
  }

  reset(): void {
    this.lastFiredTurn.clear();
  }
}
