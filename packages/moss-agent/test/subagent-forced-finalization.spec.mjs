#!/usr/bin/env node
import assert from 'node:assert/strict';

import { createSubAgentRunner } from '../dist/core/subagent/subagent-runner.js';
import {
  ABSOLUTE_MAX_SUBAGENT_STARTS_PER_RUN,
  DEFAULT_MAX_SUBAGENT_STARTS_PER_RUN,
  expandSubagentStartBudget,
} from '../dist/core/subagent/spawn-budget.js';
import { createSpawnProfileRegistryFromDefaults } from '../dist/core/subagent/spawn-profile.js';

const modelDef = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

function responseStream(text) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text_end', content: text };
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: text ? [{ type: 'text', text }] : [],
          stopReason: 'end_turn',
        },
      };
    },
    async result() {
      return {
        role: 'assistant',
        content: text ? [{ type: 'text', text }] : [],
        stopReason: 'end_turn',
        usage: { input: 1, output: text ? 4 : 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
    push() {},
    end() {},
  };
}

{
  let calls = 0;
  const toolCounts = [];
  const phases = [];
  const runner = createSubAgentRunner({
    parentTools: [],
    streamFn: (_model, context, options) => {
      calls += 1;
      toolCounts.push(options?.tools?.length ?? context?.tools?.length ?? 0);
      const text = calls === 1 ? '' : 'Partial but evidence-backed summary.';
      return responseStream(text);
    },
    modelDef,
    systemPrompt: 'You are a test subagent.',
    maxOutputTokens: 512,
    contextTokens: 32_000,
    spawnRegistry: createSpawnProfileRegistryFromDefaults(),
    workspaceDir: process.cwd(),
  });

  const result = await runner(
    {
      runId: 'sub-finalize-1',
      parentRunId: 'parent-1',
      scope: 'explore',
      task: 'Investigate and summarize',
      maxTurns: 1,
      onProgress: (progress) => phases.push(progress.phase),
    },
    new AbortController().signal,
  );

  assert.equal(calls, 2, 'empty bounded child gets exactly one synthesis request');
  assert.equal(result.success, true);
  assert.equal(result.summary, 'Partial but evidence-backed summary.');
  assert.equal(toolCounts.at(-1), 0, 'forced synthesis exposes no tools');
  assert.ok(phases.includes('finalizing'), 'parent UI receives a finalizing phase');
}

{
  let calls = 0;
  const runner = createSubAgentRunner({
    parentTools: [],
    streamFn: () => {
      calls += 1;
      return responseStream(
        calls === 1
          ? 'VERDICT: PASS'
          : [
              'CHECKS:',
              '- npm test: exit code 0',
              'EVIDENCE:',
              '- [tool:exec] 2 passed',
              'GAPS:',
              '- none',
              'VERDICT: PASS',
            ].join('\n'),
      );
    },
    modelDef,
    systemPrompt: 'You are a test subagent.',
    maxOutputTokens: 512,
    contextTokens: 32_000,
    spawnRegistry: createSpawnProfileRegistryFromDefaults(),
    workspaceDir: process.cwd(),
  });

  const result = await runner(
    {
      runId: 'sub-finalize-contract-repair',
      parentRunId: 'parent-1',
      scope: 'verify',
      task: [
        'SUBTASK_CONTRACT v1',
        'output:',
        'CHECKS:',
        'EVIDENCE:',
        'GAPS:',
        'VERDICT: PASS|FAIL|PARTIAL',
      ].join('\n'),
      maxTurns: 1,
    },
    new AbortController().signal,
  );

  assert.equal(calls, 2, 'schema-incomplete final text gets one tool-free repair');
  assert.equal(result.success, true);
  assert.match(result.summary, /CHECKS:/);
  assert.match(result.summary, /EVIDENCE:/);
  assert.match(result.summary, /VERDICT: PASS/);
}

{
  let calls = 0;
  const runner = createSubAgentRunner({
    parentTools: [],
    streamFn: () => {
      calls += 1;
      return responseStream('');
    },
    modelDef,
    systemPrompt: 'You are a test subagent.',
    maxOutputTokens: 512,
    contextTokens: 32_000,
    spawnRegistry: createSpawnProfileRegistryFromDefaults(),
    workspaceDir: process.cwd(),
  });

  const result = await runner(
    {
      runId: 'sub-finalize-empty',
      parentRunId: 'parent-1',
      scope: 'explore',
      task: 'Investigate and summarize',
      maxTurns: 1,
    },
    new AbortController().signal,
  );

  assert.equal(calls, 2, 'persistent empty output stops after one forced synthesis');
  assert.equal(result.success, false);
  assert.match(result.summary, /completed without a final response/);
}

{
  assert.equal(
    expandSubagentStartBudget(DEFAULT_MAX_SUBAGENT_STARTS_PER_RUN, 'single', 8),
    8,
    'single-agent calls retain the default global cost cap',
  );
  assert.equal(
    expandSubagentStartBudget(DEFAULT_MAX_SUBAGENT_STARTS_PER_RUN, 'fan-out', 6),
    12,
    'a six-agent fan-out has room for one bounded retry batch',
  );
  assert.equal(
    expandSubagentStartBudget(DEFAULT_MAX_SUBAGENT_STARTS_PER_RUN, 'fan-out', 8),
    ABSOLUTE_MAX_SUBAGENT_STARTS_PER_RUN,
    'fan-out retry capacity remains absolutely bounded',
  );
  assert.equal(
    expandSubagentStartBudget(12, 'fan-out', 2),
    12,
    'a smaller retry batch never shrinks an already granted budget',
  );
}

console.log('[PASS] subagent forced finalization + dynamic bounded spawn budget');
