export function stripEndpointSuffix(value: string): string {
  return value
    .replace(/\/+$/, '')
    .replace(/\/(?:v1\/)?(?:chat\/completions|completions|embeddings)$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildApiV1Url(baseUrl: string, path: string): string {
  const normalizedBaseUrl = stripEndpointSuffix(baseUrl.trim());
  const normalizedPath = path.trim().replace(/^\/+/, '');
  return `${normalizedBaseUrl}/v1/${normalizedPath}`;
}
