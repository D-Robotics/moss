/**
 * Session drain — the explicit per-turn runner that consumes a {@link SessionInbox}.
 *
 * Instead of a fire-and-forget loop, execution is modelled as a *drain*: at each
 * safe provider-turn boundary the runner promotes eligible admitted input, runs
 * exactly one provider turn, and decides whether to continue. This is the
 * orchestration that turns the admission/execution split into behaviour:
 *
 *   - `steer` input promotes at the next boundary while the drain still needs to
 *     continue, folding new prompts into the running turn sequence.
 *   - `queue` input is held until the drain would otherwise end; then exactly one
 *     queued entry is promoted and continuation is reevaluated.
 *
 * The runner is provider-agnostic: callers supply a `runTurn` callback that
 * performs one provider turn (later wired to moss's actual provider stream) and
 * reports whether another turn is required (e.g. tool calls still pending). A
 * drain has no durable identity of its own — it reasons purely from the inbox.
 *
 * Mirrors the opencode V2 Session drain contract, adapted to moss.
 */
import type { SessionInbox, SessionInboxEntry } from './session-inbox.js';

export interface ProviderTurnResult {
  /** True if the runner must perform another provider turn before the session idles. */
  readonly continue: boolean;
}

/** Perform one provider turn. `promoted` are the entries promoted at this turn's boundary. */
export type ProviderTurn = (
  promoted: readonly SessionInboxEntry[],
  turnIndex: number,
) => Promise<ProviderTurnResult>;

export interface SessionDrainResult {
  /** Number of provider turns executed. */
  readonly turns: number;
  /** Ids of every entry promoted, in promotion order. */
  readonly promoted: readonly string[];
  /** True if the drain stopped because it hit `maxTurns` rather than going idle. */
  readonly stoppedAtLimit: boolean;
}

export interface SessionDrainInput {
  readonly inbox: SessionInbox;
  readonly runTurn: ProviderTurn;
  /** Safety bound on provider turns per drain. Default 256. */
  readonly maxTurns?: number;
}

/**
 * Drain a session: promote eligible input at each boundary, run one provider turn,
 * and continue until no immediate continuation remains and no queued input is left.
 */
export async function runSessionDrain(input: SessionDrainInput): Promise<SessionDrainResult> {
  const maxTurns = input.maxTurns ?? 256;
  const promotedIds: string[] = [];
  let turns = 0;
  // Does the previous turn require another (e.g. tool results still pending)?
  let owedContinuation = false;

  while (turns < maxTurns) {
    // Safe boundary: promote every pending steer in admission order.
    const promotedThisTurn: SessionInboxEntry[] = [];
    for (const steer of input.inbox.promotableSteers()) {
      input.inbox.promote(steer.id);
      promotedThisTurn.push(steer);
      promotedIds.push(steer.id);
    }

    if (promotedThisTurn.length === 0 && !owedContinuation) {
      // No new steers and nothing owed — the drain would idle. Promote exactly one
      // queued entry if present, otherwise the session is genuinely idle.
      const queued = input.inbox.nextQueued();
      if (!queued) break;
      input.inbox.promote(queued.id);
      promotedThisTurn.push(queued);
      promotedIds.push(queued.id);
    }

    const result = await input.runTurn(promotedThisTurn, turns);
    turns++;
    owedContinuation = result.continue;
  }

  return { turns, promoted: promotedIds, stoppedAtLimit: turns >= maxTurns };
}
