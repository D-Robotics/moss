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

/** Discovery tools: repeated *failures* should stop sooner than generic tools. */
const DISCOVERY_TOOLS = new Set([
  'list_directory',
  'search_files',
  'search_code',
  'read_file',
  'device_file_list',
  'device_file_read',
  // CodeGraph navigation thrash (same failed hop / empty node spam).
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_trace',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_context',
  'codegraph_explore',
  'codegraph_files',
  'codegraph_status',
  // Skill catalog / load / install thrash.
  'skillhub_search',
  'skillhub_install',
  'install_skill',
  'load_skill',
  // Sub-agent spawn/status thrash (repeated failed fan-out / create / status).
  'create_subagent',
  'fan_out_subagents',
  'subagent_status',
  'subagent_stop',
  // Long-term memory thrash.
  'memory_read',
  'memory_write',
  'memory_delete',
  // Structured user interview thrash.
  'ask_user_question',
  // Plan / eval / structured-output thrash.
  'plan',
  'plan_step',
  'eval',
  'generate_structured',
  // Browser control thrash.
  'web_browser_fetch',
  'web_browser_control',
  // Vision / screenshot thrash.
  'vision_analyze',
  'screenshot_capture',
  // Device / fleet thrash (beyond file list/read already covered).
  'device_exec',
  'device_info',
  'device_temperature',
  'device_resources',
  'device_processes',
  'device_network',
  'device_cameras',
  'device_robotics_status',
  'fleet_batch',
]);

const DEFAULT_IDENTICAL_TOOL_INPUT_LIMIT = 3;
const DEFAULT_TOOL_FAILURE_LIMIT = 3;
/** Failed discovery retries on the same tool before short-circuit (stricter than generic 3). */
const DEFAULT_DISCOVERY_FAILURE_LIMIT = 2;







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

function normalizePathKey(raw: string): string {
  return raw.trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * All workspace paths touched by a surgical edit call. multi_edit / apply_patch
 * can touch many files — thrash must count every path, not only the first.
 * @internal exported for tests
 */
export function collectSurgicalEditPathKeys(input?: Record<string, unknown>): string[] {
  if (!input || typeof input !== 'object') return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const k = normalizePathKey(raw);
    if (!k || seen.has(k)) return;
    seen.add(k);
    keys.push(k);
  };

  // edit_file / write-style single path
  if (typeof input.path === 'string' && input.path.trim()) {
    add(input.path);
  }

  // multi_edit: every edits[].path
  if (Array.isArray(input.edits)) {
    for (const item of input.edits) {
      if (item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') {
        add(String((item as { path: string }).path));
      }
    }
  }

  // apply_patch: every Update/Delete/Add File line
  if (typeof input.patch === 'string' && input.patch.trim()) {
    const re = /\*\*\*\s+(?:Update|Delete|Add)\s+File:\s*(\S+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.patch)) !== null) {
      if (m[1]) add(m[1]);
    }
    if (keys.length === 0) {
      // Unparseable patch body — stable fallback so identical resubmits still count
      add(`patch:${input.patch.length}:${input.patch.slice(0, 64)}`);
    }
  }

  return keys;
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
  // Surgical edit thrash: count EVERY path only (like web_fetch per-URL).
  // multi_edit / apply_patch may touch several files — all must accumulate.
  // Do NOT also bump tool-level failure — that would block edits on other
  // files after three thrashing retries on one path.
  if (SURGICAL_EDIT_TOOLS.has(toolName)) {
    const pathKeys = collectSurgicalEditPathKeys(input);
    if (pathKeys.length > 0) {
      for (const pathKey of pathKeys) {
        state.byEditPathFailure.set(
          pathKey,
          (state.byEditPathFailure.get(pathKey) ?? 0) + 1,
        );
      }
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
  // Discovery / skill / sub-agent thrash: same input again.
  if (/identical input was already requested/i.test(reason)) {
    if (
      toolName === 'skillhub_search' ||
      toolName === 'skillhub_install' ||
      toolName === 'install_skill' ||
      toolName === 'load_skill'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already have that skill catalog/install/load result this turn — do not repeat the same query/slug/name.',
        'Next: change slug/keywords, `load_skill` after a successful install, or answer from results already returned.',
        'Never invent install/load outcomes you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'create_subagent' ||
      toolName === 'fan_out_subagents' ||
      toolName === 'subagent_status' ||
      toolName === 'subagent_stop'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that sub-agent call this turn — do not resubmit the same spawn/status/stop input.',
        'Next: change task/scope/label, wait on a different task id, merge evidence you have, or continue without another identical spawn.',
        'Never invent child SUCCESS from repeated failed or duplicate sub-agent calls.',
      ].join(' ');
    }
    if (
      toolName === 'memory_read' ||
      toolName === 'memory_write' ||
      toolName === 'memory_delete'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already have that memory result this turn — do not repeat the same query/content/id.',
        'Next: change the query, write a different durable fact, or continue with evidence already retrieved.',
        'Never invent memories you did not observe.',
      ].join(' ');
    }
    if (toolName === 'ask_user_question') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already asked that structured question set this turn — do not resubmit the same interview.',
        'Next: proceed with the answers already collected, ask a *different* clarifying question, or implement against a stated assumption.',
        'Never invent user choices you did not receive.',
      ].join(' ');
    }
    if (
      toolName === 'plan' ||
      toolName === 'plan_step' ||
      toolName === 'eval' ||
      toolName === 'generate_structured'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that plan/eval/structured call this turn — do not resubmit the same payload.',
        'Next: change planId/step/action/schema, continue execution, or answer with results already returned.',
        'Never invent plan progress or eval scores you did not observe.',
      ].join(' ');
    }
    if (toolName === 'web_browser_fetch' || toolName === 'web_browser_control') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that browser call this turn — do not resubmit the same navigation/control payload.',
        'Next: change URL/selector/action, use web_fetch for static pages, or answer from page text already returned.',
        'Never invent browser DOM state you did not observe.',
      ].join(' ');
    }
    if (toolName === 'vision_analyze' || toolName === 'screenshot_capture') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that vision/screenshot call this turn — do not resubmit the same image/target payload.',
        'Next: analyze a different image/region, or answer from vision results already returned.',
        'Never invent image contents you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'device_exec' ||
      toolName === 'device_info' ||
      toolName === 'device_temperature' ||
      toolName === 'device_resources' ||
      toolName === 'device_processes' ||
      toolName === 'device_network' ||
      toolName === 'device_cameras' ||
      toolName === 'device_robotics_status' ||
      toolName === 'fleet_batch'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already issued that device/fleet call this turn — do not resubmit the same command/target payload.',
        'Next: change the command/board/target, or answer from device evidence already returned.',
        'Never invent board state you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'list_directory' ||
      toolName === 'search_code' ||
      toolName === 'search_files' ||
      toolName === 'read_file' ||
      toolName.startsWith('codegraph_')
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'You already have that discovery result in this turn — do not re-list or re-search the same target.',
        'Next: open the specific paths you need with `read_file`, refine with a *different* glob/pattern/path, or answer from evidence already gathered.',
        'If stuck, use create_subagent scope=explore for an open-ended pass instead of repeating the same listing.',
      ].join(' ');
    }
  }
  if (/has failed \d+ time/.test(reason) && !/^web_fetch on /.test(reason)) {
    if (
      toolName === 'skillhub_search' ||
      toolName === 'skillhub_install' ||
      toolName === 'install_skill' ||
      toolName === 'load_skill'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Skill discovery/install/load is failing repeatedly — STOP retrying the same query or skill name/slug.',
        'Change keywords/slug, try a different skill, or continue without that skill using general methods.',
        'Never invent skill bodies or install success you did not observe.',
      ].join(' ');
    }
    if (
      toolName === 'create_subagent' ||
      toolName === 'fan_out_subagents' ||
      toolName === 'subagent_status' ||
      toolName === 'subagent_stop'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Sub-agent tools are failing repeatedly — STOP retrying the same spawn/status/stop call.',
        'Change task/scope, reduce fan-out width, fix the underlying error, or continue with parent tools only.',
        'Never invent child SUCCESS after repeated sub-agent failures.',
      ].join(' ');
    }
    if (
      toolName === 'memory_read' ||
      toolName === 'memory_write' ||
      toolName === 'memory_delete'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Memory tools are failing repeatedly — STOP retrying the same query/content/id.',
        'Change the query, skip writing if the store rejects the content, or continue without that memory.',
        'Never invent stored memories you did not observe.',
      ].join(' ');
    }
    if (toolName === 'ask_user_question') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Structured user questions are failing repeatedly — STOP resubmitting the same ask_user_question payload.',
        'Simplify the questions, proceed with a stated assumption, or ask one freeform question in the reply instead.',
        'Never invent user answers you did not receive.',
      ].join(' ');
    }
    if (
      toolName === 'plan' ||
      toolName === 'plan_step' ||
      toolName === 'eval' ||
      toolName === 'generate_structured'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Plan/eval/structured tools are failing repeatedly — STOP retrying the same action/payload.',
        'Fix planId/schema/suite definition, use a different action, or continue with parent coding tools.',
        'Never invent plan completion or eval results after repeated failures.',
      ].join(' ');
    }
    if (toolName === 'web_browser_fetch' || toolName === 'web_browser_control') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Browser tools are failing repeatedly — STOP retrying the same navigation/control call.',
        'Change URL/selector, fall back to web_fetch for static content, or report the blocker.',
        'Never invent page contents after repeated browser failures.',
      ].join(' ');
    }
    if (toolName === 'vision_analyze' || toolName === 'screenshot_capture') {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Vision/screenshot tools are failing repeatedly — STOP retrying the same image/target.',
        'Change the image/path/region, or report that vision is unavailable.',
        'Never invent image analysis after repeated failures.',
      ].join(' ');
    }
    if (
      toolName === 'device_exec' ||
      toolName === 'device_info' ||
      toolName === 'device_temperature' ||
      toolName === 'device_resources' ||
      toolName === 'device_processes' ||
      toolName === 'device_network' ||
      toolName === 'device_cameras' ||
      toolName === 'device_robotics_status' ||
      toolName === 'fleet_batch'
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Device/fleet tools are failing repeatedly — STOP retrying the same board command/target.',
        'Check connectivity, change the command, or report the board blocker.',
        'Never invent device telemetry after repeated failures.',
      ].join(' ');
    }
    if (
      toolName === 'list_directory' ||
      toolName === 'search_code' ||
      toolName === 'search_files' ||
      toolName === 'read_file' ||
      toolName === 'device_file_list' ||
      toolName === 'device_file_read' ||
      toolName.startsWith('codegraph_')
    ) {
      return [
        `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
        'Discovery is failing repeatedly — STOP retrying the same list/search/read/codegraph hop.',
        'Change the path/pattern/symbol, use a different tool (`search_files` vs `search_code` vs `codegraph_*` vs `list_directory`), or spawn create_subagent scope=explore.',
        'Answer with what you already have; never invent file listings, call graphs, or search hits you did not observe.',
      ].join(' ');
    }
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
  const discoveryFailureLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_DISCOVERY_FAILURE_LIMIT',
    DEFAULT_DISCOVERY_FAILURE_LIMIT,
  );
  const editPathFailureLimit = resolveOptionalPositiveIntEnv(
    'MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT',
    DEFAULT_EDIT_PATH_FAILURE_LIMIT,
  );
  const signature = `${toolName}:${stableSerializeToolInput(input)}`;
  const sameSignatureCount = state.bySignature.get(signature) ?? 0;
  const sameToolCount = state.byTool.get(toolName) ?? 0;
  const failureCount = state.byToolFailure.get(toolName) ?? 0;
  const effectiveFailureLimit =
    DISCOVERY_TOOLS.has(toolName) && discoveryFailureLimit !== undefined
      ? discoveryFailureLimit
      : failureLimit;

  // Per-path edit thrash: block when ANY path in this call is already over the
  // limit (multi_edit/apply_patch can thrash a later path while the first is clean).
  if (SURGICAL_EDIT_TOOLS.has(toolName) && editPathFailureLimit !== undefined) {
    const pathKeys = collectSurgicalEditPathKeys(input);
    for (const pathKey of pathKeys) {
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
  } else if (effectiveFailureLimit !== undefined && failureCount >= effectiveFailureLimit) {
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
