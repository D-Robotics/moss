/**
 * Run-epoch coordination for the agent loop.
 *
 * Each call to `runAgentLoop` bumps its sessionKey's epoch and closes over the
 * new value. Any stream.push captured by an earlier run of the same sessionKey
 * discovers its epoch is stale and silently drops — the "later run wins"
 * preemption pattern.
 *
 * The default `runEpochBySessionKey` is a MODULE-LEVEL Map, i.e. a
 * process-wide singleton. This is intentional for the single-agent CLI case
 * (only one MossAgent instance per process) but INCORRECT when a host embeds
 * multiple MossAgent instances that may collide on the same sessionKey — they
 * would stomp each other's epochs and cancel each other's live streams.
 *
 * MossAgent instances therefore pass their OWN Map via
 * `AgentLoopExtensions.runEpochStore`; both `bumpAgentLoopRunEpoch` and
 * `guardMiniAgentStreamPush` accept it as an optional argument.
 * When omitted, they fall back to the singleton for backwards compatibility.
 */

import type { EventStream } from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent, MiniAgentResult } from '../subagent/agent-events.js';

const MAX_MAP_SIZE = 1000;
const TRIM_TO_SIZE = 500;
const runEpochBySessionKey = new Map<string, number>();

/** Exposed for tests/hosts that want the singleton store explicitly. */
export function getDefaultRunEpochStore(): Map<string, number> {
  return runEpochBySessionKey;
}

export function bumpAgentLoopRunEpoch(
  sessionKey: string,
  store: Map<string, number> = runEpochBySessionKey
): number {
  const next = (store.get(sessionKey) ?? 0) + 1;
  store.set(sessionKey, next);
  if (store.size > MAX_MAP_SIZE) {
    const toDelete = store.size - TRIM_TO_SIZE;
    let deleted = 0;
    for (const key of store.keys()) {
      if (deleted >= toDelete) break;
      store.delete(key);
      deleted++;
    }
  }
  return next;
}




export function guardMiniAgentStreamPush(
  stream: EventStream<MiniAgentEvent, MiniAgentResult>,
  sessionKey: string,
  runEpoch: number,
  store: Map<string, number> = runEpochBySessionKey
): void {
  const protoPush = stream.push.bind(stream) as (e: MiniAgentEvent) => void;

  (stream as unknown as { push: (e: MiniAgentEvent) => void }).push = (e: MiniAgentEvent) => {
    if ((store.get(sessionKey) ?? 0) !== runEpoch) return;
    protoPush(e);
  };
}
