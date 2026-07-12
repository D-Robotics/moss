














import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import TurndownService from 'turndown';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { getRootLogger } from '../logger.js';
import { MossError, ErrorCode, errorMessage } from '../errors.js';
import { injectTraceparent } from '../observability/index.js';

const log = getRootLogger().child('tool:web-fetch');







const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_TEXT_CHARS = 16_000;
const BODY_CAP_PROBE_TIMEOUT_MS = 100;

const DNS_CHECK_TIMEOUT_MS = 3_000;

const DNS_CACHE_TTL_MS = 60_000;

const dnsCache = new Map<string, { addresses: string[]; expiresAt: number }>();
type HostAddressResolver = (hostname: string) => Promise<string[]>;
type BodyProbeReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
};
type ClosableDispatcher = { close?: () => Promise<void> | void };

export interface WebFetchOptions {
  
  maxBytes?: number;
  
  maxTextChars?: number;
  
  timeoutMs?: number;
  
  blockPrivateNetwork?: boolean;
  
  allowHosts?: string[];
  





  allowPrivateHosts?: string[] | (() => string[]);
  
  userAgent?: string;
  
  resolveHostAddresses?: HostAddressResolver;
}

const PRIVATE_IP_RES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/i,
  /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.|0\.)/i,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

async function resolveHostAddressesWithTimeout(
  hostname: string,
  resolver: HostAddressResolver
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new MossError({ code: ErrorCode.TOOL_EXECUTION_TIMEOUT, message: 'dns timeout' })
            ),
          DNS_CHECK_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ipFamily(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4;
}

async function createPinnedHttpsDispatcher(address: string): Promise<ClosableDispatcher> {
  let Agent: typeof import('undici').Agent;
  try {
    ({ Agent } = await import('undici'));
  } catch (err) {
    throw new MossError({
      code: ErrorCode.TOOL_NOT_ALLOWED,
      message: 'web_fetch: unable to enforce HTTPS DNS pinning because undici is unavailable',
      hint: 'Install the optional undici peer dependency, or create the tool with blockPrivateNetwork: false only for trusted URLs.',
      recoverable: false,
      cause: err,
    });
  }

  const family = ipFamily(address);
  type PinnedLookupCallback = (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void;
  const lookup = ((
    _hostname: string,
    optionsOrCallback: { all?: boolean } | PinnedLookupCallback,
    callback?: PinnedLookupCallback
  ) => {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (!cb) return;
    if (typeof optionsOrCallback === 'function') {
      cb(null, address, family);
      return;
    }
    const wantsAll = Boolean(optionsOrCallback?.all);
    if (wantsAll) {
      cb(null, [{ address, family } satisfies LookupAddress]);
      return;
    }
    cb(null, address, family);
  }) as LookupFunction;

  return new Agent({ connect: { lookup } });
}

async function closeDispatcher(dispatcher: ClosableDispatcher): Promise<void> {
  try {
    await dispatcher.close?.();
  } catch {
    
  }
}

export async function resolveHostIp(
  hostname: string,
  resolver: HostAddressResolver = resolveHostAddresses
): Promise<string | null> {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return null;
  if (h === '0.0.0.0') return null;
  if (PRIVATE_IP_RES.some((re) => re.test(h))) return null;
  try {
    const now = Date.now();
    let addresses: string[];
    const cached = dnsCache.get(h);
    if (resolver === resolveHostAddresses && cached && cached.expiresAt > now) {
      addresses = cached.addresses;
    } else {
      addresses = await resolveHostAddressesWithTimeout(h, resolver);
      if (resolver === resolveHostAddresses) {
        dnsCache.set(h, { addresses, expiresAt: now + DNS_CACHE_TTL_MS });
      }
    }
    for (const ip of addresses) {
      if (PRIVATE_IP_RES.some((re) => re.test(ip))) return null;
    }
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

export async function isPrivateHost(
  hostname: string,
  resolver: HostAddressResolver = resolveHostAddresses
): Promise<boolean> {
  return (await resolveHostIp(hostname, resolver)) === null;
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return false;
}









export function detectSpaShellNote(html: string, extractedText: string): string | null {
  const readable = extractedText.replace(/\s+/g, ' ').trim();
  if (readable.length >= 200) return null; 
  if (html.length < 600) return null; 
  const hasScript = /<script\b/i.test(html);
  const spaRoot =
    /(id=["'](root|app|__next|__nuxt|docusaurus(?:[_-]?root)?)["']|data-reactroot|data-server-rendered|window\.__(INITIAL_STATE|NUXT|NEXT_DATA)__|ng-version=)/i.test(
      html
    );
  if (!hasScript || !spaRoot) return null;
  return (
    '⚠️ web_fetch note: this URL returned a client-side-rendered single-page app. ' +
    'Its HTML shell has almost no readable text and loads the real content via JavaScript, ' +
    'which web_fetch cannot execute — the page body was NOT retrieved. Do not describe, ' +
    'summarize, or assume its content. Try the underlying data/API endpoint, a raw source ' +
    'URL (e.g. a GitHub raw .md), or the project source repo instead.'
  );
}








let turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
    });
    turndown.remove(['script', 'style', 'meta', 'link', 'noscript', 'iframe']);
  }
  return turndown;
}

function htmlToText(html: string, maxChars: number): string {
  let out: string;
  try {
    out = getTurndown().turndown(html);
  } catch {
    
    
    out = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ');
  }
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n\n… (truncated, original length ${out.length} chars)`;
  }
  return out;
}











async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<{ buffer: Buffer; truncated: boolean; totalBytes: number }> {
  if (!body) {
    return { buffer: Buffer.alloc(0), truncated: false, totalBytes: 0 };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (total + value.length > maxBytes) {
        const need = maxBytes - total;
        if (need > 0) chunks.push(value.subarray(0, need));
        total = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          
        }
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    if (!truncated && total === maxBytes) {
      const probe = await readProbeWithTimeout(reader, BODY_CAP_PROBE_TIMEOUT_MS);
      if (!probe || !probe.done) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          
        }
      }
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      
    }
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      
    }
  }
  const buffer = Buffer.concat(
    chunks.map((c) =>
      c instanceof Uint8Array && !(c instanceof Buffer) ? Buffer.from(c) : (c as Buffer)
    ),
    total
  );
  return { buffer, truncated, totalBytes: total };
}

async function readProbeWithTimeout(
  reader: BodyProbeReader,
  timeoutMs: number
): Promise<{ done: boolean; value?: Uint8Array } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function coerceString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return fallback;
  return String(v);
}









function proxyEnvActive(): boolean {
  return Boolean(
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
  );
}

export function createWebFetchTool(opts: WebFetchOptions = {}): Tool<{ url: string }> {
  const maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxTextChars = Math.max(256, opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const blockPrivate = opts.blockPrivateNetwork !== false;
  const userAgent = opts.userAgent ?? 'moss-agent/0.1 (+https://github.com/D-Robotics/moss)';
  const allowHosts = (opts.allowHosts ?? []).map((s) => s.toLowerCase());
  const resolveAllowPrivate = (): string[] => {
    const raw =
      typeof opts.allowPrivateHosts === 'function'
        ? opts.allowPrivateHosts()
        : opts.allowPrivateHosts;
    return (raw ?? [])
      .filter((h): h is string => typeof h === 'string' && h.length > 0)
      .map((h) => h.toLowerCase());
  };
  const resolveAddresses = opts.resolveHostAddresses ?? resolveHostAddresses;

  return {
    name: 'web_fetch',
    description:
      'Fetch an http(s) URL and return a readable text extract of the page. ' +
      'Useful when you need the content of a documentation / API reference / status page. ' +
      'Blocks private / loopback / link-local addresses by default (anti-SSRF). ' +
      'Truncates very large bodies. For live JS apps, prefer a headless browser tool. ' +
      'Prefer fetching a specific article / product / docs URL discovered via web_search over a brand or marketing ' +
      'homepage — homepages are often client-side-rendered SPAs that return an empty shell with no readable text.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
      permissionBoundary:
        'Performs outbound HTTP(S) only; private, loopback, and link-local targets are blocked by default.',
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      },
      required: ['url'],
    },
    async execute(input, ctx: ToolContext) {
      const raw = coerceString(input?.url).trim();
      if (!raw) {
        throw new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: 'web_fetch: url is required',
          hint: 'Pass an absolute http(s) URL, e.g. https://example.com/',
          recoverable: false,
        });
      }
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: `web_fetch: invalid URL "${raw}"`,
          hint: 'Provide an absolute http(s) URL; relative paths are not supported.',
          recoverable: false,
        });
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new MossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: `web_fetch: unsupported protocol ${url.protocol}`,
          hint: 'Only http: and https: are allowed. For local files use read/readFile tools.',
          recoverable: false,
        });
      }
      if (allowHosts.length > 0 && !allowHosts.some((p) => hostMatches(url.hostname, p))) {
        throw new MossError({
          code: ErrorCode.TOOL_NOT_ALLOWED,
          message: `web_fetch: host "${url.hostname}" is not in the allowlist`,
          hint: 'Add the host to allowHosts when creating the tool, or use a different URL.',
          recoverable: false,
        });
      }
      
      
      
      const privateWaived =
        blockPrivate && resolveAllowPrivate().some((p) => hostMatches(url.hostname, p));
      let verifiedIp: string | null = null;
      if (blockPrivate && !privateWaived) {
        verifiedIp = await resolveHostIp(url.hostname, resolveAddresses);
        if (verifiedIp === null) {
          throw new MossError({
            code: ErrorCode.TOOL_NOT_ALLOWED,
            message: `web_fetch: refused to connect to private host "${url.hostname}"`,
            hint:
              'Private/loopback/link-local IPs are blocked by default (SSRF protection). ' +
              'For a connected board, moss waives this for the /connect target automatically; ' +
              'otherwise create the tool with `blockPrivateNetwork: false` only for trusted URLs.',
            recoverable: false,
          });
        }
      }

      const controller = new AbortController();
      const mergedSignal = ctx.abortSignal
        ? anySignal(ctx.abortSignal, controller.signal)
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      log.debug('start', { url: url.toString(), maxBytes, timeoutMs });
      const started = Date.now();
      const dispatchersToClose: ClosableDispatcher[] = [];
      try {
        let activeUserAgent = userAgent;
        
        
        
        const runOnce = async (): Promise<Response> => {
          let currentUrl = url;
          let res: Response;
          let redirectCount = 0;
          const MAX_REDIRECTS = 5;

          
          for (;;) {
            const fetchUrl = new URL(currentUrl.toString());
            const originalHost = currentUrl.host;
            
            
            
            
            
            const isHttps = currentUrl.protocol === 'https:';
            const useProxy = proxyEnvActive();
            const shouldRewriteToIp = verifiedIp && !isHttps && !useProxy;
            if (shouldRewriteToIp) {
              fetchUrl.hostname = verifiedIp!;
            }
            const pinnedDispatcher =
              verifiedIp && isHttps && !useProxy
                ? await createPinnedHttpsDispatcher(verifiedIp)
                : undefined;
            if (pinnedDispatcher) dispatchersToClose.push(pinnedDispatcher);
            const fetchInit: RequestInit = {
              signal: mergedSignal,
              headers: {
                'User-Agent': activeUserAgent,
                Accept:
                  'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                ...(shouldRewriteToIp ? { Host: originalHost } : {}),
              },
              redirect: 'manual',
            };
            if (pinnedDispatcher) {
              (fetchInit as { dispatcher?: unknown }).dispatcher = pinnedDispatcher;
            }
            res = await fetch(fetchUrl.toString(), {
              ...fetchInit,
              headers: injectTraceparent(fetchInit.headers as Record<string, string> ?? {}),
            });
            if (res.status >= 300 && res.status < 400 && redirectCount < MAX_REDIRECTS) {
              const location = res.headers.get('location');
              if (!location) break;
              let nextUrl: URL;
              try {
                nextUrl = new URL(location, currentUrl);
              } catch {
                break;
              }
              if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
                res.body?.cancel?.();
                throw new MossError({
                  code: ErrorCode.USER_INPUT_INVALID,
                  message: `web_fetch: redirect to unsupported protocol ${nextUrl.protocol}`,
                  hint: 'Only http: and https: redirects are allowed.',
                  recoverable: false,
                });
              }
              redirectCount++;
              const redirectPrivateWaived =
                blockPrivate && resolveAllowPrivate().some((p) => hostMatches(nextUrl.hostname, p));
              if (blockPrivate && !redirectPrivateWaived) {
                verifiedIp = await resolveHostIp(nextUrl.hostname, resolveAddresses);
                if (verifiedIp === null) {
                  res.body?.cancel?.();
                  throw new MossError({
                    code: ErrorCode.TOOL_NOT_ALLOWED,
                    message: `web_fetch: redirect to private host "${nextUrl.hostname}" blocked (SSRF protection)`,
                    hint: 'The target server redirected to a private/internal address.',
                    recoverable: false,
                  });
                }
              }
              if (
                allowHosts.length > 0 &&
                !allowHosts.some((p) => hostMatches(nextUrl.hostname, p))
              ) {
                res.body?.cancel?.();
                throw new MossError({
                  code: ErrorCode.TOOL_NOT_ALLOWED,
                  message: `web_fetch: redirect to "${nextUrl.hostname}" not in allowlist`,
                  hint: 'Add the host to allowHosts when creating the tool.',
                  recoverable: false,
                });
              }
              res.body?.cancel?.();
              currentUrl = nextUrl;
              continue;
            }
            break;
          }
          return res;
        };

        let res = await runOnce();
        
        
        
        if (
          res.status === 403 &&
          res.headers.get('cf-mitigated') === 'challenge' &&
          activeUserAgent !== BROWSER_USER_AGENT
        ) {
          res.body?.cancel?.();
          activeUserAgent = BROWSER_USER_AGENT;
          res = await runOnce();
        }
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!res.ok) {
          log.warn('non-2xx response', { url: url.toString(), status: res.status });
          return `web_fetch_error: HTTP ${res.status} ${res.statusText} — ${url.toString()}`;
        }
        




        const {
          buffer: body,
          truncated,
          totalBytes,
        } = await readBodyCapped(res.body as ReadableStream<Uint8Array> | null, maxBytes);
        const isJson = contentType.includes('application/json');
        const isText = contentType.startsWith('text/') || isJson || contentType.includes('xml');
        let out: string;
        if (isJson) {
          try {
            const parsed = JSON.parse(body.toString('utf-8'));
            out = JSON.stringify(parsed, null, 2);
          } catch {
            out = body.toString('utf-8');
          }
        } else if (isText) {
          const text = body.toString('utf-8');
          if (contentType.includes('html')) {
            out = htmlToText(text, maxTextChars);
            const spaNote = detectSpaShellNote(text, out);
            if (spaNote) out = out.trim() ? `${out}\n\n${spaNote}` : spaNote;
          } else {
            out = text.slice(0, maxTextChars);
          }
        } else {
          out = `web_fetch_ok: ${totalBytes} bytes, binary content-type=${contentType || 'unknown'}; not returning binary data as text.`;
        }
        if (out.length > maxTextChars) {
          out = out.slice(0, maxTextChars) + `\n\n… (truncated at ${maxTextChars} chars)`;
        }
        const elapsed = Date.now() - started;
        log.debug('ok', {
          url: url.toString(),
          status: res.status,
          bytes: totalBytes,
          outChars: out.length,
          truncatedBytes: truncated,
          elapsedMs: elapsed,
        });
        const header = `web_fetch_ok: ${url.toString()} · HTTP ${res.status} · ${totalBytes}B${truncated ? ' (body truncated)' : ''} · ${elapsed}ms\n`;
        return header + '\n' + out;
      } catch (err) {
        
        
        if (err instanceof MossError) {
          throw err;
        }
        const msg = errorMessage(err);
        if ((err as { name?: string })?.name === 'AbortError') {
          throw new MossError({
            code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
            message: `web_fetch: timed out or aborted after ${timeoutMs}ms`,
            hint: 'Increase timeoutMs when creating the tool, or ensure the target is reachable.',
            recoverable: true,
            context: { url: url.toString(), timeoutMs },
          });
        }
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `web_fetch: ${msg}`,
          hint: 'Check the URL, network connectivity, and host reachability.',
          recoverable: true,
          cause: err,
          context: { url: url.toString() },
        });
      } finally {
        clearTimeout(timer);
        for (const dispatcher of dispatchersToClose) {
          await closeDispatcher(dispatcher);
        }
      }
    },
  };
}




function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (
    typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any ===
    'function'
  ) {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([a, b]);
  }
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const on = () => {
    ctrl.abort();
    a.removeEventListener('abort', on);
    b.removeEventListener('abort', on);
  };
  a.addEventListener('abort', on, { once: true });
  b.addEventListener('abort', on, { once: true });
  return ctrl.signal;
}
