



















import type { SessionInbox, SessionInboxEntry } from './session-inbox.js';

export interface ProviderTurnResult {
  
  readonly continue: boolean;
}


export type ProviderTurn = (
  promoted: readonly SessionInboxEntry[],
  turnIndex: number
) => Promise<ProviderTurnResult>;

export interface SessionDrainResult {
  
  readonly turns: number;
  
  readonly promoted: readonly string[];
  
  readonly stoppedAtLimit: boolean;
}

export interface SessionDrainInput {
  readonly inbox: SessionInbox;
  readonly runTurn: ProviderTurn;
  
  readonly maxTurns?: number;
}





export async function runSessionDrain(input: SessionDrainInput): Promise<SessionDrainResult> {
  const maxTurns = input.maxTurns ?? 256;
  const promotedIds: string[] = [];
  let turns = 0;
  
  let owedContinuation = false;

  while (turns < maxTurns) {
    
    const promotedThisTurn: SessionInboxEntry[] = [];
    for (const steer of input.inbox.promotableSteers()) {
      input.inbox.promote(steer.id);
      promotedThisTurn.push(steer);
      promotedIds.push(steer.id);
    }

    if (promotedThisTurn.length === 0 && !owedContinuation) {
      
      
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
