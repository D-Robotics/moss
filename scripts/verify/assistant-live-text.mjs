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
  let response;
  for await (const event of agent.streamChat('live-text', 'Write a short story.', {
    toolFilter: () => false,
  })) {
    if (event.type === 'text_delta') {
      live.push(event.delta);
      if (!providerDone && event.delta) beforeDone += 1;
    } else if (event.type === 'done') {
      response = event.result.response;
    }
  }
  assert.ok(beforeDone >= 2, `only ${beforeDone} text events before model completion`);
  assert.equal(live.join(''), deltas.join(''));
  assert.equal(response, deltas.join(''));
  console.log(
    `[assistant-live-text] ${cases.length} split-point cases and ${beforeDone} pre-completion events passed`
  );
} finally {
  await agent.close();
}
