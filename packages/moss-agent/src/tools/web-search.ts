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
import { createRssSearchBackend, parseUserFeeds } from './rss-search.js';

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
/** Grace window for the first backend in the parallel race: if it hasn't returned
 *  non-empty results within this window, the next backend is also launched. */
const RACE_PRIMARY_GRACE_MS = 2_500;
/**
 * Shared recovery guidance for keyless-backend blocked/anti-bot failures.
 * Kept as a single constant so the China/international API-key advice never
 * drifts between the Bing / DuckDuckGo / DuckDuckGo-Lite error sites.
 */
const SEARCH_BACKEND_KEY_GUIDANCE =
  'Configure an API key for reliable search: BOCHA_API_KEY (set provider: "bocha", recommended for mainland China) for Bocha, or BRAVE_API_KEY (set provider: "brave", for international access) for Brave. Or call web_fetch on a specific known URL instead.';

/** Browser-like UA: public search endpoints reject the default agent UA. Overridable. */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
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
  if (opts.recency) {
    const dfMap: Record<string, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };
    body.set('df', dfMap[opts.recency]);
  }
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
  if (opts.recency) {
    const dfMap: Record<string, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };
    body.set('df', dfMap[opts.recency]);
  }
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
  if (opts.recency) {
    const filterMap: Record<string, string> = { day: '"1 day"', week: '"1 week"', month: '"1 month"', year: '"1 year"' };
    u.searchParams.set('filters', `exft:${filterMap[opts.recency]}`);
  }
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

/**
 * Baidu wraps result links in `http://www.baidu.com/link?url=<base64-target>`.
 * Decode the base64 url parameter to get the real target URL.
 */
function unwrapBaiduHref(href: string): string {
  const normalized = decodeEntities(href);
  try {
    const u = new URL(normalized, 'https://www.baidu.com');
    if (u.hostname.endsWith('baidu.com') && u.pathname.startsWith('/link')) {
      const urlParam = u.searchParams.get('url');
      if (urlParam) {
        const b64 = urlParam.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        try {
          const decoded = Buffer.from(padded, 'base64').toString('utf8');
          if (/^https?:\/\//i.test(decoded)) return decoded;
        } catch { /* not valid base64 — fall through */ }
      }
      return normalized;
    }
    return u.toString();
  } catch {
    return normalized;
  }
}

/**
 * Keyless Baidu web-search backend (GET `www.baidu.com/s`). Useful for CJK
 * queries where Baidu's index is strongest. Parses organic result blocks,
 * filters ads (tuiguang / promoted), and extracts dates from c-color-gray spans.
 * @beta
 */
export async function baiduSearch(
  query: string,
  opts: WebSearchBackendOptions,
): Promise<WebSearchResult[]> {
  const u = new URL('https://www.baidu.com/s');
  u.searchParams.set('wd', query);
  u.searchParams.set('rn', String(opts.maxResults));

  if (opts.recency) {
    const now = Date.now();
    const dayMs = 86_400_000;
    const offsets: Record<string, number> = { day: dayMs, week: 7 * dayMs, month: 30 * dayMs, year: 365 * dayMs };
    const start = now - (offsets[opts.recency] ?? dayMs);
    u.searchParams.set('gpc', `stf=${start},${now}`);
  }

  const { ok, status, text } = await fetchWithTimeout(
    u.toString(),
    { method: 'GET', headers: { 'user-agent': opts.userAgent, accept: 'text/html' } },
    opts.timeoutMs,
    opts.signal,
  );

  if (!ok) {
    throw new MossError({
      code: status === 429 ? ErrorCode.PROVIDER_RATE_LIMITED : ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: Baidu returned HTTP ${status}`,
      hint: status === 429 ? 'Rate-limited by Baidu. Retry shortly.' : undefined,
      recoverable: true,
    });
  }

  // Split at each result-container opening tag, keeping the tag in the odd
  // indices so we can inspect its attributes for ad markers.
  const blockParts = text.split(/(<div[^>]*?class="result c-container[^"]*"[^>]*?>)/);
  // blockParts[0] = prefix, [1] = open tag, [2] = content, [3] = next open tag, ...

  const results: WebSearchResult[] = [];
  for (let i = 1; i + 1 < blockParts.length && results.length < opts.maxResults; i += 2) {
    const openTag = blockParts[i];
    const content = blockParts[i + 1];

    // Filter ads: skip if the container has data-tuiguang, ec_tuiguang, or result-op class
    if (/(?:data-tuiguang|ec_tuiguang|result-op)/.test(openTag)) continue;

    // Extract link: <a href="..." data-url="..." >title</a>
    const aMatch = content.match(/<a[^>]+?href="([^"]+)"[^>]*?>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const href = aMatch[1];
    const title = stripTags(aMatch[2]);
    if (!title) continue;

    // data-url attribute on the anchor carries the real URL when present
    const dataUrlMatch = aMatch[0].match(/data-url="([^"]+)"/i);
    const url = dataUrlMatch ? dataUrlMatch[1] : unwrapBaiduHref(href);
    if (!/^https?:\/\//i.test(url)) continue;

    // Extract snippet from c-abstract
    const snippetMatch = content.match(/<div[^>]*?class="c-abstract[^"]*?"[^>]*?>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';

    // Extract date from c-color-gray span
    const dateMatch = content.match(/<span[^>]*?class="c-color-gray[^"]*?"[^>]*?>([^<]*)<\/span>/i);
    const date = dateMatch ? stripTags(dateMatch[1]) : undefined;

    results.push({ title, url, snippet, ...(date ? { date } : {}) });
  }

  if (results.length === 0 && baiduResponseLooksBlocked(text)) {
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message:
        'web_search: Baidu blocked automated access (anti-bot/verification page) — no results could be retrieved.',
      hint: SEARCH_BACKEND_KEY_GUIDANCE,
      recoverable: true,
    });
  }
  return results;
}

/**
 * Given Baidu's HTML response body that yielded zero parsed results, decide
 * whether the backend is blocked/broken (verification page, or no result markup)
 * vs a genuinely empty result set. Exported for testing.
 */
export function baiduResponseLooksBlocked(text: string): boolean {
  const looksBlocked = /验证|安全检查|captcha|unusual|deny|access denied/i.test(text);
  const hasResultMarkup = /result c-container|result-op|bai\d+/i.test(text);
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
    // Bocha's official API is POST with a JSON body ({query, count, summary,
    // freshness}). The previous implementation used GET with ?q= query params,
    // which the endpoint does not accept — every keyed request failed and fell
    // through silently to the keyless chain, so a configured/bundled key never
    // actually worked. freshness (recency) is added in a separate change.
    const { ok, status, text } = await fetchWithTimeout(
      'https://api.bochaai.com/v1/web-search',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': opts.userAgent,
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          count: opts.maxResults,
          summary: true,
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
 * When `isCjk` is true, the Baidu keyless backend is inserted after Bing
 * (before DuckDuckGo), since Baidu's index is strongest for CJK queries.
 *
 * If no API keys are configured and fallback is enabled, logs a warning that
 * keyless backends are increasingly blocked by anti-bot measures and may fail.
 * @beta Exported for testing.
 */
export function resolveBackendChain(opts: WebSearchOptions, isCjk = false): NamedBackend[] {
  if (opts.search) return [{ name: 'custom', backend: opts.search }];

  const provider = opts.provider ?? 'bing';
  const braveKey = opts.apiKey ?? process.env.BRAVE_API_KEY;
  const bochaKey = opts.bochaApiKey ?? process.env.BOCHA_API_KEY;
  const exaKey = opts.exaApiKey ?? process.env.EXA_API_KEY;
  // RSS backend: supplements keyless search with structured, dated entries from
  // curated feeds. Enabled by default (no key needed). Disabled via
  // MOSS_NO_RSS=1 or by passing fallback: false.
  const rssEnabled = process.env.MOSS_NO_RSS !== '1' && opts.fallback !== false;
  const rssFeeds = parseUserFeeds();
  const rssBackend = rssEnabled
    ? { name: 'rss', backend: createRssSearchBackend({ feeds: rssFeeds.length > 0 ? rssFeeds : undefined }) }
    : null;
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
  // CJK queries get Baidu inserted after Bing (before DuckDuckGo);
  // non-CJK queries skip Baidu (no advantage for English queries).
  const fallbackCandidates: NamedBackend[] = isCjk
    ? [
        { name: 'bing', backend: bingSearch },
        { name: 'baidu', backend: baiduSearch },
        ...(rssBackend ? [rssBackend] : []),
        { name: 'duckduckgo', backend: duckDuckGoSearch },
        { name: 'duckduckgo-lite', backend: duckDuckGoLiteSearch },
      ]
    : [
        { name: 'bing', backend: bingSearch },
        ...(rssBackend ? [rssBackend] : []),
        { name: 'duckduckgo', backend: duckDuckGoSearch },
        { name: 'duckduckgo-lite', backend: duckDuckGoLiteSearch },
      ];
  for (const candidate of fallbackCandidates) {
    if (!chain.some((c) => c.name === candidate.name)) chain.push(candidate);
  }

  // No API keys configured — running on the keyless backend chain. This is a
  // working default, not a failure: keyless Bing is reachable without a proxy
  // (including from mainland China) and returns usable results. Surface it only
  // at debug level so it aids diagnosis without alarming every startup. If a
  // real search later fails because every backend is blocked, *that* error's
  // hint (SEARCH_BACKEND_KEY_GUIDANCE) points the user to Bocha/Brave — guidance
  // belongs at the point of actual failure, not unconditionally at construction.
  const keylessNames = isCjk
    ? ['bing', 'baidu', 'duckduckgo', 'duckduckgo-lite']
    : ['bing', 'duckduckgo', 'duckduckgo-lite'];
  const isKeylessOnly = chain.every((c) => keylessNames.includes(c.name));
  if (isKeylessOnly && !braveKey && !bochaKey && !exaKey) {
    log.debug(
      `web_search: no API keys configured; using keyless backend chain (${chain.map((c) => c.name).join(' → ')}). ` +
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
 * Combine two AbortSignals: the returned signal aborts when EITHER input aborts.
 * If either signal is already aborted, the returned signal is immediately aborted.
 */
function combineAbortSignals(s1: AbortSignal | undefined, s2: AbortSignal): AbortSignal {
  if (!s1) return s2;
  if (s1.aborted) return s1;
  if (s2.aborted) return s2;
  const combined = new AbortController();
  const cleanup = () => {
    s1?.removeEventListener('abort', onS1);
    s2.removeEventListener('abort', onS2);
  };
  const onS1 = () => { cleanup(); if (!combined.signal.aborted) combined.abort(); };
  const onS2 = () => { cleanup(); if (!combined.signal.aborted) combined.abort(); };
  s1.addEventListener('abort', onS1, { once: true });
  s2.addEventListener('abort', onS2, { once: true });
  return combined.signal;
}

/**
 * Parallel-race fallback: start backends one by one with a grace window
 * (RACE_PRIMARY_GRACE_MS). If the first backend hasn't returned non-empty
 * results within the window, the next backend is also launched. The moment
 * any backend returns non-empty results, all in-flight backends are aborted
 * via `raceController` and the winner is returned. If all backends fail or
 * return empty, falls through with the same contract as before.
 */
export async function searchWithFallback(
  chain: NamedBackend[],
  query: string,
  opts: WebSearchBackendOptions,
  retry: ResolvedRetry,
  raceGraceMs = RACE_PRIMARY_GRACE_MS,
): Promise<WebSearchResult[]> {
  let sawEmptySuccess = false;
  let lastErr: unknown;

  if (chain.length <= 1) {
    if (chain.length === 0) return [];
    if (opts.signal?.aborted) {
      throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
    }
    try {
      return await runBackendWithRetry(chain[0].backend, query, opts, retry);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw err;
    }
  }

  const raceController = new AbortController();

  // Shared backend runner: returns results or null (failure/empty/aborted).
  // Non-empty results from this backend trigger the race abort.
  const runBackendInRace = async (backend: WebSearchBackend): Promise<WebSearchResult[] | null> => {
    if (raceController.signal.aborted) return null;
    const signal = combineAbortSignals(opts.signal, raceController.signal);
    const backendOpts = { ...opts, signal };
    try {
      const results = await runBackendWithRetry(backend, query, backendOpts, retry);
      if (results.length > 0 && !raceController.signal.aborted) {
        // This backend wins — abort all others
        raceController.abort();
        return results;
      }
      if (results.length === 0) sawEmptySuccess = true;
      return null;
    } catch (err) {
      if (isAbortError(err)) return null;
      lastErr = err;
      return null;
    }
  };

  // Single promise that resolves when a winner is found
  let resolveWinner: (results: WebSearchResult[]) => void;
  const winnerPromise = new Promise<WebSearchResult[]>((resolve) => {
    resolveWinner = resolve;
  });

  // Track all launched backend promises so we can wait for all to settle
  const allBackendPromises: Promise<WebSearchResult[] | null>[] = [];

  // Staggered start: launch backend i, then after the grace window launch i+1,
  // and so on — but stop immediately if a winner is found.
  const launchNext = async (i: number): Promise<void> => {
    if (i >= chain.length || raceController.signal.aborted) return;

    // Start backend i
    const promise = runBackendInRace(chain[i].backend);
    allBackendPromises.push(promise);

    // Wait for backend i's grace window OR the backend to settle.
    const result = await Promise.race([
      promise,
      new Promise<void>((resolve) => setTimeout(resolve, raceGraceMs)),
    ]);

    // If the backend returned non-empty results within the grace window, we win
    if (result && result.length > 0) {
      resolveWinner(result);
      return;
    }

    // Grace window expired or backend failed/empty — recurse to the next
    // backend. `await` (not fire-and-forget setTimeout) so that the outer
    // Promise.all(allBackendPromises) below sees EVERY launched promise: the
    // no-winner path must wait for the whole chain to settle, not just the
    // first batch that happened to be in the array when Promise.all was called
    // (which would prematurely return [] while later backends were still
    // in-flight — defeating the parallel fallback).
    if (!raceController.signal.aborted) {
      await launchNext(i + 1);
    }
  };

  // Launch the whole chain; once every backend has been launched, wait for all
  // in-flight backend promises to settle. Only then (if no winner) do we fall
  // through to the empty/error result.
  const allSettled = launchNext(0).then(() => Promise.all(allBackendPromises));

  try {
    // Wait for either a winner or all backends to settle with no winner.
    const winner = await Promise.race([
      winnerPromise,
      allSettled.then(() => null as WebSearchResult[] | null),
    ]);

    if (winner && winner.length > 0) return winner;

    // All backends finished with no winner — fall through
    if (sawEmptySuccess) return [];
    if (lastErr) throw lastErr;
    return [];
  } finally {
    // Abort raceController on ALL exit paths (winner, no-winner, throw). Every
    // backend goes through combineAbortSignals(opts.signal, raceController),
    // which registers a listener on opts.signal. Those listeners are only
    // removed when EITHER of the combined signals aborts — so if the caller's
    // signal is long-lived (session-scoped) and we return on the no-winner
    // path without abort()ing raceController, we leak one listener per backend
    // per web_search call. Aborting raceController fires its listener, which
    // runs the cleanup that removes the opts.signal listener.
    if (!raceController.signal.aborted) raceController.abort();
  }
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
    const datePart = r.date ? ` (${r.date})` : '';
    const snippet = r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : '';
    return `${idx + 1}. ${r.title}${datePart}\n   ${r.url}${snippet}`;
  });
  return `Found ${results.length} result(s) for "${query}":\n\n${lines.join('\n\n')}${irrelevanceNote}${siteNote}`;
}

export function createWebSearchTool(opts: WebSearchOptions = {}): Tool<{
  query: string;
  max_results?: number;
  recency?: 'day' | 'week' | 'month' | 'year';
}> {
  const defaultMax = Math.min(Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS), MAX_RESULTS_CAP);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const region = opts.region;
  const defaultRecency = opts.recency;
  const retry: ResolvedRetry = {
    maxAttempts: Math.max(1, Math.trunc(opts.retry?.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS)),
    baseDelayMs: Math.max(0, opts.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
    sleep: opts.retry?.sleep ?? defaultSleep,
  };

  // Eagerly validate keyed provider configuration at construction time
  // (the dynamic chain for execute-time is resolved per-query with CJK awareness).
  resolveBackendChain(opts, false);

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
        recency: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Filter to recent results: day/week/month/year. Use when searching for the latest information.',
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
      const recency = (input as { recency?: 'day' | 'week' | 'month' | 'year' } | undefined)?.recency ?? defaultRecency;

      const { query, region: effectiveRegion, siteHint } = preprocessQuery(rawQuery, region);
      if (!query) {
        return formatResults(rawQuery, [], siteHint);
      }
      // Resolve backend chain dynamically per-query: CJK queries add Baidu
      const isCjk = containsCjk(query);
      const chain = resolveBackendChain(opts, isCjk);
      log.debug('start', { rawQuery, query, maxResults, region: effectiveRegion, recency, chain: chain.map((c) => c.name) });
      const started = Date.now();
      const results = await searchWithFallback(
        chain,
        query,
        { maxResults, timeoutMs, signal: ctx.abortSignal, region: effectiveRegion, userAgent, recency },
        retry,
      );
      log.debug('done', { query, count: results.length, ms: Date.now() - started });
      return formatResults(query, results.slice(0, maxResults), siteHint);
    },
  };
}
