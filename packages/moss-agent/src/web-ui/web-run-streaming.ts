import type http from 'node:http';

import type { ChatOptions, MossAgent } from '../core/agent/moss-agent.js';
import type { TaskRunLedger } from '../core/task-run/task-run-ledger.js';
import { errorMessage } from '../errors.js';
import type { MossWebStreamEvent } from './web-contracts.js';
import type { MossWebEventJournal } from './web-event-journal.js';
import { finalizeDeliveryRun } from '../orchestration/delivery-run-finalizer.js';
import { createIndependentDeliveryReviewer } from '../orchestration/independent-delivery-reviewer.js';

/** Return a durable intake response without starting the agent before required gates. @internal */
export function streamDeliveryGate(
  taskRuns: TaskRunLedger,
  eventJournal: MossWebEventJournal,
  runId: string,
  sessionId: string,
  depth: string,
  riskLevel: string,
  response: http.ServerResponse
): void {
  const run = taskRuns.get(runId);
  if (!run) throw new Error(`unknown task run "${runId}"`);
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  const events: readonly MossWebStreamEvent[] = [
    { type: 'run', run },
    {
      type: 'text',
      delta: `This ${depth} delivery is paused for structured clarification (${riskLevel} risk). Answer the Delivery Case questions in Task Details before execution.`,
    },
    { type: 'done', stopReason: 'delivery_gate', run },
  ];
  for (const event of events) {
    eventJournal.append(runId, sessionId, event);
    response.write(`${JSON.stringify(event)}\n`);
  }
  response.end();
}

/** Stream durable run events with cursor replay and terminal close semantics. @internal */
export function streamRunEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  eventStreams: Set<http.ServerResponse>,
  journal: MossWebEventJournal,
  run: NonNullable<ReturnType<TaskRunLedger['get']>>,
  after: number
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  response.write(': moss-event-stream\n\n');
  eventStreams.add(response);
  const subscription: { unsubscribe?: () => void } = {};
  let finished = false;
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
  keepAlive.unref();
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearInterval(keepAlive);
    subscription.unsubscribe?.();
    eventStreams.delete(response);
  };
  const finish = () => {
    cleanup();
    response.end();
  };
  const send = (record: ReturnType<MossWebEventJournal['append']>) => {
    if (finished) return;
    response.write(`id: ${record.seq}\n`);
    response.write(`event: ${record.event.type}\n`);
    response.write(`data: ${JSON.stringify(record)}\n\n`);
    if (record.event.type === 'done' || record.event.type === 'interrupted') finish();
  };
  request.once('aborted', cleanup);
  response.once('close', cleanup);
  for (const record of journal.events(run.id, after)) send(record);
  if (finished) return;
  if (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled' ||
    run.status === 'interrupted'
  ) {
    finish();
    return;
  }
  subscription.unsubscribe = journal.subscribe(run.id, send);
}

/** Stream one agent turn as legacy NDJSON while journaling resumable browser events. @internal */
export async function streamPrompt(
  agent: MossAgent,
  taskRuns: TaskRunLedger,
  eventJournal: MossWebEventJournal,
  active: Map<string, AbortController>,
  runId: string,
  sessionId: string,
  prompt: string,
  attachments: NonNullable<ChatOptions['attachments']>,
  response: http.ServerResponse
): Promise<void> {
  const controller = new AbortController();
  active.set(sessionId, controller);
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  const emit = (event: MossWebStreamEvent) => {
    try {
      eventJournal.append(runId, sessionId, event);
    } catch (error) {
      console.error(`[web] failed to persist resumable event: ${errorMessage(error)}`);
    }
    response.write(`${JSON.stringify(event)}\n`);
  };
  let stopReason = 'end_turn';
  let streamError: string | undefined;
  let assistantSummary = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const startedAt = Date.now();
  try {
    const before = taskRuns.get(runId);
    if (before?.status === 'created') {
      const run = taskRuns.append(runId, {
        type: 'run.started',
        data: { promptLength: prompt.length },
      });
      emit({ type: 'run', run });
    }
    for await (const event of agent.streamChat(sessionId, prompt, {
      abortSignal: controller.signal,
      ...(attachments.length > 0 ? { attachments } : {}),
    })) {
      if (event.type === 'text_delta') {
        assistantSummary += event.delta;
        emit({ type: 'text', delta: event.delta });
      }
      if (event.type === 'thinking_delta') emit({ type: 'thought', delta: event.delta });
      if (event.type === 'tool_start') {
        taskRuns.append(runId, {
          type: 'tool.started',
          data: { toolCallId: event.toolCallId, name: event.toolName },
        });
        emit({
          type: 'tool',
          state: 'start',
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: event.input,
        });
      }
      if (event.type === 'tool_end') {
        taskRuns.append(runId, {
          type: event.isError ? 'tool.failed' : 'tool.succeeded',
          data: { toolCallId: event.toolCallId, name: event.toolName, isError: event.isError },
        });
        emit({
          type: 'tool',
          state: 'end',
          toolCallId: event.toolCallId,
          name: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      }
      if (event.type === 'retry')
        emit({ type: 'retry', attempt: event.attempt, error: event.error });
      if (event.type === 'compaction') {
        emit({
          type: 'compaction',
          summaryChars: event.summaryChars,
          droppedMessages: event.droppedMessages,
          ...(event.checkpointOutline ? { checkpointOutline: event.checkpointOutline } : {}),
        });
      }
      if (event.type === 'llm_usage') {
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        emit({
          type: 'usage',
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cacheReadTokens !== undefined
            ? { cacheReadTokens: event.cacheReadTokens }
            : {}),
          ...(event.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: event.cacheCreationTokens }
            : {}),
          ...(event.contextTokens !== undefined ? { contextTokens: event.contextTokens } : {}),
        });
      }
      if (event.type === 'working_context_checkpoint') {
        emit({
          type: 'context',
          status: event.status,
          reason: event.reason,
          goal: event.goal,
          nextAction: event.nextAction,
        });
      }
      if (event.type === 'turn_end') stopReason = event.stopReason;
      if (event.type === 'error') {
        streamError = event.error;
        stopReason = 'error';
        emit({ type: 'error', message: event.error });
      }
      if (event.type === 'done') {
        stopReason = event.result.stopReason ?? (streamError ? 'error' : stopReason);
      }
    }
    const current = taskRuns.get(runId);
    const terminalType =
      !streamError && (stopReason === 'end_turn' || stopReason === 'stop_sequence')
        ? 'run.completed'
        : 'run.failed';
    const run =
      current?.status === 'running'
        ? taskRuns.append(runId, {
            type: terminalType,
            data: { stopReason, ...(streamError ? { message: streamError } : {}) },
          })
        : current;
    if (terminalType === 'run.completed') {
      await finalizeDeliveryRun(
        agent,
        runId,
        assistantSummary,
        {
          inputTokens,
          outputTokens,
          wallTimeMs: Date.now() - startedAt,
          humanInterventions: 0,
        },
        createIndependentDeliveryReviewer(agent)
      );
    }
    emit({ type: 'done', stopReason, run });
  } catch (error) {
    const current = taskRuns.get(runId);
    if (current?.status === 'running') {
      taskRuns.append(runId, { type: 'run.failed', data: { message: errorMessage(error) } });
    }
    emit({ type: 'error', message: errorMessage(error) });
    emit({ type: 'done', stopReason: controller.signal.aborted ? 'aborted_by_user' : 'error' });
  } finally {
    if (active.get(sessionId) === controller) active.delete(sessionId);
    response.end();
  }
}
