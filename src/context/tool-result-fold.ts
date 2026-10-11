/**
 * Fold older tool results into a short head/tail stub.
 *
 * The pending batch (every tool result after the latest assistant message)
 * and the most recent completed results stay in full. A fold rewrites every
 * byte from the first folded message through the end of the cached prefix, so
 * it runs only when a batch of unfolded results sits outside that window AND
 * the cache-price inequality pays for the rewrite:
 *
 *   savedTokens * remainingRequests * readPrice
 *     > suffixTokens * (writePrice - readPrice)
 *
 * which is `savedTokens * remainingRequests >= savingsRatio * suffixTokens`
 * with savingsRatio = (write - read) / read. Anthropic sonnet/haiku is 11.5;
 * that is the gate (the strict end of the 9–11.5 band). Between folds the
 * transcript is append-only. This is not limited to context-window compaction.
 */
import type { ContentBlock, Message } from '../contracts/messages.js';
import { estimateMessagesTokens, estimateTokensForText } from './tokens.js';
import { TOOL_RESULT_ELIDED_MARKER } from './tool-result-elision.js';

export const TOOL_RESULT_FOLDED_MARKER = '[earlier tool result folded';

/**
 * (cacheWrite - cacheRead) / cacheRead for Anthropic sonnet and haiku
 * (write 3.75 / read 0.3, or write 1.25 / read 0.1).
 */
export const TOOL_RESULT_FOLD_SAVINGS_RATIO = 11.5;

/**
 * Requests the savings gate may assume are still coming.
 *
 * The estimate is how many requests this user turn has already made, capped
 * here. Five is the smallest cap that still folds a 14k page inside a
 * 12-result turn; a cap of 4 never does. The leftover turn budget (64) folded
 * 4k pages whose rewrite was not paid back.
 */
export const TOOL_RESULT_FOLD_HORIZON = 5;

/** No fold until the prompt reaches this many tokens, when the window is larger. */
export const TOOL_RESULT_FOLD_MIN_PROMPT_TOKENS = 60_000;

/** No fold until the prompt is at least this fraction of the context window. */
export const TOOL_RESULT_FOLD_CONTEXT_FRACTION = 0.5;

/**
 * Token count the prompt must reach before any fold.
 * A large window waits for half of it (and at least 60k). A window smaller
 * than 60k waits for half of that window so a fold can still run before overflow.
 */
export function toolResultFoldMinPromptTokens(contextWindowTokens: number): number {
  const windowTokens = Math.max(1, Math.floor(contextWindowTokens));
  const half = Math.max(1, Math.floor(windowTokens * TOOL_RESULT_FOLD_CONTEXT_FRACTION));
  if (windowTokens <= TOOL_RESULT_FOLD_MIN_PROMPT_TOKENS) return half;
  return Math.max(TOOL_RESULT_FOLD_MIN_PROMPT_TOKENS, half);
}

export interface ToolResultFoldConfig {
  /** Completed results to keep in full, newest first. */
  keepRecent: number;
  /** Only results at least this long are folded. */
  minChars: number;
  /**
   * Do not fold until this many unfolded results sit outside the recent
   * window. One rewrite, then the prefix stays stable until the next batch.
   */
  minBatch: number;
  headChars: number;
  tailChars: number;
  /**
   * Requests still expected after this one. The loop passes
   * min(turns, TOOL_RESULT_FOLD_HORIZON). The default is that cap, so a
   * direct call does not assume a long run.
   */
  remainingRequests: number;
  /**
   * Estimated prompt tokens. With `contextWindowTokens`, a fold is refused
   * until `toolResultFoldMinPromptTokens` is met. Omitted, the size gate is
   * not applied (callers that already checked).
   */
  promptTokens?: number;
  contextWindowTokens?: number;
  /** Minimum `savedTokens * remainingRequests / suffixTokens`. */
  savingsRatio: number;
  /** Tool names whose results stay in full (`ToolMetadata.retainResult`). */
  retainTools?: ReadonlySet<string>;
}

export const DEFAULT_TOOL_RESULT_FOLD: ToolResultFoldConfig = {
  keepRecent: 6,
  minChars: 4_000,
  minBatch: 3,
  headChars: 180,
  tailChars: 240,
  remainingRequests: TOOL_RESULT_FOLD_HORIZON,
  savingsRatio: TOOL_RESULT_FOLD_SAVINGS_RATIO,
};

export interface ToolResultFoldResult {
  messages: Message[];
  foldedCount: number;
  savedChars: number;
  savedTokens: number;
}

export function isFoldedToolResult(content: string): boolean {
  return content.includes(TOOL_RESULT_FOLDED_MARKER);
}

type FoldedResultListener = (toolName: string, input: Record<string, unknown>) => void;

const foldedResultListeners = new Set<FoldedResultListener>();

/** Called with the tool name and tool_use input of each result that was folded. */
export function setFoldedResultListener(listener: FoldedResultListener): () => void {
  foldedResultListeners.add(listener);
  return () => {
    foldedResultListeners.delete(listener);
  };
}

function notifyFoldedResult(toolName: string, input: Record<string, unknown>): void {
  for (const listener of foldedResultListeners) {
    try {
      listener(toolName, input);
    } catch {
      // A cache listener must not block the fold.
    }
  }
}

interface ToolUseRef {
  name: string;
  input: Record<string, unknown>;
}

function toolUseById(messages: Message[]): Map<string, ToolUseRef> {
  const map = new Map<string, ToolUseRef>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.id) continue;
      const input =
        block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input
          : {};
      map.set(block.id, { name: block.name ?? '', input });
    }
  }
  return map;
}

function toolResultText(block: ContentBlock): string | undefined {
  if (block.type !== 'tool_result') return undefined;
  if (typeof block.content === 'string') return block.content;
  return undefined;
}

function resultToolName(block: ContentBlock, uses: Map<string, ToolUseRef>): string {
  if (block.name && block.name.trim().length > 0) return block.name;
  if (block.tool_use_id) return uses.get(block.tool_use_id)?.name ?? '';
  return '';
}

function alreadyCompacted(text: string): boolean {
  return isFoldedToolResult(text) || text.includes(TOOL_RESULT_ELIDED_MARKER);
}

function foldStub(
  name: string | undefined,
  raw: string,
  headChars: number,
  tailChars: number
): string {
  const who = name?.trim() || 'tool';
  const head = raw.slice(0, headChars);
  const tailStart = Math.max(headChars, raw.length - tailChars);
  const tail = raw.slice(tailStart);
  const body = tail.length > 0 && tailStart > headChars ? `${head}\n…\n${tail}` : head;
  return `${TOOL_RESULT_FOLDED_MARKER}: ${who}, ${raw.length} chars]\n${body}`;
}

export function foldOlderToolResults(
  messages: Message[],
  config: Partial<ToolResultFoldConfig> = {}
): ToolResultFoldResult {
  const cfg = { ...DEFAULT_TOOL_RESULT_FOLD, ...config };
  if (
    cfg.promptTokens !== undefined &&
    cfg.contextWindowTokens !== undefined &&
    cfg.promptTokens < toolResultFoldMinPromptTokens(cfg.contextWindowTokens)
  ) {
    return { messages, foldedCount: 0, savedChars: 0, savedTokens: 0 };
  }
  const uses = toolUseById(messages);
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
      if (!block || block.is_error === true) continue;
      const text = toolResultText(block);
      if (text === undefined) continue;
      if (alreadyCompacted(text)) continue;
      if (text.length < cfg.minChars) continue;
      const name = resultToolName(block, uses);
      if (name && cfg.retainTools?.has(name)) continue;
      candidates.push({ msgIdx: mi, blockIdx: bi });
    }
  }

  const beyond = candidates.slice(0, Math.max(0, candidates.length - cfg.keepRecent));
  if (beyond.length < cfg.minBatch) {
    return { messages, foldedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  const keys = new Set(beyond.map((row) => `${row.msgIdx}:${row.blockIdx}`));
  const foldedUses: ToolUseRef[] = [];
  let savedChars = 0;
  let savedTokens = 0;
  let foldedCount = 0;
  let firstFoldIdx = messages.length;
  const next = messages.map((msg, mi) => {
    if (typeof msg.content === 'string') return msg;
    let changed = false;
    const content = msg.content.map((block, bi) => {
      if (!keys.has(`${mi}:${bi}`) || block.type !== 'tool_result') return block;
      const raw = typeof block.content === 'string' ? block.content : '';
      const name = resultToolName(block, uses);
      const stub = foldStub(name, raw, cfg.headChars, cfg.tailChars);
      if (stub.length >= raw.length) return block;
      changed = true;
      foldedCount += 1;
      savedChars += raw.length - stub.length;
      savedTokens += Math.max(0, estimateTokensForText(raw) - estimateTokensForText(stub));
      const use = block.tool_use_id ? uses.get(block.tool_use_id) : undefined;
      foldedUses.push({ name: name || use?.name || '', input: use?.input ?? {} });
      return { ...block, content: stub };
    });
    if (changed) firstFoldIdx = Math.min(firstFoldIdx, mi);
    return changed ? { ...msg, content } : msg;
  });
  if (foldedCount === 0 || savedTokens <= 0) {
    return { messages, foldedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  // L is the post-fold suffix from the first rewritten message. That suffix
  // is what a cache miss rewrites at write price instead of read price.
  const suffixTokens = estimateMessagesTokens(next.slice(firstFoldIdx));
  if (savedTokens * cfg.remainingRequests < cfg.savingsRatio * suffixTokens) {
    return { messages, foldedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  for (const use of foldedUses) notifyFoldedResult(use.name, use.input);
  return { messages: next, foldedCount, savedChars, savedTokens };
}
