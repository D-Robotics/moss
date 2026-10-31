import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFileTool, runAgentLoop, ToolHookRegistry } from '../dist/index.js';

const model = {
  id: 'offline',
  name: 'offline',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1024,
};

async function runFixture(options = {}) {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'moss-fresh-observation-'));
  const filename = path.join(workspaceDir, 'state.txt');
  const alternate = path.join(workspaceDir, 'alternate.txt');
  const callsPerTurn = options.callsPerTurn ?? Array(4).fill(1);
  let turn = 0;
  let callId = 0;
  let executions = 0;
  let approvals = 0;
  const results = [];
  const contexts = [];
  const storedBlocks = [];
  const events = [];
  try {
    await writeFile(filename, 'before');
    await writeFile(alternate, 'alternate');
    const tool = options.builtin
      ? {
          ...readFileTool,
          async execute(input, ctx) {
            executions += 1;
            return readFileTool.execute(input, ctx);
          },
        }
      : {
          name: 'fixture_read',
          description: 'Read the changing local fixture.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          metadata: options.metadata ?? {
            sideEffectClass: 'readonly',
            noReplay: true,
            freshObservation: true,
          },
          async execute(input) {
            executions += 1;
            if (options.readFailure) throw new Error('fixture unavailable');
            if (options.largeHiddenChange)
              return 'a'.repeat(40000) + String(executions % 10) + 'b'.repeat(40000);
            return readFile(path.join(workspaceDir, input.path), 'utf8');
          },
        };
    if (options.structured) {
      tool.executeStructured = async () => {
        executions += 1;
        return {
          content: [
            {
              ...(options.structured === 'text-changing'
                ? { type: 'text', text: `revision-${executions}` }
                : options.structured === 'text-private'
                  ? { type: 'text', text: 'synthetic-private-value' }
                  : {
                      type: 'image',
                      mimeType: 'image/png',
                      data: Buffer.from(
                        String(options.structured === 'changing' ? executions : 1)
                      ).toString('base64'),
                    }),
            },
          ],
        };
      };
    }
    const streamFn = (_model, context) => {
      contexts.push(context);
      const callIndex = turn++;
      return {
        async *[Symbol.asyncIterator]() {
          if (options.beforeTurn) await options.beforeTurn(callIndex, filename, workspaceDir);
          for (let index = 0; index < (callsPerTurn[callIndex] ?? 0); index += 1) {
            yield {
              type: 'toolcall_end',
              toolCall: {
                id: `read-${++callId}`,
                name: tool.name,
                arguments: { path: options.pathForCall?.(callId - 1) ?? 'state.txt' },
              },
            };
          }
        },
        async result() {
          return callIndex < callsPerTurn.length
            ? { stopReason: 'toolUse', usage: { input: 5, output: 3 } }
            : {
                stopReason: 'end',
                usage: { input: 5, output: 3 },
                content: [{ type: 'text', text: 'done' }],
              };
        },
        push() {},
        end() {},
      };
    };
    const cancelled = new AbortController();
    cancelled.abort();
    const stream = runAgentLoop({
      runId: `fresh-observation-${Math.random()}`,
      sessionKey: `fresh-observation-${Math.random()}`,
      agentId: 'main',
      currentMessages: [{ role: 'user', content: 'Inspect the file.', timestamp: Date.now() }],
      systemPrompt: 'Use the provided tool.',
      toolsForRun: [tool],
      toolCtx: { workspaceDir, sessionKey: 'fresh-observation-session' },
      checkToolApproval: async () => {
        approvals += 1;
        return options.denyApprovalAt === approvals
          ? { approved: false, decision: 'deny', reason: 'fixture denial' }
          : { approved: true, decision: 'allow' };
      },
      ...(options.cancelCall || options.cancelSignal
        ? {
            toolAbortSignalFor: (id) =>
              id === `read-${options.cancelCall ?? 1}`
                ? (options.cancelSignal ?? cancelled.signal)
                : undefined,
          }
        : {}),
      ...(options.toolHooks ? { toolHooks: options.toolHooks } : {}),
      ...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}),
      modelDef: model,
      streamFn,
      maxTurns: callsPerTurn.length + 3,
      contextTokens: 128_000,
      appendMessage: async (_session, message) => {
        if (Array.isArray(message.content)) {
          for (const block of message.content)
            if (block.type === 'tool_result') {
              results.push(String(block.content));
              storedBlocks.push(block);
            }
        }
      },
      prepareCompaction: async () => ({}),
      abortSignal: new AbortController().signal,
    });
    const collectEvents = (async () => {
      for await (const event of stream) events.push(event);
    })();
    await stream.result();
    await collectEvents;
    return { executions, approvals, results, contexts, storedBlocks, events };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

test('an opted-in observation sees a file changed after three identical reads', async () => {
  const result = await runFixture({
    beforeTurn: (turn, filename) => (turn === 3 ? writeFile(filename, 'after') : undefined),
  });
  assert.equal(result.executions, 4);
  assert.equal(result.approvals, 4);
  assert.deepEqual(result.results.slice(0, 4), ['before', 'before', 'before', 'after']);
});

test('the built-in read_file sees an external change after three reads', async () => {
  const result = await runFixture({
    builtin: true,
    beforeTurn: (turn, filename) => (turn === 3 ? writeFile(filename, 'after') : undefined),
  });
  assert.equal(result.executions, 4);
  assert.match(result.results[3], /after/);
});

test('the built-in unchanged stub does not count as a changed observation', async () => {
  const result = await runFixture({ builtin: true, callsPerTurn: Array(7).fill(1) });
  assert.equal(result.executions, 4);
  assert.match(result.results[4], /identical input/i);
});

test('the built-in stub after a real change retains the new observation', async () => {
  const result = await runFixture({
    builtin: true,
    callsPerTurn: Array(8).fill(1),
    beforeTurn: (turn, filename) => (turn === 3 ? writeFile(filename, 'after') : undefined),
  });
  assert.equal(result.executions, 7);
  assert.match(result.results[3], /after/);
  assert.match(result.results[7], /identical input/i);
});

test('invisible structured image changes do not count as model-visible progress', async () => {
  const result = await runFixture({ structured: 'changing', callsPerTurn: Array(6).fill(1) });
  assert.equal(result.executions, 4);
  assert.match(result.results[4], /identical input/i);
});

test('visible structured text changes count as progress up to the absolute bound', async () => {
  const result = await runFixture({ structured: 'text-changing', callsPerTurn: Array(13).fill(1) });
  assert.equal(result.executions, 12);
  assert.match(result.results[12], /identical input/i);
});

test('changes hidden by tool output truncation do not count as model-visible progress', async () => {
  const result = await runFixture({ largeHiddenChange: true, callsPerTurn: Array(6).fill(1) });
  assert.equal(result.executions, 4);
  assert.match(result.results[0], /truncated/);
  assert.match(result.results[4], /identical input/i);
});

test('a post-hook redaction cannot leak old structured content to storage or the model', async () => {
  const hooks = new ToolHookRegistry();
  hooks.registerPost({
    name: 'redact',
    priority: 1,
    async process() {
      return { result: '[redacted]' };
    },
  });
  const result = await runFixture({
    structured: 'text-private',
    toolHooks: hooks,
    callsPerTurn: [1],
  });
  assert.equal(result.results[0], '[redacted]');
  assert.doesNotMatch(JSON.stringify(result.storedBlocks), /synthetic-private-value/);
  assert.doesNotMatch(JSON.stringify(result.contexts.at(-1).messages), /synthetic-private-value/);
  assert.doesNotMatch(JSON.stringify(result.events), /synthetic-private-value/);
});

test('a post-hook that explicitly replaces the projection drops prior structured payload', async () => {
  const hooks = new ToolHookRegistry();
  hooks.registerPost({
    name: 'replace',
    priority: 1,
    async process({ result }) {
      return { result };
    },
  });
  const result = await runFixture({
    structured: 'text-private',
    toolHooks: hooks,
    callsPerTurn: [1],
  });
  assert.equal(result.results[0], 'synthetic-private-value');
  assert.equal(result.storedBlocks[0].structuredContent, undefined);
});

test('a denied structured call cannot expose unexecuted content', async () => {
  const result = await runFixture({
    structured: 'text-private',
    denyApprovalAt: 1,
    callsPerTurn: [1],
  });
  assert.equal(result.executions, 0);
  assert.doesNotMatch(JSON.stringify(result.storedBlocks), /synthetic-private-value/);
  assert.doesNotMatch(JSON.stringify(result.contexts.at(-1).messages), /synthetic-private-value/);
  assert.doesNotMatch(JSON.stringify(result.events), /synthetic-private-value/);
});

test('cancellation during a post-hook cannot expose prior structured content', async () => {
  const controller = new AbortController();
  const hooks = new ToolHookRegistry();
  hooks.registerPost({
    name: 'cancel',
    priority: 1,
    async process() {
      controller.abort();
      return { result: '[redacted]' };
    },
  });
  const result = await runFixture({
    structured: 'text-private',
    toolHooks: hooks,
    cancelSignal: controller.signal,
    callsPerTurn: [1],
  });
  assert.equal(result.executions, 1);
  assert.doesNotMatch(JSON.stringify(result.storedBlocks), /synthetic-private-value/);
  assert.doesNotMatch(JSON.stringify(result.contexts.at(-1).messages), /synthetic-private-value/);
  assert.doesNotMatch(JSON.stringify(result.events), /synthetic-private-value/);
});

test('an unmodified structured result still reaches storage and the model', async () => {
  const hooks = new ToolHookRegistry();
  hooks.registerPost({
    name: 'observe',
    priority: 1,
    async process() {
      return null;
    },
  });
  const result = await runFixture({
    structured: 'text-private',
    toolHooks: hooks,
    callsPerTurn: [1],
  });
  assert.match(JSON.stringify(result.storedBlocks), /synthetic-private-value/);
  assert.match(JSON.stringify(result.contexts.at(-1).messages), /synthetic-private-value/);
});
test('unchanged structured observations retain the unchanged-output bound', async () => {
  const result = await runFixture({ structured: 'constant', callsPerTurn: Array(6).fill(1) });
  assert.equal(result.executions, 4);
  assert.match(result.results[4], /identical input/i);
});

test('noReplay alone keeps the original identical-call guard', async () => {
  const result = await runFixture({ metadata: { sideEffectClass: 'readonly', noReplay: true } });
  assert.equal(result.executions, 3);
  assert.match(result.results[3], /identical input/i);
});

test('an unchanged observation gets only one extra probe before blocking', async () => {
  const result = await runFixture({ callsPerTurn: [1, 1, 1, 1, 1] });
  assert.equal(result.executions, 4);
  assert.match(result.results[4], /identical input/i);
});

test('a denied observation probe is not executed and cannot unlock another probe', async () => {
  const result = await runFixture({ callsPerTurn: [1, 1, 1, 1, 1], denyApprovalAt: 4 });
  assert.equal(result.executions, 3);
  assert.equal(result.approvals, 4);
  assert.match(result.results[3], /denied|fixture denial/i);
  assert.match(result.results[4], /identical input/i);
});

test('an already cancelled observation probe cannot read or unlock another probe', async () => {
  const result = await runFixture({ callsPerTurn: [1, 1, 1, 1, 1], cancelCall: 4 });
  assert.equal(result.executions, 3);
  assert.match(result.results[3], /abort|cancel/i);
  assert.match(result.results[4], /identical input/i);
});

test('a pre-hook rewritten probe cannot count its result as progress for the requested path', async () => {
  const hooks = new ToolHookRegistry();
  let called = 0;
  hooks.registerPre({
    name: 'fixture-rewrite',
    priority: 1,
    async check() {
      called += 1;
      return called === 4
        ? { action: 'modify', input: { path: 'alternate.txt' } }
        : { action: 'allow' };
    },
  });
  const result = await runFixture({ callsPerTurn: [1, 1, 1, 1, 1], toolHooks: hooks });
  assert.equal(result.executions, 4);
  assert.equal(result.results[3], 'alternate');
  assert.match(result.results[4], /identical input/i);
});

test('parallel identical observations cannot exceed the unchanged-output bound', async () => {
  const result = await runFixture({ callsPerTurn: [5] });
  assert.equal(result.executions, 4);
  assert.match(result.results[4], /identical input/i);
});

test('the ordinary maxToolCalls budget still limits an opted-in parallel batch', async () => {
  const result = await runFixture({ callsPerTurn: [5], maxToolCalls: 3 });
  assert.equal(result.executions, 3);
  assert.match(result.results[3], /budget/i);
});

test('the configured total loop budget still limits opted-in observations', async () => {
  const original = process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT;
  process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT = '3';
  try {
    const result = await runFixture();
    assert.equal(result.executions, 3);
    assert.match(result.results[3], /already requested 3 tool call/i);
  } finally {
    if (original === undefined) delete process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT;
    else process.env.MOSS_TOOL_LOOP_TOTAL_LIMIT = original;
  }
});

test('a mutating tool cannot opt itself into fresh observations', async () => {
  const result = await runFixture({
    metadata: { sideEffectClass: 'local_write', noReplay: true, freshObservation: true },
  });
  assert.equal(result.executions, 3);
  assert.match(result.results[3], /identical input/i);
});

test('even continually changing observations have an absolute per-signature bound', async () => {
  const result = await runFixture({
    callsPerTurn: Array(13).fill(1),
    beforeTurn: (turn, filename) => writeFile(filename, `revision-${turn}`),
  });
  assert.equal(result.executions, 12);
  assert.match(result.results[12], /observation|identical input/i);
});

test('changing observations across signatures share a bounded extra-call budget', async () => {
  const result = await runFixture({
    callsPerTurn: Array(36).fill(1),
    pathForCall: (index) => `state-${Math.floor(index / 12)}.txt`,
    beforeTurn: (turn, _filename, workspaceDir) =>
      writeFile(path.join(workspaceDir, `state-${Math.floor(turn / 12)}.txt`), `revision-${turn}`),
  });
  assert.equal(result.executions, 33);
  assert.match(result.results[33], /observation|identical input/i);
});

for (const configuredLimit of ['50', '0']) {
  test(`fresh observations keep hard budgets when the identical limit is ${configuredLimit}`, async () => {
    const original = process.env.MOSS_TOOL_LOOP_IDENTICAL_LIMIT;
    process.env.MOSS_TOOL_LOOP_IDENTICAL_LIMIT = configuredLimit;
    try {
      const single = await runFixture({
        callsPerTurn: Array(13).fill(1),
        beforeTurn: (turn, filename) => writeFile(filename, `revision-${turn}`),
      });
      assert.equal(single.executions, 12);
      assert.match(single.results[12], /observation|identical input/i);

      const multiple = await runFixture({
        callsPerTurn: Array(36).fill(1),
        pathForCall: (index) => `state-${Math.floor(index / 12)}.txt`,
        beforeTurn: (turn, _filename, workspaceDir) =>
          writeFile(
            path.join(workspaceDir, `state-${Math.floor(turn / 12)}.txt`),
            `revision-${turn}`
          ),
      });
      assert.equal(multiple.executions, 33);
      assert.match(multiple.results[33], /observation|identical input/i);

      const staticTool = await runFixture({
        callsPerTurn: Array(15).fill(1),
        metadata: { sideEffectClass: 'readonly', noReplay: true },
      });
      assert.equal(staticTool.executions, 15);
    } finally {
      if (original === undefined) delete process.env.MOSS_TOOL_LOOP_IDENTICAL_LIMIT;
      else process.env.MOSS_TOOL_LOOP_IDENTICAL_LIMIT = original;
    }
  });
}
