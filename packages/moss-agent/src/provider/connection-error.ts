import { MossError, ErrorCode, errorMessage } from '../errors.js';







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
      
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const causeText =
      cause?.code || cause?.message
        ? ` (${[cause?.code, cause?.message].filter(Boolean).join(': ')})`
        : '';
    const base = errorMessage(err);
    throw new MossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `${base} for ${host}${causeText}`,
      hint: 'Check baseUrl, network/proxy reachability, and that the gateway is running.',
      recoverable: true,
      cause: err,
      context: { url: host },
    });
  }
}
