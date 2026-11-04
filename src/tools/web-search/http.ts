/**
 * Transport-level primitives shared by all web-search backends: bounded fetch,
 * HTML/text hygiene, SSE frame parsing, and retry/backoff building blocks.
 * Pure infrastructure — no backend or tool policy lives here.
 */

import { MossError, ErrorCode, errorMessage } from '../../errors.js';
import { ensureKeepAliveDispatcherInstalled } from '../../provider/keep-alive-dispatcher.js';

/**
 * B19: recovery guidance for failures that used to report only "timed out" or
 * "request failed". A search that fails without a next step leaves the model (or
 * the user reading the transcript) guessing between network, proxy, provider and
 * query problems. Kept as one constant so every transport-level site says the
 * same thing.
 */
export const SEARCH_TRANSPORT_GUIDANCE =
  'Retry once; if it keeps failing check network/proxy settings (HTTP(S)_PROXY / NO_PROXY), ' +
  'or call web_fetch on a specific known URL instead. Searching can also be made reliable by ' +
  'setting a provider API key (BOCHA_API_KEY for mainland China, BRAVE_API_KEY internationally).';

/**
 * Recovery guidance for an API backend that answered with a non-2xx status.
 * `keyEnv` names the env var that would satisfy an auth failure, and
 * `switchHint` points at the mechanism that picks another provider.
 */
export function searchHttpStatusHint(
  status: number,
  backend: string,
  keyEnv: string,
  switchHint = 'switch providers via the web_search `provider` option or the key env vars'
): string {
  if (status === 401 || status === 403) {
    return `${backend} rejected the credential: set ${keyEnv} (or pass the key explicitly), then retry.`;
  }
  if (status === 429) {
    return `${backend} rate-limited the request: retry shortly, or ${switchHint}.`;
  }
  if (status >= 500) {
    return `${backend} is having a server-side problem: retry shortly, or ${switchHint}.`;
  }
  return `Check the request against ${backend}'s API (query/params) and retry, or ${switchHint}.`;
}

/** Upper bound on any single backoff sleep. */
const RETRY_MAX_DELAY_MS = 4_000;

export function coerceString(v: unknown, fallback = ''): string {
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

export function decodeEntities(text: string): string {
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

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal
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
    await ensureKeepAliveDispatcherInstalled();
    const res = await fetch(url, {
      ...init,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: controller.signal,
    });
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
        hint: SEARCH_TRANSPORT_GUIDANCE,
        recoverable: true,
      });
    }
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: provider request failed: ${errorMessage(err)}`,
      hint: SEARCH_TRANSPORT_GUIDANCE,
      recoverable: true,
    });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

/** Abort-aware default sleep used between retry attempts. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export function isAbortError(err: unknown): boolean {
  return err instanceof MossError && err.code === ErrorCode.USER_ABORTED;
}

export function isRecoverableError(err: unknown): boolean {
  return (
    err instanceof MossError && err.recoverable === true && err.code !== ErrorCode.USER_ABORTED
  );
}

export function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs * 0.5;
  return Math.min(RETRY_MAX_DELAY_MS, exp + jitter);
}
