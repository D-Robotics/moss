
















import type { LLMMessage, LLMContentBlock } from '../llm/llm-provider.js';
import { stripThinkingTagsKeepVisible } from '../llm/inline-thinking-stream.js';
import {
  CHINESE_PLAN_NEGATION_BEFORE_RE,
  CHINESE_PLAN_TOOL_INVOCATION_RE,
  NOISE_PLANNED_TOOL_NAMES,
} from '../../prompts/plan-detection.js';


type MessageLike = { role: string; content: unknown };









export function extractThinkingTagBodies(raw: string): string {
  const s = String(raw || '');
  if (!s.trim()) return '';
  const re =
    /<(?:thinking|redacted_thinking|think)(?:\s[^>]*)?>([\s\S]*?)<\/(?:thinking|redacted_thinking|think)>/gi;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const inner = m[1]?.trim();
    if (inner) parts.push(inner);
  }
  return parts.join('\n');
}

function joinAssistantTextBlocks(last: LLMMessage): string {
  if (typeof last.content === 'string') return last.content;
  return (last.content as LLMContentBlock[])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}








export function lastMessageNeedsToolFollowUp(messages: readonly MessageLike[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return false;
  if (typeof last.content === 'string') return false;
  return (last.content as LLMContentBlock[]).some((b) => b && b.type === 'tool_result');
}










export function hasToolResultAfterLastAssistant(messages: readonly MessageLike[]): boolean {
  return lastMessageNeedsToolFollowUp(messages);
}









export function shouldSuppressReasoningForToolFollowUpRound(
  messages: readonly MessageLike[]
): boolean {
  return hasToolResultAfterLastAssistant(messages);
}



export interface FollowUpPattern {
  
  pattern: RegExp;
  
  expectedTool: string;
  
  guidance: string;
}

export interface TextActionFollowUp {
  matchedPattern: string;
  expectedTool: string;
  guidance: string;
}





export function hasCompletedToolCallRecently(
  messages: LLMMessage[],
  toolName: string,
  lookback = 12
): boolean {
  const start = Math.max(0, messages.length - lookback);
  for (let i = messages.length - 2; i >= start; i--) {
    const userMsg = messages[i];
    if (userMsg.role !== 'user' || typeof userMsg.content === 'string') continue;
    const ublocks = userMsg.content as LLMContentBlock[];
    if (!ublocks.some((b) => b.type === 'tool_result')) continue;
    const asst = messages[i - 1];
    if (!asst || asst.role !== 'assistant' || typeof asst.content === 'string') continue;
    const used = (asst.content as LLMContentBlock[]).some(
      (b): b is Extract<LLMContentBlock, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === toolName
    );
    if (used) return true;
  }
  return false;
}

















export function extractPlannedToolNamesFromChineseText(text: string): string[] {
  if (text.length > 800) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(
    CHINESE_PLAN_TOOL_INVOCATION_RE.source,
    CHINESE_PLAN_TOOL_INVOCATION_RE.flags
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const low = raw.toLowerCase();
    if (NOISE_PLANNED_TOOL_NAMES.has(low)) continue;
    if (low.length < 3) continue;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (CHINESE_PLAN_NEGATION_BEFORE_RE.test(before)) continue;
    if (!seen.has(low)) {
      seen.add(low);
      out.push(raw);
    }
  }
  return out;
}

const DEFAULT_PATTERNS: FollowUpPattern[] = [
  {
    pattern: /(?:let me|i(?:'ll| will)|going to)\s+(?:run|execute|exec)\b/i,
    expectedTool: 'exec',
    guidance:
      'You described running a command but did not use a tool. Please use the appropriate exec tool to actually execute it.',
  },
  {
    pattern:
      /(?:let me|i(?:'ll| will)|going to)\s+(?:read|check|look at|open)\s+(?:the\s+)?(?:file|content)/i,
    expectedTool: 'read',
    guidance:
      'You described reading a file but did not use a tool. Please use the read/file tool to retrieve the content.',
  },
  {
    pattern:
      /(?:let me|i(?:'ll| will)|going to)\s+(?:write|create|save|update)\s+(?:the\s+)?(?:file|config)/i,
    expectedTool: 'write',
    guidance:
      'You described writing a file but did not use a tool. Please use the write/edit tool to make the change.',
  },
];







export function detectUnexecutedToolIntents(
  messages: LLMMessage[],
  extraPatterns?: FollowUpPattern[],
  maxFollowUps = 1
): TextActionFollowUp[] {
  if (messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (last.role !== 'assistant') return [];

  const hasToolUse =
    typeof last.content !== 'string' &&
    (last.content as LLMContentBlock[]).some((b) => b.type === 'tool_use');
  if (hasToolUse) return [];

  let text =
    typeof last.content === 'string'
      ? stripThinkingTagsKeepVisible(last.content)
      : (last.content as LLMContentBlock[])
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .map((t) => stripThinkingTagsKeepVisible(t))
          .join('\n');

  




  if (!text.trim()) {
    const rawJoined = joinAssistantTextBlocks(last);
    const thinkingOnly = extractThinkingTagBodies(rawJoined);
    if (thinkingOnly.trim()) {
      text = thinkingOnly;
    }
  }

  if (!text.trim()) return [];

  const patterns = [...DEFAULT_PATTERNS, ...(extraPatterns ?? [])];
  const results: TextActionFollowUp[] = [];

  for (const p of patterns) {
    if (results.length >= maxFollowUps) break;
    if (!p.pattern.test(text)) continue;
    if (hasCompletedToolCallRecently(messages, p.expectedTool)) continue;
    results.push({
      matchedPattern: p.pattern.source,
      expectedTool: p.expectedTool,
      guidance: p.guidance,
    });
  }

  for (const toolName of extractPlannedToolNamesFromChineseText(text)) {
    if (results.length >= maxFollowUps) break;
    if (hasCompletedToolCallRecently(messages, toolName)) continue;
    if (results.some((r) => r.expectedTool === toolName)) continue;
    results.push({
      matchedPattern: 'chinese-plan-tool-invoke',
      expectedTool: toolName,
      guidance:
        `You planned to call ${toolName} in text but did not emit a tool call. ` +
        `Invoke ${toolName} now with valid JSON arguments per its schema. Do not repeat the plan.`,
    });
  }

  return results;
}

export interface FollowUpGuardConfig {
  enabled: boolean;
  
  extraPatterns?: FollowUpPattern[];
  
  maxFollowUps?: number;
}

export const DEFAULT_FOLLOW_UP_GUARD_CONFIG: FollowUpGuardConfig = {
  enabled: true,
  maxFollowUps: 1,
};
