#!/usr/bin/env node
/**
 * Harness-injection probe (offline, scripted provider).
 *
 * Pins the 2026-11-26 subtraction. The harness must not add a model turn
 * because a regex matched the model's prose or the user's words:
 *   - a model that narrates a tool call without emitting one gets no
 *     corrective turn and no host-synthesised tool call;
 *   - user wording that used to trip the ambiguity trigger, followed by a
 *     run of edits, gets no [System] / [Steering] message.
 * And it pins the recovery that was kept because it keys off a provider fact
 * instead of prose: an empty response is retried once, a max_tokens cutoff is
 * continued.
 *
 * Every LLM call must be one the script planned. An unplanned call (a hidden
 * corrective turn) fails the case with its call number.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (file) => import(pathToFileURL(path.join(root, 'dist', file)).href);
const { MossAgent } = await load('core/agent/moss-agent.js');
const { InMemorySessionStore } = await load('core/session/session.js');
const { registerBuiltinTools } = await load('tools/builtin.js');

const workspaceDir = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'moss-harness-injection-'))
);

const text = (value, stopReason = 'end_turn') => ({
  stopReason,
  content: [{ type: 'text', text: value }],
});
const use = (id, name, input) => ({
  stopReason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
});

async function run(sessionKey, turns, userMessage, config = {}) {
  let calls = 0;
  const provider = {
    id: 'scripted',
    displayName: 'scripted (offline)',
    capabilities: { streaming: false },
    async complete() {
      calls += 1;
      const turn = turns[calls - 1];
      if (!turn) {
        throw new Error(`unplanned LLM call ${calls}: the script planned ${turns.length}`);
      }
      return turn;
    },
  };
  const store = new InMemorySessionStore();
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    workspaceDir,
    baseSystemPrompt: 'You are a test agent.',
    domainPrompt: false,
    ...config,
  });
  registerBuiltinTools(agent);
  try {
    const result = await agent.chat(sessionKey, userMessage, { maxTurns: 12 });
    return { calls, result, history: await store.loadMessages(sessionKey) };
  } finally {
    await agent.close();
  }
}

/** Text of a message, for both stored shapes (plain string and text blocks). */
const userText = (message) => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
};

/** Harness-authored user turns in the stored history (the model saw them as user input). */
const harnessText = (history) =>
  history
    .filter((message) => message.role === 'user')
    .map(userText)
    .filter((value) => value.startsWith('[System]') || value.startsWith('[Steering]'));

try {
  {
    // Before the subtraction this bought a "[System] You described using tools"
    // turn, and the host could synthesise a web_search call from the plan text.
    const { calls, result, history } = await run(
      'prose-plan',
      [text('我来调用 web_search 打开 https://example.com/docs 查一下配置方法，然后给你结论。')],
      '查一下文档里怎么配置'
    );
    assert.equal(calls, 1, 'a narrated tool call must not buy a corrective turn');
    assert.deepEqual(
      harnessText(history),
      [],
      'no harness turn may be derived from the model prose'
    );
    const assistant = history.find((message) => message.role === 'assistant');
    assert.deepEqual(
      assistant.content.map((block) => block.type),
      ['text'],
      'the host must not synthesise a tool call from plan text'
    );
    assert.match(result.response, /web_search/, 'the narrated answer reaches the user as is');
    console.log('[harness-injection] ok a narrated tool call adds no turn and no host tool call');
  }

  {
    // The user's words hit the old ambiguity trigger ("or", "either", "maybe",
    // "或者", "还是") and the run edits a file, which is what that trigger
    // needed. The verification gate is a kept product guarantee; it is off here
    // so the only possible extra turn is the one under test.
    const notes = path.join(workspaceDir, 'notes.txt');
    const { calls, history } = await run(
      'regex-triggers',
      [
        use('w1', 'write_file', { path: notes, content: 'a' }),
        use('w2', 'write_file', { path: notes, content: 'b' }),
        use('w3', 'write_file', { path: notes, content: 'c' }),
        text('Done.'),
      ],
      'Should I fix the bug or implement the feature? Either is fine, maybe both. 修复或者实现都可以，还是你来定。',
      { verificationGate: false }
    );
    assert.equal(calls, 4, 'only the scripted turns reach the model');
    assert.deepEqual(harnessText(history), [], 'no [System] or [Steering] turn');
    assert.equal(await fs.readFile(notes, 'utf8'), 'c', 'the scripted edits still ran');
    console.log('[harness-injection] ok trigger words plus edits add no harness turn');
  }

  {
    const { calls, result, history } = await run(
      'empty-response',
      [text(''), text('Here is the answer.')],
      'say something'
    );
    assert.equal(calls, 2, 'an empty response is retried exactly once');
    assert.match(result.response, /Here is the answer\./);
    assert.ok(
      harnessText(history).some((value) => value.includes('previous response was empty')),
      'the empty-response correction is still recorded'
    );
    console.log('[harness-injection] ok an empty response is still retried once');
  }

  {
    // A roomy window keeps the length stop on the continuation path. With the
    // conservative default the same stop reads as context overflow instead.
    const { calls, result } = await run(
      'output-limit',
      [text('Hello wor', 'length'), text('ld')],
      'count',
      { contextTokens: 200_000 }
    );
    assert.equal(calls, 2, 'a max_tokens cutoff is continued exactly once');
    assert.equal(result.response, 'Hello world', 'the two fragments are stitched');
    console.log('[harness-injection] ok a max_tokens cutoff is still continued');
  }
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
