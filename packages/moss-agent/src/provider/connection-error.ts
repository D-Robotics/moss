import { MossError, ErrorCode, errorMessage } from '../errors.js';

/**
 * Classify a fetch error's cause code into a specific, actionable hint.
 * Users see this hint in the TUI — a specific hint ("DNS lookup failed for
 * api.deepseek.com — check your network/DNS") is far more useful than the
 * generic "Check baseUrl, network/proxy reachability" for every error type.
 */
function classifyConnectionHint(
  causeCode: string | undefined,
  host: string,
): { hint: string; code: ErrorCode } {
  if (!causeCode) {
    return {
      hint: `Check that ${host} is reachable (network, proxy, DNS, and that the gateway is running).`,
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    };
  }
  // DNS resolution failures (including all EAI_* family)
  const dnsCodes = ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'EAI_FAIL', 'EAI_SERVICE'];
  if (dnsCodes.includes(causeCode)) {
    return {
      hint: `DNS lookup failed for ${host} — check your network connection and DNS settings. If using a VPN/proxy, ensure DNS is routed correctly.`,
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    };
  }
  // Connection refused — server is down or wrong port
  if (causeCode === 'ECONNREFUSED') {
    return {
      hint: `Connection refused by ${host} — the server is not running or the port is wrong. Check that the gateway/service is up and the baseUrl port is correct.`,
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    };
  }
  // Host/network unreachable — routing issue, VPN, firewall dropping packets
  if (causeCode === 'EHOSTUNREACH' || causeCode === 'ENETUNREACH' || causeCode === 'ENETDOWN' || causeCode === 'EHOSTDOWN') {
    return {
      hint: `No route to ${host} — network is unreachable. Check VPN connection, network cable/WiFi, and firewall rules (packets may be dropped rather than rejected).`,
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    };
  }
  // Timeout, reset, broken pipe, aborted — flaky connection mid-stream
  if (causeCode === 'ETIMEDOUT' || causeCode === 'ECONNRESET' || causeCode === 'EPIPE' || causeCode === 'ECONNABORTED') {
    return {
      hint: `Connection to ${host} timed out or was reset — check network speed, firewall rules, and proxy configuration. For long streaming requests, the proxy may have a timeout limit.`,
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    };
  }
  // SSL/TLS errors — self-signed certs, cert chain, TLS version mismatch
  const tlsCodes = [
    'CERT_', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_UNSUPPORTED_PROTOCOL', 'ERR_TLS_INVALID_PROTOCOL_VERSION',
  ];
  if (tlsCodes.some((c) => causeCode.startsWith(c) || causeCode === c)) {
    return {
      hint: `TLS/SSL certificate error for ${host} — the server's certificate is invalid or self-signed. For a local gateway, set NODE_TLS_REJECT_UNAUTHORIZED=0 temporarily.`,
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    };
  }
  if (causeCode === 'EPROTO' || causeCode.includes('PROXY')) {
    return {
      hint: `Proxy/protocol error connecting to ${host} — check HTTP_PROXY / HTTPS_PROXY environment variables.`,
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
    };
  }
  return {
    hint: `Connection to ${host} failed (${causeCode}) — check network, proxy, DNS, and that the gateway is running.`,
    code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
  };
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
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const causeCode = cause?.code;
    const causeText =
      cause?.code || cause?.message
        ? ` (${[cause?.code, cause?.message].filter(Boolean).join(': ')})`
        : '';
    const base = errorMessage(err);
    const { hint, code } = classifyConnectionHint(causeCode, host);
    throw new MossError({
      code,
      message: `${base} for ${host}${causeText}`,
      hint,
      recoverable: true,
      cause: err,
      context: { url: host, causeCode },
    });
  }
}
