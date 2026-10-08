#!/usr/bin/env node
/**
 * Acceptance completion gate (P0-2/P0-9): pure decision matrix, the
 * blocks-at-most-once wrapper, and an end-to-end run through the real
 * MossAgent loop with a scripted provider — the final answer is held back
 * until a task contract has an acceptance verdict.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateAcceptanceCompletionGate,
  createAcceptanceCompletionGate,
  collectToolResultsByName,
} from '../dist/core/loop/acceptance-completion-gate.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { registerBuiltinTools } from '../dist/tools/builtin.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

function toolUseMessage(name, input) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: `use_${name}`, name, input }],
    timestamp: 1,
  };
}

function toolResultMessage(id, text) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
    timestamp: 2,
  };
}

test('evaluateAcceptanceCompletionGate: pure decision matrix', () => {
  // No task contract defined this run → gate open.
  assert.equal(evaluateAcceptanceCompletionGate({ messages: [], toolCallsByName: {} }).ok, true);

  // Contract defined, no acceptance run → blocked.
  const defined = {
    messages: [
      toolUseMessage('task_define', {}),
      toolResultMessage('use_task_define', 'Task contract task_x: active'),
    ],
    toolCallsByName: { task_define: 1 },
  };
  const blocked = evaluateAcceptanceCompletionGate(defined);
  assert.equal(blocked.ok, false);
  assert.match(blocked.correction, /task_acceptance/);
  assert.match(blocked.correction, /record_evidence/);

  // FAIL with no repair after it → blocked once so the run enters the repair loop.
  const failed = {
    messages: [
      ...defined.messages,
      toolUseMessage('task_acceptance', {}),
      toolResultMessage(
        'use_task_acceptance',
        'Task acceptance (task_x): FAIL\nFINAL: not accepted'
      ),
    ],
    toolCallsByName: { task_define: 1, task_acceptance: 1 },
  };
  const unrepaired = evaluateAcceptanceCompletionGate(failed);
  assert.equal(unrepaired.ok, false);
  assert.equal(unrepaired.kind, 'unrepaired-fail');
  assert.match(unrepaired.correction, /record_failure/);

  // FAIL followed by a repair-path tool → open (the loop has started; a later
  // honest report is allowed).
  const repaired = {
    messages: [
      ...failed.messages,
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'use_record_failure', name: 'record_failure', input: {} },
        ],
        timestamp: 3,
      },
      toolResultMessage('use_record_failure', 'failure recorded'),
    ],
    toolCallsByName: { task_define: 1, task_acceptance: 1, record_failure: 1 },
  };
  assert.equal(evaluateAcceptanceCompletionGate(repaired).ok, true);

  // Acceptance PASS → open.
  const passed = {
    messages: [
      ...defined.messages,
      toolUseMessage('task_acceptance', {}),
      toolResultMessage(
        'use_task_acceptance',
        'Task acceptance (task_x): PASS\nFINAL: PASS — acceptance criteria met'
      ),
    ],
    toolCallsByName: { task_define: 1, task_acceptance: 1 },
  };
  assert.equal(evaluateAcceptanceCompletionGate(passed).ok, true);

  // Results from other tools are not mistaken for acceptance verdicts.
  const decoy = {
    messages: [
      ...defined.messages,
      toolUseMessage('exec', {}),
      toolResultMessage('use_exec', 'Task acceptance (decoy): PASS'),
    ],
    toolCallsByName: { task_define: 1, exec: 1 },
  };
  assert.equal(evaluateAcceptanceCompletionGate(decoy).ok, false);
});

test('createAcceptanceCompletionGate blocks at most once per run', async () => {
  const gate = createAcceptanceCompletionGate();
  const request = {
    messages: [toolUseMessage('task_define', {}), toolResultMessage('use_task_define', 'ok')],
    toolCallsByName: { task_define: 1 },
  };
  const first = await gate({
    ...request,
    sessionKey: 's',
    runId: 'r',
    turn: 1,
    response: 'done',
    totalToolCalls: 2,
  });
  assert.equal(first.ok, false);
  const second = await gate({
    ...request,
    sessionKey: 's',
    runId: 'r',
    turn: 2,
    response: 'done again',
    totalToolCalls: 3,
  });
  assert.equal(second.ok, true, 'second attempt passes — the gate never holds the run hostage');

  const failedRequest = {
    messages: [
      ...request.messages,
      toolUseMessage('task_acceptance', {}),
      toolResultMessage(
        'use_task_acceptance',
        'Task acceptance (task_x): FAIL\nFINAL: not accepted'
      ),
    ],
    toolCallsByName: { task_define: 1, task_acceptance: 1 },
  };
  const repairBlock = await gate({
    ...failedRequest,
    sessionKey: 's',
    runId: 'r',
    turn: 3,
    response: 'it failed',
    totalToolCalls: 4,
  });
  assert.equal(repairBlock.ok, false, 'a later unrepaired FAIL is its own block');
  const repairGiveUp = await gate({
    ...failedRequest,
    sessionKey: 's',
    runId: 'r',
    turn: 4,
    response: 'reporting FAIL',
    totalToolCalls: 4,
  });
  assert.equal(repairGiveUp.ok, true, 'the repair block also fires only once');
});

test('collectToolResultsByName pairs tool_use ids with tool_result blocks', () => {
  const messages = [
    toolUseMessage('task_acceptance', {}),
    toolResultMessage('other_tool', 'noise'),
    toolUseMessage('other_tool', {}),
    toolResultMessage('use_task_acceptance', 'verdict text'),
    toolResultMessage('use_other_tool', 'noise2'),
  ];
  assert.deepEqual(collectToolResultsByName(messages, 'task_acceptance'), ['verdict text']);
});

test('E2E: gate forces an acceptance run before the agent may finish', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-gate-e2e-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('gate-e2e', 'Gate E2E', [
      {
        toolCalls: [
          {
            name: 'task_define',
            input: {
              goal: 'demo closed loop',
              acceptance_criteria: [{ metric: 'checks_done', expected: '>=1' }],
            },
          },
        ],
      },
      { text: 'Task complete, everything works.' },
      { toolCalls: [{ name: 'task_acceptance', input: {} }] },
      { text: 'Honest report: acceptance FAILED — no evidence recorded for checks_done.' },
      { text: 'Reporting the recorded FAIL. The task is not done.' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'gate-e2e',
    workspaceDir: workspace,
    baseSystemPrompt: 'Follow the task contract discipline.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 10,
  });
  registerBuiltinTools(agent);

  const result = await agent.chat('gate-e2e-run', 'Do the task.');
  const text = typeof result === 'string' ? result : result?.response;
  assert.match(text, /not done/);
  assert.match(text, /FAIL/);

  // The blocked "Task complete" claim never became the final answer.
  assert.ok(!/everything works/.test(text));

  const acceptance = await fs.readFile(path.join(workspace, '.moss', 'acceptance.jsonl'), 'utf8');
  const verdicts = acceptance
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].verdict, 'fail');

  const tasks = (await fs.readFile(path.join(workspace, '.moss', 'tasks.jsonl'), 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  assert.equal(tasks[tasks.length - 1].status, 'failed', 'task status flipped to failed');
});

test('E2E: without a task contract the gate never interferes', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-gate-e2e-open-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('gate-open', 'Gate Open', [
      { text: 'Answer delivered without any task contract.' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'gate-open',
    workspaceDir: workspace,
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 4,
  });
  registerBuiltinTools(agent);

  const result = await agent.chat('gate-open-run', 'Just answer.');
  const text = typeof result === 'string' ? result : result?.response;
  assert.match(text, /without any task contract/);
});
