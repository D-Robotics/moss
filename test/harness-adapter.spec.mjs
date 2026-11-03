import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  MossAgent,
  InMemorySessionStore,
  ErrorCode,
  hashHarnessAdapter,
  createAgentTurnRunner,
} from '../dist/index.js';

function artifact(version = '1', instructions = `Use strategy ${version}.`) {
  const value = { id: 'test-harness', version, instructions };
  return { ...value, sha256: hashHarnessAdapter(value) };
}

function receipt(value) {
  return { id: value.id, version: value.version, sha256: value.sha256 };
}

function reply(text = 'done') {
  return { stopReason: 'end_turn', content: [{ type: 'text', text }] };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function agentFor(complete, config = {}) {
  return new MossAgent({
    llmProvider: { id: 'harness-test', capabilities: { streaming: false }, complete },
    model: 'test',
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    enableSteering: false,
    ...config,
  });
}

test('harness hash is the full SHA-256 of canonical UTF-8 JSON without trimming', () => {
  const input = { instructions: '  核验真实结果。\n', version: '2', id: 'unicode' };
  const expected = createHash('sha256')
    .update(JSON.stringify(['unicode', '2', '  核验真实结果。\n']), 'utf8')
    .digest('hex');
  assert.equal(hashHarnessAdapter(input), expected);
  assert.notEqual(
    hashHarnessAdapter({ ...input, instructions: input.instructions.trim() }),
    expected
  );
});

test('native run applies stable instructions and reports the exact artifact through existing events', async () => {
  const selected = artifact('1', '  Check the observed result before concluding.\n');
  const observed = [];
  const requests = [];
  const agent = agentFor(
    async (request) => {
      requests.push(request);
      assert.equal(observed.length, 1, 'producer observer runs before the provider');
      return reply();
    },
    {
      extraPromptLayers: ['project-layer'],
      dynamicPromptLayers: ['dynamic-layer'],
      onAgentLoopEvent(event, identity) {
        if (event.type === 'turn_start') {
          observed.push({ event, identity });
          throw new Error('observer failure must remain isolated');
        }
      },
    }
  );
  try {
    const events = [];
    for await (const event of agent.streamChat('native-session', 'reply', {
      harnessAdapter: selected,
      runId: 'native-run',
      omitExtraPromptLayers: true,
      taskFlow: false,
    })) {
      events.push(event);
    }
    assert.ok(requests[0].systemPrompt.endsWith(selected.instructions));
    assert.ok(requests[0].systemPromptParts.stable.endsWith(selected.instructions));
    assert.doesNotMatch(requests[0].systemPrompt, /project-layer|dynamic-layer/);
    assert.deepEqual(
      events.find((event) => event.type === 'turn_start').harnessAdapter,
      receipt(selected)
    );
    assert.deepEqual(events.at(-1).result.harnessAdapter, receipt(selected));
    assert.deepEqual(observed[0].event.harnessAdapter, receipt(selected));
    assert.equal(observed[0].identity.runId, 'native-run');
    assert.equal(observed[0].identity.sessionKey, 'native-session');
    assert.ok(Object.isFrozen(events.at(-1).result.harnessAdapter));
    assert.deepEqual(agent.config.extraPromptLayers, ['project-layer']);
  } finally {
    await agent.close();
  }
});

test('invalid adapter hashes and bounds reject before guardrails, session loading or provider calls', async () => {
  let sideEffects = 0;
  const agent = agentFor(
    async () => {
      sideEffects += 1;
      return reply();
    },
    {
      sessionStore: {
        async loadMessages() {
          sideEffects += 1;
          return [];
        },
      },
      hooks: {
        async onInputGuardrail() {
          sideEffects += 1;
          return { approved: true };
        },
      },
    }
  );
  const invalid = [
    { ...artifact(), sha256: '0'.repeat(64) },
    artifact('1', '界'.repeat(2731)),
    artifact('1', ' '),
    { ...artifact(), id: '' },
    { ...artifact(), version: 'v'.repeat(129) },
    { ...artifact(), instructions: 123 },
    null,
    [],
  ];
  try {
    for (const harnessAdapter of invalid) {
      await assert.rejects(
        agent.chat('invalid', 'reply', { harnessAdapter }),
        (error) => error.code === ErrorCode.USER_INPUT_INVALID
      );
    }
    assert.equal(sideEffects, 0);
  } finally {
    await agent.close();
  }
});

test('the 8 KiB instruction limit accepts its exact UTF-8 boundary without truncation', async () => {
  const selected = artifact('boundary', `${'界'.repeat(2730)}ab`);
  assert.equal(Buffer.byteLength(selected.instructions, 'utf8'), 8192);
  let sent;
  const agent = agentFor(async (request) => {
    sent = request.systemPrompt;
    return reply();
  });
  try {
    const result = await agent.chat('boundary', 'reply', { harnessAdapter: selected });
    assert.ok(sent.endsWith(selected.instructions));
    assert.deepEqual(result.harnessAdapter, receipt(selected));
  } finally {
    await agent.close();
  }
});

test('mutation during admission cannot alter any prompt refresh or receipt in the run', async () => {
  const entered = deferred();
  const release = deferred();
  const selected = artifact('original', 'Keep the originally selected strategy.');
  const expected = receipt(selected);
  const requests = [];
  const config = {
    dynamicPromptLayers: ['dynamic-before'],
    hooks: {
      async onInputGuardrail() {
        entered.resolve();
        await release.promise;
        return { approved: true };
      },
    },
  };
  const agent = agentFor(async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      config.dynamicPromptLayers[0] = 'dynamic-after';
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'inspect-1', name: 'inspect', input: {} }],
      };
    }
    return reply();
  }, config);
  agent.tools.register({
    name: 'inspect',
    description: 'Observe a value.',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly' },
    async execute() {
      return 'observed';
    },
  });
  try {
    const options = { harnessAdapter: selected, taskFlow: false };
    const pending = agent.chat('mutation', 'inspect and reply', options);
    await entered.promise;
    Object.assign(selected, artifact('mutated', 'Mutated instructions must not appear.'));
    options.harnessAdapter = artifact('replacement', 'Replacement must not appear.');
    release.resolve();
    const result = await pending;
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.match(request.systemPrompt, /Keep the originally selected strategy\./);
      assert.doesNotMatch(request.systemPrompt, /Mutated instructions|Replacement must/);
    }
    assert.match(requests[1].systemPrompt, /dynamic-after/);
    assert.equal(requests[0].systemPromptParts.stable, requests[1].systemPromptParts.stable);
    assert.deepEqual(result.harnessAdapter, expected);
  } finally {
    release.resolve();
    await agent.close();
  }
});

test('sequential runs can replace adapters and a later baseline has no adapter or receipt', async () => {
  const requests = [];
  const agent = agentFor(async (request) => {
    requests.push(request);
    return reply();
  });
  const first = artifact('first', 'FIRST_UNIQUE_STRATEGY');
  const second = artifact('second', 'SECOND_UNIQUE_STRATEGY');
  try {
    assert.deepEqual(
      (await agent.chat('sequential', 'one', { harnessAdapter: first })).harnessAdapter,
      receipt(first)
    );
    assert.deepEqual(
      (await agent.chat('sequential', 'two', { harnessAdapter: second })).harnessAdapter,
      receipt(second)
    );
    const baselineEvents = [];
    for await (const event of agent.streamChat('sequential', 'three')) baselineEvents.push(event);
    assert.match(requests[0].systemPrompt, /FIRST_UNIQUE_STRATEGY/);
    assert.doesNotMatch(requests[1].systemPrompt, /FIRST_UNIQUE_STRATEGY/);
    assert.match(requests[1].systemPrompt, /SECOND_UNIQUE_STRATEGY/);
    assert.doesNotMatch(requests[2].systemPrompt, /UNIQUE_STRATEGY|Host-selected harness/);
    assert.equal(Object.hasOwn(baselineEvents.at(-1).result, 'harnessAdapter'), false);
    assert.equal(
      Object.hasOwn(
        baselineEvents.find((event) => event.type === 'turn_start'),
        'harnessAdapter'
      ),
      false
    );
    assert.equal(requests[2].systemPrompt, agent.composeSystemPrompt().full);
  } finally {
    await agent.close();
  }
});

test('concurrent sessions keep their selected adapter and receipt isolated', async () => {
  const entered = deferred();
  const release = deferred();
  const requests = [];
  const observed = new Map();
  const agent = agentFor(
    async (request) => {
      requests.push(request);
      if (requests.length === 2) entered.resolve();
      await release.promise;
      return reply();
    },
    {
      onAgentLoopEvent(event, identity) {
        if (event.type === 'turn_start') observed.set(identity.runId, event.harnessAdapter);
      },
    }
  );
  const left = artifact('left', 'LEFT_ONLY_INSTRUCTIONS');
  const right = artifact('right', 'RIGHT_ONLY_INSTRUCTIONS');
  try {
    const runs = [
      agent.chat('left-session', 'left', { runId: 'left-run', harnessAdapter: left }),
      agent.chat('right-session', 'right', { runId: 'right-run', harnessAdapter: right }),
    ];
    await entered.promise;
    release.resolve();
    const [leftResult, rightResult] = await Promise.all(runs);
    assert.deepEqual(leftResult.harnessAdapter, receipt(left));
    assert.deepEqual(rightResult.harnessAdapter, receipt(right));
    assert.deepEqual(observed.get('left-run'), receipt(left));
    assert.deepEqual(observed.get('right-run'), receipt(right));
    assert.equal(
      requests.filter((request) => request.systemPrompt.includes(left.instructions)).length,
      1
    );
    assert.equal(
      requests.filter((request) => request.systemPrompt.includes(right.instructions)).length,
      1
    );
    assert.ok(
      requests.every(
        (request) =>
          !(
            request.systemPrompt.includes(left.instructions) &&
            request.systemPrompt.includes(right.instructions)
          )
      )
    );
  } finally {
    release.resolve();
    await agent.close();
  }
});

test('Task OS forwards the selected adapter through both supported agent methods', async () => {
  const selected = artifact();
  for (const method of ['streamChat', 'chat']) {
    let actual;
    const agent =
      method === 'streamChat'
        ? {
            async *streamChat(_session, _prompt, options) {
              actual = options;
              yield { type: 'done', result: { response: 'task reply' } };
            },
          }
        : {
            async chat(_session, _prompt, options) {
              actual = options;
              return { response: 'task reply' };
            },
          };
    const run = createAgentTurnRunner(agent, 'task', { harnessAdapter: selected });
    assert.equal(await run('do work', 'executing'), 'task reply');
    assert.equal(actual.harnessAdapter, selected);
    assert.equal(actual.taskFlow, true);
    assert.equal(actual.goalExecWait, true);
  }
});

test('native children and finalization report adapters only when their actual prompt includes them', async () => {
  const selected = artifact('parent', 'PARENT_ADAPTER_INSTRUCTION');
  const requests = [];
  const children = [];
  const observed = new Map();
  let overrideCalls = 0;
  const agent = agentFor(
    async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'children-1', name: 'launch_children', input: {} }],
        };
      }
      if (request.systemPrompt.includes('OVERRIDE_ONLY_PROMPT') && overrideCalls++ === 0) {
        return reply('');
      }
      return reply();
    },
    {
      onAgentLoopEvent(event, identity) {
        if (event.type === 'turn_start') observed.set(identity.runId, event);
      },
    }
  );
  agent.tools.register({
    name: 'launch_children',
    description: 'Run bounded research children.',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'subagent' },
    async execute(_input, context) {
      for (const override of [false, true]) {
        children.push(
          await context.spawnSubagent({
            task: 'Reply with done.',
            scope: 'explore',
            maxTurns: 1,
            ...(override ? { systemPromptOverride: 'OVERRIDE_ONLY_PROMPT' } : {}),
          })
        );
      }
      return 'Research children completed.';
    },
  });
  try {
    const result = await agent.chat('parent', 'Run research and reply.', {
      harnessAdapter: selected,
      runId: 'parent-run',
      taskFlow: false,
    });
    assert.deepEqual(result.harnessAdapter, receipt(selected));
    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.success));
    assert.deepEqual(observed.get(children[0].runId).harnessAdapter, receipt(selected));
    assert.equal(Object.hasOwn(observed.get(children[1].runId), 'harnessAdapter'), false);
    assert.equal(
      Object.hasOwn(observed.get(`${children[1].runId}/finalize`), 'harnessAdapter'),
      false
    );
    assert.match(requests[1].systemPrompt, /PARENT_ADAPTER_INSTRUCTION/);
    assert.equal(overrideCalls, 2, 'override child also exercises forced finalization');
    for (const request of requests.filter((entry) =>
      entry.systemPrompt.includes('OVERRIDE_ONLY_PROMPT')
    )) {
      assert.doesNotMatch(request.systemPrompt, /PARENT_ADAPTER_INSTRUCTION/);
    }
  } finally {
    await agent.close();
  }
});
