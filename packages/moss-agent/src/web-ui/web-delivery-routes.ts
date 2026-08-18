import type http from 'node:http';

import type { MossAgent } from '../core/agent/moss-agent.js';
import type { TaskRunLedger } from '../core/task-run/task-run-ledger.js';
import type { MossWebAttachmentService } from './web-attachment-service.js';
import type { MossWebEventJournal } from './web-event-journal.js';
import type { MossWebRuntimeService } from './web-runtime-service.js';
import { streamDeliveryGate, streamPrompt } from './web-run-streaming.js';

interface PrepareDeliveryInput {
  readonly agent: MossAgent;
  readonly runtime: MossWebRuntimeService;
  readonly taskRuns: TaskRunLedger;
  readonly eventJournal: MossWebEventJournal;
  readonly runId: string;
  readonly sessionId: string;
  readonly response: http.ServerResponse;
}

/** Apply intake gates and prepare minimal delivery before a Web provider call. @internal */
export function prepareWebDelivery(input: PrepareDeliveryInput): boolean {
  // Some host adapters intentionally expose only the chat seam. They retain legacy behavior until
  // they opt into the ExecutionStore contract instead of failing an otherwise valid attachment turn.
  if (!input.agent.executionStore) return true;
  const delivery = input.agent.executionStore.load(input.runId)?.deliveryCase;
  if (delivery && delivery.depth !== 'minimal') {
    streamDeliveryGate(
      input.taskRuns,
      input.eventJournal,
      input.runId,
      input.sessionId,
      delivery.depth,
      delivery.riskLevel,
      input.response
    );
    return false;
  }
  if (delivery?.depth === 'minimal') {
    const graph = input.agent.executionStore.load(input.runId);
    if (!graph) return false;
    const proposal = input.runtime.executeAction(graph.id, graph.revision, {
      type: 'prepare_proposal',
    });
    input.runtime.executeAction(proposal.graphId, proposal.revision, {
      type: 'transition_delivery',
      stage: 'executing',
    });
  }
  return true;
}

interface RunApprovedDeliveryInput {
  readonly graphId: string;
  readonly agent: MossAgent;
  readonly runtime: MossWebRuntimeService;
  readonly taskRuns: TaskRunLedger;
  readonly eventJournal: MossWebEventJournal;
  readonly attachments: MossWebAttachmentService;
  readonly active: Map<string, AbortController>;
  readonly response: http.ServerResponse;
  readonly sendJson: (response: http.ServerResponse, status: number, body: unknown) => void;
}

/** Start one previously approved Web delivery using its persisted prompt and attachments. @internal */
export async function runApprovedWebDelivery(input: RunApprovedDeliveryInput): Promise<void> {
  let graph = input.agent.executionStore.load(input.graphId);
  const run = input.taskRuns.get(input.graphId);
  if (!graph?.deliveryCase || !run) {
    input.sendJson(input.response, 404, { error: 'delivery execution not found' });
    return;
  }
  if (input.active.has(run.sessionId)) {
    input.sendJson(input.response, 409, { error: 'session already has an active turn' });
    return;
  }
  if (graph.deliveryCase.stage === 'proposed') {
    input.runtime.executeAction(graph.id, graph.revision, {
      type: 'transition_delivery',
      stage: 'executing',
    });
    graph = input.agent.executionStore.load(input.graphId);
  }
  if (graph?.deliveryCase?.stage !== 'executing') {
    input.sendJson(input.response, 409, { error: 'delivery must be approved before execution' });
    return;
  }
  const created = input.taskRuns.events(run.id)[0];
  const attachmentIds = Array.isArray(created?.data.attachmentIds)
    ? created.data.attachmentIds.filter((id): id is string => typeof id === 'string')
    : [];
  await streamPrompt(
    input.agent,
    input.taskRuns,
    input.eventJournal,
    input.active,
    run.id,
    run.sessionId,
    graph.goal,
    await input.attachments.resolveForPrompt(attachmentIds),
    input.response
  );
}
