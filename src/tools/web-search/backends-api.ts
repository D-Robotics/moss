/**
 * Keyed-API search backends: Brave, Bocha (博查) and Exa. Unlike the HTML
 * scrapers these return structured JSON and need no markup parsing.
 */

import { MossError, ErrorCode } from '../../errors.js';
import type { WebSearchBackend, WebSearchResult } from './types.js';
import { coerceString, fetchWithTimeout, stripTags } from './http.js';

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
      opts.signal
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
      opts.signal
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
      (json as { data?: { webPages?: { value?: unknown[] } } })?.data?.webPages?.value ?? [];
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
      opts.signal
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
      const snippet = highlights.length > 0 ? coerceString(highlights[0]) : coerceString(r.text);
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
