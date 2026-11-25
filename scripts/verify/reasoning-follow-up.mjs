#!/usr/bin/env node
/**
 * Offline regression: the reasoning level reaches the wire on every call,
 * including the call that follows a tool result.
 *
 * The provider is the real PiAiLLMProvider on a scripted stream function and
 * the loop is the real agent loop, so the options recorded here are what a
 * provider would have received. The second call used to lose its reasoning
 * level with a "provider compatibility" note that no provider had asked for.
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
const { PiAiLLMProvider } = await load('provider/pi-ai-adapter.js');

const workspaceDir = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'moss-reasoning-follow-up-'))
);
const usage = { input: 12, output: 4 };

async function run(key, config, chatOptions) {
  const sent = [];
  const provider = new PiAiLLMProvider({
    apiKey: 'offline-key',
    ...config,
    streamFn: async function* (model, context, options) {
      sent.push({
        model: model.id,
        reasoning: options?.reasoning,
        lastRole: context.messages.at(-1)?.role,
      });
      if (sent.length === 1) {
        yield {
          type: 'toolcall_end',
          toolCall: { id: 'call-1', name: 'read_file', arguments: { path: 'note.txt' } },
        };
        yield { type: 'done', reason: 'toolCall', usage };
      } else {
        yield { type: 'text_delta', delta: 'The note says hello.' };
        yield { type: 'done', reason: 'stop', usage };
      }
    },
  });
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    baseSystemPrompt: 'Read the file, then answer.',
    domainPrompt: false,
    verificationGate: false,
  });
  registerBuiltinTools(agent);
  try {
    const result = await agent.chat(key, 'Read note.txt and tell me what it says.', {
      maxTurns: 6,
      ...chatOptions,
    });
    assert.equal(result.toolResults.length, 1, 'one tool call ran between the two model calls');
    assert.match(result.response, /The note says hello\./);
  } finally {
    await agent.close();
  }
  return sent;
}

try {
  await fs.writeFile(path.join(workspaceDir, 'note.txt'), 'hello\n');
  const model = {
    api: 'anthropic-messages',
    provider: 'anthropic',
    id: 'claude-sonnet-4-5',
    reasoning: true,
  };

  const perCall = await run('reasoning-per-call', { model }, { reasoning: 'high' });
  assert.equal(perCall.length, 2, 'exactly two model calls');
  assert.deepEqual(
    perCall.map((call) => call.lastRole),
    ['user', 'toolResult']
  );
  assert.deepEqual(
    perCall.map((call) => call.reasoning),
    ['high', 'high'],
    'a per-call level is sent on the call after the tool result too'
  );
  console.log('[reasoning-follow-up] ok per-call level reaches both calls');

  const providerLevel = await run('reasoning-provider', { model, reasoning: 'medium' }, {});
  assert.deepEqual(
    providerLevel.map((call) => call.reasoning),
    ['medium', 'medium'],
    'a provider-level setting is sent on both calls'
  );
  console.log('[reasoning-follow-up] ok provider-level setting reaches both calls');

  const off = await run('reasoning-off', { model, reasoning: null }, { reasoning: null });
  assert.deepEqual(
    off.map((call) => call.reasoning),
    [undefined, undefined],
    'an explicit off stays off on both calls'
  );
  console.log('[reasoning-follow-up] ok an explicit off is sent as no reasoning option');
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
