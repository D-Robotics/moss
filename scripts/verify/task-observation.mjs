#!/usr/bin/env node
/** Offline behavior probe for generic task observation, cancellation and bounded waits. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);
await load('safety/tool-output-redact.js');
const { executeOneToolCall } = await load('core/tools/execute-tool-call.js');
const { readTaskObservation } = await load('core/tools/task-observation.js');
const { findLoopReplay } = await load('core/loop/agent-loop-tool-execution.js');
const { MossAgent } = await load('core/agent/moss-agent.js');
const { InMemorySessionStore } = await load('core/session/session.js');
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-observation-'));
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`[task-observation] ok ${label}`);
};
const policy = { maxWaitMs: 300, initialPollMs: 2, maxPollMs: 8 };
const makeTool = (name, execute, metadata = {}) => ({
  name,
  description: 'Observe an existing external task.',
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass: 'readonly', taskObservation: policy, ...metadata },
  execute,
});
const invoke = async (tool, input, options = {}) => {
  const events = [];
  const result = await executeOneToolCall(
    { id: 'call-1', name: tool.name, input },
    {
      toolsForRun: [tool],
      toolCtx: { workspaceDir, sessionKey: 'wait-probe' },
      sessionKey: 'wait-probe',
      abortSignal: options.signal ?? new AbortController().signal,
      toolTimeoutMs: options.toolTimeoutMs ?? 200,
      enableHeartbeat: false,
      heartbeatIntervalMs: 20,
      skipHeartbeatToolNames: new Set(),
      push: (event) => events.push(event),
    }
  );
  return { result, events };
};

try {
  for (const [name, idKey] of [
    ['build_job_status', 'jobId'],
    ['deployment_state', 'taskId'],
    ['training_logs', 'runId'],
  ]) {
    let calls = 0;
    const keys = [];
    const input = { [idKey]: 'external-1', idempotencyKey: 'initial-query' };
    const tool = makeTool(name, async (args) => {
      keys.push(args.idempotencyKey);
      calls++;
      return JSON.stringify({
        [idKey]: 'external-1',
        status: calls < 4 ? 'running' : 'completed',
        progressPercent: calls * 25,
        lines: [{ n: calls, text: `line ${calls}` }],
      });
    });
    const { result, events } = await invoke(tool, input);
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.text).status, 'completed');
    assert.equal(JSON.parse(result.text).lines.length, 4, 'all observed incremental logs retained');
    assert.equal(events.filter((event) => event.type === 'tool_execution_start').length, 1);
    assert.equal(new Set(keys).size, 4, 'poll keys are fresh');
    assert.ok(keys.every((key) => key.length <= 64));
    assert.deepEqual(input, { [idKey]: 'external-1', idempotencyKey: 'initial-query' });
    assert.equal(events.findLast((event) => event.toolWait)?.toolWait.state, 'resumed');
    assert.equal(events.find((event) => event.toolWait)?.toolWait.progress, 0.25);
  }
  ok('build, deployment and training queries wait within one invocation and aggregate logs');

  let cachedKeys = new Set();
  for (let window = 0; window < 2; window++) {
    let calls = 0;
    const terminalWithoutLogs = makeTool('cached_job_status', async (args) => {
      calls++;
      if (calls > 1) {
        assert.ok(
          !cachedKeys.has(args.idempotencyKey),
          'a resumed wait must never reuse an old poll cache key'
        );
        cachedKeys.add(args.idempotencyKey);
      }
      return JSON.stringify(
        calls === 1
          ? { jobId: 'cached', status: 'running', lines: [{ n: 1, text: 'retained' }] }
          : { jobId: 'cached', status: 'completed' }
      );
    });
    const { result } = await invoke(terminalWithoutLogs, {
      jobId: 'cached',
      idempotencyKey: 'same-original',
    });
    assert.equal(JSON.parse(result.text).lines[0].text, 'retained');
  }
  ok('new wait windows use distinct polling cache keys and terminal snapshots retain prior logs');

  let envelopeCalls = 0;
  const envelopeTool = makeTool('artifact_status', async () =>
    JSON.stringify({
      structuredContent: {
        taskId: 'artifact',
        status: ++envelopeCalls < 2 ? 'running' : 'completed',
      },
      content: [{ type: 'text', text: 'artifact: https://example.invalid/model.onnx' }],
      metadata: { preserve: true },
    })
  );
  const envelopeResult = JSON.parse(
    (await invoke(envelopeTool, { taskId: 'artifact' })).result.text
  );
  assert.equal(envelopeResult.content[0].text, 'artifact: https://example.invalid/model.onnx');
  assert.equal(envelopeResult.structuredContent.status, 'completed');
  assert.equal(envelopeResult.metadata.preserve, true);
  let structuredCalls = 0;
  const structuredTool = makeTool('image_job_state', async () => 'unused');
  structuredTool.executeStructured = async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          jobId: 'image',
          status: ++structuredCalls < 2 ? 'running' : 'completed',
        }),
      },
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
    ],
  });
  const structuredResult = (await invoke(structuredTool, { jobId: 'image' })).result;
  assert.ok(
    structuredResult.structuredContent.some(
      (block) => block.type === 'image' && block.data === 'AQID'
    )
  );
  ok('final MCP envelopes, artifact text and structured image attachments survive observation');

  let constrainedCalls = 0;
  const constrained = makeTool('constrained_job_state', async () => {
    constrainedCalls++;
    return JSON.stringify({
      jobId: 'strict',
      status: 'running',
      lines: [{ n: 1, text: 'validated evidence' }],
    });
  });
  constrained.inputSchema.properties = {
    jobId: { type: 'string' },
    idempotencyKey: { type: 'string', enum: ['allowed-key'] },
  };
  const constrainedResult = await invoke(constrained, {
    jobId: 'strict',
    idempotencyKey: 'allowed-key',
  });
  assert.equal(constrainedCalls, 1, 'derived keys must pass validation before another RPC');
  assert.equal(constrainedResult.result.isError, true);
  assert.match(constrainedResult.result.text, /must be one of/);
  assert.match(constrainedResult.result.text, /validated evidence/);
  ok('derived polling inputs are schema validated and reject strict keys before sending an RPC');

  const plain = { runId: 'r', status: 'running', progress: 0.4 };
  assert.equal(readTaskObservation(plain, { runId: 'r' }).progress, 0.4);
  assert.equal(
    readTaskObservation(
      { structuredContent: plain, content: [{ type: 'text', text: 'unrelated' }] },
      { runId: 'r' }
    ).taskId,
    'r'
  );
  assert.equal(
    readTaskObservation(
      { content: [{ type: 'text', text: JSON.stringify(plain) }] },
      { runId: 'r' }
    ).taskId,
    'r'
  );
  assert.equal(
    readTaskObservation({ isError: true, structuredContent: plain }, { runId: 'r' }),
    null
  );
  for (const value of [plain, { ...plain, status: 'unknown' }, 'status: running']) {
    assert.equal(readTaskObservation(value, { runId: 'different' }), null);
  }
  ok('strict JSON/MCP envelopes require a matching existing task ID');

  for (const metadata of [{ sideEffectClass: 'local_write' }, { taskObservation: undefined }]) {
    let calls = 0;
    await invoke(
      makeTool(
        'submit_build',
        async () => {
          calls++;
          return JSON.stringify(plain);
        },
        metadata
      ),
      { runId: 'r' }
    );
    assert.equal(calls, 1, 'mutations and non-opted-in tools never auto-repeat');
  }
  assert.equal(
    findLoopReplay(
      [],
      'build_job_status',
      {},
      { sideEffectClass: 'readonly', taskObservation: {} }
    ),
    null
  );
  ok('mutation/opt-in boundaries stay intact and observations cannot replay cached results');

  let mismatchedCalls = 0;
  await invoke(
    makeTool('get_status', async () => {
      mismatchedCalls++;
      return JSON.stringify(plain);
    }),
    { runId: 'different' }
  );
  assert.equal(mismatchedCalls, 1);
  let errorCalls = 0;
  const failed = await invoke(
    makeTool('get_build', async () => {
      errorCalls++;
      return errorCalls === 1 ? JSON.stringify(plain) : 'Error: service rejected query';
    }),
    { runId: 'r' }
  );
  assert.equal(errorCalls, 2);
  assert.equal(failed.result.isError, true);
  ok('ID mismatches and tool errors return immediately without autonomous retries');

  let thrownCalls = 0;
  const thrown = await invoke(
    makeTool(
      'failing_build_state',
      async () => {
        if (++thrownCalls > 1) throw new Error('query connection dropped');
        return JSON.stringify({
          runId: 'r',
          status: 'running',
          lines: [{ n: 1, text: 'previous evidence' }],
        });
      },
      { transientRetry: true }
    ),
    { runId: 'r' }
  );
  assert.equal(thrownCalls, 2, 'a failed wait must not restart its whole window');
  assert.equal(thrown.result.isError, true);
  assert.match(thrown.result.text, /previous evidence/);
  assert.match(thrown.result.text, /query connection dropped/);
  ok('RPC exceptions retain previous evidence and do not restart the observation window');

  let initialRetryCalls = 0;
  const initialRetry = await invoke(
    makeTool(
      'docs_search',
      async () => {
        initialRetryCalls++;
        if (initialRetryCalls === 1) throw new Error('ECONNRESET');
        return 'Documentation found';
      },
      { transientRetry: true }
    ),
    {}
  );
  assert.equal(initialRetryCalls, 2);
  assert.equal(initialRetry.result.isError, false);
  ok('non-task readonly tools retain their existing transient-retry behavior');

  const controller = new AbortController();
  let cancelledCalls = 0;
  const pending = invoke(
    makeTool(
      'job_status',
      async () => {
        cancelledCalls++;
        return JSON.stringify(plain);
      },
      { taskObservation: { ...policy, initialPollMs: 100 } }
    ),
    { runId: 'r' },
    { signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 10);
  const cancelled = await pending;
  assert.equal(cancelled.result.aborted.by, 'user');
  assert.equal(cancelledCalls, 1);
  ok('cancellation interrupts wait timers without issuing remote cancellation');

  const stalled = await invoke(
    makeTool('build_status', async () => JSON.stringify(plain), {
      taskObservation: { ...policy, maxWaitMs: 25 },
      transientRetry: true,
    }),
    { runId: 'r' }
  );
  assert.equal(stalled.result.waitTimeout.taskId, 'r');
  assert.equal(stalled.result.isError, false, 'waiting deadline is not a network error');
  assert.equal(JSON.parse(stalled.result.text).observationWait.remoteTaskCancelled, false);
  assert.equal(stalled.events.findLast((event) => event.toolWait)?.toolWait.state, 'timed_out');
  ok('a stalled external task produces an explicit wait timeout with its latest state');

  const hung = await invoke(
    makeTool('unresponsive_status', async () => new Promise(() => {})),
    { runId: 'r' },
    { toolTimeoutMs: 15 }
  );
  assert.equal(hung.result.aborted.by, 'timeout');
  assert.equal(hung.result.isError, true);
  ok('ordinary RPC deadlines remain active even when task observation is enabled');

  let modelCalls = 0;
  const provider = {
    id: 'offline-wait-probe',
    displayName: 'Offline wait probe',
    capabilities: { streaming: false },
    async complete() {
      modelCalls++;
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `query-${modelCalls}`,
            name: 'build_status',
            input: { runId: 'r' },
          },
        ],
      };
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'Observe this job.',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    workspaceDir,
  });
  agent.tools.register(
    makeTool('build_status', async () => JSON.stringify(plain), {
      taskObservation: { ...policy, maxWaitMs: 20 },
    })
  );
  try {
    const result = await agent.chat('task-wait-timeout', 'Wait for this existing build.', {
      maxTurns: 5,
    });
    assert.equal(result.stopReason, 'tool_wait_timeout');
    assert.equal(modelCalls, 1, 'deadline must not start another observation/model window');
    assert.equal(result.toolCalls.length, 1);
    assert.match(result.response, /not cancelled|未被取消/);
  } finally {
    await agent.close();
  }
  ok('the full agent loop stops once with tool_wait_timeout instead of burning model rounds');
  const budgetAgent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'Observe this job.',
    includeDomainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    budget: { maxWallMs: 40 },
    workspaceDir,
  });
  budgetAgent.tools.register(
    makeTool('build_status', async () => JSON.stringify(plain), {
      taskObservation: { ...policy, maxWaitMs: 1000 },
    })
  );
  try {
    const start = Date.now();
    const result = await budgetAgent.chat('task-wait-budget', 'Wait for this existing build.');
    assert.equal(result.stopReason, 'budget_wall_ms_reached');
    assert.match(result.response, /not cancelled|未被取消/);
    assert.ok(Date.now() - start < 500);
  } finally {
    await budgetAgent.close();
  }
  ok('autonomous observation respects the existing run wall budget');

  const { createHeadlessPrintState, formatHeadlessStreamEvent, isHeadlessResultError } =
    await load('cli/print.js');
  const { unfinishedReasonFromStop } = await load('cli/run-progress.js');
  const { createRunCompletionTracker, resolveRunOutcome } = await load('cli/run-outcome.js');
  for (const zh of [false, true]) {
    const reason = unfinishedReasonFromStop('tool_wait_timeout', zh);
    assert.ok(reason);
    const outcome = resolveRunOutcome({
      tracker: createRunCompletionTracker(),
      finalText: '',
      runError: reason,
    });
    assert.notEqual(outcome.exitCode, 0);
    assert.equal(outcome.status, 'incomplete');
  }
  const state = createHeadlessPrintState({ sessionId: 'wait-print' });
  const printed = formatHeadlessStreamEvent(state, {
    type: 'done',
    result: {
      response: 'External task is still running.',
      toolCalls: [],
      toolResults: [],
      stopReason: 'tool_wait_timeout',
    },
  });
  assert.equal(isHeadlessResultError(printed.find((event) => event.type === 'result')), true);
  ok(
    'headless JSON and bilingual CLI outcomes classify wait timeouts as incomplete with nonzero exit'
  );

  console.log(`[task-observation] ${checks} checks passed`);
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
