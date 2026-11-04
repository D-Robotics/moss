/**
 * Historical image budget (backlog B01).
 *
 * Every image a tool observed stays in the session file as an audit trail, but
 * the provider request should not re-send every image forever: a screenshot-heavy
 * debugging session would otherwise grow the wire payload quadratically (each
 * turn carries the whole image history) and eventually overflow the context
 * window with base64 the model never needs again.
 *
 * Claude Code and Cursor keep only the most recent attachments reachable and let
 * the agent re-read an old file when it needs it again. This module implements
 * that policy at the one place where Moss already expands tool-observed images
 * into provider messages (`convertMessagesToPi`): the newest images survive, the
 * older ones are replaced in the *request* by a short notice telling the model
 * how to get them back.
 *
 * The session transcript is not modified: pruning is a wire-level decision, so
 * session replay, `/export` and the JSONL audit trail keep every observed image.
 */
/** Newest images kept in provider requests when the caller does not override. */
export const IMAGE_HISTORY_MAX_COUNT = 8;
/** Newest images kept by cumulative base64 payload (12 MiB of encoded data). */
export const IMAGE_HISTORY_MAX_BYTES = 12 * 1024 * 1024;

export interface ImageBudgetLimits {
  maxCount: number;
  maxBytes: number;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Limits for this process. The env override exists so the behavior can be forced
 * small in tests; production runs get the constants above.
 */
export function resolveImageBudgetLimits(env: NodeJS.ProcessEnv = process.env): ImageBudgetLimits {
  return {
    maxCount: positiveInteger(env.MOSS_IMAGE_HISTORY_MAX_COUNT, IMAGE_HISTORY_MAX_COUNT),
    maxBytes: positiveInteger(env.MOSS_IMAGE_HISTORY_MAX_BYTES, IMAGE_HISTORY_MAX_BYTES),
  };
}

/** Notice that replaces an image the request no longer carries. */
export function omittedImageNotice(count: number, limits: ImageBudgetLimits): string {
  const images = count === 1 ? 'image' : 'images';
  return (
    `[${count} earlier ${images} omitted from this request: only the newest ` +
    `${limits.maxCount} images / ${Math.floor(limits.maxBytes / (1024 * 1024))} MiB stay attached. ` +
    'The session still has them; call read_image again if you need to look.]'
  );
}

/** The only structural shape this module needs; keeps context free of core imports. */
export interface BudgetedMessage {
  role: string;
  content: unknown;
}

interface ImagePart {
  type: 'image';
  data: string;
  mimeType: string;
}

function isImagePart(part: unknown): part is ImagePart {
  if (!part || typeof part !== 'object') return false;
  const typed = part as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    typed.type === 'image' && typeof typed.data === 'string' && typeof typed.mimeType === 'string'
  );
}

/**
 * Keep the newest `maxCount` images (and at most `maxBytes` of base64) in the
 * outgoing request; replace every older image part with one notice per message.
 * Messages without images are returned untouched (same references), which keeps
 * prefix caching and history hashing stable.
 */
export function pruneHistoricalImages<T extends BudgetedMessage>(
  messages: readonly T[],
  limits: ImageBudgetLimits = resolveImageBudgetLimits()
): T[] {
  const budgeted: T[] = [...messages];
  let kept = 0;
  let keptBytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const content = message.content;
    if (!content.some(isImagePart)) continue;
    let omitted = 0;
    const next: unknown[] = [];
    for (const part of content) {
      if (!isImagePart(part)) {
        next.push(part);
        continue;
      }
      if (kept < limits.maxCount && keptBytes + part.data.length <= limits.maxBytes) {
        kept += 1;
        keptBytes += part.data.length;
        next.push(part);
      } else {
        omitted += 1;
      }
    }
    if (omitted > 0) {
      budgeted[index] = {
        ...message,
        content: [...next, { type: 'text', text: omittedImageNotice(omitted, limits) }],
      } as T;
    }
  }
  return budgeted;
}
