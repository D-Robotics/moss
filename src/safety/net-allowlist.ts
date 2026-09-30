/**
 * Network egress policy (v0.16-S4): an optional hostname allowlist that web
 * tools must respect. Enforcement lives in the web tools (web_fetch already
 * applies `allowHosts` at request time AND after redirects); this module is
 * the shared matcher plus the policy object handed through config
 * (`net.allowHosts`).
 */

export interface NetPolicy {
  /** True when no allowlist is configured — everything is allowed. */
  readonly open: boolean;
  isHostAllowed(host: string): boolean;
  /** Filter a list of URLs down to allowed hosts (web_search results). */
  filterAllowedUrls(urls: readonly string[]): string[];
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\*\./, '');
}

/** Exact host match or dotted wildcard suffix (`*.example.com`). */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = normalizeHost(host);
  if (!p || !h) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === p.slice(2);
  }
  return p === h;
}

export function createNetPolicy(allowHosts?: readonly string[]): NetPolicy {
  const patterns = (allowHosts ?? []).filter(Boolean);
  if (patterns.length === 0) {
    return {
      open: true,
      isHostAllowed: () => true,
      filterAllowedUrls: (urls) => [...urls],
    };
  }
  return {
    open: false,
    isHostAllowed: (host: string) => patterns.some((p) => hostMatches(p, host)),
    filterAllowedUrls: (urls) =>
      urls.filter((u) => {
        try {
          return patterns.some((p) => hostMatches(p, new URL(u).hostname));
        } catch {
          return false;
        }
      }),
  };
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
