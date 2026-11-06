/**
 * Background lifecycle completion gate: a run that started tracked background
 * work must either stop it or explicitly justify why it remains running before
 * claiming completion. Blocks once, then lets an honest report through.
 */
import type { AgentLoopExtensions } from './agent-loop-types.js';
import { listBackgroundProcessSnapshots } from '../tools/background-process-registry.js';
import { isNudgeDisabled } from './nudges/disable.js';

export interface BackgroundLifecycleSnapshot {
  id: string;
  pid?: number;
  command: string;
  status: string;
}

export type BackgroundLifecycleGateDecision =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      correction: string;
      /** Which gate held the answer (ledger `gates[]`, B155). */
      gate?: 'background';
      kind?: 'background-running';
    };

export function evaluateBackgroundLifecycleGate(
  running: BackgroundLifecycleSnapshot[]
): BackgroundLifecycleGateDecision {
  if (isNudgeDisabled('background-lifecycle-gate')) return { ok: true };
  const live = running.filter((proc) => proc.status === 'running');
  if (live.length === 0) return { ok: true };
  const described = live
    .map((proc) => `${proc.id} (pid ${proc.pid ?? '?'}): ${proc.command}`)
    .join('; ');
  return {
    ok: false,
    gate: 'background',
    kind: 'background-running',
    reason: `background processes still running: ${described}`,
    correction:
      `[System] Background process(s) are still running: ${described}. ` +
      'Before claiming completion, call exec_stop for each process you started unless the user explicitly asked it to keep running; ' +
      'use exec_wait when the completion result itself is the required evidence. ' +
      'Do not merely report that a process was started — confirm it stopped, or state clearly why it must remain live.',
  };
}

export function createBackgroundLifecycleGate(
  options: { sessionKey?: string } = {}
): NonNullable<AgentLoopExtensions['completionGate']> {
  let blockedOnce = false;
  return async () => {
    const owned = listBackgroundProcessSnapshots().filter(
      (proc) =>
        proc.status === 'running' &&
        (options.sessionKey === undefined || proc.sessionKey === options.sessionKey)
    );
    const decision = evaluateBackgroundLifecycleGate(owned);
    if (decision.ok) return decision;
    if (blockedOnce) return { ok: true as const };
    blockedOnce = true;
    return decision;
  };
}
