/**
 * Context-overflow detection — merged from Pi's `utils/overflow.ts` (v0.80.3)
 * and moss's existing Chinese + inline patterns.
 *
 * Used by `isContextOverflowError` (errors.ts) and `matchContextLengthExceeded`
 * (error-classify.ts) to trigger compaction / escalation when the prompt
 * exceeds the model's context window.
 *
 * Pi contributes precise per-provider regex patterns (Anthropic, OpenAI,
 * Bedrock, Google, xAI, Groq, OpenRouter, Together, llama.cpp, LM Studio,
 * GitHub Copilot, MiniMax, Kimi, DS4, Cerebras, Mistral, z.ai, Ollama).
 * moss contributes Chinese patterns (上下文过长, 输入超限, tokens过多, etc.)
 * and a few moss-specific English patterns.
 */

// ── Pi v0.80.3 patterns (per-provider, regex) ──────────────────────────────
const PI_OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long/i, // Bedrock / minimal proxies (bare variant — found by moss self-iteration)
  /input is too long for requested model/i, // Amazon Bedrock (full)
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of \(?[\d,]+\)? tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow
  /context[_ ]length[_ ]exceeded/i, // Generic fallback (underscore/hyphen variants)
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 400/413 with no body
];

// ── moss Chinese + moss-specific English patterns ───────────────────────────
const MOSS_OVERFLOW_PATTERNS: RegExp[] = [
  // Chinese — moss serves Chinese users; Pi doesn't have these
  /上下文\s*(?:长度|窗口)?\s*(?:超限|超过|溢出|超长|超出)/i,
  /(?:超过|超出)\s*(?:最大)?\s*上下文/i,
  /prompt\s*过长/i,
  /输入\s*(?:过长|超限|超长)/i,
  /(?:消息|文本|请求).*过长/i,
  /token\s*(?:超限|不足|溢出|过多)/i,
  /(?:超过|超出).*?\btokens?\b/i,
  /上下文过长|上下文超长|上下文超限|上下文超出|上下文长度/i,
  /请求过长|请求超长/i,
  /超过最大|超出最大/i,
  /tokens?\s*超限|tokens?\s*过多/i,
  // moss-specific English not covered by Pi
  /exceeds model context window/i,
  /context window is full/i,
  /exceeds (?:the )?maximum (?:input )?length/i,
  /maximum input length/i,
  /context window(?: exceeded)?/i,
  /max(?:imum)?_tokens/i,
];

const ALL_OVERFLOW_PATTERNS = [...PI_OVERFLOW_PATTERNS, ...MOSS_OVERFLOW_PATTERNS];

/**
 * Detect context-overflow from an error message string. Tests against all
 * known provider patterns (Pi's 25+ regexes + moss's Chinese + moss-specific).
 * Case-insensitive.
 */
export function isOverflowMessage(message: string): boolean {
  if (!message) return false;
  return ALL_OVERFLOW_PATTERNS.some((re) => re.test(message));
}

/** Exported for testing — returns the full pattern list. */
export function getOverflowPatterns(): RegExp[] {
  return [...ALL_OVERFLOW_PATTERNS];
}
