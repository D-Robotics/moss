import { getRootLogger } from '../../logger.js';
import { describeError } from '../../provider/errors.js';
import type { Tool } from '../tools/tool-types.js';
import type { ContentBlock } from '../session/session-jsonl.js';

const log = getRootLogger().child('agent:loop');

export interface ToolExecGroup {
  calls: { id: string; name: string; input: Record<string, unknown> }[];
  parallel: boolean;
}

const TRAILING_NOTICE_LINE = /^\[moss\]\s+\S/;

/** Trailing `[moss]` notice lines of a full result (blank lines between them dropped). */
function trailingNotices(full: string): string[] {
  const lines = full.split('\n');
  const notices: string[] = [];
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? '').trim();
    if (last === '') {
      lines.pop();
      continue;
    }
    if (!TRAILING_NOTICE_LINE.test(last)) break;
    notices.unshift(last);
    lines.pop();
  }
  return notices;
}

/** A head-truncated preview keeps the result's trailing `[moss]` notices. */
function withNotices(full: string, preview: string): string {
  if (preview === full) return preview;
  const notices = trailingNotices(full);
  return notices.length > 0 ? `${preview}\n\n${notices.join('\n')}` : preview;
}

export function formatToolResultForSsePreview(truncatedResult: string, isError: boolean): string {
  if (isError) {
    return withNotices(
      truncatedResult,
      truncatedResult.length > 500 ? `${truncatedResult.slice(0, 500)}...` : truncatedResult
    );
  }
  const trimmed = truncatedResult.trimStart();
  if (trimmed.startsWith('{') && trimmed.includes('"__type"')) {
    const max = 12_000;
    return truncatedResult.length > max ? `${truncatedResult.slice(0, max)}...` : truncatedResult;
  }
  return withNotices(
    truncatedResult,
    truncatedResult.length > 500 ? `${truncatedResult.slice(0, 500)}...` : truncatedResult
  );
}

export function normalizeToolCallInput(
  call: { name: string; input: Record<string, unknown> },
  toolsForRun: Tool[],
  ctx: { sessionKey: string }
): Record<string, unknown> {
  const tool = toolsForRun.find((t) => t.name === call.name);
  if (!tool?.normalizeInput) return call.input;
  try {
    const normalized = tool.normalizeInput(call.input, { sessionKey: ctx.sessionKey });
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
  } catch (err) {
    log.warn('tool input normalizer failed; using original input', {
      tool: call.name,
      error: describeError(err),
    });
  }
  return call.input;
}

export function syncAssistantToolUseInput(
  assistantContent: ContentBlock[],
  call: { id: string; input: Record<string, unknown> }
): void {
  for (const block of assistantContent) {
    if (block.type === 'tool_use' && block.id === call.id) {
      block.input = call.input;
    }
  }
}

export function groupToolCallsForExecution(
  calls: { id: string; name: string; input: Record<string, unknown> }[],
  parallelSafeTools: Set<string>,
  loadToolsMetaName?: string
): ToolExecGroup[] {
  const ordered = partitionLoadToolsFirst(calls, loadToolsMetaName);
  if (ordered.length <= 1) return [{ calls: ordered, parallel: false }];
  const groups: ToolExecGroup[] = [];
  let pending: typeof ordered = [];
  for (const call of ordered) {
    if (loadToolsMetaName && call.name === loadToolsMetaName) {
      if (pending.length > 0) {
        groups.push({ calls: pending, parallel: true });
        pending = [];
      }
      groups.push({ calls: [call], parallel: false });
      continue;
    }
    if (parallelSafeTools.has(call.name)) {
      pending.push(call);
    } else {
      if (pending.length > 0) {
        groups.push({ calls: pending, parallel: true });
        pending = [];
      }
      groups.push({ calls: [call], parallel: false });
    }
  }
  if (pending.length > 0) groups.push({ calls: pending, parallel: true });
  return groups;
}

export function partitionLoadToolsFirst(
  calls: { id: string; name: string; input: Record<string, unknown> }[],
  loadToolsMetaName?: string
): typeof calls {
  if (!loadToolsMetaName) return calls;
  const loads = calls.filter((c) => c.name === loadToolsMetaName);
  const rest = calls.filter((c) => c.name !== loadToolsMetaName);
  return [...loads, ...rest];
}
