import type { MiniAgentEvent } from '../subagent/agent-events.js';

/** A provisional view of one model attempt. Never used by the canonical response or store. */
export function createVersionedTextDraft(
  publish: (event: MiniAgentEvent) => void,
  assertCurrent: () => void,
  signal: AbortSignal
) {
  let closed = false;
  let active = false;
  let watcher: ReturnType<typeof setInterval> | undefined;

  const end = (accepted: boolean) => {
    if (!active) return;
    active = false;
    if (watcher) clearInterval(watcher);
    watcher = undefined;
    publish({ type: 'message_draft_end', accepted });
  };

  const current = () => {
    if (closed || signal.aborted) return false;
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  };

  const dispose = () => {
    closed = true;
    signal.removeEventListener('abort', dispose);
    end(false);
  };
  signal.addEventListener('abort', dispose, { once: true });

  return {
    push(event: MiniAgentEvent) {
      if (event.type !== 'message_delta') {
        if (event.type === 'retry') end(false);
        publish(event);
        return;
      }
      if (!current()) {
        dispose();
        return;
      }
      if (!active) {
        active = true;
        // An external store correction can occur while the provider is silent.
        watcher = setInterval(() => {
          if (!current()) dispose();
        }, 75);
        watcher.unref();
      }
      publish({ type: 'message_draft_delta', delta: event.delta });
    },
    settle(accepted: boolean) {
      end(accepted && current());
      dispose();
    },
    dispose,
  };
}
