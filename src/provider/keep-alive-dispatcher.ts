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

export async function ensureKeepAliveDispatcherInstalled(): Promise<void> {
  if (installed) return;
  if (typeof process === 'undefined' || !process.versions?.node) return;
  if (process.env.MOSS_DISABLE_CONN_WARMUP === '1') return;

  let mod: UndiciModule;
  try {
    mod = await import('undici');
  } catch {
    return;
  }
  const { Agent, EnvHttpProxyAgent, setGlobalDispatcher } = mod;

  const common = {
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connections: 8,
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
}

export function wasConnectionReused(): boolean {
  return reuseObserved || (installed && firstConnectSeen);
}
