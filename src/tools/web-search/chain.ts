/**
 * Backend chain resolution and execution policies: ordered provider fallback,
 * per-backend bounded retry with backoff, parallel-race fallback with a grace
 * window, and shared-latency-budget fan-out.
 */

import { getRootLogger } from '../../logger.js';
import { MossError, ErrorCode, errorMessage } from '../../errors.js';
import type {
  WebSearchBackend,
  WebSearchBackendOptions,
  WebSearchOptions,
  WebSearchResult,
} from './types.js';
import { backoffDelay, isAbortError, isRecoverableError } from './http.js';
import {
  baiduSearch,
  bingSearch,
  duckDuckGoLiteSearch,
  duckDuckGoSearch,
} from './backends-scrape.js';
import { createBochaSearch, createBraveSearch, createExaSearch } from './backends-api.js';
import { mergeSearchEvidence } from './merge.js';

const log = getRootLogger().child('tool:web-search');

/** Grace window for the first backend in the parallel race: if it hasn't returned
 *  non-empty results within this window, the next backend is also launched. */
export const RACE_PRIMARY_GRACE_MS = 2_500;

interface NamedBackend {
  name: string;
  backend: WebSearchBackend;
}

/** Session-level circuit breaker (O1): a keyless backend that keeps answering
 * with anti-bot/captcha pages gets demoted to the chain tail for the rest of
 * this process, so later searches reach a working backend first. */
const BLOCKED_TRIP_THRESHOLD = 3;
const blockedStreaks = new Map<string, number>();

function looksLikeBlockedFailure(err: unknown): boolean {
  return err instanceof Error && /blocked automated access/i.test(err.message);
}

/** Record one backend outcome: null/undefined = success (resets the streak),
 * a blocked-shaped error increments it. Other errors are ignored. */
export function noteSearchBackendOutcome(name: string, err: unknown | null | undefined): void {
  if (!err) {
    blockedStreaks.delete(name);
    return;
  }
  if (!looksLikeBlockedFailure(err)) return;
  blockedStreaks.set(name, (blockedStreaks.get(name) ?? 0) + 1);
}

export function searchBackendBlockedStreak(name: string): number {
  return blockedStreaks.get(name) ?? 0;
}

/** Test hook: clear the session breaker state. */
export function resetSearchBackendStreaksForTests(): void {
  blockedStreaks.clear();
}

function demoteBlockedBackends(chain: NamedBackend[]): NamedBackend[] {
  if (blockedStreaks.size === 0) return chain;
  const healthy = chain.filter((c) => (blockedStreaks.get(c.name) ?? 0) < BLOCKED_TRIP_THRESHOLD);
  const demoted = chain.filter((c) => (blockedStreaks.get(c.name) ?? 0) >= BLOCKED_TRIP_THRESHOLD);
  if (demoted.length > 0 && demoted.length < chain.length) {
    log.debug(
      `web_search: demoting blocked backend(s) to chain tail for this session: ${demoted.map((c) => c.name).join(', ')}`
    );
  }
  return healthy.concat(demoted);
}

export interface ResolvedRetry {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  const onS1 = () => {
    cleanup();
    if (!combined.signal.aborted) combined.abort();
  };
  const onS2 = () => {
    cleanup();
    if (!combined.signal.aborted) combined.abort();
  };
  s1.addEventListener('abort', onS1, { once: true });
  s2.addEventListener('abort', onS2, { once: true });
  return combined.signal;
}

/** Run one backend with bounded retry-with-backoff on recoverable errors. */
async function runBackendWithRetry(
  name: string,
  backend: WebSearchBackend,
  query: string,
  opts: WebSearchBackendOptions,
  retry: ResolvedRetry
): Promise<WebSearchResult[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
    }
    try {
      const results = await backend(query, opts);
      noteSearchBackendOutcome(name, null);
      return results;
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;
      noteSearchBackendOutcome(name, err);
      if (!isRecoverableError(err) || attempt >= retry.maxAttempts) throw err;
      await retry.sleep(backoffDelay(attempt, retry.baseDelayMs), opts.signal);
    }
  }
  throw lastErr; // unreachable: the loop always returns or throws
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

  if (opts.fallback === false) return demoteBlockedBackends([primary]);

  const chain: NamedBackend[] = [primary];
  // CJK queries get Baidu inserted after Bing (before DuckDuckGo);
  // non-CJK queries skip Baidu (no advantage for English queries).
  const fallbackCandidates: NamedBackend[] = isCjk
    ? [
        { name: 'bing', backend: bingSearch },
        { name: 'baidu', backend: baiduSearch },
        { name: 'duckduckgo', backend: duckDuckGoSearch },
        { name: 'duckduckgo-lite', backend: duckDuckGoLiteSearch },
      ]
    : [
        { name: 'bing', backend: bingSearch },
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
        'Configure BOCHA_API_KEY or BRAVE_API_KEY for higher reliability.'
    );
  }

  return demoteBlockedBackends(chain);
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
  policy: { acceptResults?: (results: WebSearchResult[]) => boolean } = {}
): Promise<WebSearchResult[]> {
  let sawEmptySuccess = false;
  let lastErr: unknown;
  let bestRejectedResults: WebSearchResult[] | undefined;
  let acceptedResults: WebSearchResult[] | undefined;

  if (chain.length <= 1) {
    if (chain.length === 0) return [];
    if (opts.signal?.aborted) {
      throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
    }
    try {
      return await runBackendWithRetry(chain[0].name, chain[0].backend, query, opts, retry);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw err;
    }
  }

  const raceController = new AbortController();

  // Shared backend runner: returns results or null (failure/empty/aborted).
  // Non-empty results from this backend trigger the race abort.
  const runBackendInRace = async (named: NamedBackend): Promise<WebSearchResult[] | null> => {
    if (raceController.signal.aborted) return null;
    const signal = combineAbortSignals(opts.signal, raceController.signal);
    const backendOpts = { ...opts, signal };
    try {
      const results = await runBackendWithRetry(
        named.name,
        named.backend,
        query,
        backendOpts,
        retry
      );
      if (
        results.length > 0 &&
        (policy.acceptResults?.(results) ?? true) &&
        !raceController.signal.aborted
      ) {
        // This backend wins — abort all others
        acceptedResults = results;
        raceController.abort();
        return results;
      }
      if (results.length > 0 && !bestRejectedResults) bestRejectedResults = results;
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
    const promise = runBackendInRace(chain[i]);
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
    if (acceptedResults) return acceptedResults;

    // All backends finished with no winner — fall through
    if (bestRejectedResults) return bestRejectedResults;
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

/** Run all evidence sources concurrently within a shared latency budget. */
export async function searchAllWithBudget(
  chain: NamedBackend[],
  query: string,
  opts: WebSearchBackendOptions,
  retry: ResolvedRetry,
  budgetMs: number
): Promise<WebSearchResult[]> {
  if (opts.signal?.aborted) {
    throw new MossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
  }
  const budgetController = new AbortController();
  const signal = combineAbortSignals(opts.signal, budgetController.signal);
  const completed: WebSearchResult[] = [];
  const tasks = chain.map(async ({ name, backend }) => {
    try {
      const results = await runBackendWithRetry(name, backend, query, { ...opts, signal }, retry);
      completed.push(...results);
    } catch (err) {
      if (!isAbortError(err))
        log.debug('evidence source failed', { backend: name, error: errorMessage(err) });
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, budgetMs));
      }),
    ]);
    return mergeSearchEvidence(completed);
  } finally {
    if (timer) clearTimeout(timer);
    if (!budgetController.signal.aborted) budgetController.abort();
  }
}
