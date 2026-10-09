/**
 * Replace old large tool results with a short head/tail stub.
 *
 * The pending batch — every tool result after the latest assistant message —
 * stays intact, so a follow-up turn still sees the results it must answer.
 * Small results stay intact so multi-file recall is not wiped. Once a result
 * is stubbed, later passes leave the stub alone, so the prefix stops changing.
 */
import type { ContentBlock, Message } from '../contracts/messages.js';
import { estimateTokensForText } from './tokens.js';

export const TOOL_RESULT_ELIDED_MARKER = '[earlier tool result elided';

export interface ToolResultElisionConfig {
  /** Large results before the pending batch to keep in full, newest first. */
  keepRecent: number;
  /** Only results at least this long are elided. */
  minChars: number;
  headChars: number;
  tailChars: number;
}

export const DEFAULT_TOOL_RESULT_ELISION: ToolResultElisionConfig = {
  keepRecent: 3,
  minChars: 8_000,
  headChars: 400,
  tailChars: 240,
};

export interface ToolResultElisionResult {
  messages: Message[];
  elidedCount: number;
  savedChars: number;
  savedTokens: number;
}

function toolResultText(block: ContentBlock): string | undefined {
  if (block.type !== 'tool_result') return undefined;
  if (typeof block.content === 'string') return block.content;
  return undefined;
}

function elisionStub(name: string | undefined, raw: string, cfg: ToolResultElisionConfig): string {
  const head = raw.slice(0, cfg.headChars);
  const tail = raw.slice(raw.length - cfg.tailChars);
  const who = name?.trim() || 'tool';
  return (
    `${head}\n${TOOL_RESULT_ELIDED_MARKER}: ${who}, kept ${cfg.headChars}+${cfg.tailChars} of ${raw.length} chars. ` +
    `Re-call the tool for the omitted middle.]\n${tail}`
  );
}

export function elideOldLargeToolResults(
  messages: Message[],
  config: Partial<ToolResultElisionConfig> = {}
): ToolResultElisionResult {
  const cfg = { ...DEFAULT_TOOL_RESULT_ELISION, ...config };
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }

  const candidates: Array<{ msgIdx: number; blockIdx: number; content: string; name?: string }> =
    [];
  for (let mi = 0; mi < messages.length; mi++) {
    if (mi > lastAssistant && lastAssistant !== -1) break;
    const msg = messages[mi];
    if (!msg || typeof msg.content === 'string') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (!block) continue;
      const text = toolResultText(block);
      if (text === undefined) continue;
      if (text.includes(TOOL_RESULT_ELIDED_MARKER)) continue;
      if (text.length < cfg.minChars) continue;
      candidates.push({
        msgIdx: mi,
        blockIdx: bi,
        content: text,
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
      });
    }
  }

  const elide = candidates.slice(0, Math.max(0, candidates.length - cfg.keepRecent));
  if (elide.length === 0) {
    return { messages, elidedCount: 0, savedChars: 0, savedTokens: 0 };
  }
  const keys = new Set(elide.map((row) => `${row.msgIdx}:${row.blockIdx}`));
  let savedChars = 0;
  let savedTokens = 0;
  let elidedCount = 0;
  const next = messages.map((msg, mi) => {
    if (typeof msg.content === 'string') return msg;
    let changed = false;
    const content = msg.content.map((block, bi) => {
      if (!keys.has(`${mi}:${bi}`) || block.type !== 'tool_result') return block;
      const raw = typeof block.content === 'string' ? block.content : '';
      const stub = elisionStub(block.name, raw, cfg);
      if (stub.length >= raw.length) return block;
      changed = true;
      elidedCount += 1;
      savedChars += raw.length - stub.length;
      savedTokens += Math.max(0, estimateTokensForText(raw) - estimateTokensForText(stub));
      return { ...block, content: stub };
    });
    return changed ? { ...msg, content } : msg;
  });
  if (elidedCount === 0) {
    return { messages, elidedCount: 0, savedChars: 0, savedTokens: 0 };
  }
  return { messages: next, elidedCount, savedChars, savedTokens };
}
