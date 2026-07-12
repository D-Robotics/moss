/**
 * PreFlightRouter — pre-llm auto-search trigger.
 *
 * Before the LLM sees a user question, this module checks whether any matched
 * skill has time-sensitive content. By default, ALL skills are time-sensitive
 * (pre-search is triggered). Skills that are pure methodology (e.g. git-workflow,
 * refactoring) can opt out by setting `stable: true` in frontmatter.
 *
 * When triggered, auto-runs web_search + web_fetch and injects the results
 * into the LLM context — so the LLM answers based on fresh data.
 */

import type { SkillMeta } from '../../skills/types.js';
import { createWebSearchTool } from '../../tools/web-search.js';
import { createWebFetchTool } from '../../tools/web-fetch.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('pre-flight-router');

const PRE_SEARCH_TIMEOUT_MS = 10_000;
const PRE_SEARCH_MAX_RESULTS = 3;

// ── Lazy tool instances for pre-search ──

let _webSearch: ReturnType<typeof createWebSearchTool> | null = null;
let _webFetch: ReturnType<typeof createWebFetchTool> | null = null;

function getWebSearch() {
  if (!_webSearch) _webSearch = createWebSearchTool({ maxResults: PRE_SEARCH_MAX_RESULTS });
  return _webSearch;
}

function getWebFetch() {
  if (!_webFetch) _webFetch = createWebFetchTool({ maxTextChars: 4000, timeoutMs: 10_000 });
  return _webFetch;
}

// ── Public API ──

/**
 * Check if any matched skill is marked as time-sensitive.
 */
export function hasTimeSensitiveSkill(matchedSkills: SkillMeta[]): boolean {
  return matchedSkills.some((s) => s.timeSensitive === true);
}

/**
 * Determine whether pre-search should be triggered for this question.
 * Only triggers when a matched skill has `timeSensitive: true`.
 */
export function shouldPreSearch(matchedSkills: SkillMeta[]): {
  trigger: boolean;
  reason: 'skill' | 'none';
} {
  if (hasTimeSensitiveSkill(matchedSkills)) {
    return { trigger: true, reason: 'skill' };
  }
  return { trigger: false, reason: 'none' };
}

/**
 * Build the search query for pre-search.
 * Uses the skill's search_query_template if available, otherwise the user message.
 */
export function buildSearchQuery(message: string, matchedSkills: SkillMeta[]): string {
  const tsSkill = matchedSkills.find((s) => s.timeSensitive && s.searchQueryTemplate);
  if (tsSkill?.searchQueryTemplate) {
    return tsSkill.searchQueryTemplate.replace(/\{\{query\}\}/g, message);
  }
  return message;
}

/**
 * Run pre-search: web_search → web_fetch top results → aggregated text.
 * Returns the search result string, or '' on failure/timeout.
 */
export async function runPreSearch(
  query: string,
  workspaceDir: string,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const started = Date.now();
  log.debug('pre-search start', { query });

  try {
    // Step 1: search
    const webSearch = getWebSearch();
    const searchOutput = await withTimeout(
      webSearch.execute(
        { query, max_results: PRE_SEARCH_MAX_RESULTS },
        { workspaceDir, sessionKey, abortSignal: signal },
      ),
      PRE_SEARCH_TIMEOUT_MS,
      signal,
    );

    if (!searchOutput) {
      log.debug('pre-search: search timed out or returned empty');
      return '';
    }

    // Step 2: extract URLs
    const urlRegex = /(https?:\/\/[^\s\n]+)/g;
    const urls: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(searchOutput)) !== null) {
      const url = match[1].replace(/[),;.]+$/, '');
      if (!urls.includes(url) && urls.length < PRE_SEARCH_MAX_RESULTS) {
        urls.push(url);
      }
    }

    if (urls.length === 0) {
      log.debug('pre-search: no URLs in search results');
      return '';
    }

    // Step 3: fetch top results
    const webFetch = getWebFetch();
    const fetchResults = await Promise.allSettled(
      urls.map(async (url) => {
        try {
          const result = await webFetch.execute(
            { url },
            { workspaceDir, sessionKey, abortSignal: signal },
          );
          return { url, content: typeof result === 'string' ? result.slice(0, 4000) : String(result).slice(0, 4000) };
        } catch {
          return { url, content: '' };
        }
      }),
    );

    // Step 4: aggregate
    const parts: string[] = [
      `[Pre-search results for: "${query}" — ${Date.now() - started}ms]`,
      '',
    ];
    for (const r of fetchResults) {
      if (r.status === 'fulfilled' && r.value.content) {
        parts.push(`Source: ${r.value.url}`);
        parts.push(r.value.content);
        parts.push('');
      }
    }

    const result = parts.join('\n').trim();
    log.debug('pre-search done', { query, chars: result.length, ms: Date.now() - started });
    return result;
  } catch (err) {
    log.debug('pre-search failed', { query, error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

/** Run a promise with a timeout. Returns undefined on timeout. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const onAbort = () => {
    if (timer) clearTimeout(timer);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}