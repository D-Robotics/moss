const BASE_TOOL_OUTPUT_LIMITS: Record<string, number> = {
  device_exec: 6_000,
  device_file_read: 10_000,
  read: 10_000,
  web_search: 2_250,
  web_fetch: 8_000,
  device_diagnose: 3_000,
  exec: 4_500,
  bash: 4_500,
};

let _extraToolOutputLimits: Record<string, number> = {};

export function registerToolOutputLimits(limits: Record<string, number>): void {
  _extraToolOutputLimits = { ..._extraToolOutputLimits, ...limits };
}

function getToolOutputLimitTokens(toolName: string): number {
  return (
    _extraToolOutputLimits[toolName] ?? BASE_TOOL_OUTPUT_LIMITS[toolName] ?? DEFAULT_LIMIT_TOKENS
  );
}

const DEFAULT_LIMIT_TOKENS = 4_000;
const BYTES_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

/**
 * Per-tool recovery hint appended to the elision notice. The dropped middle is
 * gone from context, so the notice must say how to fetch just that slice —
 * otherwise the model re-reads the whole thing and burns a turn (Task OS M12
 * finding #2: 2-3 blind re-read turns per coding run).
 */
const TRUNCATION_RECOVERY_HINTS: Record<string, string> = {
  read: 'the dropped region is not in context — re-read only it with offset/limit',
  device_file_read: 'the dropped region is not in context — page it with offset/limit',
  exec: 'output was cut — narrow the command (grep/head/tail) to the slice you need',
  bash: 'output was cut — narrow the command (grep/head/tail) to the slice you need',
  device_exec: 'output was cut — narrow the remote command to the slice you need',
};

/**
 * True when `truncateToolOutput` would drop part of this output. Tool
 * implementations use it to avoid promising that a body is still in context
 * when the budget will elide it.
 */
export function wouldTruncateToolOutput(toolName: string, output: string): boolean {
  return estimateTokens(output) > getToolOutputLimitTokens(toolName);
}

export function truncateToolOutput(toolName: string, output: string): string {
  const limitTokens = getToolOutputLimitTokens(toolName);
  const outputTokens = estimateTokens(output);

  if (outputTokens <= limitTokens) return output;

  const limitBytes = limitTokens * BYTES_PER_TOKEN;
  const halfBytes = Math.floor(limitBytes / 2);

  const headEnd = avoidRedactionCut(
    output,
    findSafeSlicePoint(output, halfBytes, 'forward'),
    'forward'
  );
  const tailStart = avoidRedactionCut(
    output,
    findSafeSlicePoint(output, halfBytes, 'backward'),
    'backward'
  );

  if (headEnd >= tailStart) return output;

  const head = output.slice(0, headEnd);
  const tail = output.slice(tailStart);
  const droppedTokens = estimateTokens(output.slice(headEnd, tailStart));
  const hint = TRUNCATION_RECOVERY_HINTS[toolName];
  const notice = `…${droppedTokens} tokens truncated${hint ? ` (${hint})` : ''}…`;

  let truncated = `${head}\n\n${notice}\n\n${tail}`;
  if (keepsRdkDocUrls(toolName)) {
    const missing = citeableHttpUrls(output).filter((url) => !truncated.includes(url));
    if (missing.length > 0) truncated += `\n\nDoc URLs:\n${missing.join('\n')}`;
  }
  return truncated;
}

/** Wire prefix from `mcpServerWirePrefix('rdk-docs')`. Server id, not a tool-name substring. */
const RDK_DOCS_TOOL_PREFIX = 'mcp__rdk-docs__';

function keepsRdkDocUrls(toolName: string): boolean {
  return toolName.startsWith(RDK_DOCS_TOOL_PREFIX);
}

/** Drop userinfo and query. Keep `#anchor`. A redacted password is removed, not cited. */
function citeableUrl(raw: string): string | null {
  const stripped = raw.replace(/^(https?:\/\/)[^/\s@]*:[^@/\s]*@/i, '$1');
  try {
    const url = new URL(stripped);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function citeableHttpUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  // Drop userinfo first so `[REDACTED]` in a password does not end the match at `]`.
  const normalized = text.replace(/(https?:\/\/)[^/\s@]*:[^@/\s]*@/gi, '$1');
  for (const match of normalized.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/g)) {
    const raw = match[0].replace(/[.,;:]+$/, '');
    const url = citeableUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

// The budget is in UTF-8 bytes but string indices are UTF-16 code units; for
// multi-byte text (CJK, emoji) they are not interchangeable. Convert with a
// binary search over Buffer.byteLength so the kept head/tail respect the byte
// budget, and never land inside a surrogate pair.
function prefixCharIndexForBytes(text: string, budgetBytes: number): number {
  if (budgetBytes <= 0) return 0;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budgetBytes) lo = mid;
    else hi = mid - 1;
  }
  const prev = lo > 0 ? text.charCodeAt(lo - 1) : 0;
  const next = lo < text.length ? text.charCodeAt(lo) : 0;
  const splitsPair = prev >= 0xd800 && prev <= 0xdbff && !(next >= 0xdc00 && next <= 0xdfff);
  return splitsPair ? lo - 1 : lo;
}

function suffixCharIndexForBytes(text: string, budgetBytes: number): number {
  if (budgetBytes <= 0) return text.length;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= budgetBytes) hi = mid;
    else lo = mid + 1;
  }
  const at = lo < text.length ? text.charCodeAt(lo) : 0;
  const startsMidPair = at >= 0xdc00 && at <= 0xdfff;
  return startsMidPair ? lo + 1 : lo;
}

const REDACTION_MARKER = '[REDACTED]';

/** A cut that lands inside `[REDACTED]` moves to the marker edge so the token stays whole. */
function avoidRedactionCut(text: string, index: number, direction: 'forward' | 'backward'): number {
  let from = Math.max(0, index - REDACTION_MARKER.length);
  while (from < index + REDACTION_MARKER.length) {
    const at = text.indexOf(REDACTION_MARKER, from);
    if (at < 0 || at >= index + REDACTION_MARKER.length) break;
    const end = at + REDACTION_MARKER.length;
    if (index > at && index < end) return direction === 'forward' ? at : end;
    from = at + 1;
  }
  return index;
}

function findSafeSlicePoint(
  text: string,
  targetBytes: number,
  direction: 'forward' | 'backward'
): number {
  const approxCharIndex =
    direction === 'forward'
      ? prefixCharIndexForBytes(text, targetBytes)
      : suffixCharIndexForBytes(text, targetBytes);

  if (direction === 'forward') {
    const searchStart = Math.max(0, approxCharIndex - 100);
    const searchEnd = Math.min(text.length, approxCharIndex + 100);
    const newlineIdx = text.lastIndexOf('\n', searchEnd);
    if (newlineIdx >= searchStart) return newlineIdx + 1;
    return approxCharIndex;
  }

  const searchStart = Math.max(0, approxCharIndex - 100);
  const searchEnd = Math.min(text.length, approxCharIndex + 100);
  const newlineIdx = text.indexOf('\n', searchStart);
  if (newlineIdx >= 0 && newlineIdx <= searchEnd) return newlineIdx;
  return approxCharIndex;
}
