













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
    if (ctx.contextUsageRatio < CONTEXT_PRESSURE_RATIO) return null;
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
    if (distinct.size < 2) return null;
    return [
      `[Steering] You have already run web_search ${queries.length} time(s) with ${distinct.size} different queries in this turn.`,
      'The first search almost certainly returned the relevant results — re-searching the same topic with synonym variations rarely improves them and wastes the turn.',
      'Pick the most relevant result URL from the searches already done and call web_fetch on it, or answer with the evidence already gathered.',
      'Only search again if you need a genuinely different topic, not a rephrase of the same query.',
    ].join(' ');
  },
};

export const DEFAULT_STEERING_RULES: SteeringRule[] = [
  BUILTIN_ERROR_RECOVERY_RULE,
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
