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
 *
 * Module map:
 *   - `types.ts` — shared contracts (WebSearchResult/WebSearchOptions/...)
 *   - `http.ts` — transport + text/retry primitives
 *   - `backends-scrape.ts` — keyless HTML backends (DuckDuckGo HTML/Lite, Bing, Baidu)
 *   - `backends-api.ts` — keyed/hosted API backends (Brave, Bocha, Exa, anonymous Exa MCP)
 *   - `chain.ts` — backend chain resolution, retry, race fallback, budget fan-out
 *   - `merge.ts` — evidence merging, ranking, news diversification
 *   - `tool.ts` — the `web_search` tool definition and execution body
 *
 * The public surface (re-exported here) is exactly the historical surface of
 * the former single-file `tools/web-search.ts`, which remains as a thin
 * re-export shell so `dist/tools/web-search.js` keeps working for consumers.
 */

export type {
  WebSearchResult,
  WebSearchBackendOptions,
  WebSearchBackend,
  WebSearchRetryOptions,
  WebSearchOptions,
} from './types.js';
export {
  duckDuckGoSearch,
  duckDuckGoResponseLooksBlocked,
  duckDuckGoLiteSearch,
  bingSearch,
  bingResponseLooksBlocked,
  baiduSearch,
  baiduResponseLooksBlocked,
} from './backends-scrape.js';
export { createBraveSearch, createBochaSearch, createExaSearch } from './backends-api.js';
export { resolveBackendChain, searchWithFallback, searchAllWithBudget } from './chain.js';
export { diversifyNewsResults } from './merge.js';
export {
  inferSearchRecency,
  preprocessQuery,
  normalizeDomainFilterList,
  applyDomainFilters,
  createWebSearchTool,
} from './tool.js';
