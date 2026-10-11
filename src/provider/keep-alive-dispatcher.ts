type UndiciModule = typeof import('undici');

let installed = false;
let reuseObserved = false;
let firstConnectSeen = false;

function hasProxyEnv(): boolean {
  return Boolean(
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
  );
}

function normalizeProxyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;

  return url.replace(/^socks5h:/i, 'socks5:');
}

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

export function withLoopbackNoProxy(raw: string | undefined): string {
  const parts = (raw ?? '')
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const host of LOOPBACK_NO_PROXY) if (!parts.includes(host)) parts.push(host);
  return parts.join(',');
}

function proxyEnvOptions(): {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
} {
  return {
    httpProxy: normalizeProxyUrl(process.env.http_proxy ?? process.env.HTTP_PROXY),
    httpsProxy: normalizeProxyUrl(process.env.https_proxy ?? process.env.HTTPS_PROXY),
    // O83: loopback always bypasses the proxy (a local gateway such as
    // Ollama at 127.0.0.1 kept working before the dispatcher was installed at
    // CLI entry; NO_PROXY=localhost alone does not match 127.0.0.1).
    noProxy: withLoopbackNoProxy(process.env.no_proxy ?? process.env.NO_PROXY),
  };
}

/** Default undici connectTimeout under HTTPS_PROXY/HTTP_PROXY (O87). */
const PROXY_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Resolve undici `connectTimeout` for the global dispatcher.
 * - No proxy: leave undefined (undici default 10s).
 * - Proxy: 30s, unless MOSS_CONNECT_TIMEOUT_MS is set (0 = undici default).
 */
export function resolveConnectTimeoutMs(proxyConfigured: boolean): number | undefined {
  const raw = process.env.MOSS_CONNECT_TIMEOUT_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      return n === 0 ? undefined : Math.floor(n);
    }
  }
  return proxyConfigured ? PROXY_CONNECT_TIMEOUT_MS : undefined;
}

export async function ensureKeepAliveDispatcherInstalled(): Promise<void> {
  if (installed) return;
  if (typeof process === 'undefined' || !process.versions?.node) return;

  // Install the proxy-aware dispatcher regardless of MOSS_DISABLE_CONN_WARMUP.
  // That env only skips connection warmup below — never skips HTTPS_PROXY/HTTP_PROXY.
  await installKeepAliveDispatcher();
}

async function installKeepAliveDispatcher(): Promise<void> {
  let mod: UndiciModule;
  try {
    mod = await import('undici');
  } catch {
    return;
  }
  const { Agent, EnvHttpProxyAgent, setGlobalDispatcher } = mod;

  // O87: undici defaults connectTimeout to 10s. Board → ssh -R → HTTPS_PROXY →
  // gateway often needs longer after CONNECT; raise only when a proxy is set.
  // Override with MOSS_CONNECT_TIMEOUT_MS (milliseconds). 0 keeps undici default.
  const connectTimeout = resolveConnectTimeoutMs(hasProxyEnv());
  const common: {
    keepAliveTimeout: number;
    keepAliveMaxTimeout: number;
    connections: number;
    connectTimeout?: number;
  } = {
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connections: 8,
    ...(connectTimeout !== undefined ? { connectTimeout } : {}),
  };

  let nextDispatcher: InstanceType<typeof Agent> | InstanceType<typeof EnvHttpProxyAgent>;
  try {
    nextDispatcher = hasProxyEnv()
      ? new EnvHttpProxyAgent({ ...common, ...proxyEnvOptions() })
      : new Agent(common);
  } catch {
    try {
      nextDispatcher = new Agent(common);
    } catch {
      return;
    }
  }

  try {
    setGlobalDispatcher(nextDispatcher);
  } catch {
    return;
  }

  installed = true;

  try {
    const emitter = nextDispatcher as unknown as {
      on?: (evt: string, fn: (...args: unknown[]) => void) => void;
    };
    emitter.on?.('connect', () => {
      if (!firstConnectSeen) {
        firstConnectSeen = true;
        return;
      }
      reuseObserved = true;
    });
  } catch {}

  // Optional connection warmup (pre-connect). MOSS_DISABLE_CONN_WARMUP=1 skips
  // only this step; the dispatcher above stays installed so HTTPS_PROXY works.
  if (process.env.MOSS_DISABLE_CONN_WARMUP === '1') return;
  await maybeWarmupKeepAliveConnection();
}

/** Best-effort pre-connect; currently a no-op reserved for future warmup. */
async function maybeWarmupKeepAliveConnection(): Promise<void> {
  // No proactive pre-connect yet: keep-alive reuse is observed on the first
  // real request via the 'connect' listener above. Hook kept so the env flag
  // has a clear, separate target from dispatcher install.
}

export function wasConnectionReused(): boolean {
  return reuseObserved || (installed && firstConnectSeen);
}
