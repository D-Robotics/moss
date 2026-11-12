#!/usr/bin/env node
/** Offline SDK probe. Run after building dist/. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MossAgent } from '../../dist/core/agent/moss-agent.js';
import { createMossAgentLoopEventAdapter } from '../../dist/core/agent/moss-agent-loop-adapter.js';
import { createInlineThinkingRouter } from '../../dist/core/llm/inline-thinking-stream.js';
import { InMemorySessionStore } from '../../dist/core/session/session.js';
import { noteKnownSecret } from '../../dist/safety/known-secrets.js';
import {
  createAssistantTextRedactor,
  createStreamingTextRedactor,
} from '../../dist/safety/redact-stream.js';
import { redactEgress } from '../../dist/safety/tool-output-redact.js';

const known = 'boundary sample\nsecond line';
noteKnownSecret(known);
const cases = [
  'The first lines are plain. The final word is here.',
  '第一批汉字不等待换行。第二批也即时可见。',
  '漢字𠮷和另一个字。',
  'Plain prose. ' + known,
  'Plain prose. ' + JSON.stringify(known).slice(1, -1),
  'Plain prose.\n  -----BEGIN PRIVATE KEY-----\nABCdef12345\n-----END PRIVATE KEY-----',
  'Plain prose. -----BEGIN PRIVATE KEY-----\nABCdef12345\n-----END PRIVATE KEY-----',
  'Plain prose.\npassword="start\n  continued\n  closed"',
  'Plain prose. authorization : Bearer authorization',
  'Here is a story: a quiet day — with a smile 😊.',
  '第一行是 `name=stream-check`，表示名称。\n\n第二行是 `status=ready`，表示已经准备好。',
  'RDK-X5 /tmp/stream-check.txt C:\\work\\sample.txt name=stream-check count=42 status=ready.',
  '- RDK-X5 状态正常。\n- 第二个条目正常。',
  '```text\nname=stream-check\nstatus=ready\n```\n代码说明继续输出。',
  '普通路径 https://example.test/docs 之后继续写作。',
  '普通输出路径为 /tmp/stream-check/result.txt。针对 RDK-X5 继续说明。',
  '\n\n  原始前导空白用于校验纯脱敏函数的原文一致性。',
  'name=stream-check status=ready password="full credential sample"',
  'name=stream-check ' + known,
  'name=stream-check ' + JSON.stringify(known).slice(1, -1),
  'Plain prose. password samplevalue machine localhost',
  'Plain prose. sshpass -p samplevalue ssh demo',
  'Plain prose. https://username:sample1234@example.test',
  'Plain prose. sk-' + 'a'.repeat(28),
  'Plain prose. gsk_' + 'b'.repeat(28),
  'Plain prose. AKIA' + 'C'.repeat(16),
  'Plain prose. eyJ' + 'D'.repeat(12) + '.eyJ' + 'E'.repeat(12) + '.' + 'F'.repeat(15),
];

function verifyChunks(chunks, expected, caseIndex) {
  const redactor = createAssistantTextRedactor();
  let output = '';
  for (const chunk of chunks) {
    output += redactor.push(chunk);
    assert.ok(expected.startsWith(output), `unsafe or unstable prefix in case ${caseIndex}`);
  }
  assert.ok(output + redactor.flush() === expected, `settled text differs in case ${caseIndex}`);
}

for (const [index, text] of cases.entries()) {
  const expected = redactEgress(text);
  verifyChunks(text.split(''), expected, index);
  for (let split = 1; split < text.length; split += 1) {
    verifyChunks([text.slice(0, split), text.slice(split)], expected, index);
  }
}

const isolatedConfig = await mkdtemp(join(tmpdir(), 'moss-live-text-'));
const previousConfig = process.env.MOSS_CONFIG_DIR;
try {
  process.env.MOSS_CONFIG_DIR = isolatedConfig;
  await writeFile(join(isolatedConfig, 'config.json'), JSON.stringify({ passwordValue: 'demo' }));
  const shortField = '"passwordValue" : "demo"';
  const expected = redactEgress(shortField);
  assert.ok(!expected.includes('demo'));
  verifyChunks(shortField.split(''), expected, 'short configured password');
} finally {
  if (previousConfig === undefined) delete process.env.MOSS_CONFIG_DIR;
  else process.env.MOSS_CONFIG_DIR = previousConfig;
  await rm(isolatedConfig, { recursive: true, force: true });
}

// Reasoning is a separate public channel with the same cross-chunk egress boundary.
for (const [index, text] of cases.entries()) {
  const expected = redactEgress(text);
  const reasoner = createMossAgentLoopEventAdapter();
  let visible = '';
  reasoner.onMiniEvent({ type: 'turn_start', turn: 1 });
  for (const delta of text) {
    visible += reasoner
      .onMiniEvent({ type: 'thinking_delta', delta })
      .filter((event) => event.type === 'thinking_delta')
      .map((event) => event.delta)
      .join('');
    assert.ok(expected.startsWith(visible), `unsafe reasoning prefix in case ${index}`);
  }
  visible += reasoner
    .onMiniEvent({ type: 'message_end', text: '' })
    .filter((event) => event.type === 'thinking_delta')
    .map((event) => event.delta)
    .join('');
  assert.equal(visible, expected, `reasoning completion in case ${index}`);
  assert.equal(reasoner.getResult({ finalText: '' }).thinking?.join(''), expected);
}

for (const boundary of [
  { type: 'retry', attempt: 1, error: 'temporary failure' },
  { type: 'turn_end', turn: 1, stopReason: 'end_turn' },
  { type: 'message_end', text: '', stopReason: 'aborted_by_user' },
  { type: 'message_end', text: '', stopReason: 'length' },
  { type: 'agent_error', error: 'interrupted' },
]) {
  const reasoner = createMossAgentLoopEventAdapter();
  const live = reasoner.onMiniEvent({ type: 'thinking_delta', delta: '先检查环境。' });
  assert.equal(live[0]?.delta, '先检查环境。', 'reasoning must publish before completion');
  assert.deepEqual(reasoner.onMiniEvent({ type: 'thinking_delta', delta: known.slice(0, 3) }), []);
  assert.ok(reasoner.onMiniEvent(boundary).every((event) => event.type !== 'thinking_delta'));
  reasoner.onMiniEvent({ type: 'turn_start', turn: 2 });
  assert.equal(
    reasoner.onMiniEvent({ type: 'thinking_delta', delta: '接下来验证。' })[0]?.delta,
    '接下来验证。'
  );
  assert.equal(
    reasoner.getResult({ finalText: '' }).thinking?.join(''),
    '先检查环境。接下来验证。'
  );
}
console.log(
  '[assistant-live-text] safe live reasoning, settled results and interrupted tails passed'
);

const reasoningBoundary = createMossAgentLoopEventAdapter();
assert.deepEqual(
  reasoningBoundary.onMiniEvent({ type: 'thinking_delta', delta: 'trailingword' }),
  []
);
assert.deepEqual(reasoningBoundary.onMiniEvent({ type: 'message_delta', delta: '公开正文。' }), [
  { type: 'thinking_delta', delta: 'trailingword' },
  { type: 'text_delta', delta: '公开正文。' },
]);
assert.deepEqual(reasoningBoundary.onMiniEvent({ type: 'message_end', text: '公开正文。' }), []);

const commandRedactor = createStreamingTextRedactor();
assert.equal(commandRedactor.push('Command logs still hold a partial line.'), '');
assert.equal(commandRedactor.flush(), 'Command logs still hold a partial line.');

const adapter = createMossAgentLoopEventAdapter();
const whole = 'Some plain prose. ' + known;
const partial = whole.slice(0, 22);
const continuation = [];
const feed = (event) =>
  continuation.push(...adapter.onMiniEvent(event).filter((item) => item.type === 'text_delta'));
feed({ type: 'turn_start', turn: 1 });
feed({ type: 'message_delta', delta: partial });
feed({ type: 'message_end', text: partial, stopReason: 'length' });
feed({ type: 'turn_end', turn: 1, stopReason: 'length' });
feed({ type: 'output_continuation', attempt: 1, maxAttempts: 2 });
feed({ type: 'turn_start', turn: 2 });
feed({ type: 'message_delta', delta: whole.slice(partial.length) });
assert.equal(continuation.map((event) => event.delta).join(''), 'Some plain prose.');
feed({ type: 'message_end', text: whole });
assert.ok(continuation.map((event) => event.delta).join('') === redactEgress(whole));

for (const reason of ['error', 'aborted_by_user', 'output_limit']) {
  const interrupted = createMossAgentLoopEventAdapter();
  const collected = [];
  const emit = (event) =>
    collected.push(...interrupted.onMiniEvent(event).filter((item) => item.type === 'text_delta'));
  const partialValue = 'Visible sentence. ' + known.slice(0, 3);
  const firstReason = reason === 'output_limit' ? 'length' : reason;
  emit({ type: 'turn_start', turn: 1 });
  emit({ type: 'message_delta', delta: partialValue });
  emit({ type: 'message_end', text: partialValue, stopReason: firstReason });
  emit({ type: 'turn_end', turn: 1, stopReason: firstReason });
  if (reason === 'output_limit') {
    emit({ type: 'output_continuation', attempt: 1, maxAttempts: 1, exhausted: true });
    emit({ type: 'turn_transition', reason });
  }
  assert.equal(collected.map((event) => event.delta).join(''), 'Visible sentence.');
  assert.equal(interrupted.getResult({ finalText: partialValue }).response, 'Visible sentence.');
}

const suspendedAdapter = createMossAgentLoopEventAdapter();
suspendedAdapter.onMiniEvent({ type: 'turn_start', turn: 1 });
const unsettled = 'Visible sentence. ' + known.slice(0, 3);
suspendedAdapter.onMiniEvent({ type: 'message_delta', delta: unsettled });
const suspendedResult = suspendedAdapter.getResult({
  finalText: unsettled,
  suspendedTool: {
    continuationId: 'waiting',
    toolCallId: 'waiting-call',
    toolName: 'await_reply',
  },
});
assert.equal(suspendedResult.stopReason, 'suspended');
assert.equal(suspendedResult.response, 'Visible sentence.');
assert.equal(suspendedResult.suspendedTool?.continuationId, 'waiting');
suspendedAdapter.onMiniEvent({ type: 'message_end', text: 'Visible sentence. ' + known });
assert.equal(
  suspendedAdapter.getResult({ finalText: '', suspendedTool: suspendedResult.suspendedTool })
    .response,
  redactEgress('Visible sentence. ' + known)
);

const rejected = createMossAgentLoopEventAdapter();
rejected.onMiniEvent({ type: 'turn_start', turn: 1 });
rejected.onMiniEvent({ type: 'message_delta', delta: 'Visible sentence. ' + known.slice(0, 3) });
const ended = rejected.onMiniEvent({ type: 'turn_end', turn: 1, stopReason: 'end_turn' });
assert.ok(ended.every((event) => event.type !== 'text_delta'));

const formatted = createAssistantTextRedactor();
assert.equal(
  formatted.push('第一行是 `name=stream-check`，表示名称。'),
  '第一行是 `name=stream-check`，表示名称。'
);
assert.equal(
  formatted.push('\n\n第二行是 `status=ready`，表示已经准备好。'),
  '\n\n第二行是 `status=ready`，表示已经准备好。'
);
assert.equal(
  formatted.push('普通输出路径为 /tmp/stream-check/result.txt。针对 RDK-X5 继续说明。'),
  '普通输出路径为 /tmp/stream-check/result.txt。针对 RDK-X5 继续说明。'
);
assert.equal(formatted.flush(), '');

const normalized = createMossAgentLoopEventAdapter();
normalized.onMiniEvent({ type: 'turn_start', turn: 1 });
assert.deepEqual(normalized.onMiniEvent({ type: 'message_delta', delta: '\n\n   ' }), []);
const resumed = normalized.onMiniEvent({ type: 'message_delta', delta: '正常正文继续输出。' });
assert.equal(resumed.map((event) => event.delta ?? '').join(''), '正常正文继续输出。');
assert.deepEqual(normalized.onMiniEvent({ type: 'message_end', text: '正常正文继续输出。' }), []);

const punctuation = createAssistantTextRedactor();
const first = punctuation.push('Here is a story: It begins — ');
const second = punctuation.push('with a smile 😊 and a quiet day.');
assert.equal(first, 'Here is a story: It begins —');
assert.equal(second, ' with a smile 😊 and a quiet day.');
assert.equal(punctuation.flush(), '');

const withTags = 'First <ThInKiNg>reasoning</THINKING>Second <think>hidden</think>Last.';
for (let split = 1; split < withTags.length; split += 1) {
  const router = createInlineThinkingRouter();
  const events = [router.push(withTags.slice(0, split)), router.push(withTags.slice(split))];
  events.push(router.end());
  assert.equal(events.flatMap((event) => event.message).join(''), 'First Second Last.');
  assert.equal(events.flatMap((event) => event.thinking).join(''), 'reasoninghidden');
}
const router = createInlineThinkingRouter();
assert.deepEqual(router.push('short plain delta'), {
  message: ['short plain delta'],
  thinking: [],
});

const deltas = ['清晨，机器人走出门口。', '它把画册交给等待的人。', '它转身看到了花园。'];
const reasoningDeltas = ['先确定故事的场景。', '再补充角色的行动。'];
let providerDone = false;
const provider = {
  id: 'assistant-live-text-fixture',
  displayName: 'Assistant live text fixture',
  capabilities: { streaming: true },
  async complete() {
    return { stopReason: 'end_turn', content: [{ type: 'text', text: deltas.join('') }] };
  },
  async stream(options, emit) {
    assert.equal(options.tools?.length ?? 0, 0);
    for (const text of reasoningDeltas) {
      emit({ type: 'content_block_delta', deltaRole: 'thinking', text });
      await delay(100);
    }
    for (const text of deltas) {
      emit({ type: 'content_block_delta', text });
      await delay(200);
    }
    providerDone = true;
    return this.complete();
  },
};
const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
});
try {
  const live = [];
  let beforeDone = 0;
  const liveReasoning = [];
  let reasoningBeforeDone = 0;
  let response;
  for await (const event of agent.streamChat('live-text', 'Write a short story.', {
    toolFilter: () => false,
  })) {
    if (event.type === 'text_delta') {
      live.push(event.delta);
      if (!providerDone && event.delta) beforeDone += 1;
    } else if (event.type === 'thinking_delta') {
      liveReasoning.push(event.delta);
      if (!providerDone && event.delta) reasoningBeforeDone += 1;
    } else if (event.type === 'done') {
      response = event.result.response;
      assert.equal(event.result.thinking?.join(''), reasoningDeltas.join(''));
    }
  }
  assert.ok(beforeDone >= 2, `only ${beforeDone} text events before model completion`);
  assert.equal(liveReasoning.join(''), reasoningDeltas.join(''));
  assert.equal(reasoningBeforeDone, reasoningDeltas.length);
  assert.equal(live.join(''), deltas.join(''));
  assert.equal(response, deltas.join(''));
  console.log(
    `[assistant-live-text] ${cases.length} split-point cases and ${beforeDone} pre-completion events passed`
  );
} finally {
  await agent.close();
}

async function verifyFormattedReply(buffered, continuation) {
  const pieces = continuation
    ? [['   这是第一部分， '], [' 这是续写的第二部分。']]
    : [
        [
          '\n\n   ',
          '第一行是 `name=stream-check`，表示名称。',
          '\n\n第二行是 `status=ready`，表示已经准备好。',
        ],
      ];
  let request = 0;
  let modelFinished = false;
  const formattedProvider = {
    id: 'formatted-reply',
    displayName: 'Formatted reply fixture',
    capabilities: { streaming: true },
    async complete() {
      throw new Error('Expected streaming');
    },
    async stream(_options, emit) {
      const index = request++;
      for (const text of pieces[index]) {
        emit({ type: 'content_block_delta', text });
        await delay(50);
      }
      modelFinished = request === pieces.length;
      return {
        stopReason: request < pieces.length ? 'max_tokens' : 'end_turn',
        content: [{ type: 'text', text: pieces[index].join('') }],
      };
    },
  };
  const formattedAgent = new MossAgent({
    llmProvider: formattedProvider,
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    bufferAssistantUntilComplete: buffered,
  });
  try {
    let text = '';
    let finalResponse;
    let live = 0;
    for await (const event of formattedAgent.streamChat('formatted', 'Write a short story.', {
      toolFilter: () => false,
    })) {
      if (event.type === 'text_delta') {
        text += event.delta;
        if (!modelFinished && event.delta) live += 1;
      }
      if (event.type === 'done') finalResponse = event.result.response;
    }
    const raw = pieces.flat().join('');
    const expected = continuation ? (buffered ? raw : raw.trimStart()) : raw.trim();
    assert.equal(text, expected);
    assert.equal(finalResponse, expected);
    if (!buffered && !continuation) assert.ok(live >= 2);
  } finally {
    await formattedAgent.close();
  }
}
await verifyFormattedReply(false, false);
await verifyFormattedReply(false, true);
await verifyFormattedReply(true, true);
console.log(
  '[assistant-live-text] formatted prose, leading whitespace and buffered/live continuations passed'
);
