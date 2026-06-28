











import { parseEnvBoundedFloat, parseEnvBoundedInt } from '../utils/env-compat.js';


export const SUMMARY_OUTPUT_CAP_TOKENS = 20_000;







function resolveAutoCompactBuffer(): number {
  return parseEnvBoundedInt('MOSS_AUTOCOMPACT_BUFFER_TOKENS', 13_000, 1_000, 80_000);
}

export const AUTOCOMPACT_BUFFER_TOKENS = resolveAutoCompactBuffer();


export const WARNING_BAND_TOKENS = 20_000;

const MIN_EFFECTIVE_WINDOW = 4_000;










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




export function getEffectiveContextWindowTokens(
  contextWindowTokens: number,
  maxOutputTokens: number
): number {
  const reserved = Math.min(Math.max(0, maxOutputTokens), SUMMARY_OUTPUT_CAP_TOKENS);
  return Math.max(MIN_EFFECTIVE_WINDOW, contextWindowTokens - reserved);
}





export function getProactiveCompactThreshold(effectiveContextWindowTokens: number): number {
  return Math.max(
    MIN_EFFECTIVE_WINDOW,
    effectiveContextWindowTokens - resolveDynamicBuffer(effectiveContextWindowTokens)
  );
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
