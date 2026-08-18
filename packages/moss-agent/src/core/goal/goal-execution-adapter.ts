import { createHash } from 'node:crypto';

import { createDeliveryIntakeSeed } from '../../orchestration/delivery-intake.js';
import type { ExecutionStore } from '../../orchestration/execution-types.js';
import type { LegacyExecutionImporter } from '../../orchestration/legacy-execution-importer.js';
import { importLegacySessionCheckpoint } from '../agent/agent-legacy-execution-import.js';
import type { LLMMessage } from '../llm/llm-provider.js';
import { splitGoalCheckpointMessages, type GoalState } from './goal-state.js';

function goalExecutionId(goal: GoalState): string {
  return `goal-${createHash('sha256')
    .update(`${goal.sessionKey}\0${goal.createdAt}\0${goal.objective}`)
    .digest('hex')
    .slice(0, 24)}`;
}

/** Return whether a checkpoint already has an authoritative delivery graph. @internal */
export function hasGoalExecution(
  store: ExecutionStore,
  sessionKey: string,
  objective: string
): boolean {
  return store.list().some((graph) => graph.sessionId === sessionKey && graph.goal === objective);
}

/** Create the standard-minimum Goal compatibility projection exactly once. @internal */
export function ensureGoalExecution(store: ExecutionStore, goal: GoalState): void {
  const graphId = goalExecutionId(goal);
  if (store.load(graphId)) return;
  const intake = createDeliveryIntakeSeed(graphId, goal.objective, 'standard', goal.createdAt);
  const graph = store.create({
    id: graphId,
    sessionId: goal.sessionKey,
    goal: goal.objective,
    nodes: intake.nodes,
    deliveryCase: intake.deliveryCase,
    now: goal.createdAt,
  });
  if (intake.initialElaboration) {
    store.append(graph.id, {
      expectedRevision: graph.revision,
      type: 'delivery.elaboration_recorded',
      time: goal.createdAt,
      data: { round: intake.initialElaboration },
    });
  }
}

/** Load a legacy Goal checkpoint and import it only when no authoritative graph exists. @internal */
export async function loadGoalExecutionState(input: {
  readonly store: ExecutionStore;
  readonly importer: LegacyExecutionImporter;
  readonly sessionStore: { loadMessages(sessionKey: string): Promise<LLMMessage[]> };
  readonly sessionKey: string;
  readonly workspaceDir?: string;
}): Promise<{ goal?: GoalState; messages: LLMMessage[] }> {
  const split = splitGoalCheckpointMessages(
    await input.sessionStore.loadMessages(input.sessionKey)
  );
  if (!split.goal || hasGoalExecution(input.store, input.sessionKey, split.goal.objective)) {
    return split;
  }
  importLegacySessionCheckpoint({
    importer: input.importer,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    sessionKey: input.sessionKey,
    kind: 'goal',
    state: { ...split.goal },
  });
  return split;
}
