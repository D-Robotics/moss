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







// Default 6 — headroom for a few genuinely different search angles (a Chinese
// query, an English query, the brand name, a refined keyword set) before
// blocking the 7th. The old cap of 4 was too tight: with the keyless backend
// often returning degraded results the model legitimately needs more than one
// refinement, and a 4-query cap drove it into guessing URLs instead. Override
// via MOSS_WEB_SEARCH_VARIATION_LIMIT.
const DEFAULT_WEB_SEARCH_VARIATION_LIMIT = 6;

/** Surgical edit tools that thrash when old_string / patch body is stale. */
const SURGICAL_EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'apply_patch']);

/** Max failed surgical edits per path before forcing re-read (identical input limit still applies). */
const DEFAULT_EDIT_PATH_FAILURE_LIMIT = 3;

export type ToolLoopGuardState = {
  bySignature: Map<string, number>;
  byTool: Map<string, number>;
  byToolFailure: Map<string, number>;
  // Per-URL failure count for web_fetch. web_fetch targets are independent
  // (different hosts fail for different reasons — a 401 on Reuters says
  // nothing about whether IEEE's RSS is fetchable), so a tool-level failure
  // cap would punish legitimate source-switching. Only a *single URL*
  // failing repeatedly counts toward blocking that URL.
  byWebFetchUrlFailure: Map<string, number>;
  /**
   * Per-file surgical-edit failures (edit_file / multi_edit). Prevents
   * thrashing the same path with slightly different old_string after reads
   * go stale — Claude Code "read then edit" discipline at the loop layer.
   */
  byEditPathFailure: Map<string, number>;

  webSearchQueries: Set<string>;
  freshNewsSearchRequested: boolean;
  hasSufficientRssNewsEvidence: boolean;
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

function normalizeEditPathKey(input?: Record<string, unknown>): string | null {
  if (!input || typeof input !== 'object') return null;
  // edit_file: path; multi_edit: first edits[].path (all-or-nothing batch)
  const direct = input.path;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim().replace(/\\/g, '/').toLowerCase();
  }
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const first = edits[0] as { path?: unknown };
    if (typeof first?.path === 'string' && first.path.trim()) {
      return first.path.trim().replace(/\\/g, '/').toLowerCase();
    }
  }
  // apply_patch: extract first Update/Delete/Add file path from patch body
  const patch = input.patch;
  if (typeof patch === 'string' && patch.trim()) {
    const m = patch.match(/\*\*\*\s+(?:Update|Delete|Add)\s+File:\s*(\S+)/i);
    if (m?.[1]) return m[1].trim().replace(/\\/g, '/').toLowerCase();
    // Fall back to a stable hash-ish key of the whole patch so identical
    // resubmits still trip the thrash counter even without a parseable path.
    return `patch:${patch.length}:${patch.slice(0, 64).toLowerCase()}`;
  }
  return null;
}

export function createToolLoopGuardState(): ToolLoopGuardState {
  return {
    bySignature: new Map(),
    byTool: new Map(),
    byToolFailure: new Map(),
    byWebFetchUrlFailure: new Map(),
    byEditPathFailure: new Map(),
    webSearchQueries: new Set(),
    freshNewsSearchRequested: false,
    hasSufficientRssNewsEvidence: false,
    total: 0,
  };
}








// Normalize a web_fetch URL to a stable key for per-URL failure counting.
// Strips the fragment and a trailing slash so trivial variations (a `#section`
// anchor, a cosmetic trailing slash) don't let the model reset the counter on
// what is effectively the same fetch. Query string is kept — different query
// strings can be genuinely different resources. Returns null if the input has
// no usable URL (empty, wrong type, or unparseable), in which case callers
// fall back to tool-level tracking rather than silently dropping the signal.
function normalizeWebFetchUrlKey(input: unknown): string | null {
  const raw = typeof input === 'object' && input !== null
    ? String((input as Record<string, unknown>)?.url ?? '').trim()
    : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    const key = `${url.origin}${url.pathname}${url.search}`.replace(/\/$/, '') || url.origin;
    return key || null;
  } catch {
    // Not a valid absolute URL — key on the raw string so repeated identical
    // garbage still counts, but distinct garbage strings don't collide.
    return raw;
  }
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
  resultText?: string,
  input?: Record<string, unknown>
): void {
  if (
    toolName === 'web_search' &&
    !isError &&
    /RSS news snapshot: dated publisher\/feed summaries above are sufficient/i.test(resultText ?? '')
  ) {
    state.hasSufficientRssNewsEvidence = true;
  }
  if (!isError && !isSoftToolFailureResult(resultText)) return;
  // web_fetch failures are tracked per-URL (see ToolLoopGuardState) so that a
  // failed host doesn't poison the tool's reputation for unrelated hosts.
  if (toolName === 'web_fetch') {
    const url = normalizeWebFetchUrlKey(input);
    if (url) {
      state.byWebFetchUrlFailure.set(url, (state.byWebFetchUrlFailure.get(url) ?? 0) + 1);
      return;
    }
    // No URL to key on (shouldn't happen for web_fetch) — fall through to the
    // generic tool-level counter rather than silently dropping the signal.
  }
  // Surgical edit thrash: count per path only (like web_fetch per-URL).
  // Do NOT also bump tool-level failure — that would block edits on other
  // files after three thrashing retries on one path.
  if (SURGICAL_EDIT_TOOLS.has(toolName)) {
    const pathKey = normalizeEditPathKey(input);
    if (pathKey) {
      state.byEditPathFailure.set(
        pathKey,
        (state.byEditPathFailure.get(pathKey) ?? 0) + 1,
      );
      return;
    }
  }
  state.byToolFailure.set(toolName, (state.byToolFailure.get(toolName) ?? 0) + 1);
}

export function formatToolLoopGuardMessage(reason: string, toolName: string): string {
  if (/fresh-news search is already in progress/i.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'Wait for and use the first result instead of launching parallel language or keyword variants.',
      'If that result is empty, a later assistant step may try one refined query.',
    ].join(' ');
  }
  if (/dated RSS news snapshot/i.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'The current turn already has dated headlines, publisher names, source URLs, and summaries.',
      'Answer now using that evidence; do not broaden the search merely to restate the same news.',
      'Only continue with a known original publisher page when the user explicitly requested full-text verification of a specific claim.',
    ].join(' ');
  }
  // Per-URL web_fetch failure: only this *specific URL* is stuck, not the
  // whole tool. Tell the model to drop this URL and keep going elsewhere —
  // the opposite of the tool-level failure message below.
  if (/^web_fetch on .+ has failed \d+ time/.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'This specific URL is not returning usable results — STOP retrying THIS URL.',
      'Other URLs are still fine: you may web_fetch a different source, or answer with the evidence already gathered.',
      'Never invent, assume, or describe the content you could not actually fetch.',
    ].join(' ');
  }
  if (/^edit thrash on /.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'This path has already rejected repeated surgical edits/patches.',
      'STOP retrying edit_file/multi_edit/apply_patch with the same body.',
      'Call `read_file` on that path, rebuild the edit from exact current text, then retry — or switch approach (smaller context, replace_all only when intentional).',
    ].join(' ');
  }
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
      'If the previous search results were relevant, pick the best URL and call web_fetch on it.',
      'If the results were irrelevant or empty, stop searching — try web_fetch on a known official URL, or answer with the evidence already gathered.',
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
  input: Record<string, unknown>,
  options: { parallelBatch?: boolean } = {},
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
  const editPathFailureLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT',
    DEFAULT_EDIT_PATH_FAILURE_LIMIT,
  );
  const signature = `${toolName}:${stableSerializeToolInput(input)}`;
  const sameSignatureCount = state.bySignature.get(signature) ?? 0;
  const sameToolCount = state.byTool.get(toolName) ?? 0;
  const failureCount = state.byToolFailure.get(toolName) ?? 0;

  // Per-path edit thrash: block further edit_file/multi_edit on a path after
  // N failures (even with different old_string) so the model re-reads.
  if (SURGICAL_EDIT_TOOLS.has(toolName) && editPathFailureLimit !== undefined) {
    const pathKey = normalizeEditPathKey(input);
    if (pathKey) {
      const pathFails = state.byEditPathFailure.get(pathKey) ?? 0;
      if (pathFails >= editPathFailureLimit) {
        return `edit thrash on ${pathKey}: ${pathFails} failed surgical edit(s) this turn`;
      }
    }
  }

  if (toolName === 'web_search' && state.hasSufficientRssNewsEvidence) {
    return 'this user turn already has a dated RSS news snapshot with sufficient publisher provenance';
  }
  if (
    toolName === 'web_search' &&
    state.freshNewsSearchRequested &&
    !options.parallelBatch &&
    (input?.recency === 'day' || input?.recency === 'week')
  ) {
    return 'a fresh-news search is already in progress in this assistant step';
  }

  // web_fetch failures are tracked per-URL (see ToolLoopGuardState), so the
  // block decision for a given web_fetch call keys off its own URL, not the
  // aggregate tool-level counter. A different URL that has never failed stays
  // at 0 and is never blocked by other hosts' failures.
  if (toolName === 'web_fetch' && failureLimit !== undefined) {
    const urlKey = normalizeWebFetchUrlKey(input);
    if (urlKey) {
      const urlFailureCount = state.byWebFetchUrlFailure.get(urlKey) ?? 0;
      if (urlFailureCount >= failureLimit) {
        return `web_fetch on ${urlKey} has failed ${urlFailureCount} time(s) in this user turn`;
      }
    }
    // web_fetch without a URL (or with an unparseable one) skips the
    // failure-based short-circuit entirely — there's no stable key to count
    // against, and the identical-input / single-tool / total guards below
    // still bound it.
  } else if (failureLimit !== undefined && failureCount >= failureLimit) {
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
    if (input?.recency === 'day' || input?.recency === 'week') {
      state.freshNewsSearchRequested = true;
    }
  }
  return null;
}
