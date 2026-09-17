import type { LLMMessage, LLMContentBlock } from '../llm/llm-provider.js';
import type { ToolSideEffectClass } from './tool-types.js';
import {
  isCompactedReadPlaceholder,
  isFileMutationTool,
  toolPathKey,
} from '../../context/stale-read-invalidate.js';

export function isToolAssumedMutating(
  _toolName: string,
  sideEffectClass?: ToolSideEffectClass
): boolean {
  return sideEffectClass !== 'readonly';
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`
  );
  return `{${pairs.join(',')}}`;
}

export function stableSerializeToolInput(input: Record<string, unknown>): string {
  return stableStringify(input);
}

export function toolInputsReplayEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return stableSerializeToolInput(a) === stableSerializeToolInput(b);
}

export function findReplayableToolResultContent(
  messages: LLMMessage[],
  toolName: string,
  input: Record<string, unknown>,
  lookback = 32,
  sideEffectClass?: ToolSideEffectClass
): string | null {
  if (isToolAssumedMutating(toolName, sideEffectClass)) return null;

  const want = stableSerializeToolInput(input);
  const wantedPathKey = toolPathKey(toolName, input);
  const mutatedPathKeys = new Set<string>();
  let encounteredUnknownFileMutation = false;
  const start = Math.max(0, messages.length - lookback);

  for (let i = messages.length - 1; i >= 1; i--) {
    if (i < start) break;
    const userMsg = messages[i];
    if (userMsg.role !== 'user' || typeof userMsg.content === 'string') continue;
    const ublocks = userMsg.content as LLMContentBlock[];
    const results = ublocks.filter(
      (b): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
        b.type === 'tool_result'
    );
    if (results.length === 0) continue;
    const asst = messages[i - 1];
    if (!asst || asst.role !== 'assistant' || typeof asst.content === 'string') continue;
    const uses = (asst.content as LLMContentBlock[]).filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use'
    );
    for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex--) {
      const tr = results[resultIndex];
      if (tr.is_error) continue;
      const tu = uses.find((u) => u.id === tr.tool_use_id);
      if (!tu) continue;
      const prevIn =
        tu.input && typeof tu.input === 'object' && !Array.isArray(tu.input)
          ? (tu.input as Record<string, unknown>)
          : {};
      const historicalPathKey = toolPathKey(tu.name, prevIn);
      if (tu.name === 'apply_patch') {
        encounteredUnknownFileMutation = true;
        continue;
      }
      if (isFileMutationTool(tu.name)) {
        if (historicalPathKey) mutatedPathKeys.add(historicalPathKey);
        continue;
      }
      if (tu.name !== toolName) continue;
      if (stableSerializeToolInput(prevIn) !== want) continue;
      const body = String(tr.content || '').trim();
      if (isCompactedReadPlaceholder(body)) continue;
      if (wantedPathKey && encounteredUnknownFileMutation) continue;
      if (wantedPathKey && mutatedPathKeys.has(wantedPathKey)) continue;
      if (body) return tr.content;
    }
  }
  return null;
}
