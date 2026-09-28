/**
 * Keyed-API and hosted-MCP search backends: Brave, Bocha (博查), Exa, and the
 * anonymous Exa hosted-MCP fallback. Unlike the HTML scrapers these return
 * structured JSON (or MCP text sections) and need no markup parsing.
 */

import { MossError, ErrorCode } from '../../errors.js';
import type { WebSearchBackend, WebSearchResult } from './types.js';
import { coerceString, fetchWithTimeout, parseSseJsonMessages, stripTags } from './http.js';

function parseExaMcpText(text: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const section of text.split(/\n\s*---\s*\n/g)) {
    const title = section.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const url = section.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]?.trim();
    if (!title || !url) continue;
    const published = section.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
    const publishedDate = published ? new Date(published) : undefined;
    const date =
      publishedDate && !Number.isNaN(publishedDate.getTime())
        ? publishedDate.toISOString().slice(0, 10)
        : undefined;
    const highlights = section.split(/^Highlights:\s*$/m)[1]?.trim() ?? '';
    let sourceName: string | undefined;
    try {
      sourceName = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      sourceName = undefined;
    }
    results.push({
      title: stripTags(title),
      url,
      snippet: stripTags(highlights).slice(0, 600),
      ...(date ? { date } : {}),
      ...(sourceName ? { sourceName } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Anonymous Exa hosted MCP backend. The hosted service supplies a bounded
 * fallback key for the basic search/fetch tools, so no user API key is needed.
 * It is used only for fresh-news evidence and always remains optional. */
export function createAnonymousExaMcpSearch(): WebSearchBackend {
  return async (query, opts) => {
    const { ok, status, text } = await fetchWithTimeout(
      'https://mcp.exa.ai/mcp?tools=web_search_exa',
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: { query, numResults: opts.maxResults },
          },
        }),
      },
      Math.min(opts.timeoutMs, 6_000),
      opts.signal
    );
    if (!ok) {
      throw new MossError({
        code: status === 429 ? ErrorCode.PROVIDER_RATE_LIMITED : ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: `web_search: anonymous Exa MCP returned HTTP ${status}`,
        recoverable: true,
      });
    }
    const frames = parseSseJsonMessages(text);
    for (const frame of frames) {
      const content = (frame as { result?: { content?: Array<{ type?: string; text?: string }> } })
        ?.result?.content;
      if (!Array.isArray(content)) continue;
      const combined = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
      const results = parseExaMcpText(combined, opts.maxResults);
      if (results.length > 0) return results;
    }
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: 'web_search: anonymous Exa MCP returned no parseable results',
      recoverable: true,
    });
  };
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
