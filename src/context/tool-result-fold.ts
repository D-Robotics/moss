/**
 * Fold older tool results into a one-line summary at a checkpoint.
 *
 * The pending batch (every tool result after the latest assistant message)
 * and the most recent completed results stay in full. A fold rewrites
 * history, so it runs only when at least `minBatch` unfolded results sit
 * outside that window, and it folds that whole batch at once. Later passes
 * leave folded text byte-identical: the next few results are append-only and
 * the prompt-cache prefix holds.
 */
import type { ContentBlock, Message } from '../contracts/messages.js';
import { estimateTokensForText } from './tokens.js';
import { TOOL_RESULT_ELIDED_MARKER } from './tool-result-elision.js';

export const TOOL_RESULT_FOLDED_MARKER = '[earlier tool result folded';

export interface ToolResultFoldConfig {
  /** Completed results to keep in full, newest first. */
  keepRecent: number;
  /** Only results at least this long are folded. */
  minChars: number;
  /**
   * Do not fold until this many unfolded results sit outside the recent
   * window. One checkpoint, then the prefix stays stable until the next batch.
   */
  minBatch: number;
  excerptChars: number;
}

export const DEFAULT_TOOL_RESULT_FOLD: ToolResultFoldConfig = {
  keepRecent: 2,
  minChars: 600,
  minBatch: 3,
  excerptChars: 180,
};

export interface ToolResultFoldResult {
  messages: Message[];
  foldedCount: number;
  savedChars: number;
  savedTokens: number;
}

function toolResultText(block: ContentBlock): string | undefined {
  if (block.type !== 'tool_result') return undefined;
  if (typeof block.content === 'string') return block.content;
  return undefined;
}

function alreadyCompacted(text: string): boolean {
  return text.includes(TOOL_RESULT_FOLDED_MARKER) || text.includes(TOOL_RESULT_ELIDED_MARKER);
}

function foldStub(name: string | undefined, raw: string, excerptChars: number): string {
  const who = name?.trim() || 'tool';
  const first = raw.split('\n').find((line) => line.trim().length > 0) ?? '';
  const excerpt = first.replace(/\s+/g, ' ').trim().slice(0, excerptChars);
  const body = excerpt.length > 0 ? `\n${excerpt}` : '';
  return `${TOOL_RESULT_FOLDED_MARKER}: ${who}, ${raw.length} chars]${body}`;
}

export function foldOlderToolResults(
  messages: Message[],
  config: Partial<ToolResultFoldConfig> = {}
): ToolResultFoldResult {
  const cfg = { ...DEFAULT_TOOL_RESULT_FOLD, ...config };
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }

  const candidates: Array<{ msgIdx: number; blockIdx: number }> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    if (mi > lastAssistant && lastAssistant !== -1) break;
    const msg = messages[mi];
    if (!msg || typeof msg.content === 'string') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (!block) continue;
      const text = toolResultText(block);
      if (text === undefined) continue;
      if (alreadyCompacted(text)) continue;
      if (text.length < cfg.minChars) continue;
      candidates.push({ msgIdx: mi, blockIdx: bi });
    }
  }

  const beyond = candidates.slice(0, Math.max(0, candidates.length - cfg.keepRecent));
  if (beyond.length < cfg.minBatch) {
    return { messages, foldedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  const keys = new Set(beyond.map((row) => `${row.msgIdx}:${row.blockIdx}`));
  let savedChars = 0;
  let savedTokens = 0;
  let foldedCount = 0;
  const next = messages.map((msg, mi) => {
    if (typeof msg.content === 'string') return msg;
    let changed = false;
    const content = msg.content.map((block, bi) => {
      if (!keys.has(`${mi}:${bi}`) || block.type !== 'tool_result') return block;
      const raw = typeof block.content === 'string' ? block.content : '';
      const stub = foldStub(block.name, raw, cfg.excerptChars);
      if (stub.length >= raw.length) return block;
      changed = true;
      foldedCount += 1;
      savedChars += raw.length - stub.length;
      savedTokens += Math.max(0, estimateTokensForText(raw) - estimateTokensForText(stub));
      return { ...block, content: stub };
    });
    return changed ? { ...msg, content } : msg;
  });
  if (foldedCount === 0) {
    return { messages, foldedCount: 0, savedChars: 0, savedTokens: 0 };
  }
  return { messages: next, foldedCount, savedChars, savedTokens };
}
