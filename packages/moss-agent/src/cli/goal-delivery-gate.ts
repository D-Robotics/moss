import type { MossAgent } from '../core/agent/moss-agent.js';

/** Find a Goal delivery that still requires clarification or approval. @internal */
export function pendingGoalDelivery(
  agent: Pick<MossAgent, 'executionStore'>,
  sessionId: string,
  objective: string
) {
  const graph = agent.executionStore
    .list()
    .find((candidate) => candidate.sessionId === sessionId && candidate.goal === objective);
  return graph?.deliveryCase &&
    graph.deliveryCase.depth !== 'minimal' &&
    graph.deliveryCase.stage !== 'executing'
    ? graph
    : undefined;
}

/** Format the shared host message for a gated Goal. @internal */
export function pendingGoalDeliveryMessage(
  agent: Pick<MossAgent, 'executionStore'>,
  sessionId: string,
  objective: string
): string | undefined {
  const graph = pendingGoalDelivery(agent, sessionId, objective);
  return graph
    ? `Goal paused at Delivery Case ${graph.id}. Complete clarification and Proposal approval in the Web workspace before autonomous execution.`
    : undefined;
}
