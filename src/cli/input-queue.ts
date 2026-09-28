import type { PreparedPromptAttachment, PromptAttachmentBlock } from './attachments.js';
import { sanitizeRenderableText } from './terminal-text.js';

export interface QueuedInput {
  raw: string;
  message: string;
  enqueuedAt?: number;
  attachments?: PreparedPromptAttachment[];
  attachmentBlocks?: PromptAttachmentBlock[];
}

export interface QueueDrainState {
  busy: boolean;
  approvalActive: boolean;
  pausedAfterCancel: boolean;
  queueLength: number;
}

export const MAX_INPUT_HISTORY = 100;

export function isLocalShellLine(raw: string): boolean {
  return raw.startsWith('!') && raw.trim() !== '!';
}

export function formatQueueWait(enqueuedAt: number | undefined, now = Date.now()): string | null {
  if (enqueuedAt === undefined || !Number.isFinite(enqueuedAt)) return null;
  const waitMs = Math.max(0, now - enqueuedAt);
  if (waitMs < 1000) return '<1s';
  if (waitMs < 60_000) return `${Math.floor(waitMs / 1000)}s`;
  if (waitMs < 3_600_000) return `${Math.floor(waitMs / 60_000)}m`;
  return `${Math.floor(waitMs / 3_600_000)}h`;
}

export function queueItemKind(item: QueuedInput): string {
  if (isLocalShellLine(item.raw)) return 'local shell';
  if (item.message.startsWith('/')) return 'command';
  return 'prompt';
}

export function dropLastQueuedInput(items: QueuedInput[]): {
  next: QueuedInput[];
  dropped?: QueuedInput;
} {
  if (items.length === 0) return { next: [] };
  return {
    next: items.slice(0, -1),
    dropped: items[items.length - 1],
  };
}

export function queueItemMeta(item: QueuedInput, now = Date.now()): string {
  const lineCount = sanitizeRenderableText(item.message).split('\n').length;
  const charCount = sanitizeRenderableText(item.message).length;
  const wait = formatQueueWait(item.enqueuedAt, now);
  const attachmentCount = item.attachments?.length ?? 0;
  return [
    queueItemKind(item),
    wait ? `waiting ${wait}` : null,
    `${lineCount} line${lineCount === 1 ? '' : 's'}`,
    `${charCount} chars`,
    attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function shouldDrainQueue(state: QueueDrainState): boolean {
  return !state.busy && !state.approvalActive && !state.pausedAfterCancel && state.queueLength > 0;
}

export class SerialQueueDrain {
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  async run(task: () => Promise<void>): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await task();
      return true;
    } finally {
      this.running = false;
    }
  }
}

export function stopRequestedMessage(queueLength: number): string {
  if (queueLength > 0) {
    return `Stopping current run… ${queueLength} queued prompt${queueLength === 1 ? '' : 's'} will run next — /queue drop to discard the next, /queue clear to discard all.`;
  }
  return 'Stopping current run…';
}

export function queueResumedMessage(queueLength: number): string {
  if (queueLength > 0) {
    return `Queue resumed (${queueLength} item${queueLength === 1 ? '' : 's'} waiting).`;
  }
  return 'Queue resumed.';
}

export function queuePausedSubmissionMessage(queueLength: number, message: string): string {
  return `Queued #${queueLength}; queue remains paused until /queue resume: ${message}`;
}

export function isQueueControlCommand(message: string): boolean {
  return (
    message === '/queue' ||
    message === '/queued' ||
    message === '/queue pause' ||
    message === '/queue drop' ||
    message === '/queue pop' ||
    message === '/queue clear' ||
    message === '/clearqueue' ||
    message === '/queue resume' ||
    message === '/queue continue'
  );
}

export function isImmediateGoalCommand(message: string): boolean {
  return (
    message === '/goal clear' ||
    message === '/goal pause' ||
    message === '/goal complete' ||
    message.startsWith('/goal complete ') ||
    message === '/goal block' ||
    message.startsWith('/goal block ')
  );
}
