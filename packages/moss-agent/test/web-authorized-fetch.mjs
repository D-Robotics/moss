const csrfByOrigin = new Map();

export async function authorizedWebFetch(input, init = {}) {
  const url =
    typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
  const method = String(
    init.method ?? (typeof input === 'object' ? input.method : 'GET')
  ).toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return globalThis.fetch(input, init);
  }
  let csrfToken = csrfByOrigin.get(url.origin);
  if (!csrfToken) {
    const bootstrap = await globalThis
      .fetch(`${url.origin}/api/bootstrap`)
      .then((response) => response.json());
    csrfToken = bootstrap.csrfToken;
    csrfByOrigin.set(url.origin, csrfToken);
  }
  const headers = new Headers(init.headers);
  if (!headers.has('origin')) headers.set('origin', url.origin);
  if (!headers.has('x-moss-csrf')) headers.set('x-moss-csrf', csrfToken);
  return globalThis.fetch(input, { ...init, headers });
}
