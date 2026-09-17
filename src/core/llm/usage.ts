export interface NormalizedPromptUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  /** Prompt tokens read from cache, excluded from inputTokens. */
  cacheReadTokens?: number;
  /** Prompt tokens written to cache, excluded from inputTokens. */
  cacheCreationTokens?: number;
}

export function totalPromptTokens(usage: NormalizedPromptUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
}
