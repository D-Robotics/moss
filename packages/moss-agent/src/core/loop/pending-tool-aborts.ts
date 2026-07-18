








import type { Message } from '../session/session-jsonl.js';

interface PendingAbortEntry {
  name: string;
  startedAt: number;
}

const PENDING_ABORT_TTL_MS = 5 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 1000;













export class PendingToolAbortStore {
  private readonly pendingAbortBySession = new Map<string, Map<string, PendingAbortEntry>>();
  private gcTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  note(sessionKey: string, calls: readonly { id: string; name: string }[]): void {
    if (this.disposed || calls.length === 0) return;
    let pending = this.pendingAbortBySession.get(sessionKey);
    if (!pending) {
      pending = new Map();
      this.pendingAbortBySession.set(sessionKey, pending);
    }
    const now = Date.now();
    for (const call of calls) {
      if (call.id) pending.set(call.id, { name: call.name, startedAt: now });
    }
    this.scheduleGc();
  }

  consumeSyntheticMessages(sessionKey: string): Message[] {
    const pending = this.pendingAbortBySession.get(sessionKey);
    if (!pending || pending.size === 0) return [];
    const entries = [...pending.entries()];
    this.pendingAbortBySession.delete(sessionKey);
    this.stopGcIfEmpty();

    const now = Date.now();
    const content = entries.map(([tool_use_id, entry]) => ({
      type: 'tool_result' as const,
      tool_use_id,
      name: entry.name,
      content: JSON.stringify({
        output: 'aborted',
        metadata: {
          exit_code: 1,
          duration_seconds: Math.round((now - entry.startedAt) / 1000),
          reason: 'user_cancelled',
        },
      }),
      is_error: true,
    }));

    return [{ role: 'user', content, timestamp: now }];
  }

  clear(): void {
    this.pendingAbortBySession.clear();
    this.stopGc();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private scheduleGc(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionKey, pending] of this.pendingAbortBySession) {
        for (const [id, entry] of pending) {
          if (now - entry.startedAt > PENDING_ABORT_TTL_MS) pending.delete(id);
        }
        if (pending.size === 0) this.pendingAbortBySession.delete(sessionKey);
      }
      this.stopGcIfEmpty();
    }, GC_INTERVAL_MS);
    if (typeof this.gcTimer === 'object' && 'unref' in this.gcTimer) this.gcTimer.unref();
  }

  private stopGcIfEmpty(): void {
    if (this.pendingAbortBySession.size === 0) this.stopGc();
  }

  private stopGc(): void {
    if (!this.gcTimer) return;
    clearInterval(this.gcTimer);
    this.gcTimer = undefined;
  }
}
