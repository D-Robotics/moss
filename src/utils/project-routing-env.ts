/**
 * Environment variables from a project `.env` that choose where model traffic
 * goes or which model tier handles it: proxies, TLS verification, CA /
 * trust-store paths, model tiers, remote compaction, and fallback providers.
 * An untrusted folder does not apply them. The user's own process environment
 * is untouched.
 */

const EXACT = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SOCKS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'AWS_CA_BUNDLE',
  'PIP_CERT',
  'PIP_TRUSTED_HOST',
  'UV_INSECURE_HOST',
  'DENO_CERT',
  'NIX_SSL_CERT_FILE',
  'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
  'HTTPLIB2_CA_CERTS',
  'PERL_LWP_SSL_CA_FILE',
  'PERL_LWP_SSL_CA_PATH',
  'GRPC_PROXY',
  'FTP_PROXY',
  'GLOBAL_AGENT_HTTP_PROXY',
  'SSLKEYLOGFILE',
  'PYTHONHTTPSVERIFY',
  'PGSSLROOTCERT',
  'HF_HUB_DISABLE_SSL_VERIFY',
  'MOSS_MODEL_CHEAP',
  'MOSS_MODEL_BALANCED',
  'MOSS_MODEL_STRONG',
  'MOSS_REMOTE_COMPACT_ENDPOINT',
  'MOSS_REMOTE_COMPACT_API_KEY',
  'MOSS_REMOTE_COMPACT_TIMEOUT_MS',
  'MOSS_FALLBACK_PROVIDERS',
  'MOSS_FALLBACK_MAX_RETRIES',
  'MOSS_FALLBACK_COOLDOWN_MS',
]);

/** Suffixes used by other language runtimes for a CA bundle or directory. */
const CA_SUFFIXES = [
  '_CA_BUNDLE',
  '_CA_FILE',
  '_CA_PATH',
  '_CA_CERTS',
  '_SSL_CERT_FILE',
  '_CAINFO',
  '_SSL_CA_CERT',
  '_CAFILE',
];

export function isProjectRoutingEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (EXACT.has(upper) || upper.startsWith('NODE_TLS_')) return true;
  return CA_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}
