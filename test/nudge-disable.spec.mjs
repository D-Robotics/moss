#!/usr/bin/env node
/**
 * MOSS_DISABLE_NUDGES: each stable id suppresses only its injection.
 * Unset / empty leaves every nudge on. The frozen shell-soft-failure
 * appendix is not in the registry and still appends when named.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NUDGE_IDS,
  isKnownNudgeId,
  parseDisabledNudgeIds,
} from '../dist/core/loop/nudges/disable.js';
import { collectNudgeInjections } from '../dist/core/loop/nudges/registry.js';
import { createInitialLoopState } from '../dist/core/loop/agent-loop-state.js';
import { decidePostLlmAction } from '../dist/core/loop/agent-loop-post-llm.js';
import { SteeringEngine } from '../dist/core/loop/steering.js';
import {
  buildBackgroundCompletionSystemText,
  clearBackgroundCompletionReminderForTests,
} from '../dist/core/loop/background-completion.js';
import { enqueueBackgroundCompletion } from '../dist/core/tools/background-completion-state.js';
import { evaluateAcceptanceCompletionGate } from '../dist/core/loop/acceptance-completion-gate.js';
import { correctionTextForTurnError } from '../dist/core/loop/agent-loop.js';
import { gateFollowUpInjections } from '../dist/core/loop/follow-up-guard.js';
import { appendShellContinueHint } from '../dist/safety/shell-soft-failure-hint.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REGISTRY = [
  { id: 'todo', needle: 'have not used `todo_write`', counter: 'todoNudgeAttempts' },
  { id: 'verify', needle: 'without running verification', counter: 'verifyNudgeAttempts' },
  { id: 'red-verify', needle: 'verification result is RED', counter: 'redVerifyNudgeAttempts' },
  { id: 'fan-out', needle: 'FAILED or empty children', counter: 'fanOutNudgeAttempts' },
  { id: 'ambiguity', needle: 'multi-interpretation', counter: 'ambiguityNudgeAttempts' },
  {
    id: 'subagent-running',
    needle: 'still STARTED',
    counter: 'subagentRunningNudgeAttempts',
  },
  {
    id: 'subagent-stopped',
    needle: 'stopped a background sub-agent',
    counter: 'subagentStoppedNudgeAttempts',
  },
  {
    id: 'web-tools',
    needle: 'no `web_search` / `web_fetch` has run',
    counter: 'webToolsNudgeAttempts',
  },
  { id: 'git-tools', needle: 'git/gh VCS action', counter: 'gitToolsNudgeAttempts' },
  {
    id: 'install-tools',
    needle: 'asked to install dependencies',
    counter: 'installToolsNudgeAttempts',
  },
  { id: 'run-tests', needle: 'asked to run tests', counter: 'runTestsToolsNudgeAttempts' },
  { id: 'build-tools', needle: 'asked to build/compile', counter: 'buildToolsNudgeAttempts' },
  {
    id: 'background-server',
    needle: 'long-running server/watcher',
    counter: 'backgroundServerNudgeAttempts',
  },
  { id: 'task-repair', needle: 'enter the repair loop now', counter: 'taskRepairNudgeAttempts' },
];

const USER =
  'fix the login bug either by rewriting the parser or by patching the caller. ' +
  'Please npm install the dependencies, git commit and push, run the tests, npm run build, ' +
  'start the server, and search the web for https://example.com/docs.';

function toolUse(id, name, input = {}) {
  return { type: 'tool_use', id, name, input };
}

function toolResult(id, name, text) {
  return { type: 'tool_result', tool_use_id: id, name, content: text };
}

const messages = [
  {
    role: 'assistant',
    content: [
      toolUse('e1', 'exec', { command: 'pwd' }),
      toolUse('r1', 'run_tests', {}),
      toolUse('f1', 'fan_out_subagents', {}),
      toolUse('c1', 'create_subagent', {}),
      toolUse('s1', 'subagent_stop', {}),
      toolUse('a1', 'task_acceptance', {}),
    ],
  },
  {
    role: 'user',
    content: [
      toolResult('e1', 'exec', 'ok'),
      toolResult('r1', 'run_tests', 'Result: FAIL\n1 failed'),
      toolResult('f1', 'fan_out_subagents', '1 ok, 1 failed'),
      toolResult('c1', 'create_subagent', '[Sub-agent task child-1] STARTED'),
      toolResult('s1', 'subagent_stop', '[Sub-agent task child-2] STOPPED'),
      toolResult('a1', 'task_acceptance', 'Task acceptance (task-1): FAIL\nmetric missed'),
    ],
  },
];

function freshState() {
  const state = createInitialLoopState();
  state.turns = 4;
  state.toolExecutionMetrics.totalToolCalls = 5;
  state.toolExecutionMetrics.toolCallsByName = {
    edit_file: 2,
    read_file: 2,
    subagent_stop: 1,
  };
  return state;
}

function collect(state) {
  return collectNudgeInjections({
    state,
    currentMessages: messages,
    lastUserText: () => USER,
    buildCorrectionMessage: (systemText) => ({
      role: 'user',
      content: [{ type: 'text', text: systemText }],
      timestamp: 1,
    }),
  });
}

function textsOf(injected) {
  return injected.map((message) => message.content[0].text);
}

function matchedIds(texts) {
  const hits = [];
  for (const text of texts) {
    const ids = REGISTRY.filter((row) => text.includes(row.needle)).map((row) => row.id);
    assert.equal(
      ids.length,
      1,
      `expected exactly one registry id, got [${ids.join(', ')}] in: ${text.slice(0, 160)}`
    );
    hits.push(ids[0]);
  }
  return hits;
}

function withDisabled(raw, fn) {
  const prev = process.env.MOSS_DISABLE_NUDGES;
  if (raw === undefined) delete process.env.MOSS_DISABLE_NUDGES;
  else process.env.MOSS_DISABLE_NUDGES = raw;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MOSS_DISABLE_NUDGES;
    else process.env.MOSS_DISABLE_NUDGES = prev;
  }
}

function assertSameMembers(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
}

{
  assert.equal(parseDisabledNudgeIds(undefined).size, 0);
  assert.equal(parseDisabledNudgeIds('').size, 0);
  assert.equal(parseDisabledNudgeIds('   ').size, 0);
  assert.deepEqual([...parseDisabledNudgeIds('todo, verify ,,todo')].sort(), ['todo', 'verify']);
  assert.equal(isKnownNudgeId('todo'), true);
  assert.equal(isKnownNudgeId('shell-soft-failure'), false);
  assert.equal(NUDGE_IDS.includes('shell-soft-failure'), false);
  const disableSrc = fs.readFileSync(path.join(root, 'src/core/loop/nudges/disable.ts'), 'utf8');
  assert.equal(disableSrc.includes('/proc'), false);
  assert.equal(disableSrc.includes('cmdline'), false);
  assert.equal(disableSrc.includes('ppid'), false);
}

const allRegistryIds = REGISTRY.map((row) => row.id);

{
  const hits = matchedIds(textsOf(collect(freshState())));
  assertSameMembers(hits, allRegistryIds, 'unset env fires every registry nudge');
}

withDisabled('', () => {
  const hits = matchedIds(textsOf(collect(freshState())));
  assertSameMembers(hits, allRegistryIds, 'empty env fires every registry nudge');
});

withDisabled('   ', () => {
  const hits = matchedIds(textsOf(collect(freshState())));
  assertSameMembers(hits, allRegistryIds, 'whitespace env fires every registry nudge');
});

withDisabled('not-a-nudge', () => {
  const hits = matchedIds(textsOf(collect(freshState())));
  assertSameMembers(hits, allRegistryIds, 'unknown id does not disable a known nudge');
});

withDisabled('Todo', () => {
  const hits = matchedIds(textsOf(collect(freshState())));
  assertSameMembers(hits, allRegistryIds, 'ids are case-sensitive');
});

for (const target of REGISTRY) {
  withDisabled(target.id, () => {
    const state = freshState();
    const hits = matchedIds(textsOf(collect(state)));
    assert.equal(hits.includes(target.id), false, `${target.id} still fired`);
    assert.equal(state[target.counter], 0, `${target.id} counter advanced while disabled`);
    for (const other of REGISTRY) {
      if (other.id === target.id) continue;
      assert.equal(
        hits.includes(other.id),
        true,
        `disabling ${target.id} also dropped ${other.id}`
      );
      assert.equal(state[other.counter], 1, `${other.id} counter did not advance`);
    }
  });
}

withDisabled('todo, verify', () => {
  const hits = matchedIds(textsOf(collect(freshState())));
  assert.equal(hits.includes('todo'), false);
  assert.equal(hits.includes('verify'), false);
  assert.equal(hits.includes('red-verify'), true);
  assert.equal(hits.includes('task-repair'), true);
});

function postLlm(overrides) {
  return decidePostLlmAction({
    hasThinkingOnly: false,
    toolCallCount: 0,
    postToolThinkingOnlyRetryAttempts: 0,
    emptyResponseRetryAttempts: 0,
    totalToolCalls: 1,
    streamStopReason: 'end_turn',
    outputContinuationCount: 0,
    maxOutputContinuations: 2,
    missingToolNudgeAttempts: 0,
    finalText: 'visible answer',
    maxTurns: 80,
    turns: 4,
    shouldNudge: false,
    abortAborted: false,
    ...overrides,
  });
}

{
  const thinking = { hasThinkingOnly: true, toolCallCount: 0, finalText: '', totalToolCalls: 2 };
  assert.equal(postLlm(thinking).kind, 'thinking_retry');
  withDisabled('reasoning-only', () => {
    assert.equal(postLlm(thinking).kind, 'thinking_only_complete');
  });
  withDisabled('missing-tool-call', () => {
    assert.equal(postLlm(thinking).kind, 'thinking_retry');
  });

  const truncated = { streamStopReason: 'length', finalText: 'partial answer that was cut off' };
  assert.equal(postLlm(truncated).kind, 'continuation');
  withDisabled('output-continuation', () => {
    assert.equal(postLlm(truncated).kind, 'steering_or_complete');
  });
  withDisabled('reasoning-only', () => {
    assert.equal(postLlm(truncated).kind, 'continuation');
  });

  const missing = {
    shouldNudge: true,
    finalText: 'I will open https://example.com with web_fetch',
  };
  assert.equal(postLlm(missing).kind, 'nudge');
  withDisabled('missing-tool-call', () => {
    assert.equal(postLlm(missing).kind, 'steering_or_complete');
  });
  withDisabled('empty-response', () => {
    assert.equal(postLlm(missing).kind, 'nudge');
  });

  const empty = { finalText: '   ' };
  assert.equal(postLlm(empty).kind, 'empty_retry');
  withDisabled('empty-response', () => {
    assert.equal(postLlm(empty).kind, 'empty_complete');
  });
  withDisabled('missing-tool-call', () => {
    assert.equal(postLlm(empty).kind, 'empty_retry');
  });
}

function steeringMessages() {
  const messages = [];
  for (let i = 0; i < 4; i++) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `e${i}`, name: 'exec', input: { command: 'pwd' } }],
    });
  }
  for (const query of ['alpha', 'beta', 'gamma']) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `w-${query}`, name: 'web_search', input: { query } }],
    });
  }
  for (let i = 0; i < 3; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `l${i}`, name: 'list_directory', input: { path: '/tmp/same' } },
      ],
    });
  }
  return messages;
}

const steeringCtx = {
  messages: steeringMessages(),
  turn: 8,
  consecutiveToolErrors: 3,
  totalToolCalls: 12,
  contextUsageRatio: 0.8,
  sessionKey: 'nudge-disable',
};

const steeringRuleIds = [
  'error-recovery',
  'local-exploration-loop',
  'web-search-variation',
  'tool-loop',
  'context-pressure',
];

{
  const fired = new SteeringEngine().evaluate(steeringCtx).firedRules;
  assertSameMembers(fired, steeringRuleIds, 'all five steering rules fire together');
}

for (const ruleId of steeringRuleIds) {
  withDisabled(`steering-${ruleId}`, () => {
    const fired = new SteeringEngine().evaluate(steeringCtx).firedRules;
    assert.equal(fired.includes(ruleId), false, `${ruleId} still fired`);
    for (const other of steeringRuleIds) {
      if (other === ruleId) continue;
      assert.equal(
        fired.includes(other),
        true,
        `disabling steering-${ruleId} also dropped ${other}`
      );
    }
  });
}

withDisabled('todo', () => {
  const fired = new SteeringEngine().evaluate(steeringCtx).firedRules;
  assertSameMembers(fired, steeringRuleIds, 'a registry id does not disable steering');
});

function snap(id) {
  return {
    id,
    command: 'npm test',
    status: 'exited',
    exitCode: 0,
    signal: null,
    startedAt: 1,
    endedAt: 2,
  };
}

clearBackgroundCompletionReminderForTests();
enqueueBackgroundCompletion(snap('bg_drop'));
withDisabled('background-completion', () => {
  assert.equal(buildBackgroundCompletionSystemText(), null);
});
enqueueBackgroundCompletion(snap('bg_keep'));
assert.match(buildBackgroundCompletionSystemText() ?? '', /bg_keep/);
withDisabled('todo', () => {
  enqueueBackgroundCompletion(snap('bg_todo'));
  assert.match(buildBackgroundCompletionSystemText() ?? '', /bg_todo/);
});
clearBackgroundCompletionReminderForTests();

const gateRequest = { messages: [], toolCallsByName: { task_define: 1 } };
assert.equal(evaluateAcceptanceCompletionGate(gateRequest).ok, false);
withDisabled('acceptance-gate', () => {
  assert.equal(evaluateAcceptanceCompletionGate(gateRequest).ok, true);
});
withDisabled('task-repair', () => {
  assert.equal(evaluateAcceptanceCompletionGate(gateRequest).ok, false);
});

const truncated = new Error('Unterminated string in JSON');
assert.match(correctionTextForTurnError(truncated), /smaller pieces/);
withDisabled('truncated-tool-json', () => {
  const text = correctionTextForTurnError(truncated);
  assert.match(text, /internal error/);
  assert.doesNotMatch(text, /smaller pieces/);
});

const followUps = [{ guidance: 'use the exec tool' }];
assert.equal(gateFollowUpInjections(followUps).length, 1);
withDisabled('follow-up-guard', () => {
  assert.deepEqual(gateFollowUpInjections(followUps), []);
});
withDisabled('missing-tool-call', () => {
  assert.equal(gateFollowUpInjections(followUps).length, 1);
});

withDisabled('shell-soft-failure', () => {
  const hinted = appendShellContinueHint('exec', 'failed\n[EXIT CODE] 1');
  assert.match(hinted, /编排提示 · 须继续/);
});

function benchChildSaw(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-forward-'));
  const marker = path.join(dir, 'seen.txt');
  const stub = path.join(dir, 'cli.js');
  const label = `nudge-forward-${process.pid}-${Date.now()}`;
  const runDir = path.join(root, 'bench', 'results', label);
  fs.writeFileSync(
    stub,
    [
      "import fs from 'node:fs';",
      'const env = process.env;',
      'const disable = Object.prototype.hasOwnProperty.call(env, "MOSS_DISABLE_NUDGES")',
      '  ? env.MOSS_DISABLE_NUDGES',
      '  : "<unset>";',
      'const sentinel = Object.prototype.hasOwnProperty.call(env, "MOSS_NUDGE_FORWARD_SENTINEL")',
      '  ? env.MOSS_NUDGE_FORWARD_SENTINEL',
      '  : "<unset>";',
      `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ disable, sentinel }));`,
      'process.exit(0);',
      '',
    ].join('\n')
  );
  const env = { ...process.env };
  if (raw === undefined) delete env.MOSS_DISABLE_NUDGES;
  else env.MOSS_DISABLE_NUDGES = raw;
  env.MOSS_NUDGE_FORWARD_SENTINEL = 'leak';
  env.MOSS_BENCH_CLI = stub;
  env.MOSS_BENCH_API_KEY = 'nudge-forward-test';
  delete env.MOSS_GOAL_VERIFY_LOOP;
  delete env.MOSS_BENCH_WITH_SKILLS;
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts/run-benchmark.mjs'),
        '--task',
        'single-edit',
        '--samples',
        '1',
        '--label',
        label,
        '--model',
        'nudge-forward',
        '--base-url',
        'http://127.0.0.1:9',
      ],
      { cwd: root, env, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(marker), true, 'bench runner did not spawn the child');
    return JSON.parse(fs.readFileSync(marker, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

{
  const forwarded = benchChildSaw('todo,verify');
  assert.equal(forwarded.disable, 'todo,verify');
  assert.equal(forwarded.sentinel, '<unset>', 'bench child env is an allowlist');
  const empty = benchChildSaw('');
  assert.equal(empty.disable, '');
  assert.equal(empty.sentinel, '<unset>');
  const absent = benchChildSaw(undefined);
  assert.equal(absent.disable, '<unset>');
  assert.equal(absent.sentinel, '<unset>');
}

const covered = new Set([
  ...allRegistryIds,
  'reasoning-only',
  'output-continuation',
  'missing-tool-call',
  'empty-response',
  ...steeringRuleIds.map((id) => `steering-${id}`),
  'background-completion',
  'acceptance-gate',
  'follow-up-guard',
  'truncated-tool-json',
]);
assert.deepEqual([...covered].sort(), [...NUDGE_IDS].sort());

console.log('[PASS] nudge-disable: each id suppresses only its nudge');
