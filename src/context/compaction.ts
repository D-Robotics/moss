import fs from 'node:fs/promises';
import path from 'node:path';
import { createCompactionSummaryMessage, type Message } from '../core/session/session-jsonl.js';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateMessagesChars,
  estimatePromptUnitsForContextWindow,
  estimateTokensForText,
  CHARS_PER_TOKEN_ESTIMATE,
} from './tokens.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import {
  expandKeptWithToolRoundtrips,
  pruneContextMessages,
  type ContextPruningSettings,
  type PruneResult,
} from './pruning.js';
import { getRootLogger } from '../logger.js';
import { parsePatch } from '../utils/apply-patch-core.js';

/**
 * Extract every workspace file path a tool_use input touches, as raw display
 * paths (no normalization) — matching FileOps' string-set semantics. Mirrors
 * toolPathKeys' coverage but returns the bare paths compaction tracks, so
 * multi_edit's edits[].path, apply_patch's patch-text paths, and move_file's
 * source/destination all land in <modified-files>.
 */
function extractFilePathsFromToolUse(name: string, args: Record<string, unknown>): string[] {
  switch (name) {
    case 'read':
    case 'read_file':
    case 'write':
    case 'write_file':
    case 'edit':
    case 'edit_file':
    case 'notebook_edit': {
      const p =
        typeof args.path === 'string'
          ? args.path
          : typeof args.file_path === 'string'
            ? args.file_path
            : undefined;
      return p ? [p] : [];
    }
    case 'multi_edit': {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const out: string[] = [];
      for (const item of edits) {
        if (!item || typeof item !== 'object') continue;
        const p = (item as Record<string, unknown>).path;
        if (typeof p === 'string' && p) out.push(p);
      }
      return out;
    }
    case 'apply_patch': {
      const patchText = typeof args.patch === 'string' ? args.patch : '';
      if (!patchText) return [];
      let parsed;
      try {
        parsed = parsePatch(patchText);
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const hunk of parsed.hunks) {
        if (typeof hunk.path === 'string' && hunk.path) out.push(hunk.path);
      }
      return out;
    }
    case 'move_file': {
      const out: string[] = [];
      for (const field of ['source', 'destination']) {
        const p = args[field];
        if (typeof p === 'string' && p) out.push(p);
      }
      return out;
    }
    default:
      return [];
  }
}
import type { RemoteCompactProvider } from './remote-compaction.js';
import { buildDeterministicCompactionSummary } from './deterministic-summary.js';
import { extractLatestTodosFromMessages, type ParsedTodoItem } from './message-tool-helpers.js';
import {
  extractCompactionSummaryText,
  isCompactionSummaryMessage,
  mergePriorCompactionSummaries,
} from './summary-checkpoint-merge.js';
import {
  MERGE_SUMMARIES_INSTRUCTIONS,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from './compaction-prompts.js';
import { errorMessage } from '../errors.js';

const log = getRootLogger().child('agent:compaction');

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2;

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;

  restoreFileContents: boolean;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTokens: 20_000,
  restoreFileContents: true,
};

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;

export const POST_COMPACT_TOKEN_BUDGET = 50_000;

export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;

export const DEFAULT_SUMMARY_MAX_TOKENS = 900;
const DEFAULT_SUMMARY_FALLBACK = 'No prior history.';
const DEFAULT_PARTS = 2;
function extractSummaryTag(raw: string): string {
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1].trim() : raw.trim();
}

type FileOps = {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;

  recency: Array<{ path: string; modified: boolean }>;
};

function createFileOps(): FileOps {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
    recency: [],
  };
}

function touchRecency(fileOps: FileOps, filePath: string, modified: boolean): void {
  const existingIdx = fileOps.recency.findIndex((e) => e.path === filePath);
  if (existingIdx !== -1) {
    const existing = fileOps.recency[existingIdx];
    fileOps.recency.splice(existingIdx, 1);
    fileOps.recency.push({ path: filePath, modified: existing.modified || modified });
    return;
  }
  fileOps.recency.push({ path: filePath, modified });
}

function extractFileOpsFromMessage(message: Message, fileOps: FileOps): void {
  if (message.role !== 'assistant') {
    return;
  }
  if (!Array.isArray(message.content)) {
    return;
  }
  const WRITE_TOOL_NAMES = new Set(['write', 'write_file']);
  const EDIT_TOOL_NAMES = new Set([
    'edit',
    'edit_file',
    'multi_edit',
    'apply_patch',
    'move_file',
    'notebook_edit',
  ]);
  const READ_TOOL_NAMES = new Set(['read', 'read_file']);
  for (const block of message.content) {
    if (block.type !== 'tool_use') {
      continue;
    }
    const name = block.name;
    if (!name) {
      continue;
    }
    const args = block.input;
    if (!args || typeof args !== 'object') {
      continue;
    }
    const paths = extractFilePathsFromToolUse(name, args as Record<string, unknown>);
    if (paths.length === 0) {
      continue;
    }
    if (WRITE_TOOL_NAMES.has(name)) {
      for (const p of paths) {
        fileOps.written.add(p);
        touchRecency(fileOps, p, true);
      }
    } else if (EDIT_TOOL_NAMES.has(name)) {
      for (const p of paths) {
        fileOps.edited.add(p);
        touchRecency(fileOps, p, true);
      }
    } else if (READ_TOOL_NAMES.has(name)) {
      for (const p of paths) {
        fileOps.read.add(p);
        touchRecency(fileOps, p, false);
      }
    }
  }
}

function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return '';
  }
  return `\n\n${sections.join('\n\n')}`;
}

/**
 * Render the active todo checklist (the most recent `todo_write` state) as an
 * `<active-todos>` block to append to the compaction summary. A long coding
 * task's todo thread is otherwise lost when the latest todo_write result lands
 * in the pruned middle — the LLM/deterministic summary does not reliably
 * carry the structured checklist forward.
 */
function formatActiveTodos(todos: ParsedTodoItem[] | null): string {
  if (!todos || todos.length === 0) return '';
  const GLYPH: Record<ParsedTodoItem['status'], string> = {
    pending: '○',
    in_progress: '◐',
    completed: '✓',
  };
  const lines = todos.map(
    (t, i) => `${i + 1}. ${GLYPH[t.status] ?? '○'} ${t.content} [${t.status}]`
  );
  const done = todos.filter((t) => t.status === 'completed').length;
  lines.push('', `Progress: ${done}/${todos.length} complete.`);
  return `\n\n<active-todos>\n${lines.join('\n')}\n</active-todos>`;
}

function selectFilesToRestore(fileOps: FileOps, maxFiles: number): string[] {
  const inScope = (p: string): boolean =>
    fileOps.read.has(p) || fileOps.written.has(p) || fileOps.edited.has(p);
  const newestFirst = [...fileOps.recency].reverse().filter((e) => inScope(e.path));
  const modified = newestFirst.filter((e) => e.modified).map((e) => e.path);
  const readOnly = newestFirst.filter((e) => !e.modified).map((e) => e.path);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const p of [...modified, ...readOnly]) {
    if (seen.has(p)) continue;
    seen.add(p);
    ordered.push(p);
    if (ordered.length >= maxFiles) break;
  }
  return ordered;
}

function truncateToTokenBudget(content: string, maxTokens: number): string {
  if (estimateTokensForText(content) <= maxTokens) {
    return content;
  }
  const charBudget = Math.max(0, maxTokens * CHARS_PER_TOKEN_ESTIMATE);
  const chars = Array.from(content);
  const head = chars.slice(0, charBudget).join('');
  return `${head}\n\n[... truncated: file exceeds ${maxTokens} token restore cap; read it again for the rest]`;
}

async function restoreRecentFileContents(params: {
  fileOps: FileOps;
  workspaceDir: string;
  maxFiles: number;
  perFileTokenBudget: number;
  totalTokenBudget: number;
}): Promise<string> {
  const candidates = selectFilesToRestore(params.fileOps, params.maxFiles);
  if (candidates.length === 0) {
    return '';
  }

  const blocks: string[] = [];
  let usedTokens = 0;
  for (const filePath of candidates) {
    let resolved: string;
    try {
      ({ resolved } = await assertSandboxPath({
        filePath,
        cwd: params.workspaceDir,
        root: params.workspaceDir,
      }));
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = await fs.readFile(resolved, 'utf-8');
    } catch {
      continue;
    }

    const safe = sanitizeSecrets(raw);
    const body = truncateToTokenBudget(safe, params.perFileTokenBudget);
    const block = `<restored-file path="${filePath}">\n${body}\n</restored-file>`;
    const blockTokens = estimateTokensForText(block);
    if (usedTokens + blockTokens > params.totalTokenBudget) {
      continue;
    }
    usedTokens += blockTokens;
    blocks.push(block);
  }

  if (blocks.length === 0) {
    return '';
  }
  return (
    `\n\n<restored-files>\n` +
    `Current on-disk contents of the most recently used files, restored after ` +
    `compaction so you keep your working set. Do not re-read these unless you ` +
    `suspect they changed.\n\n` +
    `${blocks.join('\n\n')}\n` +
    `</restored-files>`
  );
}

export type SummarizeFn = (params: {
  system: string;
  userPrompt: string;
  maxTokens: number;
  abortSignal?: AbortSignal;
}) => Promise<string>;

export interface CompactionStrategy {
  readonly name: string;
  summarize(params: StrategyParams): Promise<string>;
  readonly fallback?: CompactionStrategy;
}

export interface StrategyParams {
  summarize?: any; // Can be either SummarizeFn signature variant
  remoteCompactProvider?: RemoteCompactProvider;
  droppedMessages: Message[];
  contextWindowTokens: number;
  maxTokens?: number;
  reserveTokens: number;
  customInstructions?: string;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
}

function throwIfCompactionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error(
    signal.reason === undefined
      ? 'compaction aborted'
      : `compaction aborted: ${String(signal.reason)}`
  );
}

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function computeAdaptiveChunkRatio(messages: Message[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }
  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}

export function splitMessagesByTokenShare(messages: Message[], parts = DEFAULT_PARTS): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function chunkMessagesByMaxTokens(messages: Message[], maxTokens: number): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (current.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;

    if (messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function isOversizedForSummary(msg: Message, contextWindow: number): boolean {
  const tokens = estimateMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

function extractUserText(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractUserText(msg.content);
      if (text) {
        parts.push(`[User]: ${text}`);
      }
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content
          .filter((block) => block.type === 'tool_result')
          .map((block) => block.content ?? '')
          .filter(Boolean);
        for (const result of toolResults) {
          parts.push(`[Tool result]: ${result}`);
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) {
              textParts.push(block.text);
            }
            continue;
          }
          if (block.type === 'tool_use') {
            const args = block.input ?? {};
            const argsStr = Object.entries(args)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(', ');
            toolCalls.push(`${block.name ?? 'tool'}(${argsStr})`);
          }
        }
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join('\n')}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
      }
    }
  }
  return parts.join('\n\n');
}

async function generateSummary(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  customInstructions?: string;
  previousSummary?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  throwIfCompactionAborted(params.abortSignal);
  let basePrompt = params.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (params.customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${params.customInstructions}`;
  }
  const conversationText = serializeConversation(params.messages);
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (params.previousSummary) {
    prompt += `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += basePrompt;

  const raw = await params.summarize({
    system: SUMMARIZATION_SYSTEM_PROMPT,
    userPrompt: prompt,
    maxTokens: params.maxTokens,
    abortSignal: params.abortSignal,
  });

  throwIfCompactionAborted(params.abortSignal);

  return extractSummaryTag(raw);
}

async function summarizeChunks(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
  let summary = params.previousSummary;
  for (const chunk of chunks) {
    summary = await generateSummary({
      messages: chunk,
      summarize: params.summarize,
      maxTokens: params.maxTokens,
      customInstructions: params.customInstructions,
      previousSummary: summary,
      abortSignal: params.abortSignal,
    });
  }
  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

async function summarizeWithFallback(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  try {
    return await summarizeChunks(params);
  } catch (e) {
    throwIfCompactionAborted(params.abortSignal);
    log.warn('summarizeChunks failed, falling back to smaller chunks', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const smallMessages: Message[] = [];
  const oversizedNotes: string[] = [];
  for (const msg of params.messages) {
    if (isOversizedForSummary(msg, params.contextWindow)) {
      const tokens = estimateMessageTokens(msg);
      oversizedNotes.push(`[Large ${msg.role} (~${Math.round(tokens / 1000)}K tokens) omitted]`);
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partial = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join('\n')}` : '';
      return partial + notes;
    } catch (e) {
      throwIfCompactionAborted(params.abortSignal);
      log.warn('smaller-chunks fallback also failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const fallback = `Context contained ${params.messages.length} messages. Summary unavailable due to size limits.`;
  return oversizedNotes.length > 0 ? `${fallback}\n\n${oversizedNotes.join('\n')}` : fallback;
}

export async function summarizeInStages(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  throwIfCompactionAborted(params.abortSignal);
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    throwIfCompactionAborted(params.abortSignal);
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      })
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  const summaryMessages: Message[] = partialSummaries.map((summary) => ({
    role: 'user',
    content: summary,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

export function shouldTriggerCompaction(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<CompactionSettings>;
  systemPrompt?: string;
  charsPerTokenUnit?: number;
  includeThinking?: boolean;
}): boolean {
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...params.settings,
  };
  if (!settings.enabled) return false;
  const totalTokens =
    params.systemPrompt !== undefined && params.charsPerTokenUnit !== undefined
      ? estimatePromptUnitsForContextWindow({
          messages: params.messages,
          systemPrompt: params.systemPrompt,
          charsPerTokenUnit: params.charsPerTokenUnit,
          effectiveContextWindowTokens: params.contextWindowTokens,
          includeThinking: params.includeThinking,
        })
      : estimateMessagesTokens(params.messages, { includeThinking: params.includeThinking });
  return totalTokens > params.contextWindowTokens - settings.reserveTokens;
}

export function shouldProactiveCompact(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<CompactionSettings>;
  includeThinking?: boolean;
}): boolean {
  const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...params.settings };
  if (!settings.enabled) return false;

  const totalTokens = estimateMessagesTokens(params.messages, {
    includeThinking: params.includeThinking,
  });
  const usageRatio = totalTokens / params.contextWindowTokens;

  if (usageRatio < 0.6) return false;

  const recentMessages = params.messages.slice(-6);
  const toolOnlyRounds = recentMessages.filter(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.content) &&
      m.content.every((b) => b.type === 'tool_use')
  ).length;

  if (toolOnlyRounds >= 3 && usageRatio > 0.65) return true;

  const lastMsg = params.messages[params.messages.length - 1];
  if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
    const toolResultTokens = lastMsg.content
      .filter((b) => b.type === 'tool_result')
      .reduce(
        (sum, b) => sum + (typeof b.content === 'string' ? estimateTokensForText(b.content) : 0),
        0
      );
    if (toolResultTokens > params.contextWindowTokens * 0.4) return true;
  }

  return false;
}

export async function buildCompactionSummary(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  maxTokens?: number;
  reserveTokens?: number;
  customInstructions?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  throwIfCompactionAborted(params.abortSignal);
  if (params.messages.length === 0) {
    return DEFAULT_SUMMARY_FALLBACK;
  }
  const adaptiveRatio = computeAdaptiveChunkRatio(params.messages, params.contextWindowTokens);
  const maxChunkTokens = Math.max(1, Math.floor(params.contextWindowTokens * adaptiveRatio));
  const reserveTokens = params.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const maxTokens = Math.max(64, Math.floor(params.maxTokens ?? 0.8 * reserveTokens));

  return summarizeInStages({
    messages: params.messages,
    summarize: params.summarize,
    maxTokens,
    maxChunkTokens,
    contextWindow: params.contextWindowTokens,
    customInstructions: params.customInstructions,
    abortSignal: params.abortSignal,
  });
}

// CompactionStrategy implementations
class DeterministicCompactionStrategy implements CompactionStrategy {
  readonly name = 'deterministic';

  async summarize(params: StrategyParams): Promise<string> {
    return buildDeterministicCompactionSummary(
      params.droppedMessages,
      'Local deterministic summary'
    );
  }
}

class LlmCompactionStrategy implements CompactionStrategy {
  readonly name = 'llm';
  readonly fallback: CompactionStrategy;

  constructor(fallback?: CompactionStrategy) {
    this.fallback = fallback ?? new DeterministicCompactionStrategy();
  }

  async summarize(params: StrategyParams): Promise<string> {
    if (!params.summarize) {
      throw new Error('LLM compaction requires a summarize function');
    }
    return buildCompactionSummary({
      summarize: params.summarize,
      messages: params.droppedMessages,
      contextWindowTokens: params.contextWindowTokens,
      maxTokens: params.maxTokens,
      reserveTokens: params.reserveTokens,
      customInstructions: params.customInstructions,
      abortSignal: params.abortSignal,
    });
  }
}

class RemoteCompactionStrategy implements CompactionStrategy {
  readonly name = 'remote';
  readonly fallback: CompactionStrategy;

  constructor(fallback?: CompactionStrategy) {
    this.fallback = fallback ?? new LlmCompactionStrategy();
  }

  async summarize(params: StrategyParams): Promise<string> {
    if (!params.remoteCompactProvider) {
      throw new Error('Remote compaction requires a remoteCompactProvider');
    }
    if (!params.summarize) {
      throw new Error('Remote compaction requires a summarize function for local fallback');
    }

    // Create a wrapper for the buildCompactionSummary-style function to match SummarizeFn signature
    const wrappedSummarize: SummarizeFn = async (summaryParams) => {
      // summaryParams has { system, userPrompt, maxTokens, abortSignal }
      // We need to call params.summarize which has { messages, maxTokens, systemPrompt, customInstructions, abortSignal }
      // For remote compaction, we convert by treating the user prompt as the messages
      return params.summarize!({
        messages: [{ role: 'user', content: summaryParams.userPrompt, timestamp: Date.now() }],
        maxTokens: summaryParams.maxTokens,
        systemPrompt: summaryParams.system,
        customInstructions: undefined,
        abortSignal: summaryParams.abortSignal,
      });
    };

    return runRemoteCompaction({
      remoteCompactProvider: params.remoteCompactProvider,
      localSummarize: wrappedSummarize,
      contextWindowTokens: params.contextWindowTokens,
      reserveTokens: params.reserveTokens,
      customInstructions: params.customInstructions,
      droppedMessages: params.droppedMessages,
      systemPrompt: params.systemPrompt,
      abortSignal: params.abortSignal,
    });
  }
}

function selectCompactionStrategy(params: {
  skipLlmCompaction?: boolean;
  remoteCompactProvider?: RemoteCompactProvider;
}): CompactionStrategy {
  if (params.skipLlmCompaction) {
    return new DeterministicCompactionStrategy();
  }

  if (params.remoteCompactProvider) {
    return new RemoteCompactionStrategy(
      new LlmCompactionStrategy(new DeterministicCompactionStrategy())
    );
  }

  return new LlmCompactionStrategy(new DeterministicCompactionStrategy());
}

async function runRemoteCompaction(params: {
  remoteCompactProvider: RemoteCompactProvider;
  localSummarize: SummarizeFn;
  contextWindowTokens: number;
  reserveTokens: number;
  customInstructions?: string;
  droppedMessages: Message[];
  systemPrompt?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { hybridCompact } = await import('./remote-compaction.js');
  const hybrid = await hybridCompact(
    {
      remoteProvider: params.remoteCompactProvider,
      localSummarize: params.localSummarize,
      contextWindowTokens: params.contextWindowTokens,
      reserveTokens: params.reserveTokens,
      customInstructions: params.customInstructions,
      abortSignal: params.abortSignal,
    },
    params.droppedMessages,
    params.systemPrompt
  );
  log.info('compaction summary source', { method: hybrid.method });
  return hybrid.summary;
}

export async function compactHistoryIfNeeded(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  compactionSettings?: Partial<CompactionSettings>;
  systemPrompt?: string;
  charsPerTokenUnit?: number;
  maxTokens?: number;
  skipLlmCompaction?: boolean;
  forceCompaction?: boolean;
  remoteCompactProvider?: RemoteCompactProvider;
  customInstructions?: string;
  includeThinking?: boolean;
  abortSignal?: AbortSignal;

  workspaceDir?: string;
}): Promise<{
  summary?: string;
  summaryMessage?: Message;
  pruneResult: PruneResult;
  degraded?: boolean;
}> {
  throwIfCompactionAborted(params.abortSignal);
  const charsPerUnitBase = Math.max(1, params.charsPerTokenUnit ?? CHARS_PER_TOKEN_ESTIMATE);
  const estimateOptions = { includeThinking: params.includeThinking };
  const rawTotalChars =
    estimateMessagesChars(params.messages, estimateOptions) + (params.systemPrompt?.length ?? 0);
  const pruneCharsPerUnit =
    rawTotalChars / params.contextWindowTokens >= 0.85 ? 1 : charsPerUnitBase;
  const systemPromptTokens = params.systemPrompt
    ? Math.ceil(
        estimatePromptUnitsForContextWindow({
          messages: [],
          systemPrompt: params.systemPrompt,
          charsPerTokenUnit: pruneCharsPerUnit,
          effectiveContextWindowTokens: params.contextWindowTokens,
          includeThinking: params.includeThinking,
        })
      )
    : undefined;

  const pruneResult = pruneContextMessages({
    messages: params.messages,
    contextWindowTokens: params.contextWindowTokens,
    systemPromptTokens,
    charsPerTokenUnit: pruneCharsPerUnit,
    includeThinking: params.includeThinking,
    settings: params.pruningSettings,
  });
  const priorCompactionSummaries = params.messages
    .filter(isCompactionSummaryMessage)
    .map(extractCompactionSummaryText)
    .filter((summary): summary is string => Boolean(summary));
  if (priorCompactionSummaries.length > 0) {
    pruneResult.messages = pruneResult.messages.filter(
      (message) => !isCompactionSummaryMessage(message)
    );
    pruneResult.droppedMessages = pruneResult.droppedMessages.filter(
      (message) => !isCompactionSummaryMessage(message)
    );
    const recalcKept = estimateMessagesChars(pruneResult.messages, estimateOptions);
    const recalcDropped = estimateMessagesChars(pruneResult.droppedMessages, estimateOptions);
    pruneResult.totalChars = recalcKept + recalcDropped;
    pruneResult.keptChars = recalcKept;
    pruneResult.droppedChars = recalcDropped;
  }

  const shouldCompact =
    Boolean(params.forceCompaction) ||
    pruneResult.droppedMessages.length > 0 ||
    shouldTriggerCompaction({
      messages: params.messages,
      contextWindowTokens: params.contextWindowTokens,
      settings: params.compactionSettings,
      systemPrompt: params.systemPrompt,
      charsPerTokenUnit: charsPerUnitBase,
      includeThinking: params.includeThinking,
    });

  if (!shouldCompact) {
    return { pruneResult };
  }
  throwIfCompactionAborted(params.abortSignal);

  if (pruneResult.droppedMessages.length === 0) {
    const totalTokens = estimateMessagesTokens(params.messages, estimateOptions);
    const threshold = params.contextWindowTokens * 0.7;
    if (!params.forceCompaction && totalTokens <= threshold) {
      return { pruneResult };
    }
    const keepLastN = Math.max(4, Math.ceil(params.messages.length * 0.5));
    const dropCount = Math.max(1, params.messages.length - keepLastN);
    pruneResult.messages = expandKeptWithToolRoundtrips(
      params.messages,
      params.messages.slice(dropCount)
    );
    const keptSet = new Set(pruneResult.messages);
    pruneResult.droppedMessages.push(...params.messages.filter((message) => !keptSet.has(message)));

    const recalcKept = estimateMessagesChars(pruneResult.messages, estimateOptions);
    const recalcDropped = estimateMessagesChars(pruneResult.droppedMessages, estimateOptions);
    pruneResult.totalChars = recalcKept + recalcDropped;
    pruneResult.keptChars = recalcKept;
    pruneResult.droppedChars = recalcDropped;
  }

  const resolvedSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...params.compactionSettings };

  // Select and execute compaction strategy
  const strategy = selectCompactionStrategy({
    skipLlmCompaction: params.skipLlmCompaction,
    remoteCompactProvider: params.remoteCompactProvider,
  });

  let summary: string = '';
  let degraded = false;
  let currentStrategy: CompactionStrategy | undefined = strategy;

  while (currentStrategy) {
    try {
      summary = await currentStrategy.summarize({
        summarize: params.summarize,
        remoteCompactProvider: params.remoteCompactProvider,
        droppedMessages: pruneResult.droppedMessages,
        contextWindowTokens: params.contextWindowTokens,
        maxTokens: params.maxTokens,
        reserveTokens: resolvedSettings.reserveTokens,
        customInstructions: params.customInstructions,
        systemPrompt: params.systemPrompt,
        abortSignal: params.abortSignal,
      });

      // Validate summary
      if (
        summary &&
        summary.trim() &&
        !summary.includes('Summary unavailable due to size limits')
      ) {
        break;
      }

      // Summary invalid, try fallback
      if (currentStrategy.fallback) {
        log.warn('Compaction summary invalid; trying fallback strategy', {
          strategy: currentStrategy.name,
          fallback: currentStrategy.fallback.name,
        });
        currentStrategy = currentStrategy.fallback;
        degraded = true;
      } else {
        throw new Error('Empty or invalid summary with no fallback');
      }
    } catch (err) {
      throwIfCompactionAborted(params.abortSignal);
      if (currentStrategy.fallback) {
        log.warn('Compaction strategy failed; trying fallback', {
          strategy: currentStrategy.name,
          fallback: currentStrategy.fallback.name,
          error: errorMessage(err),
        });
        currentStrategy = currentStrategy.fallback;
        degraded = true;
      } else {
        log.error('Compaction failed with no fallback available', {
          strategy: currentStrategy.name,
          error: errorMessage(err),
        });
        throw err;
      }
    }
  }

  // Ensure summary is set (should not happen with fallback chain)
  if (!summary) {
    summary = buildDeterministicCompactionSummary(
      pruneResult.droppedMessages,
      'Compaction exhausted all strategies'
    );
    degraded = true;
  }
  throwIfCompactionAborted(params.abortSignal);
  summary = mergePriorCompactionSummaries(summary, priorCompactionSummaries);
  const fileOps = createFileOps();
  for (const message of pruneResult.droppedMessages) {
    extractFileOpsFromMessage(message, fileOps);
  }

  if (params.workspaceDir) {
    const ws = params.workspaceDir.replace(/[/\\]+$/, '');
    const inScope = (p: string) =>
      p === ws || p.startsWith(ws + '/') || p.startsWith(ws + '\\') || !path.isAbsolute(p);
    fileOps.read = new Set([...fileOps.read].filter(inScope));
    fileOps.written = new Set([...fileOps.written].filter(inScope));
    fileOps.edited = new Set([...fileOps.edited].filter(inScope));
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  // Preserve the active todo checklist across compaction. extractLatestTodos
  // scans the full pre-prune message list, so a todo_write that landed in the
  // pruned middle (the common case in a long coding session) is still carried
  // forward into the summary the LLM sees next turn. Null/no todos → no block.
  summary += formatActiveTodos(extractLatestTodosFromMessages(params.messages));

  if (resolvedSettings.restoreFileContents) {
    const restoreRoot = params.workspaceDir ?? process.cwd();
    try {
      summary += await restoreRecentFileContents({
        fileOps,
        workspaceDir: restoreRoot,
        maxFiles: POST_COMPACT_MAX_FILES_TO_RESTORE,
        perFileTokenBudget: POST_COMPACT_MAX_TOKENS_PER_FILE,
        totalTokenBudget: POST_COMPACT_TOKEN_BUDGET,
      });
    } catch (err) {
      log.warn('post-compaction file readback failed; skipping', {
        error: errorMessage(err),
      });
    }
  }

  const summaryMessage: Message = createCompactionSummaryMessage(summary, Date.now());

  return {
    summary,
    summaryMessage,
    pruneResult,
    degraded: degraded || undefined,
  };
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_HISTORY_SHARE = 0.5;
export const DEFAULT_CONTEXT_WINDOW_CHARS =
  DEFAULT_CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
