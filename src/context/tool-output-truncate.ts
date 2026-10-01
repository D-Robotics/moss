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

  const headEnd = findSafeSlicePoint(output, halfBytes, 'forward');
  const tailStart = findSafeSlicePoint(output, halfBytes, 'backward');

  if (headEnd >= tailStart) return output;

  const head = output.slice(0, headEnd);
  const tail = output.slice(tailStart);
  const droppedTokens = estimateTokens(output.slice(headEnd, tailStart));
  const hint = TRUNCATION_RECOVERY_HINTS[toolName];
  const notice = `…${droppedTokens} tokens truncated${hint ? ` (${hint})` : ''}…`;

  return `${head}\n\n${notice}\n\n${tail}`;
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
