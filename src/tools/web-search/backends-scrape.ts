/**
 * Keyless HTML-scraping search backends: DuckDuckGo (HTML + Lite), Bing, and
 * Baidu. Each backend parses provider markup with regexes, unwraps redirect
 * links to directly fetchable URLs, and reports anti-bot blocks honestly
 * (as backend failures, never as empty result sets).
 */

import { MossError, ErrorCode } from '../../errors.js';
import type { WebSearchBackendOptions, WebSearchResult } from './types.js';
import { decodeEntities, fetchWithTimeout, stripTags } from './http.js';

/**
 * Shared recovery guidance for keyless-backend blocked/anti-bot failures.
 * Kept as a single constant so the China/international API-key advice never
 * drifts between the Bing / DuckDuckGo / DuckDuckGo-Lite error sites.
 */
const SEARCH_BACKEND_KEY_GUIDANCE =
  'Configure an API key for reliable search: BOCHA_API_KEY (set provider: "bocha", recommended for mainland China) for Bocha, or BRAVE_API_KEY (set provider: "brave", for international access) for Brave. Or call web_fetch on a specific known URL instead.';

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

/** Keyless DuckDuckGo HTML-endpoint backend. */
export async function duckDuckGoSearch(
  query: string,
  opts: WebSearchBackendOptions
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
    opts.signal
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
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/g;
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
      hint: SEARCH_BACKEND_KEY_GUIDANCE,
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
    /anomaly|challenge-form|captcha|unusual traffic|detected unusual|are you a (?:human|robot)/i.test(
      text
    );
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
  opts: WebSearchBackendOptions
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
    opts.signal
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
  const linkRe = /<a[^>]+class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
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
      hint: SEARCH_BACKEND_KEY_GUIDANCE,
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
  opts: WebSearchBackendOptions
): Promise<WebSearchResult[]> {
  const u = new URL('https://www.bing.com/search');
  u.searchParams.set('q', query);
  u.searchParams.set('count', String(opts.maxResults));
  if (opts.region) u.searchParams.set('mkt', opts.region);
  if (opts.recency) {
    const filterMap: Record<string, string> = {
      day: '"1 day"',
      week: '"1 week"',
      month: '"1 month"',
      year: '"1 year"',
    };
    u.searchParams.set('filters', `exft:${filterMap[opts.recency]}`);
  }
  const { ok, status, text } = await fetchWithTimeout(
    u.toString(),
    {
      method: 'GET',
      headers: { 'user-agent': opts.userAgent, accept: 'text/html' },
    },
    opts.timeoutMs,
    opts.signal
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
      hint: SEARCH_BACKEND_KEY_GUIDANCE,
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
        } catch {
          /* not valid base64 — fall through */
        }
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
  opts: WebSearchBackendOptions
): Promise<WebSearchResult[]> {
  const u = new URL('https://www.baidu.com/s');
  u.searchParams.set('wd', query);
  u.searchParams.set('rn', String(opts.maxResults));

  if (opts.recency) {
    const now = Date.now();
    const dayMs = 86_400_000;
    const offsets: Record<string, number> = {
      day: dayMs,
      week: 7 * dayMs,
      month: 30 * dayMs,
      year: 365 * dayMs,
    };
    const start = now - (offsets[opts.recency] ?? dayMs);
    u.searchParams.set('gpc', `stf=${start},${now}`);
  }

  const { ok, status, text } = await fetchWithTimeout(
    u.toString(),
    { method: 'GET', headers: { 'user-agent': opts.userAgent, accept: 'text/html' } },
    opts.timeoutMs,
    opts.signal
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
    const snippetMatch = content.match(
      /<div[^>]*?class="c-abstract[^"]*?"[^>]*?>([\s\S]*?)<\/div>/i
    );
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
