#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureProcess, runProcess } from './lib/proc.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(script), '../..');
const dist = process.env.MOSS_VERIFY_DIST_ROOT ?? path.join(root, 'dist');
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const [
  { MossAgent },
  { VersionedSessionStore },
  tasks,
  artifacts,
  { resumeTask },
  { createAgentTurnRunner },
  { VersionedContextPipeline, projectContextHandoff },
  { decodeSummaryEntries, relevantHistoricalExcerpts },
] = await Promise.all([
  load('core/agent/moss-agent.js'),
  load('core/session/versioned-session-store.js'),
  load('core/task/task-store.js'),
  load('core/task-runtime/artifacts.js'),
  load('core/task/task-engine.js'),
  load('core/task/agent-turn.js'),
  load('core/session/versioned-context.js'),
  load('core/session/context-summary-evidence.js'),
]);

const oldClaim = 'OBSOLETE_CLAIM_FULL_ACCEPTANCE';
const correctionText = 'Health check returned HTTP 200. Full acceptance has not run.';
const oldSummary = 'OBSOLETE_CHECKPOINT_FULL_ACCEPTANCE';
const beforeCorrection = 'Retained observation from older messages';
const text = (value) => ({ type: 'text', text: value });
const response = (...content) => ({
  stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
  content,
});
const toolCall = (name, id = name, input = {}) => ({ type: 'tool_use', id, name, input });

function intentFrame(request) {
  const lines = request.systemPrompt.split('\n');
  const index = lines.lastIndexOf('[Runtime-owned current task intent]');
  assert.notEqual(index, -1, 'runtime task intent must reach the provider');
  return JSON.parse(lines[index + 1]);
}

function decide(request, disposition, options = {}) {
  const frame = intentFrame(request);
  if (!frame.pendingInputs.length) return [];
  return [
    toolCall('turn_decision', `decision-${frame.inputSeq}`, {
      baseRevision: frame.revision,
      inputSeq: frame.inputSeq,
      messageIds: frame.pendingInputs.map((item) => item.id),
      changes: [],
      disposition,
      plan: disposition === 'execute' ? ['Perform the requested action'] : [],
      ...options,
    }),
  ];
}

function summaryInput(request) {
  if (!request.systemPrompt.includes('Summarize the supplied historical data')) return undefined;
  assert.equal(request.messages.length, 1);
  return JSON.parse(request.messages[0].content);
}

function summarize(input) {
  const chosen =
    input.sources.find((source) => JSON.stringify(source).includes(oldClaim)) ?? input.sources[0];
  assert(chosen, 'summary request must contain at least one source');
  return response(
    text(
      JSON.stringify([
        {
          kind: 'unverified',
          text: JSON.stringify(chosen).includes(oldClaim) ? oldSummary : beforeCorrection,
          sourceIds: [chosen.id],
        },
      ])
    )
  );
}

function createAgent(workspace, store, options = {}) {
  const modelRequests = [];
  const summaryRequests = [];
  const agent = new MossAgent({
    llmProvider: {
      id: 'scripted-versioned',
      displayName: 'Offline versioned context probe',
      capabilities: { streaming: false, structuredOutput: options.structuredOutput },
      async complete(request) {
        const input = summaryInput(request);
        if (input) {
          summaryRequests.push(structuredClone(input));
          return options.onSummary?.(input) ?? summarize(input);
        }
        modelRequests.push({
          systemPrompt: request.systemPrompt,
          messages: structuredClone(request.messages),
          tools: request.tools?.map((tool) => tool.name),
        });
        return (
          options.onMain?.(request, modelRequests.length) ??
          response(...decide(request, 'answer'), text('The current context was evaluated.'))
        );
      },
      async stream() {
        throw new Error('The scripted provider is non-streaming');
      },
    },
    sessionStore: store,
    workspaceDir: workspace,
    taskIntent: options.taskIntent ?? true,
    model: 'scripted-versioned',
    contextTokens: 32_000,
    maxTokens: 1024,
    baseSystemPrompt: 'Follow the authenticated current user and use source evidence.',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  return { agent, modelRequests, summaryRequests };
}

async function usingAgent(workspace, fn, options) {
  const store = new VersionedSessionStore(path.join(workspace, 'context.sqlite'));
  const fixture = createAgent(workspace, store, options);
  try {
    return await fn({ ...fixture, store });
  } finally {
    await fixture.agent.close();
    store.close();
  }
}

async function add(store, session, role, content, origin = role) {
  await store.appendMessage(session, { role, content }, origin);
}

async function testContextHandoff(workspace) {
  const database = path.join(workspace, 'handoff.sqlite');
  const store = new VersionedSessionStore(database);
  const sourceKey = 'original-device';
  const targetKey = 'new-device';
  const request = { sourceKey, targetKey, deliveryId: 'handoff-one' };
  try {
    await add(store, sourceKey, 'user', 'Keep model M.');
    await add(store, sourceKey, 'assistant', 'Model M is ready to inspect.');
    await add(store, sourceKey, 'assistant', oldClaim);
    const targetId = (await store.sourceMessages(sourceKey)).at(-1).id;
    await store.correct(sourceKey, { id: 'correct-original', targetId, text: correctionText });
    const snapshot = store.snapshot(sourceKey);
    const projected = projectContextHandoff(snapshot);
    assert.deepEqual(
      projected.map(({ text }) => text),
      ['Keep model M.', 'Model M is ready to inspect.']
    );
    const content = projected.map(({ text }) => text).join('\n') + '\n' + correctionText;
    const input = {
      ...request,
      sourceRevision: snapshot.revision,
      message: { role: 'assistant', content },
    };
    assert.equal(
      await store.appendContextHandoffOnce({ ...input, sourceRevision: 0 }),
      'source-changed'
    );
    assert.deepEqual(await store.loadMessages(targetKey), []);
    assert.equal(await store.appendContextHandoffOnce(input), 'imported');
    assert.equal(await store.appendContextHandoffOnce(input), 'duplicate');
    assert.deepEqual(
      store.snapshot(targetKey).messages.map(({ origin }) => origin),
      ['assistant']
    );
    store.updateInbox(sourceKey, (inbox) => inbox.admit({ prompt: 'A correction may follow.' }));
    assert.equal(
      await store.appendContextHandoffOnce({ ...input, deliveryId: 'handoff-two' }),
      'source-changed'
    );
  } finally {
    store.close();
  }
  const reopened = new VersionedSessionStore(database);
  try {
    const transferred = await reopened.sourceMessages(targetKey);
    assert.equal(transferred.length, 1);
    assert.doesNotMatch(JSON.stringify(transferred), new RegExp(oldClaim));
    await reopened.correct(targetKey, {
      id: 'correct-import',
      targetId: transferred[0].id,
      text: 'Model M still needs testing.',
    });
    assert.deepEqual(projectContextHandoff(reopened.snapshot(targetKey)), []);
  } finally {
    reopened.close();
  }
}

async function seed(store, session) {
  for (let index = 0; index < 8; index++) {
    await add(store, session, 'assistant', `Earlier note ${index}. `.repeat(215));
  }
  await add(store, session, 'assistant', oldClaim);
  await add(store, session, 'assistant', 'OBSOLETE_DEPENDENT_DEPLOY_PLAN');
  for (let index = 0; index < 10; index++) {
    await add(store, session, 'user', `Retain user requirement ${index}.`);
  }
  const sources = await store.sourceMessages(session);
  return sources.find((source) => source.message.content === oldClaim).id;
}

function latch() {
  return Promise.withResolvers();
}

async function waitFor(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 7000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observeRace(operation, arrived, label) {
  return waitFor(
    Promise.race([
      arrived.promise,
      operation.then(() => {
        throw new Error(`The operation finished before reaching ${label}`);
      }),
    ]),
    label
  );
}

function correct(agent, session, targetId, id) {
  return agent.correctContext(session, { id, targetId, text: correctionText });
}

async function testProgressiveStages(workspace) {
  const store = new VersionedSessionStore(path.join(workspace, 'progressive.sqlite'));
  const pipeline = new VersionedContextPipeline(store);
  const release = latch();
  const completed = latch();
  let summaryCalls = 0;
  const signal = AbortSignal.timeout(8000);
  try {
    const common = {
      window: 14000,
      output: 1024,
      minOutput: 1024,
      measure: (messages) => Buffer.byteLength(JSON.stringify(messages)),
      summarize: async () => '[]',
      signal,
      policyKey: 'progressive-probe',
    };
    await add(store, 'output', 'user', 'Keep the requested user text.');
    const reduced = await pipeline.prepare({
      ...common,
      sessionKey: 'output',
      window: 9000,
      output: 2800,
      minOutput: 1000,
      measure: () => 7400,
    });
    assert.deepEqual(reduced.stages, ['S1']);
    assert(reduced.output >= 1000 && reduced.output < 2800);
    assert.match(JSON.stringify(reduced.messages), /Keep the requested user text/);

    await add(store, 'tool', 'assistant', [toolCall('read_file', 'tool-1')]);
    const original = `${'head-'.repeat(2000)}ORIGINAL_MIDDLE${'tail-'.repeat(2000)}`;
    await add(
      store,
      'tool',
      'user',
      [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: original,
        },
      ],
      'tool'
    );
    for (let index = 0; index < 9; index++)
      await add(store, 'tool', 'user', `Recent user text ${index}.`);
    const edited = await pipeline.prepare({ ...common, sessionKey: 'tool' });
    assert(edited.stages.includes('S2'));
    assert.doesNotMatch(JSON.stringify(edited.messages), /ORIGINAL_MIDDLE/);
    assert.match(JSON.stringify(edited.messages), /Original source/);
    assert.equal((await store.sourceMessages('tool'))[1].message.content[0].content, original);

    // A single new request ages the finished tool read. The active tool response
    // still needs all of its details when the assistant is deciding what to do next.
    const finished = 'finished-reads';
    await add(store, finished, 'user', 'Read the earlier result.');
    await add(store, finished, 'assistant', [toolCall('read_file', 'finished-tool')]);
    const oldOutput = `${'historic line\n'.repeat(350)}HISTORIC_MIDDLE${'historic line\n'.repeat(50)}`;
    await add(
      store,
      finished,
      'user',
      [
        {
          type: 'tool_result',
          tool_use_id: 'finished-tool',
          content: oldOutput,
        },
      ],
      'tool'
    );
    await add(store, finished, 'user', 'Read and inspect a different result.');
    await add(store, finished, 'assistant', [toolCall('read_file', 'active-tool')]);
    const freshOutput = `${'active line\n'.repeat(350)}ACTIVE_MIDDLE${'active line\n'.repeat(50)}`;
    await add(
      store,
      finished,
      'user',
      [
        {
          type: 'tool_result',
          tool_use_id: 'active-tool',
          content: freshOutput,
        },
      ],
      'tool'
    );
    const aged = await pipeline.prepare({ ...common, sessionKey: finished });
    assert(aged.stages.includes('S2'));
    assert.doesNotMatch(JSON.stringify(aged.messages), /HISTORIC_MIDDLE/);
    assert.match(JSON.stringify(aged.messages), /ACTIVE_MIDDLE/);
    const retained = await store.sourceMessages(finished);
    assert.equal(retained.find((row) => row.ordinal === 3).message.content[0].content, oldOutput);

    await add(
      store,
      finished,
      'user',
      [{ type: 'tool_result', tool_use_id: 'orphan-intent', content: 'ORPHAN_INTENT_RECEIPT' }],
      'tool'
    );
    await add(store, finished, 'user', 'Continue from the inspection.');
    const latestEvidence = retained.find((row) => row.ordinal === 6);
    const compacted = await pipeline.prepare({
      ...common,
      sessionKey: finished,
      policyKey: 'finished-evidence-probe',
      force: true,
      summarize: async ({ system, userPrompt }) => {
        assert.match(system, /The only allowed kinds/);
        assert.doesNotMatch(userPrompt, /HISTORIC_MIDDLE|ACTIVE_MIDDLE|ORPHAN_INTENT_RECEIPT/);
        return '[]';
      },
    });
    assert(compacted.stages.includes('S5'));
    assert.match(JSON.stringify(compacted.messages), /Recent tool evidence.*active line/);
    assert.doesNotMatch(JSON.stringify(compacted.messages), /ORPHAN_INTENT_RECEIPT/);
    assert(compacted.sourceIds.includes(latestEvidence.id));

    const lookup = 'historical-evidence-lookup';
    await add(
      store,
      lookup,
      'user',
      'Inspect the two devices and preserve their individual readings.'
    );
    await add(store, lookup, 'assistant', [toolCall('read_file', 'old-config')]);
    await add(
      store,
      lookup,
      'user',
      [
        {
          type: 'tool_result',
          tool_use_id: 'old-config',
          content: `${'unrelated settings\n'.repeat(180)}Device A config: sensor_gain=17\n${'other output\n'.repeat(180)}`,
        },
      ],
      'legacy'
    );
    await add(store, lookup, 'assistant', [toolCall('read_file', 'recent-read')]);
    await add(
      store,
      lookup,
      'user',
      [
        {
          type: 'tool_result',
          tool_use_id: 'recent-read',
          content: 'Device B finished with a green indicator.',
        },
      ],
      'tool'
    );
    await add(store, lookup, 'assistant', 'Final review details. '.repeat(350));
    await add(store, lookup, 'user', 'What was sensor_gain for Device A?');
    const fallback = await pipeline.prepare({ ...common, sessionKey: lookup, force: true });
    assert(fallback.stages.includes('S5'));
    const restored = await pipeline.prepare({ ...common, sessionKey: lookup });
    assert(restored.stages.includes('S4'));
    assert.match(JSON.stringify(restored.messages), /sensor_gain=17/);
    const lookupSources = await store.sourceMessages(lookup);
    assert(restored.sourceIds.includes(lookupSources.find((row) => row.ordinal === 3).id));

    for (let index = 0; index < 3; index++) {
      await add(store, 'background', 'assistant', 'Historical analysis. '.repeat(125));
    }
    for (let index = 0; index < 9; index++)
      await add(store, 'background', 'user', `Current instruction ${index}.`);
    const preparationOptions = {
      ...common,
      sessionKey: 'background',
      summarize: async ({ userPrompt }) => {
        summaryCalls++;
        const source = JSON.parse(userPrompt).sources[0];
        await release.promise;
        completed.resolve();
        return JSON.stringify([
          { kind: 'unverified', text: 'Ready historical checkpoint', sourceIds: [source.id] },
        ]);
      },
    };
    const pending = await waitFor(
      pipeline.prepare(preparationOptions),
      'a request without background blocking'
    );
    assert(pending.stages.includes('S3'));
    assert.doesNotMatch(JSON.stringify(pending.messages), /Ready historical checkpoint/);
    assert.equal(summaryCalls, 1);
    release.resolve();
    await waitFor(completed.promise, 'the background summary');
    // The ready continuation commits the checkpoint in a subsequent microtask.
    await new Promise((resolve) => setImmediate(resolve));
    const reused = await pipeline.prepare({ ...preparationOptions, force: true });
    assert(reused.stages.includes('S4'), JSON.stringify(reused.stages));
    assert.equal(summaryCalls, 1);
    assert.match(JSON.stringify(reused.messages), /Ready historical checkpoint/);
  } finally {
    release.resolve();
    store.close();
  }
  console.log(
    'PASS progressive context adjusts output, edits old results, prepares asynchronously and reuses a ready checkpoint'
  );
}

async function testPressureContinuation(workspace) {
  const session = 'pressure-continuation';
  const visiblePrefix = 'The measured size is 4096 bytes. ';
  const privateReasoning = 'Discarded private reasoning. '.repeat(180);
  const userText = 'Report the measured byte count and verification status.';
  await usingAgent(
    workspace,
    async ({ agent, store }) => {
      const receipt = 'Observed bytes=4096.\n' + 'Repeated archived output.\n'.repeat(350);
      await add(
        store,
        session,
        'user',
        [{ type: 'tool_result', tool_use_id: 'archived', name: 'read_file', content: receipt }],
        'legacy'
      );
      await add(store, session, 'assistant', 'Earlier analysis. '.repeat(1100));
      await add(store, session, 'user', userText);
      const input = {
        sessionKey: session,
        window: 16_000,
        output: 4096,
        minOutput: 1024,
        force: true,
        policyKey: 'pressure-continuation-probe',
        measure: (messages) => 13_350 + Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4),
        summarize: async () =>
          JSON.stringify([
            { kind: 'observation', text: 'Observed bytes=4096.', sourceIds: ['s1'] },
          ]),
        signal: AbortSignal.timeout(8_000),
      };
      const pipeline = new VersionedContextPipeline(store);
      const projection = await pipeline.prepare(input);
      assert(projection.stages.includes('S5'));
      assert(projection.output >= 2000, `only ${projection.output} tokens left to answer`);
      assert.match(JSON.stringify(projection.messages), /Observed bytes=4096/);
      assert(JSON.stringify(projection.messages).includes(userText));
      assert.equal((await store.sourceMessages(session))[0].message.content[0].content, receipt);

      const oversized = 'Required user text. '.repeat(1400);
      await add(store, 'oversized-user', 'user', oversized);
      await assert.rejects(pipeline.prepare({ ...input, sessionKey: 'oversized-user' }), {
        code: 'PROVIDER_CONTEXT_OVERFLOW',
      });
      assert.equal((await store.sourceMessages('oversized-user'))[0].message.content, oversized);

      const reply = await agent.chat('live-continuation', userText, {
        taskFlow: false,
        maxTurns: 6,
      });
      assert.equal(reply.response, `${visiblePrefix}Verification complete.`);
      const original = await store.sourceMessages('live-continuation');
      assert.equal(
        original.filter(({ message }) => message.outputLimit === 'continuation').length,
        2
      );
      assert(original.some(({ message }) => message.thinking?.join('').includes(privateReasoning)));
    },
    {
      taskIntent: false,
      reasoning: 'medium',
      onMain(request, count) {
        const sent = JSON.stringify(request.messages);
        assert(sent.includes(userText));
        assert.doesNotMatch(sent, /Discarded private reasoning/);
        if (count === 1) {
          assert.equal(request.reasoning, 'medium');
          return { stopReason: 'max_tokens', content: [], thinking: [privateReasoning] };
        }
        assert.equal(request.reasoning, 'low');
        if (count === 2) {
          assert.match(sent, /used the entire output budget on private reasoning/);
          return {
            stopReason: 'max_tokens',
            content: [text(`${visiblePrefix}<think>${privateReasoning}`)],
            thinking: [privateReasoning],
          };
        }
        assert.equal(count, 3);
        assert.match(sent, /The measured size is 4096 bytes/);
        assert.match(sent, /previous response was truncated/);
        assert.doesNotMatch(sent, /used the entire output budget on private reasoning/);
        return response(text('Verification complete.'));
      },
    }
  );
  console.log(
    'PASS pressured checkpoints reserve output and cutoff retries retain only visible context'
  );
}

async function testActiveToolPressure(workspace) {
  const session = 'active-tool-pressure';
  const user = 'Inspect the selected board and report the exact detection count.';
  const original =
    'Board model is RDK X5.\n' +
    'log line\n'.repeat(1600) +
    'RAW_ARCHIVE_ONLY\n' +
    'log line\n'.repeat(1600) +
    'End of board diagnostics.';
  const latest = 'Inference exited with status 0.\n' + 'trace\n'.repeat(250) + 'Detection count: 4';
  await usingAgent(workspace, async ({ store }) => {
    await add(store, session, 'user', user);
    for (const [id, name, content] of [
      ['diagnostics', 'device_diagnose', original],
      ['inference', 'device_exec', latest],
    ]) {
      await add(store, session, 'assistant', [toolCall(name, id)]);
      await add(
        store,
        session,
        'user',
        [{ type: 'tool_result', tool_use_id: id, name, content }],
        'tool'
      );
    }
    const pipeline = new VersionedContextPipeline(store);
    const input = {
      sessionKey: session,
      window: 10_000,
      output: 2048,
      minOutput: 1024,
      policyKey: 'active-tool-pressure-probe',
      measure: (messages) => 3400 + Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4),
      summarize: async () => {
        throw new Error('The active turn cannot be summarized');
      },
      signal: AbortSignal.timeout(8_000),
    };
    const sources = await store.sourceMessages(session);
    const archived = sources.find((row) => row.message.content[0]?.tool_use_id === 'diagnostics');
    assert.ok(archived);
    const full = await pipeline.prepare({ ...input, window: 40_000 });
    assert(full.messages.some((message) => message.content[0]?.content === original));
    const projected = await pipeline.prepare(input);
    assert(projected.stages.includes('S2'));
    assert(projected.messages.some((message) => message.content === user));
    assert(projected.messages.some((message) => message.content[0]?.content === latest));
    assert.match(JSON.stringify(projected.messages), /Board model is RDK X5/);
    assert(JSON.stringify(projected.messages).includes(archived.id));
    assert(projected.sourceIds.includes(archived.id));
    assert.doesNotMatch(JSON.stringify(projected.messages), /RAW_ARCHIVE_ONLY/);
    assert.deepEqual(await store.sourceMessages(session), sources);

    const oversized =
      'Full log for the newest board operation.\n' +
      'diagnostic payload\n'.repeat(1150) +
      'MIDDLE_ARCHIVE_ONLY\n' +
      'diagnostic payload\n'.repeat(1150) +
      'Final detection count: 7';
    await add(store, session, 'assistant', [toolCall('device_file_read', 'oversized')]);
    await add(
      store,
      session,
      'user',
      [
        {
          type: 'tool_result',
          tool_use_id: 'oversized',
          name: 'device_file_read',
          content: oversized,
          structuredContent: [{ type: 'text', text: oversized }],
        },
      ],
      'tool'
    );
    const latestSources = await store.sourceMessages(session);
    const source = latestSources.at(-1);
    const bounded = await pipeline.prepare(input);
    assert(bounded.stages.includes('S2'));
    assert(bounded.messages.some((message) => message.content === user));
    const excerpt = bounded.messages
      .flatMap((message) => message.content)
      .find((part) => part.tool_use_id === 'oversized');
    assert(excerpt, 'An oversized active tool result must keep its call/result identity');
    assert(excerpt.content.includes(source.id));
    assert.match(excerpt.content, /Final detection count: 7/);
    assert.doesNotMatch(JSON.stringify(bounded.messages), /MIDDLE_ARCHIVE_ONLY/);
    assert(bounded.sourceIds.includes(source.id));
    assert.deepEqual(await store.sourceMessages(session), latestSources);
  });
  console.log(
    'PASS active tool pressure keeps recent receipts when possible and cites oversized archived results'
  );
}

async function testConcurrentSummary(workspace) {
  const summaryStarted = latch();
  const releaseSummary = latch();
  let pause = true;

  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests, summaryRequests }) => {
      const session = 'checkpoint';
      const targetId = await seed(store, session);
      const captured = agent.compactSession(session);
      const settled = captured.then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      try {
        await observeRace(captured, summaryStarted, 'the summary model request');
        const correction = await correct(agent, session, targetId, 'summary-race');
        assert.equal(correction.revision, 1);
      } finally {
        pause = false;
        releaseSummary.resolve();
      }
      const outcome = await settled;
      assert.match(String(outcome.error), /history changed|context changed|superseded/i);
      const rebuilt = await agent.compactSession(session);
      assert.equal(rebuilt.compacted, true);
      assert.match(rebuilt.summary, new RegExp(beforeCorrection));
      assert.doesNotMatch(rebuilt.summary, new RegExp(oldSummary));
      assert(
        summaryRequests.slice(1).every((request) => !JSON.stringify(request).includes(oldClaim))
      );
      await agent.chat(session, 'What remains to verify?', { taskFlow: false, maxTurns: 4 });
      const sent = JSON.stringify(modelRequests);
      assert.doesNotMatch(
        sent,
        new RegExp(`${oldClaim}|${oldSummary}|OBSOLETE_DEPENDENT_DEPLOY_PLAN`)
      );
      assert.match(sent, /Health check returned HTTP 200/);
      assert.match(sent, /Retain user requirement 0/);
      const sources = await store.sourceMessages(session);
      assert.equal(sources.find((source) => source.id === targetId).message.content, oldClaim);
      assert(sources.some((source) => source.message.content === 'OBSOLETE_DEPENDENT_DEPLOY_PLAN'));
    },
    {
      async onSummary(input) {
        if (pause) {
          summaryStarted.resolve();
          await releaseSummary.promise;
        }
        return summarize(input);
      },
    }
  );
  console.log(
    'PASS concurrent correction rejects an in-flight checkpoint and rebuilds from retained sources'
  );
}

async function testSummarySourceValidation(workspace) {
  const receipts = [
    ['older-run', 'RUNDIR=/old/run\nSaved to file: result.png'],
    ['current-run', 'RUNDIR=/tmp/new-run\nSaved to file: result.png'],
    ['old-artifact-check', 'Existing file: /old/run/result.png'],
  ].map(([id, content], ordinal) => ({
    id,
    ordinal,
    origin: 'legacy',
    message: { role: 'user', content: [{ type: 'tool_result', content }] },
  }));
  assert.deepEqual(relevantHistoricalExcerpts(receipts, '请核对这次的渲染文件'), [
    { sourceId: 'current-run', origin: 'tool', text: receipts[1].message.content[0].content },
  ]);
  const citations = [
    { id: 's1', sourceId: 'first', origin: 'tool', text: 'Replay: received zero detections.' },
    { id: 's2', sourceId: 'second', origin: 'tool', text: 'Direct feed: received two detections.' },
  ];
  const decoded = decodeSummaryEntries(
    JSON.stringify([
      { kind: 'observation', text: 'Replay: received two detections.', sourceIds: ['s1', 's2'] },
      { kind: 'observation', text: 'Replay: received zero detections.', sourceIds: ['s1'] },
    ]),
    citations
  );
  assert.deepEqual(
    decoded.map(({ kind, sourceIds }) => [kind, sourceIds]),
    [
      ['unverified', ['first', 'second']],
      ['observation', ['first']],
    ]
  );
  let corrupt = true;
  await usingAgent(
    workspace,
    async ({ agent, store }) => {
      const session = 'summary-sources';
      await seed(store, session);

      const fallback = await agent.compactSession(session);
      assert.equal(fallback.compacted, true);
      assert.doesNotMatch(fallback.summary, /FABRICATED_EVIDENCE|unknown-source/);
      const sources = await store.sourceMessages(session);
      assert(sources.some(({ id }) => fallback.summary.includes(`[sources: ${id}]`)));
      assert.match(fallback.summary, /Source excerpt/);
      corrupt = false;
      const validSession = 'summary-partial-sources';
      await seed(store, validSession);
      const rebuilt = await agent.compactSession(validSession);
      assert.equal(rebuilt.compacted, true);
      assert.doesNotMatch(rebuilt.summary, /FABRICATED_EVIDENCE|unknown-source/);
      assert.match(
        rebuilt.summary,
        /\[unverified\] Unsupported assistant observation \[sources: [a-f0-9-]+\]/
      );
    },
    {
      onSummary(input) {
        return corrupt
          ? response(
              text(
                JSON.stringify([
                  {
                    kind: 'observation',
                    text: 'FABRICATED_EVIDENCE',
                    sourceIds: ['unknown-source'],
                  },
                ])
              )
            )
          : response(
              text(
                JSON.stringify([
                  {
                    kind: 'observation',
                    text: 'Unsupported assistant observation',
                    sourceIds: [input.sources.find(({ origin }) => origin === 'assistant').id],
                  },
                  {
                    kind: 'observation',
                    text: 'FABRICATED_EVIDENCE',
                    sourceIds: ['unknown-source'],
                  },
                ])
              )
            );
      },
    }
  );
  console.log(
    'PASS invalid summary citations fall back to genuine sources and valid entries are retained'
  );
}

async function testApproval(workspace) {
  const approvalStarted = latch();
  const releaseApproval = latch();
  let obsoleteStarts = 0;
  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests }) => {
      const session = 'approval';
      await add(store, session, 'assistant', oldClaim);
      const targetId = (await store.sourceMessages(session))[0].id;
      agent.tools.register({
        name: 'test_approval_action',
        description: 'Simulate a local write after approval',
        metadata: { sideEffectClass: 'local_write' },
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          obsoleteStarts++;
          return 'UNEXPECTED_OLD_ACTION';
        },
      });
      const operation = agent.chat(session, 'Apply the current plan', {
        taskFlow: false,
        maxTurns: 6,
      });
      const settled = operation.then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      try {
        await observeRace(operation, approvalStarted, 'tool approval');
        await correct(agent, session, targetId, 'approval-race');
        assert.equal(
          agent.getTaskIntentReceipt(session, 'context:approval-race').status,
          'pending'
        );
      } finally {
        releaseApproval.resolve();
      }
      const outcome = await settled;
      if (outcome.error) throw outcome.error;
      assert.equal(obsoleteStarts, 0, 'obsolete action started after correction');
      assert.match(JSON.stringify(modelRequests[0]), new RegExp(oldClaim));
      assert.doesNotMatch(JSON.stringify(modelRequests.slice(1)), new RegExp(oldClaim));
      assert.equal(
        agent.getTaskIntentReceipt(session, 'context:approval-race').status,
        'committed'
      );
      assert(modelRequests.length >= 2);
    },
    {
      onMain(request, count) {
        return count === 1
          ? response(...decide(request, 'execute'), toolCall('test_approval_action'))
          : response(...decide(request, 'answer'), text('The obsolete action was held.'));
      },
      hooks: {
        async onBeforeToolExec() {
          approvalStarted.resolve();
          await releaseApproval.promise;
          return { approved: true };
        },
      },
    }
  );
  console.log('PASS positive approval arriving after a correction cannot launch an obsolete tool');
}

async function testModelDeclaredCorrection(workspace) {
  let targetId;
  let obsoleteStarts = 0;
  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests }) => {
      const session = 'declared-correction';
      await add(store, session, 'assistant', oldClaim);
      targetId = (await store.sourceMessages(session))[0].id;
      agent.tools.register({
        name: 'test_stale_declared_tool',
        description: 'Simulate a tool proposed against the old context',
        metadata: { sideEffectClass: 'local_write' },
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          obsoleteStarts++;
          return 'This invocation must be suppressed';
        },
      });

      await agent.chat(session, correctionText, {
        userInput: { id: 'ordinary-correction' },
        taskFlow: false,
        maxTurns: 6,
      });
      const snapshot = store.snapshot(session);
      assert.equal(snapshot.revision, 1);
      assert.equal(snapshot.corrections.length, 1);
      assert.equal(snapshot.corrections[0].targetId, targetId);
      assert.equal(obsoleteStarts, 0, 'a pre-rebuild tool invoked in the correcting response ran');
      assert(modelRequests.length >= 2, 'expected a fresh model request after context correction');
      assert.match(JSON.stringify(modelRequests[0]), new RegExp(oldClaim));
      assert.doesNotMatch(JSON.stringify(modelRequests.slice(1)), new RegExp(oldClaim));
      assert.match(JSON.stringify(modelRequests.slice(1)), /Health check returned HTTP 200/);
      assert.equal(agent.getTaskIntentReceipt(session, 'ordinary-correction').status, 'committed');
    },
    {
      onMain(request, count) {
        if (count > 1) return response(text('What remains is the full acceptance check.'));
        assert(
          request.systemPrompt.includes(targetId),
          'correctable source was not disclosed to model'
        );
        const frame = intentFrame(request);
        return response(
          ...decide(request, 'execute', {
            contextCorrections: [
              { targetId, messageId: frame.pendingInputs[0].id, quote: correctionText },
            ],
          }),
          toolCall('test_stale_declared_tool')
        );
      },
    }
  );
  console.log(
    'PASS a natural-language correction commits a source-linked declaration and resamples before action'
  );
}

async function testCapturedCorrection(workspace) {
  let targetId;
  const answer = 'Full acceptance is pending.';
  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests }) => {
      const session = 'captured-correction';
      await add(store, session, 'assistant', oldClaim);
      for (let index = 0; index < 18; index++) {
        await add(store, session, 'assistant', `Independent historical note ${index}. `.repeat(60));
      }
      for (let index = 0; index < 10; index++) {
        await add(store, session, 'user', `Retain requirement ${index}.`);
      }
      targetId = (await store.sourceMessages(session))[0].id;
      const initial = await agent.compactSession(session);
      assert.match(initial.summary, new RegExp(oldSummary));

      const corrected = await agent.chat(session, correctionText, {
        userInput: { id: 'captured-user-correction' },
        taskFlow: false,
      });
      assert.equal(corrected.response, answer);
      assert.equal(
        agent.getTaskIntentReceipt(session, 'captured-user-correction').status,
        'committed'
      );
      assert.equal(store.snapshot(session).corrections[0].targetId, targetId);
      assert.doesNotMatch(
        JSON.stringify(modelRequests.slice(1)),
        new RegExp(`${oldClaim}|${oldSummary}`)
      );

      const followUp = await agent.chat(session, 'What still needs testing?', {
        userInput: { id: 'captured-follow-up' },
        taskFlow: false,
      });
      assert.equal(followUp.response, answer);
      assert.equal(store.snapshot(session).corrections.length, 1);
      assert.equal(store.snapshot(session).claims.length, 0);
      assert.equal(modelRequests.length, 3);
    },
    {
      onMain(request, count) {
        if (count === 2) {
          assert(!request.tools?.some(({ name }) => name === 'context_claims'));
          return response(text(answer));
        }
        const previous = request.systemPrompt
          .split('\n')
          .find((line) => line.startsWith('{"contextSources":'));
        assert(previous);
        const { contextSources } = JSON.parse(previous);
        assert(!contextSources.some(({ text }) => text === correctionText) || count === 3);
        if (count === 1) assert(contextSources.some(({ id }) => id === targetId));
        return response(
          toolCall('turn_decision', `capture-${count}`, {
            disposition: 'answer',
            answer,
            contextCorrections: [{ targetId, quote: correctionText }],
          }),
          toolCall('context_claims', `invalid-claim-${count}`, {
            claims: [{ text: 'Unsupported', sourceIds: ['unknown'], dependsOn: [] }],
          })
        );
      },
    }
  );
  console.log(
    'PASS a quote-only correction resolves the older target and an exact replay is idempotent'
  );
}

async function testReadOnlyIntentPrompt(workspace) {
  let targetId;
  const answer = 'Full acceptance is pending.';
  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests }) => {
      const session = 'read-only-intent';
      await add(store, session, 'assistant', oldClaim);
      await add(
        store,
        session,
        'assistant',
        `${'The earlier release was reviewed. '.repeat(20)} CURRENT_ACCEPTANCE_PENDING`
      );
      targetId = (await store.sourceMessages(session))[0].id;
      const options = { taskFlow: false, toolFilter: () => false };
      const result = await agent.chat(session, correctionText, {
        ...options,
        userInput: { id: 'lean-correction' },
      });
      assert.equal(result.response, answer);
      const [committed] = store.snapshot(session).corrections;
      assert.equal(committed.targetId, targetId);
      assert.equal(committed.text, correctionText);
      assert.doesNotMatch(JSON.stringify(modelRequests.slice(1)), new RegExp(oldClaim));
      const prompt = 'Report the operator input.';
      const hostText = 'This input is provided separately by the host.';
      await agent.chat(session, prompt, {
        ...options,
        userInput: { id: 'host-input', text: hostText },
      });
      assert.equal(modelRequests.length, 3);
      assert.equal(intentFrame(modelRequests[2]).pendingInputs[0].text, hostText);
    },
    {
      structuredOutput: true,
      onMain(request, count) {
        if (count === 2) {
          assert(!request.tools?.length);
          assert.equal(request.toolChoice, undefined);
          assert.equal(request.responseFormat, undefined);
          assert(!request.systemPrompt.includes('contextSources'));
          assert.match(JSON.stringify(request.messages), /Health check returned HTTP 200/);
          return response(text(answer));
        }
        assert.deepEqual(
          request.tools.map(({ name }) => name),
          ['turn_decision']
        );
        assert.equal(request.toolChoice, 'required');
        assert.equal(request.tools[0].input_schema.properties.changes, undefined);
        assert.doesNotMatch(request.systemPrompt, /After a successful/);
        if (count === 1) {
          assert.equal(request.responseFormat, undefined);
          assert.deepEqual(intentFrame(request).pendingInputs, [
            { id: 'lean-correction', inHistory: true },
          ]);
          assert.doesNotMatch(request.systemPrompt, new RegExp(targetId));
          assert.match(request.systemPrompt, /"id":"s1"/);
          assert.match(request.systemPrompt, /applies only to a previous version, run, or phase/);
          assert.match(request.systemPrompt, /whose own conclusion states the superseded outcome/);
          assert.match(request.systemPrompt, /"id":"s2".*CURRENT_ACCEPTANCE_PENDING/);
          assert.doesNotMatch(request.systemPrompt, new RegExp(correctionText));
          return response(
            toolCall('turn_decision', 'lean-correction-decision', {
              disposition: 'answer',
              contextCorrections: [{ targetId: 's1' }],
            })
          );
        }
        assert.deepEqual(request.responseFormat.schema.required, ['turn_decision']);
        return response(
          text(
            JSON.stringify({
              turn_decision: { disposition: 'answer', answer },
            })
          )
        );
      },
    }
  );
  console.log(
    'PASS read-only intent sends canonical input once and refreshes context after correction'
  );
}

async function testClaimDependencies(workspace) {
  const baseText = 'INVALIDATED_CLAIM_ROOT';
  const dependentText = 'INVALIDATED_CLAIM_DEPENDENT';
  const grandchildText = 'INVALIDATED_CLAIM_GRANDCHILD';
  const independentText = 'INDEPENDENT_CLAIM_HTTP_200';
  let question = 0;
  let sourceId;
  let baseId;
  let dependentId;
  let grandchildId;
  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests }) => {
      const session = 'claim-dependencies';
      await add(store, session, 'user', 'A health check returned HTTP 200.');
      sourceId = (await store.sourceMessages(session))[0].id;

      const claim = (value) => {
        const found = store.snapshot(session).claims.find((item) => item.text === value);
        assert(found, `Missing durable claim ${value}`);
        return found;
      };
      const recordClaims = async (phase) => {
        question = phase;
        await agent.chat(session, `Review source and record conclusion ${phase}.`, {
          userInput: { id: `new-claim-${phase}` },
          taskFlow: false,
          maxTurns: 5,
        });
      };

      await recordClaims(1);
      baseId = claim(baseText).id;
      await recordClaims(2);
      dependentId = claim(dependentText).id;
      await recordClaims(3);
      grandchildId = claim(grandchildText).id;
      assert.deepEqual(claim(dependentText).dependsOn, [baseId]);
      assert.deepEqual(claim(grandchildText).dependsOn, [dependentId]);
      assert(claim(independentText).sourceIds.includes(sourceId));

      question = 4;
      const initialRequestCount = modelRequests.length;
      await correct(agent, session, baseId, 'claim-correction');
      for (const value of [baseText, dependentText, grandchildText]) {
        assert.equal(claim(value).status, 'invalidated');
      }
      assert.equal(claim(independentText).status, 'active');
      assert.equal(store.assertClaimsActive(session, [grandchildId]), false);
      await agent.chat(session, 'Continue using only claims supported by current observations.', {
        taskFlow: false,
        maxTurns: 5,
      });
      const actualRequests = JSON.stringify(modelRequests.slice(initialRequestCount));
      assert.doesNotMatch(
        actualRequests,
        new RegExp(`${baseText}|${dependentText}|${grandchildText}`)
      );
      assert.match(actualRequests, new RegExp(independentText));
      assert.match(actualRequests, /A health check returned HTTP 200/);
    },
    {
      onMain(request) {
        const frame = intentFrame(request);
        if (!frame.pendingInputs.length || question === 4) {
          return response(
            ...decide(request, 'answer'),
            text('Reviewed the effective observations.')
          );
        }
        assert(request.tools.some((tool) => tool.name === 'context_claims'));
        const drafts = {
          1: [
            { text: baseText, sourceIds: [sourceId], dependsOn: [] },
            { text: independentText, sourceIds: [sourceId], dependsOn: [] },
          ],
          2: [{ text: dependentText, sourceIds: [sourceId], dependsOn: [baseId] }],
          3: [{ text: grandchildText, sourceIds: [sourceId], dependsOn: [dependentId] }],
        }[question];
        return response(
          ...decide(request, 'answer'),
          toolCall('context_claims', `claims-${question}`, { claims: drafts }),
          text('Recorded the relevant observations.')
        );
      },
    }
  );
  console.log(
    'PASS claim invalidation is transitive and removes obsolete text from actual model requests'
  );
}

async function testLateAcceptance(workspace) {
  const task = await tasks.createDraftTask(workspace, 'Verify the actual deployment state');
  await artifacts.appendTaskRecord(workspace, {
    ...task,
    status: 'active',
    acceptanceCriteria: [{ metric: 'observed', expected: '== true' }],
    verificationPlan: ['read-only probe'],
  });
  await tasks.appendTaskEvent(workspace, task.taskId, 'task_understood');
  await tasks.appendTaskEvent(workspace, task.taskId, 'planning_started');
  await tasks.appendTaskEvent(workspace, task.taskId, 'plan_ready');
  await tasks.appendTaskEvent(workspace, task.taskId, 'execution_started');

  await usingAgent(
    workspace,
    async ({ agent, store }) => {
      const session = 'late-verdict';
      await add(store, session, 'assistant', oldClaim);
      const source = (await store.sourceMessages(session))[0];

      await agent.chat(session, task.goal, {
        userInput: { id: 'native-goal', text: task.goal, taskId: task.taskId },
        taskId: task.taskId,
        taskFlow: false,
        maxTurns: 4,
      });
      const binding = agent.getTaskIntent(session);
      assert.equal(binding.taskId, task.taskId);
      assert.equal(binding.disposition, 'execute');

      await artifacts.appendEvidenceRecord(workspace, {
        evidenceId: 'stale-measurement',
        taskId: task.taskId,
        taskRevision: (await tasks.getTaskStateSnapshot(workspace, task.taskId)).revision,
        source: 'scripted-check',
        metric: 'observed',
        expected: '== true',
        observed: true,
        result: 'pass',
        timestamp: Date.now(),
      });

      const originalOpen = fs.open;
      let correctionCommitted = false;
      fs.open = async (filename, ...args) => {
        const handle = await originalOpen(filename, ...args);
        if (!String(filename).endsWith('acceptance.jsonl.pending')) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                await target.sync();
                if (!correctionCommitted) {
                  await correct(agent, session, source.id, 'acceptance-race');
                  correctionCommitted = true;
                }
              };
            }
            const member = Reflect.get(target, property, target);
            return typeof member === 'function' ? member.bind(target) : member;
          },
        });
      };
      try {
        const resumed = await resumeTask(
          { workspaceDir: workspace, runTurn: createAgentTurnRunner(agent, session) },
          task.taskId
        );
        assert.equal(resumed.outcome, 'blocked');
      } finally {
        fs.open = originalOpen;
      }
      assert.equal(correctionCommitted, true);
      assert.deepEqual(await tasks.listAcceptanceVerdicts(workspace, task.taskId), []);
      assert.notEqual((await tasks.getTaskStateSnapshot(workspace, task.taskId)).phase, 'accepted');
    },
    {
      onMain(request) {
        return response(...decide(request, 'execute'), text('The current plan is ready.'));
      },
    }
  );
  console.log(
    'PASS a correction committed while a native verdict is being persisted fences the late PASS'
  );
}

async function testProcessRestart(workspace) {
  await usingAgent(workspace, async ({ agent, store, modelRequests }) => {
    const session = 'restart';
    const targetId = await seed(store, session);
    const checkpoint = await agent.compactSession(session);
    assert.equal(checkpoint.compacted, true);
    assert.match(checkpoint.summary, new RegExp(oldSummary));
    await agent.chat(session, 'Summarize the current recorded status', {
      taskFlow: false,
      maxTurns: 4,
    });
    assert.match(JSON.stringify(modelRequests), new RegExp(oldSummary));

    const child = await captureProcess(
      process.execPath,
      [script, '--commit-and-exit', workspace, targetId],
      {
        cwd: root,
        timeoutMs: 10_000,
      }
    );
    assert.equal(child.timedOut, false);
    assert.equal(child.status, 0, child.stderr);
  });

  const rebuildStarted = latch();
  const releaseRebuild = latch();
  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests, summaryRequests }) => {
      const session = 'restart';
      assert.equal(store.revision(session), 1);
      const original = (await store.sourceMessages(session)).find(
        (source) => source.message.content === oldClaim
      );
      const replay = await correct(agent, session, original.id, 'restart-correction');
      assert.equal(replay.revision, 1);
      assert.equal(store.snapshot(session).corrections.length, 1);
      assert.equal(
        agent.getTaskIntentReceipt(session, 'context:restart-correction').status,
        'pending'
      );
      const reply = agent.chat(session, 'Continue with the corrected context', {
        taskFlow: false,
        maxTurns: 4,
      });
      try {
        await observeRace(reply, rebuildStarted, 'the pending background rebuild');
        assert.equal(
          (await waitFor(reply, 'the reply before rebuilding')).response,
          'The current context was evaluated.'
        );
      } finally {
        releaseRebuild.resolve();
      }
      const rebuilt = await agent.compactSession(session);
      assert.equal(rebuilt.compacted, true);
      assert(summaryRequests.every((request) => !JSON.stringify(request).includes(oldClaim)));
      const sent = JSON.stringify(modelRequests);
      assert.doesNotMatch(
        sent,
        new RegExp(`${oldClaim}|${oldSummary}|OBSOLETE_DEPENDENT_DEPLOY_PLAN`)
      );
      assert.match(sent, /Health check returned HTTP 200/);
      assert(
        (await store.sourceMessages(session)).some((source) => source.message.content === oldClaim)
      );
      assert.equal(
        agent.getTaskIntentReceipt(session, 'context:restart-correction').status,
        'committed'
      );
    },
    {
      async onSummary(input) {
        rebuildStarted.resolve();
        await releaseRebuild.promise;
        return summarize(input);
      },
    }
  );
  console.log(
    'PASS restart answers while rebuilding a corrected checkpoint and excludes superseded context'
  );
}

async function testUnknownMutationRecovery(workspace) {
  const session = 'unknown-mutation';
  const previous = new VersionedSessionStore(path.join(workspace, 'context.sqlite'));
  try {
    await add(previous, session, 'user', 'Confirm the current deployment before another write.');
    // Simulate process death between durable invocation admission and outcome settlement.
    previous.registerInvocation(session, 'dispatched-write', 0, 'old_deploy', true, () => {});
  } finally {
    previous.close();
  }

  let readStarts = 0;
  let writeStarts = 0;
  let cycle = 'before-reconcile';
  await usingAgent(
    workspace,
    async ({ agent, store, modelRequests }) => {
      assert.deepEqual(
        store.unsettledInvocations(session).map(({ id, tool }) => ({ id, tool })),
        [{ id: 'dispatched-write', tool: 'old_deploy' }]
      );
      agent.tools.register({
        name: 'test_recovery_read',
        description: 'Read current deployment state',
        inputSchema: { type: 'object', properties: {} },
        metadata: { sideEffectClass: 'readonly' },
        async execute() {
          readStarts++;
          return 'Target observed without changing it.';
        },
      });
      agent.tools.register({
        name: 'test_recovery_write',
        description: 'Update the target once it has a clear state',
        inputSchema: { type: 'object', properties: {} },
        metadata: { sideEffectClass: 'local_write' },
        async execute() {
          writeStarts++;
          return 'Completed the simulated mutation.';
        },
      });
      await agent.chat(session, 'Inspect and update the target.', {
        userInput: { id: 'recover-unknown' },
        taskFlow: false,
        maxTurns: 5,
      });
      assert.equal(readStarts, 1, 'read-only recovery checks must stay available');
      assert.equal(writeStarts, 0, 'a durable unknown mutation must fence the next write');
      assert.match(JSON.stringify(modelRequests), /unknown outcome/i);
      assert.equal(
        agent.reconcileContextInvocation(
          session,
          'dispatched-write',
          'Read-only inspection confirmed the previous deployment was not applied.'
        ),
        true
      );
      assert.deepEqual(store.unsettledInvocations(session), []);
      cycle = 'after-reconcile';
      await agent.chat(session, 'Apply the reviewed update.', {
        userInput: { id: 'reviewed-update' },
        taskFlow: false,
        maxTurns: 5,
      });
      assert.equal(writeStarts, 1);
      assert.deepEqual(store.unsettledInvocations(session), []);
    },
    {
      onMain(request) {
        if (!intentFrame(request).pendingInputs.length)
          return response(text('Recorded the tool statuses.'));
        return response(
          ...decide(request, 'execute'),
          ...(cycle === 'before-reconcile'
            ? [toolCall('test_recovery_read', 'recovery-read')]
            : []),
          toolCall('test_recovery_write', `recovery-write-${cycle}`)
        );
      },
    }
  );
  console.log(
    'PASS restart preserves a mutation with unknown outcome, allows reads and requires reconciliation before a new write'
  );
}

async function testCliCorrections(workspace) {
  const session = 'versioned-context-cli';
  const dbPath = path.join(workspace, '.moss', 'runtime', 'context.sqlite');
  const original = new VersionedSessionStore(dbPath);
  let target;
  try {
    await add(original, session, 'assistant', oldClaim);
    target = (await original.sourceMessages(session))[0];
  } finally {
    original.close();
  }

  const inputPath = path.join(workspace, 'cli-stdin.txt');
  const outputPath = path.join(workspace, 'cli-stdout.txt');
  const errorPath = path.join(workspace, 'cli-stderr.txt');
  const runCommand = async (command) => {
    await fs.writeFile(inputPath, command + '\n');
    const input = await fs.open(inputPath, 'r');
    const output = await fs.open(outputPath, 'w');
    const errors = await fs.open(errorPath, 'w');
    let child;
    try {
      child = await runProcess(
        process.execPath,
        [path.join(dist, 'cli.js'), 'resume', session, '--mock'],
        {
          cwd: workspace,
          env: {
            ...process.env,
            MOSS_CONFIG_DIR: path.join(workspace, 'cli-config'),
            MOSS_NO_RDK_DOCS: '1',
            MOSS_NO_TUI: '1',
            MOSS_VERSIONED_CONTEXT: '1',
          },
          stdio: [input.fd, output.fd, errors.fd],
          timeoutMs: 10000,
        }
      );
    } finally {
      await Promise.all([input.close(), output.close(), errors.close()]);
    }
    const diagnostics =
      (await fs.readFile(outputPath, 'utf8')) + (await fs.readFile(errorPath, 'utf8'));
    assert.equal(child.timedOut, false, diagnostics);
    assert.equal(child.status, 0, diagnostics);
    return diagnostics;
  };
  const sources = await runCommand('/context sources');
  assert(sources.includes(target.id), sources);
  assert.match(await runCommand('/context claims'), /No context claims yet/);
  const corrected = await runCommand(`/context correct ${target.id} ${correctionText}`);
  assert.match(corrected, /Correction saved|纠错已保存/);
  const reopened = new VersionedSessionStore(dbPath);
  try {
    assert.equal(reopened.revision(session), 1);
    assert.equal(reopened.snapshot(session).corrections[0].targetId, target.id);
    assert.equal((await reopened.sourceMessages(session))[0].message.content, oldClaim);
  } finally {
    reopened.close();
  }
  console.log('PASS actual offline CLI resolves source IDs and persists /context correct');
}

if (process.argv[2] === '--commit-and-exit') {
  const workspace = process.argv[3];
  const store = new VersionedSessionStore(path.join(workspace, 'context.sqlite'));
  const { agent } = createAgent(workspace, store);
  await correct(agent, 'restart', process.argv[4], 'restart-correction');
  // Exit before any agent shutdown hook or compaction can rebuild the history.
  process.exit(0);
}

async function testVersionedDrafts(workspace) {
  for (const steer of [false, true]) {
    const store = new VersionedSessionStore(
      path.join(workspace, steer ? 'steer.sqlite' : 'accept.sqlite')
    );
    const session = 'draft-test';
    const seen = latch();
    const withdrawn = latch();
    const release = latch();
    const events = [];
    const first = '这里是实时输出的待校验正文。';
    const tail = '这段文字由第二个模型增量产生。';
    const corrected = '更正已生效，以下仅以最新输入为准。';
    let requests = 0;
    const agent = new MossAgent({
      sessionStore: store,
      workspaceDir: workspace,
      contextTokens: 32_000,
      maxTokens: 1024,
      taskIntent: true,
      enableFollowUpGuard: false,
      llmProvider: {
        id: 'draft-fixture',
        displayName: 'Draft fixture',
        async complete(request) {
          return summarize(summaryInput(request));
        },
        async stream(request, emit) {
          const step = ++requests;
          if (step === 1) return response(...decide(request, 'execute'));
          if (step === 2) {
            emit({ type: 'content_block_delta', text: first });
            await release.promise;
            emit({ type: 'content_block_delta', text: tail });
            return response(text(first + tail));
          }
          assert.equal(step, 3);
          return response(...decide(request, 'answer', { answer: corrected }));
        },
      },
    });
    const run = (async () => {
      for await (const event of agent.streamChat(session, 'Check the workspace before answering.', {
        userInput: { id: 'initial' },
        streamVersionedDrafts: true,
      })) {
        events.push(event);
        if (event.type === 'text_draft_delta') seen.resolve();
        if (event.type === 'text_draft_end' && !event.accepted) withdrawn.resolve();
      }
    })();
    try {
      await observeRace(run, seen, 'the first draft before provider completion');
      assert.equal(
        events.some((event) => event.type === 'text_delta'),
        false
      );
      assert(!JSON.stringify(await store.sourceMessages(session)).includes(first));
      if (steer) {
        assert(agent.steer(session, '更正，先停止旧任务，只回答本次更正。', { id: 'correction' }));
        await observeRace(run, withdrawn, 'draft withdrawal while the provider is blocked');
      }
      release.resolve();
      await waitFor(run, 'canonical output');
      const draft = events
        .filter((event) => event.type === 'text_draft_delta')
        .map((event) => event.delta)
        .join('');
      const canonical = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join('');
      assert.equal(draft, steer ? first : first + tail);
      assert.equal(canonical, steer ? corrected : first + tail);
      assert.deepEqual(
        events.filter((event) => event.type === 'text_draft_end').map((event) => event.accepted),
        [!steer]
      );
    } finally {
      release.resolve();
      await run.catch(() => {});
      store.close();
    }
  }
  console.log(
    'PASS versioned drafts stream before provider completion and disappear when a new input supersedes them'
  );
}

const workspace = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'moss-versioned-context-'))
);
try {
  for (const [directory, test] of [
    ['context-handoff', testContextHandoff],
    ['progressive', testProgressiveStages],
    ['pressure-continuation', testPressureContinuation],
    ['active-tool-pressure', testActiveToolPressure],
    ['checkpoint', testConcurrentSummary],
    ['source-validation', testSummarySourceValidation],
    ['approval', testApproval],
    ['declaration', testModelDeclaredCorrection],
    ['captured-correction', testCapturedCorrection],
    ['read-only-intent', testReadOnlyIntentPrompt],
    ['claims', testClaimDependencies],
    ['acceptance', testLateAcceptance],
    ['restart', testProcessRestart],
    ['streaming-drafts', testVersionedDrafts],
    ['unsettled-mutation', testUnknownMutationRecovery],
    ['cli', testCliCorrections],
  ]) {
    const directoryPath = path.join(workspace, directory);
    await fs.mkdir(directoryPath);
    await test(directoryPath);
  }
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
