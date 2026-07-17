









import type { Message } from '../core/session/session-jsonl.js';
import { parsePatch } from '../utils/apply-patch-core.js';
import { estimateTokensForText } from './tokens.js';

const READ_RESULT_TOOLS = new Set(['read', 'read_file', 'device_file_read']);
const MUTATE_RESULT_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'move_file',
  'device_file_write',
]);

export const STALE_READ_PLACEHOLDER =
  '[已省略：该路径在后续已被写入或编辑，旧读取结果不再可靠。必要时请重新 read / device_file_read。]';

export function isFileMutationTool(toolName: string): boolean {
  return MUTATE_RESULT_TOOLS.has(toolName);
}

function normalizePathKey(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
}






/**
 * All workspace/device path keys a tool call touches. A single multi_edit /
 * apply_patch / move_file can mutate several files; returning every key lets
 * `invalidateStaleReadToolResults` invalidate stale reads for each. Read tools
 * always return at most one key.
 *
 * `toolPathKey` (single-value, for replay) delegates to the first key here.
 */
export function toolPathKeys(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'device_file_read' || toolName === 'device_file_write') {
    const raw = typeof input.path === 'string' ? input.path : null;
    return raw ? [`dev:${normalizePathKey(raw)}`] : [];
  }

  // multi_edit: each edit carries its own path under edits[].path
  if (toolName === 'multi_edit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const keys: string[] = [];
    for (const item of edits) {
      if (!item || typeof item !== 'object') continue;
      const raw = typeof (item as Record<string, unknown>).path === 'string'
        ? ((item as Record<string, unknown>).path as string)
        : null;
      if (raw) keys.push(`ws:${normalizePathKey(raw)}`);
    }
    return dedupeKeys(keys);
  }

  // move_file: both source (deleted) and destination (created) invalidate reads
  if (toolName === 'move_file') {
    const keys: string[] = [];
    for (const field of ['source', 'destination']) {
      const raw = typeof input[field] === 'string' ? (input[field] as string) : null;
      if (raw) keys.push(`ws:${normalizePathKey(raw)}`);
    }
    return dedupeKeys(keys);
  }

  // apply_patch: parse the patch text for every Add/Update/Delete file path
  if (toolName === 'apply_patch') {
    const patchText = typeof input.patch === 'string' ? input.patch : '';
    if (!patchText) return [];
    let parsed;
    try {
      parsed = parsePatch(patchText);
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const hunk of parsed.hunks) {
      if (typeof hunk.path === 'string' && hunk.path) {
        keys.push(`ws:${normalizePathKey(hunk.path)}`);
      }
    }
    return dedupeKeys(keys);
  }

  // single-file read/write/edit tools
  if (
    toolName === 'read' ||
    toolName === 'read_file' ||
    toolName === 'write' ||
    toolName === 'write_file' ||
    toolName === 'edit' ||
    toolName === 'edit_file'
  ) {
    const raw =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : null;
    return raw ? [`ws:${normalizePathKey(raw)}`] : [];
  }

  return [];
}

function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export function toolPathKey(toolName: string, input: Record<string, unknown>): string | null {
  return toolPathKeys(toolName, input)[0] ?? null;
}

function buildToolUseIdMap(messages: Message[]): Map<string, { name: string; keys: string[] }> {
  const map = new Map<string, { name: string; keys: string[] }>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.id || !block.name) continue;
      const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<
        string,
        unknown
      >;
      map.set(block.id, { name: block.name, keys: toolPathKeys(block.name, input) });
    }
  }
  return map;
}

type ToolResultEvent = {
  globalIdx: number;
  kind: 'read' | 'mutate';
  key: string;
  msgIdx: number;
  blockIdx: number;
  contentLen: number;
};

function collectToolResultEvents(messages: Message[]): ToolResultEvent[] {
  const idMap = buildToolUseIdMap(messages);
  const events: ToolResultEvent[] = [];
  let globalIdx = 0;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let blockIdx = 0; blockIdx < msg.content.length; blockIdx++) {
      const block = msg.content[blockIdx];
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const meta = idMap.get(block.tool_use_id);
      if (!meta?.name) continue;
      const keys = meta.keys;
      if (keys.length === 0) continue;

      const contentLen = typeof block.content === 'string' ? block.content.length : 0;

      // A read tool result always maps to at most one path key (reads are
      // single-file). A mutate tool result (multi_edit / apply_patch /
      // move_file) can touch several files — emit one mutate event per key so
      // each file's prior reads get invalidated independently.
      if (READ_RESULT_TOOLS.has(meta.name)) {
        const key = keys[0];
        events.push({
          globalIdx,
          kind: 'read',
          key,
          msgIdx,
          blockIdx,
          contentLen,
        });
        globalIdx++;
      } else if (MUTATE_RESULT_TOOLS.has(meta.name)) {
        for (const key of keys) {
          events.push({
            globalIdx,
            kind: 'mutate',
            key,
            msgIdx,
            blockIdx,
            contentLen,
          });
        }
        globalIdx++;
      }
    }
  }

  return events;
}

export interface StaleReadInvalidateResult {
  messages: Message[];
  
  invalidatedCount: number;
  
  savedChars: number;
  
  savedTokens: number;
}





export function invalidateStaleReadToolResults(messages: Message[]): StaleReadInvalidateResult {
  const events = collectToolResultEvents(messages);
  if (events.length === 0) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  const mutateMaxByKey = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'mutate') continue;
    mutateMaxByKey.set(e.key, Math.max(mutateMaxByKey.get(e.key) ?? -1, e.globalIdx));
  }

  const toInvalidate = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'read') continue;
    const mx = mutateMaxByKey.get(e.key) ?? -1;
    if (mx > e.globalIdx) {
      toInvalidate.add(`${e.msgIdx}:${e.blockIdx}`);
    }
  }

  if (toInvalidate.size === 0) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  
  const placeholderTokens = estimateTokensForText(STALE_READ_PLACEHOLDER);
  let invalidatedCount = 0;
  let savedChars = 0;
  let savedTokens = 0;
  const result: Message[] = messages.map((msg, msgIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;

    let touched = false;
    const newContent = msg.content.map((block, blockIdx) => {
      const key = `${msgIdx}:${blockIdx}`;
      if (!toInvalidate.has(key)) return block;
      if (block.type !== 'tool_result') return block;
      const prev = typeof block.content === 'string' ? block.content : '';
      if (prev === STALE_READ_PLACEHOLDER) return block;
      touched = true;
      invalidatedCount++;
      savedChars += Math.max(0, prev.length - STALE_READ_PLACEHOLDER.length);
      savedTokens += Math.max(0, estimateTokensForText(prev) - placeholderTokens);
      return { ...block, content: STALE_READ_PLACEHOLDER };
    });

    return touched ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, invalidatedCount, savedChars, savedTokens };
}









export const FILE_UNCHANGED_PLACEHOLDER =
  '[已省略：该文件后续被再次读取且内容完全一致，完整内容见下方较新的读取结果，无需重复保留。]';

export function isCompactedReadPlaceholder(content: string): boolean {
  return content === STALE_READ_PLACEHOLDER || content === FILE_UNCHANGED_PLACEHOLDER;
}


const DEDUP_READ_TOOLS = new Set(['read', 'read_file', 'device_file_read']);





function dedupReadPathKey(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'read' || toolName === 'read_file') {
    const raw =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : null;
    return raw ? `ws:${normalizePathKey(raw)}` : null;
  }
  if (toolName === 'device_file_read') {
    const raw = typeof input.path === 'string' ? input.path : null;
    return raw ? `dev:${normalizePathKey(raw)}` : null;
  }
  return null;
}


function buildReadKeyByToolUseId(
  messages: Message[]
): Map<string, { name: string; key: string | null }> {
  const map = new Map<string, { name: string; key: string | null }>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.id || !block.name) continue;
      const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<
        string,
        unknown
      >;
      map.set(block.id, { name: block.name, key: dedupReadPathKey(block.name, input) });
    }
  }
  return map;
}







export function dedupeUnchangedReadToolResults(messages: Message[]): StaleReadInvalidateResult {
  const idMap = buildReadKeyByToolUseId(messages);

  type ReadRef = { msgIdx: number; blockIdx: number; key: string; content: string };
  const reads: ReadRef[] = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let blockIdx = 0; blockIdx < msg.content.length; blockIdx++) {
      const block = msg.content[blockIdx];
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const meta = idMap.get(block.tool_use_id);
      if (!meta || !DEDUP_READ_TOOLS.has(meta.name) || !meta.key) continue;
      if (typeof block.content !== 'string') continue;
      const content = block.content;
      if (content === STALE_READ_PLACEHOLDER || content === FILE_UNCHANGED_PLACEHOLDER) continue;
      reads.push({ msgIdx, blockIdx, key: meta.key, content });
    }
  }
  if (reads.length < 2) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  
  const toStub = new Set<string>();
  const seenLater = new Map<string, Set<string>>();
  for (let i = reads.length - 1; i >= 0; i--) {
    const ref = reads[i];
    const seen = seenLater.get(ref.key);
    if (seen?.has(ref.content) && ref.content.length > FILE_UNCHANGED_PLACEHOLDER.length) {
      toStub.add(`${ref.msgIdx}:${ref.blockIdx}`);
    }
    if (seen) seen.add(ref.content);
    else seenLater.set(ref.key, new Set([ref.content]));
  }

  if (toStub.size === 0) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  const placeholderTokens = estimateTokensForText(FILE_UNCHANGED_PLACEHOLDER);
  let invalidatedCount = 0;
  let savedChars = 0;
  let savedTokens = 0;
  const result: Message[] = messages.map((msg, msgIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;

    let touched = false;
    const newContent = msg.content.map((block, blockIdx) => {
      const id = `${msgIdx}:${blockIdx}`;
      if (!toStub.has(id)) return block;
      if (block.type !== 'tool_result') return block;
      const prev = typeof block.content === 'string' ? block.content : '';
      touched = true;
      invalidatedCount++;
      savedChars += Math.max(0, prev.length - FILE_UNCHANGED_PLACEHOLDER.length);
      savedTokens += Math.max(0, estimateTokensForText(prev) - placeholderTokens);
      return { ...block, content: FILE_UNCHANGED_PLACEHOLDER };
    });

    return touched ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, invalidatedCount, savedChars, savedTokens };
}
