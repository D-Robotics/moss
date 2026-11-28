#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = process.env.MOSS_VERIFY_DIST_ROOT ?? path.join(root, 'dist');
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const [
  { buildProviderToolDeclarations },
  { turnDecisionSchema, versionedTurnDecisionSchema, readOnlyTurnDecisionSchema },
  { MossAgent },
  { VersionedSessionStore },
] = await Promise.all([
  load('core/loop/agent-loop-context-prep.js'),
  load('core/session/task-intent-state.js'),
  load('core/agent/moss-agent.js'),
  load('core/session/versioned-session-store.js'),
]);

// The provider must receive the decision contract, including nested guidance.
// Ordinary tool schema compaction is covered by the tool-lean stage.
for (const contextWindowTokens of [32_768, 131_072]) {
  for (const inputSchema of [
    turnDecisionSchema,
    versionedTurnDecisionSchema,
    readOnlyTurnDecisionSchema,
  ]) {
    const [wire] = buildProviderToolDeclarations(
      [{ name: 'turn_decision', description: 'Decide how to continue.', inputSchema }],
      { contextWindowTokens }
    );
    assert.deepEqual(
      wire.parameters,
      inputSchema,
      'decision guidance was lost before the provider'
    );
  }
}
console.log('PASS decision schema guidance reaches small and large context providers intact');

const toolCall = (name, input = {}) => ({ type: 'tool_use', id: name, name, input });
const response = (...content) => ({
  stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
  content,
});

for (const needsLookup of [true, false]) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-readonly-decision-'));
  const store = new VersionedSessionStore(path.join(workspace, 'session.sqlite'));
  let calls = 0;
  let reads = 0;
  const provider = {
    id: 'scripted',
    displayName: 'read-only decision probe',
    capabilities: { streaming: false },
    async complete(request) {
      calls++;
      const decision = request.tools.find((tool) => tool.name === 'turn_decision');
      if (calls <= 2) {
        assert.deepEqual(decision.input_schema, versionedTurnDecisionSchema);
        assert.equal(reads, 0, 'a rejected batch must not execute or replay its read');
      }
      if (!needsLookup) {
        assert.equal(calls, 1, 'a complete answer must not cause another model request');
        return response(toolCall('turn_decision', { disposition: 'answer', answer: '2' }));
      }
      if (calls === 1) return response(toolCall('read_official_docs'));
      if (calls === 2) {
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ['turn_decision']
        );
        assert.equal(request.toolChoice, 'required');
        return response(
          toolCall('turn_decision', {
            disposition: 'execute',
            plan: ['Read the official documentation, then answer from the result.'],
          })
        );
      }
      assert.equal(decision, undefined, 'a committed decision must not be requested again');
      if (calls === 3) return response(toolCall('read_official_docs'));
      assert.equal(calls, 4);
      assert.equal(reads, 1);
      assert.ok(JSON.stringify(request.messages).includes('fixture-doc-value'));
      return response({ type: 'text', text: 'The documentation says fixture-doc-value.' });
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    workspaceDir: workspace,
    sessionInboxDir: path.join(workspace, 'inbox'),
    baseSystemPrompt: 'Answer from the available evidence.',
    domainPrompt: false,
    taskIntent: true,
    contextTokens: 131_072,
    maxLLMRetries: 0,
  });
  agent.tools.register({
    name: 'read_official_docs',
    description: 'Read the official documentation.',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'read' },
    async execute() {
      reads++;
      return 'fixture-doc-value';
    },
  });
  try {
    const result = await agent.chat('probe', needsLookup ? 'Read the docs and explain.' : '1+1?', {
      taskFlow: false,
      userInput: { id: 'input-1' },
      maxTurns: 5,
    });
    assert.equal(result.stopReason, needsLookup ? 'end_turn' : 'task_intent_hold');
    assert.equal(calls, needsLookup ? 4 : 1);
    assert.equal(reads, needsLookup ? 1 : 0);
    assert.equal(result.response, needsLookup ? 'The documentation says fixture-doc-value.' : '2');
    console.log(
      needsLookup
        ? 'PASS repair preserves decision guidance, then executes the read once and finishes'
        : 'PASS a complete zero-tool answer finishes in one model request'
    );
  } finally {
    await agent.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
