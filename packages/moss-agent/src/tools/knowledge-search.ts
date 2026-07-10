/**
 * `knowledge_search` — aggregated web knowledge tool for the Agent.
 *
 * Encapsulates web_search + web_fetch into a single atomic tool. The LLM
 * calls this with a query, and the tool internally searches the web, fetches
 * the top results' content, and returns a structured summary with sources.
 *
 * Design:
 *   - Reuses web_search (multi-backend: Bing / DuckDuckGo / Brave / Baidu / Bocha / Exa)
 *     and web_fetch (SSRF-safe, HTML→Markdown, timeout-controlled).
 *   - Hard constraint: the LLM CANNOT answer factual questions without calling
 *     this tool — the answer is only available through the tool's return value.
 *   - Suitable for questions about external products, platforms, versions,
 *     branches, support matrices, and other facts that may change over time.
 *   - Built-in knowledge (SKILL.md hardcoded facts) should be migrated to
 *     reference this tool instead of embedding answers directly.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { getRootLogger } from '../logger.js';
import { MossError, ErrorCode } from '../errors.js';
import { createWebSearchTool } from './web-search.js';
import { createWebFetchTool } from './web-fetch.js';

const log = getRootLogger().child('tool:knowledge-search');

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export interface KnowledgeSearchOptions {
  /** Max search results to fetch content from (default 5, max 10). */
  maxResults?: number;
  /** API key for provider backends. */
  apiKey?: string;
  /** Search provider when no API key is configured. */
  provider?: 'bing' | 'duckduckgo' | 'brave' | 'bocha' | 'exa';
  /** Region / locale hint for search. */
  region?: string;
}

function coerceString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return fallback;
  return String(v);
}

/**
 * Trim and truncate fetched page content to a reasonable size for the LLM.
 * Returns the full content up to maxChars, with a truncation note if needed.
 */
function trimContent(text: string, maxChars: number): string {
  const cleaned = text.replace(/\n{4,}/g, '\n\n\n').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars) + `\n\n… (truncated at ${maxChars} chars, original ${cleaned.length} chars)`;
}

export function createKnowledgeSearchTool(opts: KnowledgeSearchOptions = {}): Tool<{
  query: string;
  max_results?: number;
  recency?: 'day' | 'week' | 'month' | 'year';
}> {
  const defaultMax = Math.min(
    Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS),
    MAX_RESULTS_CAP,
  );

  // Create internal tool instances — reuse all the SSRF protection,
  // multi-backend fallback, HTML→Markdown conversion, etc.
  const webSearch = createWebSearchTool({
    maxResults: defaultMax,
    provider: opts.provider,
    apiKey: opts.apiKey,
    region: opts.region,
  });

  const webFetch = createWebFetchTool({
    maxTextChars: 8000,
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  });

  return {
    name: 'knowledge_search',
    description:
      'Search the web for factual information about external products, platforms, APIs, versions, ' +
      'branches, support matrices, configuration parameters, and other facts that may change over time. ' +
      'This tool searches the web AND fetches the content of top results in one call, returning a ' +
      'structured summary with source URLs. ' +
      'Use this when: (1) the user asks a factual question about a third-party product/platform/version ' +
      'that you cannot verify from the project code itself; (2) you need current, up-to-date information ' +
      'that may differ from your training data or built-in knowledge; (3) the user asks "which branch", ' +
      '"what version", "does X support Y", "is Z available on W", or similar questions about external ' +
      'tools, libraries, hardware, or services. ' +
      'Do NOT use this for questions answerable from the current project\'s code, or for general ' +
      'programming knowledge that is stable and well-established.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
      permissionBoundary:
        'Performs outbound HTTP(S) search + fetch; the model query is URL-encoded (no SSRF surface).',
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query — use keywords that would find the specific factual information needed. ' +
            'For example: "rdk_model_zoo github branches S600" or "D-Robotics RDK S600 model zoo branch name".',
        },
        max_results: {
          type: 'number',
          description: `Maximum results to fetch content from (default ${defaultMax}, max ${MAX_RESULTS_CAP}).`,
        },
        recency: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description:
            'Filter to recent results. Use "week" or "month" for version/branch questions that may change.',
        },
      },
      required: ['query'],
    },
    async execute(input, ctx: ToolContext) {
      const rawQuery = coerceString(input?.query).trim();
      if (!rawQuery) {
        throw new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: 'knowledge_search: query is required',
          hint: 'Pass a non-empty query with keywords for the factual information needed.',
          recoverable: false,
        });
      }

      const maxResults = Math.min(
        Math.max(1, Number(input?.max_results) || defaultMax),
        MAX_RESULTS_CAP,
      );

      const started = Date.now();
      log.debug('start', { rawQuery, maxResults });

      // Step 1: Search the web
      let searchOutput: string;
      try {
        searchOutput = await webSearch.execute(
          { query: rawQuery, max_results: maxResults, recency: input?.recency },
          ctx,
        );
      } catch (err) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `knowledge_search: web search failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: 'Try a different query or check network connectivity.',
          recoverable: true,
          cause: err,
        });
      }

      // Parse search results to extract URLs
      const urlRegex = /(https?:\/\/[^\s\n]+)/g;
      const urls: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = urlRegex.exec(searchOutput)) !== null) {
        const url = match[1].replace(/[),;.]+$/, ''); // strip trailing punctuation
        if (!urls.includes(url) && urls.length < maxResults) {
          urls.push(url);
        }
      }

      if (urls.length === 0) {
        return `## knowledge_search: "${rawQuery}"\n\n${searchOutput}\n\n⚠️ No fetchable URLs found in search results. ` +
          `Try a different query or use web_fetch directly on a known URL.`;
      }

      // Step 2: Fetch content from each result URL in parallel
      const fetchResults = await Promise.allSettled(
        urls.map(async (url, idx) => {
          try {
            const result = await webFetch.execute({ url }, ctx);
            return { index: idx, url, content: result };
          } catch (err) {
            log.debug('fetch failed', { url, error: err instanceof Error ? err.message : String(err) });
            return {
              index: idx,
              url,
              content: `⚠️ Failed to fetch: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }),
      );

      // Step 3: Aggregate results
      const parts: string[] = [
        `## knowledge_search results for: "${rawQuery}"`,
        `Search returned ${urls.length} URL(s); fetched content below.`,
        `(Completed in ${Date.now() - started}ms)`,
        '',
      ];

      for (const result of fetchResults) {
        if (result.status === 'fulfilled') {
          const { url, content } = result.value;
          const trimmed = trimContent(
            typeof content === 'string' ? content : String(content),
            6000,
          );
          parts.push(`### [${result.value.index + 1}] ${url}`);
          parts.push('');
          parts.push(trimmed);
          parts.push('');
        } else {
          // Should not happen since we catch inside the mapper, but handle anyway
          parts.push(`### ❌ Fetch failed: ${result.reason}`);
          parts.push('');
        }
      }

      parts.push('---');
      parts.push(
        'Use the information above to answer the user\'s question. ' +
        'Always cite the source URL when stating a fact. ' +
        'If the fetched content does not contain the answer, say so and suggest a better query or URL.',
      );

      return parts.join('\n');
    },
  };
}