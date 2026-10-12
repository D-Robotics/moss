import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MossAgent, InMemorySessionStore } from '../dist/index.js';
import { createMossAgentLoopEventAdapter } from '../dist/core/agent/moss-agent-loop-adapter.js';
import { truncateToolOutput } from '../dist/context/tool-output-truncate.js';
import { formatToolResultForSsePreview } from '../dist/core/loop/agent-loop-tool-helpers.js';

test('host observer runs in the producer before provider calls and cannot break a turn', async () => {
  const events = [];
  const identities = [];
  let providerSawTurn = false;
  const response = { stopReason: 'end_turn', content: [{ type: 'text', text: 'observed reply' }] };
  const provider = {
    id: 'observer-test',
    displayName: 'Observer test',
    async complete() {
      return response;
    },
    async stream(_options, emit) {
      providerSawTurn = events.includes('turn_start');
      emit({ type: 'text_delta', text: 'observed reply' });
      return response;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    model: 'test',
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    onAgentLoopEvent(event, identity) {
      events.push(event.type);
      identities.push(identity);
      if (event.type === 'turn_start') throw new Error('diagnostic failure');
    },
  });
  try {
    const result = await agent.chat('owner-session', 'reply', { runId: 'owner-run' });
    assert.equal(result.response, 'observed reply');
    assert.equal(providerSawTurn, true);
    assert.ok(events.includes('turn_end'));
    assert.ok(
      identities.every(
        (identity) => identity.runId === 'owner-run' && identity.sessionKey === 'owner-session'
      )
    );
  } finally {
    await agent.close();
  }
});

test('public streaming tool completion preserves bounded Python verdicts beyond its preview', async () => {
  // Real owned device outputs; only the private remote UUID is replaced at equal length.
  const failed =
    'FF\n======================================================================\nFAIL: test_negative (__main__.SumTest)\n----------------------------------------------------------------------\nTraceback (most recent call last):\n  File "/tmp/rdk-moss-model-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/test_calculate.py", line 5, in test_negative\n    def test_negative(self): self.assertEqual(add(-4,2),-2)\nAssertionError: -6 != -2\n\n======================================================================\nFAIL: test_positive (__main__.SumTest)\n----------------------------------------------------------------------\nTraceback (most recent call last):\n  File "/tmp/rdk-moss-model-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/test_calculate.py", line 4, in test_positive\n    def test_positive(self): self.assertEqual(add(2,3),5)\nAssertionError: -1 != 5\n\n----------------------------------------------------------------------\nRan 2 tests in 0.002s\n\nFAILED (failures=2)\n\n[exit code: 1]\n\n[编排提示 · 须继续] 上条设备端命令**未成功**（非零退出或 stderr 报错）。你**必须**再调用工具：例如 `ros2 pkg prefix <包名>`、`dpkg -L <包名>`、`device_file_list` 查真实路径，或先 `web_fetch` 查阅对应官方文档/例程；直到定位资源或明确告知缺什么。**禁止**仅复述上述错误就结束回合。';
  const passed =
    '..\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK';
  assert.equal(failed.length, 1132);
  assert.equal(passed.length, 99);
  const outputs = [failed, passed];
  let turn = 0;
  const agent = new MossAgent({
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    hooks: { onBeforeToolExec: async () => ({ approved: true }) },
    llmProvider: {
      id: 'bounded-evidence',
      capabilities: { streaming: false },
      async complete() {
        return turn++ < 2
          ? {
              stopReason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: `verify-${turn}`,
                  name: 'device_exec',
                  input: { round: turn },
                },
              ],
            }
          : { stopReason: 'end_turn', content: [{ type: 'text', text: 'finished' }] };
      },
    },
  });
  agent.tools.register({
    name: 'device_exec',
    description: 'Bounded host test output.',
    inputSchema: { type: 'object', properties: { round: { type: 'number' } } },
    metadata: { sideEffectClass: 'readonly' },
    async execute(input) {
      return outputs[input.round - 1];
    },
  });
  try {
    const events = [];
    for await (const event of agent.streamChat('bounded-evidence', 'verify', {
      deviceConfigured: true,
    })) {
      events.push(event);
    }
    const ends = events.filter((event) => event.type === 'tool_end');
    assert.equal(ends.length, 2);
    assert.equal(ends[0].content, failed);
    assert.equal(ends[0].result.length, 503);
    assert.doesNotMatch(ends[0].result, /Ran 2|FAILED/);
    assert.match(ends[0].content, /Ran 2[\s\S]*FAILED/);
    assert.equal(ends[1].content, passed);
    assert.equal(ends[1].result, passed);
  } finally {
    await agent.close();
  }
});

test('canonical completion retains original output limits and metadata without replacing the preview', () => {
  const raw = 'START\n' + '界'.repeat(30_000) + '\nRan 2 tests\nFAILED\n';
  const bounded = truncateToolOutput('device_exec', raw);
  const preview = formatToolResultForSsePreview(bounded, true);
  const error = { code: 'TOOL_EXECUTION_FAILED', message: 'failed' };
  const structuredContent = [{ type: 'text', text: 'bounded structured evidence' }];
  const adapter = createMossAgentLoopEventAdapter();
  const [event] = adapter.onMiniEvent({
    type: 'tool_execution_end',
    toolName: 'device_exec',
    toolCallId: 'utf8',
    result: preview,
    content: bounded,
    isError: true,
    outcome: 'error',
    durationMs: 7,
    aborted: { by: 'timeout' },
    structuredContent,
    error,
  });
  assert.equal(event.result, preview);
  assert.equal(event.content, bounded);
  assert.ok(Buffer.byteLength(event.content, 'utf8') < 24_300);
  assert.match(event.content, /tokens truncated/);
  assert.match(event.content, /START[\s\S]*Ran 2 tests\nFAILED/);
  assert.equal(event.isError, true);
  assert.equal(event.outcome, 'error');
  assert.equal(event.durationMs, 7);
  assert.deepEqual(event.aborted, { by: 'timeout' });
  assert.deepEqual(event.structuredContent, structuredContent);
  assert.deepEqual(event.error, error);
});

test('new canonical completion uses existing secret redaction and keeps legacy/denied events compatible', () => {
  const adapter = createMossAgentLoopEventAdapter();
  const source = 'plain evidence\npassword="observer-secret-12345678"\nRan 2 tests\nFAILED\n';
  const [redacted] = adapter.onMiniEvent({
    type: 'tool_execution_end',
    toolName: 'host_probe',
    toolCallId: 'secret',
    result: 'original preview',
    content: source,
    isError: false,
  });
  assert.equal(redacted.result, 'original preview');
  assert.doesNotMatch(redacted.content, /observer-secret-12345678/);
  assert.match(redacted.content, /plain evidence[\s\S]*\[REDACTED\][\s\S]*FAILED/);
  const [legacy] = adapter.onMiniEvent({
    type: 'tool_execution_end',
    toolName: 'host_probe',
    toolCallId: 'legacy',
    result: 'legacy result',
    isError: false,
  });
  assert.equal(legacy.content, undefined);
  assert.equal(legacy.result, 'legacy result');
  const [denied] = adapter.onMiniEvent({
    type: 'tool_execution_end',
    toolName: 'host_probe',
    toolCallId: 'denied',
    result: 'denied',
    content: 'denied',
    isError: true,
    outcome: 'denied',
    durationMs: 0,
  });
  assert.equal(denied.content, 'denied');
  assert.equal(denied.outcome, 'denied');
});
