import { stableSerializeToolInput } from './tool-idempotent-replay.js';
import { readEnv } from '../../utils/env-compat.js';







const SINGLE_TOOL_LIMIT_EXEMPT_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'move_file',
  'apply_patch',
  'list_directory',
  'search_files',
  'search_code',
  'device_file_read',
  'device_file_list',
]);

const DEFAULT_IDENTICAL_TOOL_INPUT_LIMIT = 3;
const DEFAULT_TOOL_FAILURE_LIMIT = 3;







// Default 4 — headroom for a few genuinely different search angles (a Chinese
// query, an English query, the brand name) before blocking the 5th. The old cap
// of 2 was too tight: with the keyless backend often returning degraded results
// the model legitimately needs more than one refinement, and a 2-query cap drove
// it into guessing URLs instead. Override via MOSS_WEB_SEARCH_VARIATION_LIMIT.
const DEFAULT_WEB_SEARCH_VARIATION_LIMIT = 4;

export type ToolLoopGuardState = {
  bySignature: Map<string, number>;
  byTool: Map<string, number>;
  byToolFailure: Map<string, number>;
  
  webSearchQueries: Set<string>;
  total: number;
};

function resolveOptionalPositiveIntEnv(name: string, fallback?: number): number | undefined {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === '0' ||
    normalized === 'off' ||
    normalized === 'false' ||
    normalized === 'disabled'
  ) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createToolLoopGuardState(): ToolLoopGuardState {
  return {
    bySignature: new Map(),
    byTool: new Map(),
    byToolFailure: new Map(),
    webSearchQueries: new Set(),
    total: 0,
  };
}








export function isSoftToolFailureResult(resultText: string | undefined): boolean {
  if (!resultText) return false;
  if (/^\s*(web_fetch_error|web_search_error)\b/i.test(resultText)) return true;
  if (/^\s*\S+\s+blocked automated access/i.test(resultText)) return true;
  
  
  
  
  
  const head = resultText.split(/\r?\n/).slice(0, 16).join('\n');
  if (!/^\s*source:\s+\S+/im.test(head)) return false;
  return (
    /^\s*http_ok:\s+false\b/im.test(head) ||
    /^\s*fetch_warning:\s+HTTP\s+(?:4\d\d|5\d\d)\b/im.test(head)
  );
}







export function recordToolLoopOutcome(
  state: ToolLoopGuardState,
  toolName: string,
  isError: boolean,
  resultText?: string
): void {
  if (!isError && !isSoftToolFailureResult(resultText)) return;
  state.byToolFailure.set(toolName, (state.byToolFailure.get(toolName) ?? 0) + 1);
}

export function formatToolLoopGuardMessage(reason: string, toolName: string): string {
  if (/has failed \d+ time/.test(reason)) {
    
    
    
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      `${toolName} is not returning usable results right now — STOP calling it.`,
      'Do NOT keep trying variations (different URLs, queries, or paths); that only wastes the turn.',
      'Answer the user with what you already have and state plainly that you could not retrieve the rest via this tool (and why). Never invent, assume, or describe the content you could not actually fetch.',
    ].join(' ');
  }
  if (/different queries/.test(reason)) {
    
    
    
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'The first search almost certainly returned the relevant results — re-searching the same topic with synonym variations does not improve them.',
      'Pick the most relevant result URL from the searches already done and call web_fetch on it, or answer with the evidence already gathered.',
      'Do not call web_search again for the same topic in this turn.',
    ].join(' ');
  }
  return [
    `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
    'Do not retry the same preset tool path immediately.',
    'If the preset tool is failing, pivot to an independent evidence source such as an available Web tool (for example web_fetch), local knowledge/files, lower-level device commands, or a simpler diagnostic tool.',
    'Then summarize what changed and continue only with a new approach, or ask the user for the missing decision.',
  ].join(' ');
}

export function shouldShortCircuitToolCall(
  state: ToolLoopGuardState,
  toolName: string,
  input: Record<string, unknown>
): string | null {
  const identicalLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_IDENTICAL_LIMIT',
    DEFAULT_IDENTICAL_TOOL_INPUT_LIMIT
  );
  const singleToolLimit = resolveOptionalPositiveIntEnv('MOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT');
  const totalLimit = resolveOptionalPositiveIntEnv('MOSS_TOOL_LOOP_TOTAL_LIMIT');
  const failureLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_FAILURE_LIMIT',
    DEFAULT_TOOL_FAILURE_LIMIT
  );
  const signature = `${toolName}:${stableSerializeToolInput(input)}`;
  const sameSignatureCount = state.bySignature.get(signature) ?? 0;
  const sameToolCount = state.byTool.get(toolName) ?? 0;
  const failureCount = state.byToolFailure.get(toolName) ?? 0;

  if (failureLimit !== undefined && failureCount >= failureLimit) {
    return `${toolName} has failed ${failureCount} time(s) in this user turn`;
  }
  if (identicalLimit !== undefined && sameSignatureCount >= identicalLimit) {
    return `identical input was already requested ${sameSignatureCount} time(s) in this user turn`;
  }
  if (
    singleToolLimit !== undefined &&
    !SINGLE_TOOL_LIMIT_EXEMPT_TOOLS.has(toolName) &&
    sameToolCount >= singleToolLimit
  ) {
    return `${toolName} has already been requested ${sameToolCount} time(s) in this user turn`;
  }
  if (totalLimit !== undefined && state.total >= totalLimit) {
    return `the user turn already requested ${state.total} tool call(s)`;
  }

  
  
  
  
  
  const webSearchVariationLimit = resolveOptionalPositiveIntEnv(
    'MOSS_WEB_SEARCH_VARIATION_LIMIT',
    DEFAULT_WEB_SEARCH_VARIATION_LIMIT
  );
  if (webSearchVariationLimit !== undefined && toolName === 'web_search') {
    const query = String(input?.query ?? '').trim().toLowerCase();
    if (query && !state.webSearchQueries.has(query)) {
      const distinctCount = state.webSearchQueries.size;
      if (distinctCount >= webSearchVariationLimit) {
        return `web_search has already been called with ${distinctCount} different queries in this user turn`;
      }
    }
  }

  state.bySignature.set(signature, sameSignatureCount + 1);
  state.byTool.set(toolName, sameToolCount + 1);
  state.total += 1;
  if (toolName === 'web_search') {
    const query = String(input?.query ?? '').trim().toLowerCase();
    if (query) state.webSearchQueries.add(query);
  }
  return null;
}
