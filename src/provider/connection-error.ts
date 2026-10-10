import { MossError, ErrorCode, errorMessage } from '../errors.js';

const UPSTREAM = ErrorCode.PROVIDER_UPSTREAM_ERROR;

function hint(text: string): { hint: string; code: ErrorCode } {
  return { hint: text, code: UPSTREAM };
}

const DNS = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NODATA',
  'EAI_NONAME',
  'EAI_FAIL',
  'EAI_SERVICE',
]);
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN']);
const RESET = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED']);
const TLS = [
  'CERT_',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_UNSUPPORTED_PROTOCOL',
  'ERR_TLS_INVALID_PROTOCOL_VERSION',
];

/**
 * Classify a fetch error's cause code into a specific, actionable hint.
 * The hint strings are user-visible before classification strips them.
 */
function classifyConnectionHint(
  causeCode: string | undefined,
  host: string,
  causeName?: string
): { hint: string; code: ErrorCode } {
  if (!causeCode && !causeName) {
    return hint(
      `Check that ${host} is reachable (network, proxy, DNS, and that the gateway is running).`
    );
  }
  const hasProxyEnv = Boolean(
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
  );
  if ((causeName === 'AbortError' || causeCode === 'UND_ERR_ABORTED') && hasProxyEnv) {
    return hint(
      `Proxy refused the connection to ${host} (undici AbortError). The proxy at HTTP_PROXY/HTTPS_PROXY denied the CONNECT tunnel — common when the host isn't on the proxy's allowlist. Fix: add ${host} to NO_PROXY (if moss should reach it directly), or have the proxy allowlist it.`
    );
  }
  if (causeCode && DNS.has(causeCode)) {
    return hint(
      `DNS lookup failed for ${host} — check your network connection and DNS settings. If using a VPN/proxy, ensure DNS is routed correctly.`
    );
  }
  if (causeCode === 'ECONNREFUSED') {
    return hint(
      `Connection refused by ${host} — the server is not running or the port is wrong. Check that the gateway/service is up and the baseUrl port is correct.`
    );
  }
  if (causeCode && UNREACHABLE.has(causeCode)) {
    return hint(
      `No route to ${host} — network is unreachable. Check VPN connection, network cable/WiFi, and firewall rules (packets may be dropped rather than rejected).`
    );
  }
  if (causeCode && RESET.has(causeCode)) {
    return hint(
      `Connection to ${host} timed out or was reset — check network speed, firewall rules, and proxy configuration. For long streaming requests, the proxy may have a timeout limit.`
    );
  }
  if (causeCode && TLS.some((code) => causeCode.startsWith(code) || causeCode === code)) {
    return hint(
      `TLS/SSL certificate error for ${host} — the server certificate is not trusted. If your network uses a corporate CA, set NODE_EXTRA_CA_CERTS to that CA file or install the CA in the system trust store.`
    );
  }
  if (causeCode === 'EPROTO' || (causeCode && causeCode.includes('PROXY'))) {
    return hint(
      `Proxy/protocol error connecting to ${host} — check HTTP_PROXY / HTTPS_PROXY environment variables.`
    );
  }
  return hint(
    `Connection to ${host} failed (${causeCode}) — check network, proxy, DNS, and that the gateway is running.`
  );
}

export async function fetchWithConnectionContext(
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (init.signal?.aborted) throw err;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // not a URL — use the raw string
    }
    const outer = (
      err as {
        cause?: {
          code?: string;
          message?: string;
          name?: string;
          cause?: { code?: string; message?: string; name?: string };
        };
      }
    ).cause;
    const inner = outer?.cause;
    const causeCode = inner?.code ?? outer?.code;
    const causeName = inner?.name ?? outer?.name;
    const causeMessage = inner?.message ?? outer?.message;
    const causeText =
      causeCode || causeMessage ? ` (${[causeCode, causeMessage].filter(Boolean).join(': ')})` : '';
    const { hint: text, code } = classifyConnectionHint(causeCode, host, causeName);
    throw new MossError({
      code,
      message: `${errorMessage(err)} for ${host}${causeText}`,
      hint: text,
      recoverable: true,
      cause: err,
      context: { url: host, causeCode },
    });
  }
}
