import { parseEnvBoundedFloat, parseEnvBoundedInt } from '../utils/env-compat.js';

export const SUMMARY_OUTPUT_CAP_TOKENS = 20_000;

function resolveAutoCompactBuffer(): number {
  return parseEnvBoundedInt('MOSS_AUTOCOMPACT_BUFFER_TOKENS', 13_000, 1_000, 80_000);
}

export const AUTOCOMPACT_BUFFER_TOKENS = resolveAutoCompactBuffer();

export const WARNING_BAND_TOKENS = 20_000;

const MIN_EFFECTIVE_WINDOW = 4_000;

/**
 * Absolute floor for the prompt budget of a very small window. It is a floor on
 * the *reported* budget, never an excuse to exceed the configured window.
 */
const MIN_PROMPT_TOKENS = 512;

function resolveAutoCompactBufferRatio(): number {
  return parseEnvBoundedFloat('MOSS_AUTOCOMPACT_BUFFER_RATIO', 0.18, 0.05, 0.5);
}

const AUTOCOMPACT_BUFFER_RATIO = resolveAutoCompactBufferRatio();
const MIN_DYNAMIC_BUFFER = 2_000;

function resolveDynamicBuffer(effectiveContextWindowTokens: number): number {
  return Math.max(
    AUTOCOMPACT_BUFFER_TOKENS,
    Math.floor(effectiveContextWindowTokens * AUTOCOMPACT_BUFFER_RATIO),
    MIN_DYNAMIC_BUFFER
  );
}

/**
 * B70: windows small enough that the standard tool-result budgets no longer fit.
 * A 4096-token window with the tiny tool surface has ~300 tokens of headroom
 * after the prompt, so a 4k-token exec/read result is rejected by the provider on
 * the very next turn. Cap tool results to a share of the window instead.
 */
export const TINY_TOOL_RESULT_WINDOW_TOKENS = 6_000;

const TINY_TOOL_RESULT_RATIO = 0.1;
const TINY_TOOL_RESULT_FLOOR = 192;

/** Per-result token ceiling for the given window; undefined = use the tool's own budget. */
export function tinyWindowToolResultTokens(contextWindowTokens: number): number | undefined {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return undefined;
  if (contextWindowTokens > TINY_TOOL_RESULT_WINDOW_TOKENS) return undefined;
  return Math.max(TINY_TOOL_RESULT_FLOOR, Math.floor(contextWindowTokens * TINY_TOOL_RESULT_RATIO));
}

export function getEffectiveContextWindowTokens(
  contextWindowTokens: number,
  maxOutputTokens: number
): number {
  const configured = Math.max(1, Math.floor(contextWindowTokens));
  const reserved = Math.min(Math.max(0, maxOutputTokens), SUMMARY_OUTPUT_CAP_TOKENS);
  const usablePrompt = Math.max(0, configured - reserved);
  // B65: the old `max(MIN_EFFECTIVE_WINDOW, window - reserved)` floor could
  // report MORE prompt budget than the window has (a 4096-token model whose
  // output reservation is 1024 has 3072 prompt tokens, but the floor reported
  // 4000). The loop then grew the prompt past the provider's context limit and
  // the request failed with a context-length error instead of compacting first.
  // The floor may only lift the *reported* budget up to the window, never past it.
  const floor = Math.min(
    MIN_EFFECTIVE_WINDOW,
    Math.max(MIN_PROMPT_TOKENS, Math.floor(configured * 0.4))
  );
  return Math.min(configured, Math.max(Math.min(floor, configured), usablePrompt));
}

export function getProactiveCompactThreshold(effectiveContextWindowTokens: number): number {
  const effective = Math.max(1, Math.floor(effectiveContextWindowTokens));
  // The 4k floor is meaningful for a 32k window (it fires at 14.9k, from the
  // buffer) but on a small window it sat AT the window, so the proactive check
  // could never fire and only the hard cap ran. A floor at 75% of the effective
  // budget keeps the check usable without compacting on every turn.
  const floor = Math.min(MIN_EFFECTIVE_WINDOW, Math.max(1, Math.floor(effective * 0.75)));
  const byBuffer = effective - resolveDynamicBuffer(effective);
  return Math.min(effective - 1, Math.max(floor, byBuffer));
}

export function getContextWarningThreshold(effectiveContextWindowTokens: number): number {
  const proactive = getProactiveCompactThreshold(effectiveContextWindowTokens);
  const band = Math.min(WARNING_BAND_TOKENS, Math.floor(effectiveContextWindowTokens * 0.1));
  return Math.max(0, proactive - band);
}

export function shouldProactiveCompactByWindowEconomics(params: {
  estimatedPromptTokens: number;
  effectiveContextWindowTokens: number;
}): boolean {
  return (
    params.estimatedPromptTokens >=
    getProactiveCompactThreshold(params.effectiveContextWindowTokens)
  );
}
