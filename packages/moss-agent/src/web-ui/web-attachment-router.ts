import type http from 'node:http';

import { ErrorCode, MossError } from '../errors.js';
import type { MossWebAttachmentService } from './web-attachment-service.js';

const MAX_UPLOAD_BODY_BYTES = 14 * 1024 * 1024;

interface MossWebAttachmentRouterOptions {
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly url: URL;
  readonly mutationAllowed: boolean;
  readonly attachments: MossWebAttachmentService;
  readonly sendJson: (response: http.ServerResponse, status: number, value: unknown) => void;
}

/** Route bounded attachment upload/download and workspace artifact registration. @internal */
export async function handleMossWebAttachmentRequest(
  options: MossWebAttachmentRouterOptions
): Promise<boolean> {
  const { request, response, url, attachments, sendJson } = options;
  const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  const isMutation =
    (request.method === 'POST' &&
      (url.pathname === '/api/attachments' || url.pathname === '/api/artifacts')) ||
    (request.method === 'DELETE' && Boolean(attachmentMatch));
  if (isMutation && !options.mutationAllowed) {
    sendJson(response, 403, { error: 'mutation requires same-origin CSRF authorization' });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/attachments') {
    const body = await readAttachmentJson(request);
    const attachment = await attachments.upload({
      filename: typeof body.filename === 'string' ? body.filename : '',
      mimeType: typeof body.mimeType === 'string' ? body.mimeType : '',
      contentBase64: typeof body.contentBase64 === 'string' ? body.contentBase64 : '',
    });
    sendJson(response, 201, { attachment });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/artifacts') {
    const body = await readAttachmentJson(request);
    const workspaceRelativePath =
      typeof body.workspaceRelativePath === 'string' ? body.workspaceRelativePath : '';
    const attachment = await attachments.registerArtifact(workspaceRelativePath);
    sendJson(response, 201, { attachment });
    return true;
  }
  if (request.method === 'GET' && attachmentMatch) {
    const { metadata, body } = await attachments.read(decodeURIComponent(attachmentMatch[1]));
    response.writeHead(200, {
      'content-type': metadata.mimeType,
      'content-length': body.length,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
    return true;
  }
  if (request.method === 'DELETE' && attachmentMatch) {
    const id = decodeURIComponent(attachmentMatch[1]);
    await attachments.delete(id);
    sendJson(response, 200, { id, deleted: true });
    return true;
  }
  return false;
}

async function readAttachmentJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BODY_BYTES) {
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message: 'attachment request exceeds 14 MiB',
    });
  }
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_UPLOAD_BODY_BYTES) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: 'attachment request exceeds 14 MiB',
      });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message: 'attachment request must be valid JSON',
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message: 'attachment request must be a JSON object',
    });
  }
  return parsed as Record<string, unknown>;
}
