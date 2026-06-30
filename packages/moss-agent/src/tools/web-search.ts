/**
 * `web_search` — keyless-by-default web search tool for the Agent.
 *
 * Companion to `web_fetch` (see web-fetch.ts): where `web_fetch` retrieves a
 * *known* URL, `web_search` *discovers* URLs from a query — "search the web",
 * "find the official docs for X", "look up this error message".
 *
 * Design (mirrors web-fetch.ts):
 *   - Zero hard dependency beyond global `fetch` (Node 18+).
 *   - Pluggable backend: keyless **Bing** by default (reachable without a
 *     proxy in regions where DuckDuckGo is not, e.g. mainland China);
 *     keyless **DuckDuckGo** as fallback or by explicit `provider` choice;
 *     **Brave** when an API key is supplied; or a host-injected `search`
 *     function (e.g. a multi-engine backplane). Tool name + `query` input
 *     stay stable so consumers work regardless of backend.
 *   - Safe-by-default: per-call timeout, result cap, fixed provider host
 *     (the model's query is URL-encoded into a constant host — no SSRF surface).
 *   - Returns a compact, source-linked result list for the LLM to act on
 *     (typically followed by a `web_fetch` on the most relevant result).
 *   - **Reliability note**: Keyless backends (Bing, DuckDuckGo HTML/Lite) are
 *     increasingly blocked by anti-bot measures. For reliable search, configure
 *     an API key: **BOCHA_API_KEY** for mainland China, or **BRAVE_API_KEY**
 *     for international access. Without an API key, search may fail if the
 *     backend is blocked; set `fallback: false` in options to fail fast when
 *     the primary backend is unavailable.
 *
 * Intentionally **not**:
 *   - A crawler or browser — follow up with `web_fetch` to read a result.
 *   - A ranking engine — it returns the provider's order verbatim.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { getRootLogger } from '../logger.js';
import { MossError, ErrorCode , errorMessage} from '../errors.js';

const log = getRootLogger().child('tool:web-search');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_CAP = 20;
/** Default attempts per backend (1 retry). Keyless endpoints often clear a transient anti-bot page on a second try. */
const DEFAULT_RETRY_ATTEMPTS = 2;
/** Base backoff between attempts (exponential, with jitter). */
const DEFAULT_RETRY_BASE_DELAY_MS = 400;
/** Upper bound on any single backoff sleep. */
const RETRY_MAX_DELAY_MS = 4_000;
/**
 * Shared recovery guidance for keyless-backend blocked/anti-bot failures.
 * Kept as a single constant so the China/international API-key advice never
 * drifts between the Bing / DuckDuckGo / DuckDuckGo-Lite error sites.
 */
const SEARCH_BACKEND_KEY_GUIDANCE =
  'Configure an API key for reliable search: BOCHA_API_KEY (set provider: "bocha", recommended for mainland China) for Bocha, or BRAVE_API_KEY (set provider: "brave", for international access) for Brave. Or call web_fetch on a specific known URL instead.';

/** Browser-like UA: public search endpoints reject the default agent UA. Overridable. */
const DEFAULT_UA =
  'Mozilla/5.0 (compatible; moss-agent/0.1; +https://github.com/D-Robotics/moss)';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchBackendOptions {
  maxResults: number;
  timeoutMs: number;
  signal?: AbortSignal;
  region?: string;
  userAgent: string;
}

/** A pluggable search backend. Receives the raw query, returns ranked results. */
export type WebSearchBackend = (
  query: string,
  opts: WebSearchBackendOptions,
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

function coerceString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return fallback;
  return String(v);
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const known = HTML_ENTITIES[entity];
    if (known !== undefined) return known;
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * DuckDuckGo wraps result links in a `/l/?uddg=<encoded-target>` redirect.
 * Unwrap it so the LLM gets a directly fetchable URL.
 */
function unwrapDuckDuckGoHref(href: string): string {
  const normalized = href.startsWith('//') ? `https:${href}` : href;
  try {
    const u = new URL(normalized, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) {
      return normalized; // redirect we couldn't decode — return as-is
    }
    return u.toString();
  } catch {
    return normalized;
  }
}

interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<FetchTextResult> {
  // An already-aborted signal must not issue a fetch: addEventListener('abort')
  // below never fires if the signal aborted before the listener was attached.
  if (outerSignal?.aborted) {
    throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    if (outerSignal?.aborted) {
      throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
    }
    if (controller.signal.aborted) {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
        message: `web_search: provider timed out after ${timeoutMs}ms`,
        recoverable: true,
      });
    }
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: provider request failed: ${errorMessage(err)}`,
      recoverable: true,
    });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

/** Keyless DuckDuckGo HTML-endpoint backend. */
export async function duckDuckGoSearch(
  query: string,
  opts: WebSearchBackendOptions,
): Promise<WebSearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: opts.region || 'wt-wt' });
  const { ok, status, text } = await fetchWithTimeout(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': opts.userAgent,
        accept: 'text/html',
      },
      body: body.toString(),
    },
    opts.timeoutMs,
    opts.signal,
  );

  if (!ok) {
    throw new MossError({
      code: status === 429 ? ErrorCode.PROVIDER_RATE_LIMITED : ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: DuckDuckGo returned HTTP ${status}`,
      hint:
        status === 429
          ? 'Rate-limited by DuckDuckGo. Retry shortly, or configure a Brave API key (provider: "brave").'
          : undefined,
      recoverable: true,
    });
  }

  const results: WebSearchResult[] = [];
  // Each result is a `result__a` anchor (title + href); the following
  // `result__snippet` (anchor or div) holds the description.
  const linkRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(text)) !== null) snippets.push(stripTags(sm[1]));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(text)) !== null && results.length < opts.maxResults) {
    const url = unwrapDuckDuckGoHref(lm[1]);
    const title = stripTags(lm[2]);
    if (!title || !/^https?:\/\//i.test(url)) {
      i++;
      continue;
    }
    results.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
  if (results.length === 0 && duckDuckGoResponseLooksBlocked(text)) {
    // DuckDuckGo's keyless HTML endpoint increasingly serves an anti-bot
    // "anomaly"/challenge page (HTTP 200, no result markup). Reporting that as
    // "No results" misleads the model into thinking the topic has no information
    // (a confabulation hazard) and makes it retry the same dead query. Tell the truth.
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message:
        'web_search: DuckDuckGo blocked automated access (anti-bot/anomaly page) — no results could be retrieved. This is a backend failure, NOT an empty result set; do not infer the topic has no information.',
      hint:
        SEARCH_BACKEND_KEY_GUIDANCE,
      recoverable: true,
    });
  }
  return results;
}

/**
 * Given DuckDuckGo's HTML response body that yielded zero parsed results, decide
 * whether the backend is blocked/broken (anti-bot/anomaly page, or no result markup
 * at all) vs a genuinely empty result set. Exported for testing.
 */
export function duckDuckGoResponseLooksBlocked(text: string): boolean {
  const looksBlocked =
    /anomaly|challenge-form|captcha|unusual traffic|detected unusual|are you a (?:human|robot)/i.test(text);
  // Recognize both the html endpoint (`result__a`/`result__snippet`) and the
  // Lite endpoint (`result-link`/`result-snippet`) markup so a genuinely empty
  // page on either surface is not misreported as blocked.
  const hasResultMarkup =
    /result__a|result__snippet|result-link|result-snippet|no-results|results_links/i.test(text);
  return looksBlocked || !hasResultMarkup;
}

/**
 * Keyless DuckDuckGo **Lite**-endpoint backend. The Lite surface (a minimal
 * table-based page) frequently succeeds when the main html endpoint serves an
 * anti-bot/anomaly page, so it serves as the keyless fallback for
 * {@link duckDuckGoSearch}. Same redirect-unwrapping and blocked-page detection.
 */
export async function duckDuckGoLiteSearch(
  query: string,
  opts: WebSearchBackendOptions,
): Promise<WebSearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: opts.region || 'wt-wt' });
  const { ok, status, text } = await fetchWithTimeout(
    'https://lite.duckduckgo.com/lite/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': opts.userAgent,
        accept: 'text/html',
      },
      body: body.toString(),
    },
    opts.timeoutMs,
    opts.signal,
  );

  if (!ok) {
    throw new MossError({
      code: status === 429 ? ErrorCode.PROVIDER_RATE_LIMITED : ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: DuckDuckGo Lite returned HTTP ${status}`,
      hint:
        status === 429
          ? 'Rate-limited by DuckDuckGo. Retry shortly, or configure a Brave API key (provider: "brave").'
          : undefined,
      recoverable: true,
    });
  }

  const results: WebSearchResult[] = [];
  // Lite results are `result-link` anchors (title + href); the matching
  // `result-snippet` cell holds the description.
  const linkRe =
    /<a[^>]+class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(text)) !== null) snippets.push(stripTags(sm[1]));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(text)) !== null && results.length < opts.maxResults) {
    const url = unwrapDuckDuckGoHref(lm[1]);
    const title = stripTags(lm[2]);
    if (!title || !/^https?:\/\//i.test(url)) {
      i++;
      continue;
    }
    results.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
  if (results.length === 0 && duckDuckGoResponseLooksBlocked(text)) {
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message:
        'web_search: DuckDuckGo Lite blocked automated access (anti-bot/anomaly page) — no results could be retrieved. This is a backend failure, NOT an empty result set; do not infer the topic has no information.',
      hint:
        SEARCH_BACKEND_KEY_GUIDANCE,
      recoverable: true,
    });
  }
  return results;
}

/**
 * Bing wraps some result links in a `/ck/a?...&u=a1<base64url-target>` redirect.
 * Unwrap it so the LLM gets a directly fetchable URL. Hrefs arrive HTML-entity
 * encoded (`&amp;`), so decode before parsing.
 */
function unwrapBingHref(href: string): string {
  const normalized = decodeEntities(href);
  try {
    const u = new URL(normalized, 'https://www.bing.com');
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const wrapped = u.searchParams.get('u');
      if (wrapped && wrapped.startsWith('a1')) {
        const b64 = wrapped.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
      return normalized; // redirect we couldn't decode — return as-is
    }
    return u.toString();
  } catch {
    return normalized;
  }
}

/**
 * Keyless Bing web-search backend (GET `www.bing.com/search`). Default primary:
 * unlike the DuckDuckGo endpoints it is directly reachable from networks where
 * duckduckgo.com is blocked (e.g. mainland China), and it serves parseable
 * `b_algo` result markup to a plain HTTP client. Same blocked-page honesty
 * contract as the DuckDuckGo backends.
 * @beta
 */
export async function bingSearch(
  query: string,
  opts: WebSearchBackendOptions,
): Promise<WebSearchResult[]> {
  const u = new URL('https://www.bing.com/search');
  u.searchParams.set('q', query);
  u.searchParams.set('count', String(opts.maxResults));
  if (opts.region) u.searchParams.set('mkt', opts.region);
  const { ok, status, text } = await fetchWithTimeout(
    u.toString(),
    {
      method: 'GET',
      headers: { 'user-agent': opts.userAgent, accept: 'text/html' },
    },
    opts.timeoutMs,
    opts.signal,
  );

  if (!ok) {
    throw new MossError({
      code: status === 429 ? ErrorCode.PROVIDER_RATE_LIMITED : ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: Bing returned HTTP ${status}`,
      hint:
        status === 429
          ? 'Rate-limited by Bing. Retry shortly, or configure a Brave API key (provider: "brave").'
          : undefined,
      recoverable: true,
    });
  }

  // Each organic result is a `b_algo` block whose `<h2><a href>` carries the
  // title + target; the matching `b_caption` paragraph holds the description.
  // Index-paired scans, same approach as the DuckDuckGo backends.
  const results: WebSearchResult[] = [];
  const linkRe = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
  const snippetRe = /class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(text)) !== null) snippets.push(stripTags(sm[1]));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(text)) !== null && results.length < opts.maxResults) {
    const url = unwrapBingHref(lm[1]);
    const title = stripTags(lm[2]);
    if (!title || !/^https?:\/\//i.test(url)) {
      i++;
      continue;
    }
    results.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
  if (results.length === 0 && bingResponseLooksBlocked(text)) {
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message:
        'web_search: Bing blocked automated access (captcha/anti-bot page) — no results could be retrieved. This is a backend failure, NOT an empty result set; do not infer the topic has no information.',
      hint:
        SEARCH_BACKEND_KEY_GUIDANCE,
      recoverable: true,
    });
  }
  return results;
}

/**
 * Given Bing's HTML response body that yielded zero parsed results, decide
 * whether the backend is blocked/broken (captcha page, or no result markup at
 * all) vs a genuinely empty result set (`b_no` marker). Exported for testing.
 */
export function bingResponseLooksBlocked(text: string): boolean {
  const looksBlocked = /captcha|challenge|verify you are|unusual traffic|异常流量/i.test(text);
  const hasResultMarkup = /b_algo|b_no|b_results/i.test(text);
  return looksBlocked || !hasResultMarkup;
}

/** Brave Search API backend (requires an API key). */
export function createBraveSearch(apiKey: string): WebSearchBackend {
  return async (query, opts) => {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(opts.maxResults));
    if (opts.region) u.searchParams.set('country', opts.region);
    const { ok, status, text } = await fetchWithTimeout(
      u.toString(),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': opts.userAgent,
          'x-subscription-token': apiKey,
        },
      },
      opts.timeoutMs,
      opts.signal,
    );
    if (!ok) {
      throw new MossError({
        code:
          status === 401 || status === 403
            ? ErrorCode.PROVIDER_AUTH_FAILED
            : status === 429
              ? ErrorCode.PROVIDER_RATE_LIMITED
              : ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: `web_search: Brave returned HTTP ${status}`,
        recoverable: status === 429 || status >= 500,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'web_search: Brave returned non-JSON response',
        recoverable: true,
      });
    }
    const rows = (json as { web?: { results?: unknown[] } })?.web?.results ?? [];
    const results: WebSearchResult[] = [];
    for (const row of rows) {
      const r = row as { title?: unknown; url?: unknown; description?: unknown };
      const url = coerceString(r.url);
      if (!/^https?:\/\//i.test(url)) continue;
      results.push({
        title: stripTags(coerceString(r.title)) || url,
        url,
        snippet: stripTags(coerceString(r.description)),
      });
      if (results.length >= opts.maxResults) break;
    }
    return results;
  };
}

/** Bocha (博查) Search API backend (requires an API key). */
export function createBochaSearch(apiKey: string): WebSearchBackend {
  return async (query, opts) => {
    const u = new URL('https://api.bochaai.com/v1/web-search');
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(opts.maxResults));
    const { ok, status, text } = await fetchWithTimeout(
      u.toString(),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': opts.userAgent,
          authorization: `Bearer ${apiKey}`,
        },
      },
      opts.timeoutMs,
      opts.signal,
    );
    if (!ok) {
      throw new MossError({
        code:
          status === 401 || status === 403
            ? ErrorCode.PROVIDER_AUTH_FAILED
            : status === 429
              ? ErrorCode.PROVIDER_RATE_LIMITED
              : ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: `web_search: Bocha returned HTTP ${status}`,
        recoverable: status === 429 || status >= 500,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'web_search: Bocha returned non-JSON response',
        recoverable: true,
      });
    }
    const rows =
      (json as { data?: { webPages?: { value?: unknown[] } } })?.data?.webPages
        ?.value ?? [];
    const results: WebSearchResult[] = [];
    for (const row of rows) {
      const r = row as { name?: unknown; url?: unknown; snippet?: unknown; summary?: unknown };
      const url = coerceString(r.url);
      if (!/^https?:\/\//i.test(url)) continue;
      results.push({
        title: stripTags(coerceString(r.name)) || url,
        url,
        snippet: stripTags(coerceString(r.summary || r.snippet)),
      });
      if (results.length >= opts.maxResults) break;
    }
    return results;
  };
}

/** Exa Search API backend (requires an API key). */
export function createExaSearch(apiKey: string): WebSearchBackend {
  return async (query, opts) => {
    const { ok, status, text } = await fetchWithTimeout(
      'https://api.exa.ai/search',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': opts.userAgent,
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          query,
          numResults: opts.maxResults,
          contents: { text: true, highlights: true },
        }),
      },
      opts.timeoutMs,
      opts.signal,
    );
    if (!ok) {
      throw new MossError({
        code:
          status === 401 || status === 403
            ? ErrorCode.PROVIDER_AUTH_FAILED
            : status === 429
              ? ErrorCode.PROVIDER_RATE_LIMITED
              : ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: `web_search: Exa returned HTTP ${status}`,
        recoverable: status === 429 || status >= 500,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'web_search: Exa returned non-JSON response',
        recoverable: true,
      });
    }
    const rows = (json as { results?: unknown[] })?.results ?? [];
    const results: WebSearchResult[] = [];
    for (const row of rows) {
      const r = row as { title?: unknown; url?: unknown; text?: unknown; highlights?: unknown[] };
      const url = coerceString(r.url);
      if (!/^https?:\/\//i.test(url)) continue;
      const highlights = Array.isArray(r.highlights) ? r.highlights : [];
      const snippet =
        highlights.length > 0
          ? coerceString(highlights[0])
          : coerceString(r.text);
      results.push({
        title: stripTags(coerceString(r.title)) || url,
        url,
        snippet: stripTags(snippet),
      });
      if (results.length >= opts.maxResults) break;
    }
    return results;
  };
}

interface NamedBackend {
  name: string;
  backend: WebSearchBackend;
}

interface ResolvedRetry {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Abort-aware default sleep used between retry attempts. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof MossError && err.code === ErrorCode.USER_ABORTED;
}

function isRecoverableError(err: unknown): boolean {
  return err instanceof MossError && err.recoverable === true && err.code !== ErrorCode.USER_ABORTED;
}

function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs * 0.5;
  return Math.min(RETRY_MAX_DELAY_MS, exp + jitter);
}

/**
 * Resolve the ordered backend chain. A custom `search` backend bypasses the
 * chain (host owns routing). Otherwise: Brave is used (and, with fallback on,
 * prepended) whenever an API key is available; the keyless Bing, DuckDuckGo
 * HTML, and DuckDuckGo Lite endpoints provide a no-key fallback. Selecting
 * `provider: 'brave'` without a key still fails fast at construction.
 *
 * If no API keys are configured and fallback is enabled, logs a warning that
 * keyless backends are increasingly blocked by anti-bot measures and may fail.
 */
function resolveBackendChain(opts: WebSearchOptions): NamedBackend[] {
  if (opts.search) return [{ name: 'custom', backend: opts.search }];

  const provider = opts.provider ?? 'bing';
  const braveKey = opts.apiKey ?? process.env.BRAVE_API_KEY;
  const bochaKey = opts.bochaApiKey ?? process.env.BOCHA_API_KEY;
  const exaKey = opts.exaApiKey ?? process.env.EXA_API_KEY;
  const braveBackend = (): NamedBackend => {
    if (!braveKey) {
      throw new MossError({
        code: ErrorCode.PROVIDER_CONFIG_MISSING,
        message: 'web_search: Brave provider selected but no API key',
        hint: 'Pass `apiKey` to createWebSearchTool or set BRAVE_API_KEY.',
        recoverable: false,
      });
    }
    return { name: 'brave', backend: createBraveSearch(braveKey) };
  };
  const bochaBackend = (): NamedBackend => {
    if (!bochaKey) {
      throw new MossError({
        code: ErrorCode.PROVIDER_CONFIG_MISSING,
        message: 'web_search: Bocha provider selected but no API key',
        hint: 'Pass `bochaApiKey` to createWebSearchTool or set BOCHA_API_KEY.',
        recoverable: false,
      });
    }
    return { name: 'bocha', backend: createBochaSearch(bochaKey) };
  };
  const exaBackend = (): NamedBackend => {
    if (!exaKey) {
      throw new MossError({
        code: ErrorCode.PROVIDER_CONFIG_MISSING,
        message: 'web_search: Exa provider selected but no API key',
        hint: 'Pass `exaApiKey` to createWebSearchTool or set EXA_API_KEY.',
        recoverable: false,
      });
    }
    return { name: 'exa', backend: createExaSearch(exaKey) };
  };

  // Primary: explicit keyed provider, or auto-selected when a key is present;
  // otherwise the explicitly chosen keyless endpoint (default Bing).
  let primary: NamedBackend;
  if (provider === 'brave' || braveKey) primary = braveBackend();
  else if (provider === 'bocha' || bochaKey) primary = bochaBackend();
  else if (provider === 'exa' || exaKey) primary = exaBackend();
  else if (provider === 'duckduckgo') primary = { name: 'duckduckgo', backend: duckDuckGoSearch };
  else primary = { name: 'bing', backend: bingSearch };

  if (opts.fallback === false) return [primary];

  const chain: NamedBackend[] = [primary];
  for (const candidate of [
    { name: 'bing', backend: bingSearch },
    { name: 'duckduckgo', backend: duckDuckGoSearch },
    { name: 'duckduckgo-lite', backend: duckDuckGoLiteSearch },
  ] satisfies NamedBackend[]) {
    if (!chain.some((c) => c.name === candidate.name)) chain.push(candidate);
  }

  // No API keys configured — running on the keyless backend chain. This is a
  // working default, not a failure: keyless Bing is reachable without a proxy
  // (including from mainland China) and returns usable results. Surface it only
  // at debug level so it aids diagnosis without alarming every startup. If a
  // real search later fails because every backend is blocked, *that* error's
  // hint (SEARCH_BACKEND_KEY_GUIDANCE) points the user to Bocha/Brave — guidance
  // belongs at the point of actual failure, not unconditionally at construction.
  const isKeylessOnly = chain.every((c) => ['bing', 'duckduckgo', 'duckduckgo-lite'].includes(c.name));
  if (isKeylessOnly && !braveKey && !bochaKey && !exaKey) {
    log.debug(
      'web_search: no API keys configured; using keyless backend chain (Bing → DuckDuckGo). ' +
        'Configure BOCHA_API_KEY or BRAVE_API_KEY for higher reliability.',
    );
  }

  return chain;
}

/** Run one backend with bounded retry-with-backoff on recoverable errors. */
async function runBackendWithRetry(
  backend: WebSearchBackend,
  query: string,
  opts: WebSearchBackendOptions,
  retry: ResolvedRetry,
): Promise<WebSearchResult[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
    }
    try {
      return await backend(query, opts);
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;
      if (!isRecoverableError(err) || attempt >= retry.maxAttempts) throw err;
      await retry.sleep(backoffDelay(attempt, retry.baseDelayMs), opts.signal);
    }
  }
  throw lastErr; // unreachable: the loop always returns or throws
}

/**
 * Try each backend in order. A backend that returns hits wins immediately. A
 * genuinely empty (but successful) result is remembered and reported only if no
 * later backend finds hits. Recoverable/non-recoverable failures fall through to
 * the next backend; the last error is rethrown if every backend fails. User
 * aborts short-circuit immediately.
 */
async function searchWithFallback(
  chain: NamedBackend[],
  query: string,
  opts: WebSearchBackendOptions,
  retry: ResolvedRetry,
): Promise<WebSearchResult[]> {
  let sawEmptySuccess = false;
  let lastErr: unknown;
  for (const { backend } of chain) {
    if (opts.signal?.aborted) {
      throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
    }
    try {
      const results = await runBackendWithRetry(backend, query, opts, retry);
      if (results.length > 0) return results;
      sawEmptySuccess = true; // valid empty answer — try the next engine for hits
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastErr = err;
    }
  }
  if (sawEmptySuccess) return [];
  if (lastErr) throw lastErr;
  return [];
}

// ── Query preprocessing ──────────────────────────────────────────────

/** Detect CJK (Chinese/Japanese/Korean) characters in a query. */
function containsCjk(text: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

interface PreprocessedQuery {
  query: string;
  region?: string;
  siteHint?: string;
}

/**
 * Preprocess a raw LLM search query before passing it to a backend:
 * - Detect CJK characters and auto-set `region` to `zh-CN` (improves Bing recall
 *   for Chinese queries — without `mkt=zh-CN`, Bing often returns Western results).
 * - Strip `site:` operators and `OR`/`AND` boolean syntax that keyless HTML
 *   backends (Bing, DuckDuckGo) do not support reliably — they cause empty
 *   results or timeouts. Extract the `site:` domain as a hint for the LLM.
 */
/** @beta Exported for testing. */
export function preprocessQuery(rawQuery: string, region?: string): PreprocessedQuery {
  let query = rawQuery;
  let resolvedRegion = region;
  let siteHint: string | undefined;

  // Extract site: filters before stripping them.
  const siteMatches = [...query.matchAll(/site:(\S+)/gi)];
  if (siteMatches.length > 0) {
    siteHint = siteMatches.map((m) => m[1]).join(', ');
    query = query.replace(/\s*site:\S+/gi, '').trim();
  }

  // Strip boolean operators that keyless backends don't support.
  query = query.replace(/\b(OR|AND)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();

  // Auto-set region for CJK queries if not explicitly configured.
  if (!resolvedRegion && containsCjk(query)) {
    resolvedRegion = 'zh-CN';
  }

  return { query, region: resolvedRegion, siteHint };
}

function formatResults(query: string, results: WebSearchResult[], siteHint?: string): string {
  const siteNote = siteHint
    ? `\n\nTip: to search within ${siteHint}, use web_fetch on that site's URL directly — keyless search backends do not support the site: operator reliably.`
    : '';

  if (results.length === 0) {
    return (
      `No results for "${query}". ` +
      'If you know a relevant URL (e.g. the official website), call web_fetch on it directly — keyless search backends often miss niche/brand topics.' +
      siteNote
    );
  }

  // Detect potentially irrelevant results: all snippets empty or very short.
  const allSnippetsEmpty = results.every((r) => !r.snippet || r.snippet.trim().length < 10);
  const irrelevanceNote = allSnippetsEmpty
    ? '\n\nNote: snippets are empty or very short — results may be irrelevant. Verify by fetching the top result URL with web_fetch before relying on the content.'
    : '';

  const lines = results.map((r, idx) => {
    const snippet = r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : '';
    return `${idx + 1}. ${r.title}\n   ${r.url}${snippet}`;
  });
  return `Found ${results.length} result(s) for "${query}":\n\n${lines.join('\n\n')}${irrelevanceNote}${siteNote}`;
}

export function createWebSearchTool(opts: WebSearchOptions = {}): Tool<{ query: string; max_results?: number }> {
  const defaultMax = Math.min(Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS), MAX_RESULTS_CAP);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const region = opts.region;
  const retry: ResolvedRetry = {
    maxAttempts: Math.max(1, Math.trunc(opts.retry?.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS)),
    baseDelayMs: Math.max(0, opts.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
    sleep: opts.retry?.sleep ?? defaultSleep,
  };
  // Resolve eagerly so an explicit but misconfigured Brave key surfaces at
  // registration; the keyless default chain is always constructible.
  const chain = resolveBackendChain(opts);

  return {
    name: 'web_search',
    description:
      'Search the web and return a ranked list of results (title, URL, snippet). ' +
      'Use this to discover official documentation, look up an error message, or find a page when you do not know its URL. ' +
      'Use concise keywords (not full sentences). For brand/company searches, if you know the official website URL, call web_fetch directly instead of searching. ' +
      'Avoid site: operators or boolean syntax (OR, AND) — keyless backends do not support them. To search within a specific site, use web_fetch on that site instead. ' +
      'Follow up with web_fetch on the most relevant result to read its contents.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
      permissionBoundary:
        'Performs an outbound HTTP(S) query to a fixed search provider; the model query is URL-encoded (no SSRF surface).',
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — keywords, a question, or a verbatim error message.',
        },
        max_results: {
          type: 'number',
          description: `Maximum results to return (default ${defaultMax}, max ${MAX_RESULTS_CAP}).`,
        },
      },
      required: ['query'],
    },
    async execute(input, ctx: ToolContext) {
      const rawQuery = coerceString(input?.query).trim();
      if (!rawQuery) {
        throw new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: 'web_search: query is required',
          hint: 'Pass a non-empty `query`, e.g. "RDK X5 BPU model conversion docs".',
          recoverable: false,
        });
      }
      const maxResults = Math.min(
        Math.max(1, Number(input?.max_results) || defaultMax),
        MAX_RESULTS_CAP,
      );

      const { query, region: effectiveRegion, siteHint } = preprocessQuery(rawQuery, region);
      if (!query) {
        return formatResults(rawQuery, [], siteHint);
      }
      log.debug('start', { rawQuery, query, maxResults, region: effectiveRegion, chain: chain.map((c) => c.name) });
      const started = Date.now();
      const results = await searchWithFallback(
        chain,
        query,
        { maxResults, timeoutMs, signal: ctx.abortSignal, region: effectiveRegion, userAgent },
        retry,
      );
      log.debug('done', { query, count: results.length, ms: Date.now() - started });
      return formatResults(query, results.slice(0, maxResults), siteHint);
    },
  };
}
