/**
 * Output-limit stop reasons across the providers Moss talks to.
 *
 * OpenAI-compatible gateways use finish_reason "length" (some also send
 * "max_tokens"). Anthropic uses stop_reason "max_tokens". pi-ai surfaces
 * the same cutoff as stopReason "length". A truncated reply — thinking
 * only, mid-text, or mid tool-call JSON — must be recognized as a cutoff,
 * not as a model that refused to act.
 */

const OUTPUT_LIMIT_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'model_length',
]);

/** True when a finish/stop reason means the output token budget was exhausted. */
export function isOutputLimitStopReason(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  const normalized = reason
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return OUTPUT_LIMIT_REASONS.has(normalized);
}

export type ProviderStopSignal = 'length' | 'tool_use' | 'stop';

/**
 * Collapse a raw provider finish/stop reason into the three signals the
 * transport and the agent loop share. Unknown reasons stay "stop" so a
 * missing finish_reason is not treated as a cutoff.
 */
export function providerStopSignal(reason: string | null | undefined): ProviderStopSignal {
  if (typeof reason !== 'string') return 'stop';
  const normalized = reason
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (
    normalized === 'tool_calls' ||
    normalized === 'tool_use' ||
    normalized === 'toolcall' ||
    normalized === 'tooluse'
  ) {
    return 'tool_use';
  }
  if (isOutputLimitStopReason(normalized)) return 'length';
  return 'stop';
}
