import type http from 'node:http';

import { ErrorCode, MossError } from '../errors.js';
import type { MossWebClientAssetName } from './web-static-assets.js';

const MAX_BODY_BYTES = 64 * 1024;

/** Write one cache-disabled JSON response. @internal */
export function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

/** Write one Web client asset with the workbench security policy. @internal */
export function sendAsset(response: http.ServerResponse, type: string, body: string): void {
  response.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  response.end(body);
}

/** Write a downloadable Markdown transcript. @internal */
export function sendMarkdown(response: http.ServerResponse, sessionId: string, body: string): void {
  response.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(sessionId)}.md`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

/** Parse one bounded object-shaped JSON request. @internal */
export async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: 'web request body exceeds 64 KiB',
      });
    }
  }
  if (!body) return {};
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message: 'expected a JSON object' });
  }
  return parsed as Record<string, unknown>;
}

/** Check the host header before serving the loopback workbench. @internal */
export function isExpectedHost(request: http.IncomingMessage, expectedOrigin: string): boolean {
  try {
    return request.headers.host === new URL(expectedOrigin).host;
  } catch {
    return false;
  }
}

/** Check Origin plus the per-process CSRF token for a mutation. @internal */
export function isAuthorizedMutation(
  request: http.IncomingMessage,
  expectedOrigin: string,
  csrfToken: string
): boolean {
  const origin = request.headers.origin;
  const submittedToken = request.headers['x-moss-csrf'];
  if (!origin || Array.isArray(submittedToken) || submittedToken !== csrfToken) return false;
  try {
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/** Resolve a static client asset MIME type. @internal */
export function clientAssetType(filename: MossWebClientAssetName): string {
  return filename.endsWith('.css') ? 'text/css' : 'text/javascript';
}
