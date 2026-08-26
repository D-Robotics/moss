#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import {
  initObservability,
  MOSS_LEGACY_ATTRIBUTE_ALIASES,
  MOSS_METRIC_CATALOG,
  MOSS_OBSERVABILITY_ATTRIBUTES,
  MOSS_OBSERVABILITY_CONTRACT_VERSION,
  MOSS_SPAN_NAMES,
  shutdownObservability,
  startSpan,
  withSpan,
} from '../dist/observability/index.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-moc-'));

function createAgent(transcript, options = {}) {
  return new MossAgent({
    llmProvider: createMockTranscriptProvider('mock-provider', 'Mock Provider', transcript),
    sessionStore: new InMemorySessionStore(),
    workspaceDir: tmp,
    model: 'gpt-test-model',
    baseSystemPrompt: 'Follow the deterministic test transcript.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 8,
    ...options,
  });
}

function registerFixtureTool(
  agent,
  implementation = async () => 'fixture inspected',
  metadata = { sideEffectClass: 'readonly' }
) {
  agent.tools.register({
    name: 'inspect_fixture',
    description: 'Inspect a deterministic fixture.',
    metadata,
    inputSchema: { type: 'object', properties: {} },
    execute: implementation,
  });
}

function successfulTranscript(text = 'observed completion') {
  return [
    { toolCalls: [{ name: 'inspect_fixture', input: {} }] },
    {
      text,
      usage: { inputTokens: 17, outputTokens: 5 },
      model: 'gpt-test-response-model',
    },
  ];
}

// Business behavior before SDK initialization is the disabled-observability baseline.
const disabledAgent = createAgent(successfulTranscript());
registerFixtureTool(disabledAgent);
const disabledResult = await disabledAgent.chat('moc-disabled-session', 'inspect', {
  runId: 'moc-disabled-run',
});
await disabledAgent.close();

const metricMeasurements = [];
const metricDefinitions = new Map();
const testMeter = {
  createCounter(name, options = {}) {
    metricDefinitions.set(name, { kind: 'counter', unit: options.unit });
    return {
      add(value, attributes = {}) {
        metricMeasurements.push({ name, kind: 'counter', value, attributes });
      },
    };
  },
  createHistogram(name, options = {}) {
    metricDefinitions.set(name, { kind: 'histogram', unit: options.unit });
    return {
      record(value, attributes = {}) {
        metricMeasurements.push({ name, kind: 'histogram', value, attributes });
      },
    };
  },
};
assert.equal(
  metrics.setGlobalMeterProvider({ getMeter: () => testMeter }),
  true,
  'the fixture installs a capture provider after proving disabled behavior'
);

const consumerA = [];
const consumerB = [];
let rejectedMutations = 0;
let throwingProcessorEnds = 0;
const throwingProcessor = {
  onStart() {
    throw new Error('fixture processor start failure');
  },
  onEnd() {
    throwingProcessorEnds++;
    throw new Error('fixture processor end failure');
  },
  async forceFlush() {
    throw new Error('fixture processor flush failure');
  },
  async shutdown() {
    throw new Error('fixture processor shutdown failure');
  },
};
const consumers = [
  {
    id: 'immutable-probe',
    onSpan(span) {
      consumerA.push(span);
      try {
        span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.runId] = 'tampered';
      } catch {
        rejectedMutations++;
      }
    },
  },
  {
    id: 'native-probe',
    onSpan(span) {
      consumerB.push(span);
    },
  },
  {
    id: 'rejecting-probe',
    onSpan() {
      throw new Error('fixture consumer delivery failure');
    },
  },
  {
    id: 'bounded-flush-probe',
    onSpan() {},
    forceFlush() {
      return new Promise(() => {});
    },
  },
];

initObservability({
  workspaceDir: tmp,
  extraSpanProcessors: [throwingProcessor],
  spanConsumers: consumers,
  shutdownTimeoutMs: 500,
});
// Duplicate initialization must not register the consumers twice.
initObservability({
  workspaceDir: tmp,
  extraSpanProcessors: [throwingProcessor],
  spanConsumers: consumers,
  shutdownTimeoutMs: 500,
});

const observedAgent = createAgent(successfulTranscript());
registerFixtureTool(observedAgent);
const hostSpan = trace.getTracer('moc-fixture-host').startSpan('studio.agent.request');
const observedResult = await context.with(trace.setSpan(context.active(), hostSpan), () =>
  observedAgent.chat('moc-shared-session', 'inspect', {
    runId: 'moc-success-run',
  })
);
hostSpan.setStatus({ code: SpanStatusCode.OK });
hostSpan.end();

assert.deepEqual(
  {
    response: observedResult.response,
    stopReason: observedResult.stopReason,
    toolOutcomes: observedResult.toolResults.map((result) => result.outcome),
  },
  {
    response: disabledResult.response,
    stopReason: disabledResult.stopReason,
    toolOutcomes: disabledResult.toolResults.map((result) => result.outcome),
  },
  'enabling observability preserves deterministic business behavior'
);

// A second run in the same conversation keeps the session id but receives a distinct run id.
await observedAgent.chat('moc-shared-session', 'second run');
await observedAgent.close();

// Input denial occurs after the root starts and must still finalize exactly once.
const deniedAgent = createAgent([{ text: 'must not run' }], {
  hooks: {
    async onInputGuardrail() {
      return { approved: false, reason: 'fixture policy' };
    },
  },
});
await assert.rejects(
  deniedAgent.chat('moc-denied-session', 'denied', { runId: 'moc-denied-run' }),
  /fixture policy/
);
await deniedAgent.close();

// Returned tool failure is an ERROR span even though the agent can recover and answer.
const failedToolAgent = createAgent(successfulTranscript('recovered completion'));
registerFixtureTool(failedToolAgent, async () => 'Error: deterministic tool failure');
const recovered = await failedToolAgent.chat('moc-failed-tool-session', 'inspect', {
  runId: 'moc-failed-tool-run',
});
assert.equal(recovered.response, 'recovered completion');
await failedToolAgent.close();

// Host approval denial and a preflight budget block both receive tool spans.
const toolDeniedAgent = createAgent(successfulTranscript('denial handled'), {
  hooks: {
    async onBeforeToolExec() {
      return { approved: false, reason: 'fixture user denial' };
    },
  },
});
registerFixtureTool(toolDeniedAgent);
await toolDeniedAgent.chat('moc-tool-denied-session', 'inspect', {
  runId: 'moc-tool-denied-run',
});
await toolDeniedAgent.close();

const blockedAgent = createAgent(successfulTranscript('block handled'));
registerFixtureTool(blockedAgent);
await blockedAgent.chat('moc-tool-blocked-session', 'inspect', {
  runId: 'moc-tool-blocked-run',
  maxToolCalls: 0,
});
await blockedAgent.close();

// A prior accepted readonly result can be replayed in a later run without a new execution.
let replayExecutions = 0;
const replayAgent = createAgent([
  ...successfulTranscript('first replay source'),
  ...successfulTranscript('second replay target'),
]);
registerFixtureTool(replayAgent, async () => {
  replayExecutions++;
  return 'stable fixture value';
});
await replayAgent.chat('moc-replay-session', 'inspect once', { runId: 'moc-replay-source' });
await replayAgent.chat('moc-replay-session', 'inspect again', { runId: 'moc-replay-target' });
assert.equal(replayExecutions, 1, 'the second run reuses the accepted readonly result');
await replayAgent.close();

// An open-url result suppresses a redundant fetch as a successful no-op.
const suppressedAgent = createAgent([
  { toolCalls: [{ name: 'open_url', input: { url: 'https://example.test/page' } }] },
  { text: 'opened' },
  { toolCalls: [{ name: 'web_fetch', input: { url: 'https://example.test/page' } }] },
  { text: 'confirmed without refetch' },
]);
suppressedAgent.tools.register({
  name: 'open_url',
  description: 'Open a URL.',
  metadata: { sideEffectClass: 'readonly' },
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async execute(input) {
    return `open_url_ok: opened ${input.url}`;
  },
});
suppressedAgent.tools.register({
  name: 'web_fetch',
  description: 'Fetch a URL.',
  metadata: { sideEffectClass: 'readonly' },
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async execute() {
    throw new Error('suppressed web_fetch must not execute');
  },
});
await suppressedAgent.chat('moc-suppressed-session', 'open the site', {
  runId: 'moc-suppressed-source',
});
await suppressedAgent.chat('moc-suppressed-session', 'open the same site again', {
  runId: 'moc-suppressed-target',
});
await suppressedAgent.close();

// Tool timeout and incomplete provider completion are separate terminal outcomes.
const timeoutAgent = createAgent(successfulTranscript('timeout handled'));
registerFixtureTool(timeoutAgent, async () => new Promise(() => {}), {
  sideEffectClass: 'readonly',
  timeoutMs: 20,
});
await timeoutAgent.chat('moc-timeout-session', 'inspect', { runId: 'moc-timeout-run' });
await timeoutAgent.close();

const incompleteProvider = {
  id: 'incomplete-provider',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('not used');
  },
  async stream(_options, onEvent) {
    onEvent({ type: 'content_block_delta', text: 'partial but visible' });
    onEvent({ type: 'message_stop' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'partial but visible' }],
      usage: { inputTokens: 3, outputTokens: 4 },
      incomplete: { reason: 'fixture_stream_closed' },
    };
  },
};
const incompleteAgent = createAgent([], {
  llmProvider: incompleteProvider,
  model: 'partial-model',
});
await assert.rejects(
  incompleteAgent.chat('moc-incomplete-session', 'partial', {
    runId: 'moc-incomplete-run',
  }),
  /stream incomplete/i
);
await incompleteAgent.close();

// A provider may return an explicit terminal failure without throwing.
const returnedFailureProvider = {
  id: 'returned-failure-provider',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('not used');
  },
  async stream(_options, onEvent) {
    onEvent({ type: 'content_block_delta', text: 'bounded fallback response' });
    return {
      stopReason: 'error',
      content: [{ type: 'text', text: 'bounded fallback response' }],
      usage: { inputTokens: 7, outputTokens: 3 },
      model: 'returned-failure-model',
    };
  },
};
const returnedFailureAgent = createAgent([], {
  llmProvider: returnedFailureProvider,
  model: 'returned-failure-request-model',
  maxAgentTurns: 1,
  maxLLMRetries: 0,
});
await returnedFailureAgent.chat('moc-returned-failure-session', 'return failure', {
  runId: 'moc-returned-failure-run',
});
await returnedFailureAgent.close();

// A thrown provider failure remains an ERROR span and fails the run normally.
const thrownProvider = {
  id: 'thrown-provider',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('401 fixture provider authentication failure');
  },
  async stream() {
    throw new Error('401 fixture provider authentication failure');
  },
};
const thrownProviderAgent = createAgent([], {
  llmProvider: thrownProvider,
  maxAgentTurns: 1,
  maxLLMRetries: 0,
});
await assert.rejects(
  thrownProviderAgent.chat('moc-thrown-provider-session', 'throw', {
    runId: 'moc-thrown-provider-run',
  }),
  /401 fixture provider authentication failure/
);
await thrownProviderAgent.close();

// First-chunk timeout is distinguished from a generic provider error.
const previousFirstChunkTimeout = process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS;
process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS = '20';
const timeoutProvider = {
  id: 'timeout-provider',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('not used');
  },
  async stream(options) {
    await new Promise((_, reject) => {
      options.abortSignal?.addEventListener(
        'abort',
        () => reject(options.abortSignal.reason ?? new Error('timeout provider aborted')),
        { once: true }
      );
    });
  },
};
const timeoutProviderAgent = createAgent([], {
  llmProvider: timeoutProvider,
  maxAgentTurns: 1,
  maxLLMRetries: 0,
});
try {
  await timeoutProviderAgent.chat('moc-llm-timeout-session', 'timeout', {
    runId: 'moc-llm-timeout-run',
  });
} catch {
  // Either terminal error propagation or max-turn completion is acceptable;
  // the MOC assertion below is on the actual model request.
} finally {
  await timeoutProviderAgent.close();
  if (previousFirstChunkTimeout === undefined) {
    delete process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS;
  } else {
    process.env.MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS = previousFirstChunkTimeout;
  }
}

// Cancelling after the provider starts exercises an active LLM span.
let markCancellationProviderStarted;
const cancellationProviderStarted = new Promise((resolve) => {
  markCancellationProviderStarted = resolve;
});
const cancellationProvider = {
  id: 'cancellation-provider',
  capabilities: { streaming: true },
  async complete() {
    throw new Error('not used');
  },
  async stream(options, onEvent) {
    markCancellationProviderStarted();
    onEvent({ type: 'content_block_delta', text: 'visible '.repeat(40) });
    await new Promise((_, reject) => {
      options.abortSignal?.addEventListener(
        'abort',
        () => reject(options.abortSignal.reason ?? new Error('cancel provider aborted')),
        { once: true }
      );
    });
  },
};
const cancellationAgent = createAgent([], {
  llmProvider: cancellationProvider,
  maxAgentTurns: 1,
  maxLLMRetries: 0,
});
const cancellationController = new AbortController();
const cancellationStream = cancellationAgent.streamChat(
  'moc-llm-cancel-session',
  'cancel after output',
  { runId: 'moc-llm-cancel-run', abortSignal: cancellationController.signal }
);
let pendingCancellationAdvance;
for (let index = 0; index < 20; index++) {
  pendingCancellationAdvance = cancellationStream.next();
  const winner = await Promise.race([
    cancellationProviderStarted.then(() => 'started'),
    pendingCancellationAdvance.then(() => 'event'),
  ]);
  if (winner === 'started') break;
}
await cancellationProviderStarted;
cancellationController.abort(new Error('fixture cancelled by user'));
await pendingCancellationAdvance?.catch(() => undefined);
await cancellationStream.return(undefined);
await cancellationAgent.close();

// Closing a real MossAgent generator aborts its producer and closes the root.
const earlyCloseAgent = createAgent(successfulTranscript('must not be required'));
registerFixtureTool(earlyCloseAgent);
const earlyStream = earlyCloseAgent.streamChat('moc-early-session', 'inspect', {
  runId: 'moc-early-run',
});
const firstEvent = await earlyStream.next();
assert.equal(firstEvent.done, false);
await earlyStream.return(undefined);
await earlyCloseAgent.close();

// The low-level generator driver must bind next() and return() to one context.
const generatorParent = startSpan('moc.generator.parent');
const driven = generatorParent.runInSpanContextGen(
  (async function* () {
    try {
      await withSpan('moc.generator.next', {}, async () => undefined);
      yield 'value';
    } finally {
      await withSpan('moc.generator.return', {}, async () => undefined);
    }
  })()
);
assert.deepEqual(await driven.next(), { value: 'value', done: false });
assert.deepEqual(await driven.return(undefined), { value: undefined, done: true });
generatorParent.endOutcome('ok');

const shutdownStartedAt = Date.now();
await shutdownObservability();
assert.ok(Date.now() - shutdownStartedAt < 1_500, 'a stuck consumer cannot block shutdown');
assert.ok(throwingProcessorEnds > 0, 'the throwing legacy processor was exercised');

assert.equal(consumerA.length, consumerB.length, 'both consumers receive equivalent span counts');
assert.equal(
  JSON.stringify(consumerA),
  JSON.stringify(consumerB),
  'consumer views preserve equivalent identity, topology, timing, attributes, outcome, and status'
);
assert.equal(rejectedMutations, consumerA.length, 'every consumer view is deeply immutable');
assert.notStrictEqual(consumerA[0], consumerB[0], 'each consumer receives an isolated copy');

function canonicalForRun(runId) {
  return consumerB.filter((span) => span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.runId] === runId);
}

const successSpans = canonicalForRun('moc-success-run');
const session = successSpans.find((span) => span.name === MOSS_SPAN_NAMES.session);
const turns = successSpans.filter((span) => span.name === MOSS_SPAN_NAMES.agentTurn);
const llmRequests = successSpans.filter((span) => span.name === MOSS_SPAN_NAMES.llmRequest);
const toolInvocations = successSpans.filter((span) => span.name === MOSS_SPAN_NAMES.toolInvoke);
assert.ok(session, 'one canonical session span exists');
assert.equal(successSpans.filter((span) => span.name === MOSS_SPAN_NAMES.session).length, 1);
assert.equal(toolInvocations.length, 1, 'one requested tool produces exactly one tool span');
assert.equal(
  session.parent_span_id,
  hostSpan.spanContext().spanId,
  'Studio host is the root parent'
);
assert.equal(session.outcome, 'ok');
assert.equal(session.status, 'OK');

for (const span of successSpans) {
  assert.equal(span.trace_id, session.trace_id, `${span.name} stays in the host trace`);
  assert.match(span.trace_id, /^[0-9a-f]{32}$/);
  assert.match(span.span_id, /^[0-9a-f]{16}$/);
  assert.equal(
    span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.contractVersion],
    MOSS_OBSERVABILITY_CONTRACT_VERSION
  );
  assert.equal(span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.runId], 'moc-success-run');
  assert.equal(span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.sessionId], 'moc-shared-session');
  assert.equal(span.attributes[MOSS_LEGACY_ATTRIBUTE_ALIASES.runId], 'moc-success-run');
  assert.equal(span.attributes[MOSS_LEGACY_ATTRIBUTE_ALIASES.sessionId], 'moc-shared-session');
}
for (const turn of turns) assert.equal(turn.parent_span_id, session.span_id);
for (const child of [...llmRequests, ...toolInvocations]) {
  const parent = turns.find((turn) => turn.span_id === child.parent_span_id);
  assert.ok(parent, `${child.name} is parented to an initiating turn`);
}
for (const llm of llmRequests) {
  assert.equal(llm.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.genAiOperationName], 'chat');
  assert.equal(llm.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.genAiProviderName], 'mock-provider');
  assert.equal(llm.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.genAiRequestModel], 'gpt-test-model');
  assert.ok(llm.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageInputTokens] >= 0);
  assert.ok(llm.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageOutputTokens] >= 0);
  assert.equal(llm.outcome, 'ok');
  assert.equal(llm.status, 'OK');
}
assert.ok(
  llmRequests.some(
    (llm) =>
      llm.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.genAiResponseModel] === 'gpt-test-response-model'
  ),
  'a known provider response model is retained'
);
assert.equal(
  toolInvocations[0].attributes[MOSS_OBSERVABILITY_ATTRIBUTES.toolOutcomeKind],
  'executed'
);
assert.equal(toolInvocations[0].outcome, 'ok');
assert.equal(toolInvocations[0].status, 'OK');

const sameConversationSessions = consumerB.filter(
  (span) =>
    span.name === MOSS_SPAN_NAMES.session &&
    span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.sessionId] === 'moc-shared-session'
);
assert.equal(sameConversationSessions.length, 2);
assert.notEqual(
  sameConversationSessions[0].attributes[MOSS_OBSERVABILITY_ATTRIBUTES.runId],
  sameConversationSessions[1].attributes[MOSS_OBSERVABILITY_ATTRIBUTES.runId]
);

const deniedSession = canonicalForRun('moc-denied-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.session
);
assert.equal(deniedSession?.outcome, 'denied');
assert.equal(deniedSession?.status, 'UNSET');

const failedTool = canonicalForRun('moc-failed-tool-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.toolInvoke
);
const recoveredSession = canonicalForRun('moc-failed-tool-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.session
);
assert.equal(failedTool?.outcome, 'error');
assert.equal(failedTool?.status, 'ERROR');
assert.equal(recoveredSession?.outcome, 'ok', 'a handled failed child does not poison its parent');
assert.equal(recoveredSession?.status, 'OK');

const deniedTool = canonicalForRun('moc-tool-denied-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.toolInvoke
);
assert.equal(deniedTool?.outcome, 'denied');
assert.equal(deniedTool?.status, 'UNSET');

const blockedTool = canonicalForRun('moc-tool-blocked-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.toolInvoke
);
assert.equal(blockedTool?.outcome, 'blocked');
assert.equal(blockedTool?.status, 'UNSET');

const replayedTool = canonicalForRun('moc-replay-target').find(
  (span) => span.name === MOSS_SPAN_NAMES.toolInvoke
);
assert.equal(replayedTool?.outcome, 'replayed');
assert.equal(replayedTool?.status, 'OK');

const suppressedTool = canonicalForRun('moc-suppressed-target').find(
  (span) => span.name === MOSS_SPAN_NAMES.toolInvoke
);
assert.equal(suppressedTool?.outcome, 'suppressed');
assert.equal(suppressedTool?.status, 'OK');

const timeoutTool = canonicalForRun('moc-timeout-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.toolInvoke
);
assert.equal(timeoutTool?.outcome, 'error');
assert.equal(timeoutTool?.status, 'ERROR');
assert.equal(timeoutTool?.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.errorCategory], 'timeout');

const incompleteLlm = canonicalForRun('moc-incomplete-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.llmRequest
);
assert.equal(incompleteLlm?.outcome, 'incomplete');
assert.equal(incompleteLlm?.status, 'UNSET');

const returnedFailureLlm = canonicalForRun('moc-returned-failure-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.llmRequest
);
assert.equal(returnedFailureLlm?.outcome, 'error');
assert.equal(returnedFailureLlm?.status, 'ERROR');
assert.equal(
  returnedFailureLlm?.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.genAiResponseModel],
  'returned-failure-model'
);

const thrownProviderLlm = canonicalForRun('moc-thrown-provider-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.llmRequest
);
assert.equal(thrownProviderLlm?.outcome, 'error');
assert.equal(thrownProviderLlm?.status, 'ERROR');
assert.equal(
  thrownProviderLlm?.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.errorCategory],
  'provider'
);

const timeoutProviderLlm = canonicalForRun('moc-llm-timeout-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.llmRequest
);
assert.equal(timeoutProviderLlm?.outcome, 'error');
assert.equal(timeoutProviderLlm?.status, 'ERROR');
assert.equal(
  timeoutProviderLlm?.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.errorCategory],
  'timeout'
);

const cancelledLlm = canonicalForRun('moc-llm-cancel-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.llmRequest
);
assert.equal(cancelledLlm?.outcome, 'cancelled');
assert.equal(cancelledLlm?.status, 'UNSET');

const earlySession = canonicalForRun('moc-early-run').find(
  (span) => span.name === MOSS_SPAN_NAMES.session
);
assert.equal(earlySession?.outcome, 'cancelled');
assert.equal(earlySession?.status, 'UNSET');

const generatorParentSpan = consumerB.find((span) => span.name === 'moc.generator.parent');
const generatorChildren = consumerB.filter((span) => span.name.startsWith('moc.generator.'));
for (const child of generatorChildren.filter((span) => span !== generatorParentSpan)) {
  assert.equal(child.parent_span_id, generatorParentSpan?.span_id);
}

const canonicalNames = new Set(Object.values(MOSS_SPAN_NAMES));
const canonicalSpans = consumerB.filter((span) => canonicalNames.has(span.name));
const measurementsFor = (metric) =>
  metricMeasurements.filter((measurement) => measurement.name === metric.name);
const outcomeCounts = (items, readOutcome) => {
  const counts = new Map();
  for (const item of items) {
    const outcome = readOutcome(item);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
};
const assertMetricOutcomeParity = (spanName, metric) => {
  const spans = canonicalSpans.filter((span) => span.name === spanName);
  const measurements = measurementsFor(metric);
  assert.deepEqual(
    outcomeCounts(measurements, (measurement) => measurement.attributes['moss.outcome']),
    outcomeCounts(spans, (span) => span.outcome),
    `${metric.name} outcomes match ${spanName} spans`
  );
};

assertMetricOutcomeParity(MOSS_SPAN_NAMES.session, MOSS_METRIC_CATALOG.sessionCount);
assertMetricOutcomeParity(MOSS_SPAN_NAMES.llmRequest, MOSS_METRIC_CATALOG.llmRequestDuration);
assertMetricOutcomeParity(MOSS_SPAN_NAMES.toolInvoke, MOSS_METRIC_CATALOG.toolInvocations);
assert.equal(
  measurementsFor(MOSS_METRIC_CATALOG.sessionDuration).length,
  measurementsFor(MOSS_METRIC_CATALOG.sessionCount).length
);
assert.equal(
  measurementsFor(MOSS_METRIC_CATALOG.toolInvokeDuration).length,
  measurementsFor(MOSS_METRIC_CATALOG.toolInvocations).length
);

const toolCountsByRun = new Map();
for (const span of canonicalSpans.filter((item) => item.name === MOSS_SPAN_NAMES.toolInvoke)) {
  const runId = span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.runId];
  toolCountsByRun.set(runId, (toolCountsByRun.get(runId) ?? 0) + 1);
}
const sessionRunIds = canonicalSpans
  .filter((span) => span.name === MOSS_SPAN_NAMES.session)
  .map((span) => span.attributes[MOSS_OBSERVABILITY_ATTRIBUTES.runId]);
assert.deepEqual(
  measurementsFor(MOSS_METRIC_CATALOG.sessionToolCount)
    .map((measurement) => measurement.value)
    .sort((left, right) => left - right),
  sessionRunIds.map((runId) => toolCountsByRun.get(runId) ?? 0).sort((left, right) => left - right),
  'session tool-count metrics equal requested canonical tool spans'
);

for (const metric of Object.values(MOSS_METRIC_CATALOG)) {
  assert.deepEqual(
    metricDefinitions.get(metric.name),
    { kind: metric.kind, unit: metric.unit },
    `${metric.name} preserves its MOC kind and unit`
  );
}
const allowedMetricDimensions = new Set([
  'moss.outcome',
  'direction',
  'model.family',
  'tool.category',
]);
for (const measurement of metricMeasurements) {
  assert.ok(Number.isFinite(measurement.value) && measurement.value >= 0);
  for (const key of Object.keys(measurement.attributes)) {
    assert.ok(allowedMetricDimensions.has(key), `${measurement.name} rejects ${key}`);
  }
}

await fs.rm(tmp, { recursive: true, force: true });
console.error('[spec] observability-moc-conformance OK');
