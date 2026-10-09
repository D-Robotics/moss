#!/usr/bin/env node
/**
 * Headless `moss -p` is runOneShot without taskFlow. Bench prompts must still
 * be able to call task_define and record_evidence. Interactive chat sets
 * taskFlow separately and is covered by task-contract.spec.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runOneShot } from '../dist/cli/oneshot.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { listEvidenceRecords, listTaskRecords } from '../dist/core/task-runtime/artifacts.js';
import { recordEvidenceTool } from '../dist/tools/evidence-tools.js';
import { taskDefineTool } from '../dist/tools/task-tools.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-oneshot-task-flow-'));
const toolEnds = [];

const agent = new MossAgent({
  llmProvider: createMockTranscriptProvider('headless-task', 'Headless', [
    {
      toolCalls: [
        {
          name: 'task_define',
          input: {
            goal: 'board probe',
            acceptance_criteria: [{ metric: 'up', expected: '==true' }],
          },
        },
        {
          name: 'record_evidence',
          input: {
            metric: 'up',
            source: 'probe',
            observed: 'true',
            result: 'pass',
          },
        },
      ],
    },
    { text: 'Board probe recorded.' },
    { text: 'Evidence is on file. Acceptance was not claimed.' },
  ]),
  sessionStore: new InMemorySessionStore(),
  model: 'headless-task',
  workspaceDir: ws,
  baseSystemPrompt: 'Use the task tools when asked.',
  domainPrompt: false,
  includeAgentBehaviorPrompt: false,
  enableSteering: false,
  maxAgentTurns: 6,
});
agent.tools.register(taskDefineTool);
agent.tools.register(recordEvidenceTool);

await runOneShot(
  agent,
  'Create a task contract for the board probe and record the measured evidence.',
  {
    sessionKey: 'headless-p-task-contracts',
    outputFormat: 'json',
    headless: true,
    cwd: ws,
    stdout: { write() {} },
    onAgentEvent(event) {
      if (event.type === 'tool_end') toolEnds.push(event);
    },
  }
);

const defined = toolEnds.find((event) => event.toolName === 'task_define');
const recorded = toolEnds.find((event) => event.toolName === 'record_evidence');
assert.ok(defined, 'headless moss -p invoked task_define');
assert.ok(recorded, 'headless moss -p invoked record_evidence');
assert.doesNotMatch(defined.result, /only created for \/goal/);
assert.doesNotMatch(recorded.result, /do not record evidence/);
assert.match(defined.result, /Task contract task_/);

const tasks = await listTaskRecords(ws);
assert.equal(tasks.length, 1);
assert.equal(tasks[0].goal, 'board probe');
const evidence = await listEvidenceRecords(ws);
assert.equal(evidence.length, 1);
assert.equal(evidence[0].metric, 'up');
assert.equal(evidence[0].result, 'pass');

console.log('[PASS] headless moss -p task contracts');
