/**
 * Shared contracts for the `web_search` tool and its pluggable backends.
 * These types are consumed by every web-search module, so they live in one
 * dependency-free home and are re-exported by the directory index.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  /** Publisher/feed name when the backend can identify it. */
  sourceName?: string;
  /** Publisher homepage or canonical source URL when supplied by the feed. */
  sourceUrl?: string;
}

export interface WebSearchBackendOptions {
  maxResults: number;
  timeoutMs: number;
  signal?: AbortSignal;
  region?: string;
  userAgent: string;
  recency?: 'day' | 'week' | 'month' | 'year';
}

/** A pluggable search backend. Receives the raw query, returns ranked results. */
export type WebSearchBackend = (
  query: string,
  opts: WebSearchBackendOptions
) => Promise<WebSearchResult[]>;

/**
 * Bounded retry policy for transient/recoverable backend failures
 * (rate-limit, timeout, upstream/anti-bot). Each backend in the fallback chain
 * is retried independently before the chain moves on to the next backend.
 * @beta
 */
export interface WebSearchRetryOptions {
  /** Max attempts per backend (≥1). Default 2 (i.e. 1 retry). */
  maxAttempts?: number;
  /** Base backoff delay in ms; grows exponentially with jitter, capped. Default 400. */
  baseDelayMs?: number;
  /**
   * Injectable sleep, primarily for tests. Must reject (or resolve fast) when
   * `signal` aborts. Default: an abort-aware `setTimeout`.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface WebSearchOptions {
  /**
   * Custom backend. Takes precedence over `provider`. Use this to route to a
   * proprietary search API or a multi-engine backplane. When set, the keyless
   * fallback chain is bypassed entirely (the host owns routing).
   */
  search?: WebSearchBackend;
  /** Built-in provider when `search` is not supplied. Default: `bing`. */
  provider?: 'bing' | 'duckduckgo' | 'brave' | 'bocha' | 'exa';
  /** API key for providers that need one (brave). Falls back to `BRAVE_API_KEY`. */
  apiKey?: string;
  /** API key for the Bocha search backend. Falls back to `BOCHA_API_KEY`. */
  bochaApiKey?: string;
  /** API key for the Exa search backend. Falls back to `EXA_API_KEY`. */
  exaApiKey?: string;
  /** Default max results (capped at 20). Default 8. */
  maxResults?: number;
  /** Per-call timeout in ms. Default 15 000. */
  timeoutMs?: number;
  /** Region / locale hint, e.g. `zh-CN` (Bing `mkt` / Brave) or `wt-wt` (DDG). */
  region?: string;
  /**
   * Recency filter: restrict results to the given time range.
   * Passed to keyless backends (Bing, DDG, Baidu) as their native filter parameter.
   */
  recency?: 'day' | 'week' | 'month' | 'year';
  /** Custom User-Agent. */
  userAgent?: string;
  /**
   * Per-backend retry-with-backoff for recoverable failures. Default 2 attempts.
   * @beta
   */
  retry?: WebSearchRetryOptions;
  /**
   * Keyless provider fallback chain. When true (default), a blocked/failed
   * primary backend falls through to the next available keyless endpoint
   * (Bing → DuckDuckGo HTML → DuckDuckGo Lite; Brave is prepended automatically
   * when an API key is present). Set false to use only the single resolved
   * backend. Ignored when a custom `search` backend is supplied.
   * @beta
   */
  fallback?: boolean;
}
