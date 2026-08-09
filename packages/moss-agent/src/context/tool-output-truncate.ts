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

  return `${head}\n\n…${droppedTokens} tokens truncated…\n\n${tail}`;
}

function findSafeSlicePoint(
  text: string,
  targetBytes: number,
  direction: 'forward' | 'backward'
): number {
  const approxCharIndex = Math.min(text.length, Math.floor(targetBytes));

  if (direction === 'forward') {
    const searchStart = Math.max(0, approxCharIndex - 100);
    const searchEnd = Math.min(text.length, approxCharIndex + 100);
    const newlineIdx = text.lastIndexOf('\n', searchEnd);
    if (newlineIdx >= searchStart) return newlineIdx + 1;
    return approxCharIndex;
  }

  const searchStart = Math.max(0, text.length - approxCharIndex - 100);
  const searchEnd = Math.min(text.length, text.length - approxCharIndex + 100);
  const newlineIdx = text.indexOf('\n', searchStart);
  if (newlineIdx >= 0 && newlineIdx <= searchEnd) return newlineIdx;
  return text.length - approxCharIndex;
}
