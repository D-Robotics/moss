#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MossAgent } from '../packages/moss-agent/dist/index.js';
import { startMossWebServer } from '../packages/moss-agent/dist/web-ui/web-server.js';

const results = [];

function sessionStore() {
  return {
    loadMessages: async () => [],
    appendMessage: async () => {},
    replaceMessages: async () => {},
  };
}

function createAgent(workspaceDir) {
  return new MossAgent({ workspaceDir, sessionStore: sessionStore() });
}

async function longTaskCase(index) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `moss-long-task-${index}-`));
  try {
    let agent = createAgent(temp);
    agent.executionStore.create({
      id: `long-task-${index}`,
      goal: `Durable long task ${index}`,
      nodes: [
        { id: 'analyse', kind: 'analysis', title: 'analyse', dependencies: [] },
        { id: 'implement', kind: 'analysis', title: 'implement', dependencies: ['analyse'] },
        { id: 'verify', kind: 'analysis', title: 'verify', dependencies: ['implement'] },
      ],
    });
    let graph = agent.tasks.resume(`long-task-${index}`);
    let executions = 0;
    let decision;
    for (let cycle = 0; cycle < 3; cycle++) {
      const outcome = await agent.runExecutionGraph(`long-task-${index}`, async (node) => {
        executions += 1;
        return {
          success: true,
          evidence: [
            {
              id: `${index}-${node.id}`,
              kind: 'tool_result',
              nodeId: node.id,
              summary: `${node.id} machine result`,
              createdAt: Date.now(),
            },
          ],
        };
      });
      decision = outcome.completion ?? decision;
      await agent.close();
      if (cycle < 2) {
        agent = createAgent(temp);
        graph = agent.tasks.inspect(`long-task-${index}`);
        assert.equal(graph.status, 'paused_recovered');
        agent.tasks.resume(graph.id);
      }
    }
    const webAgent = createAgent(temp);
    const web = await startMossWebServer(webAgent, { port: 0 });
    const response = await fetch(
      `${web.url}/api/tasks/${encodeURIComponent(`long-task-${index}`)}`
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    graph = body.task;
    await web.close();
    await webAgent.close();
    assert.equal(executions, 3);
    assert.equal(decision.verdict, 'verified');
    assert.equal(graph.status, 'completed');
    results.push({
      suite: 'long_task_loop',
      caseId: `long_task_loop-${String(index).padStart(2, '0')}`,
      passed: true,
      graphId: graph.id,
      revision: graph.revision,
      verdict: decision.verdict,
      evidenceIds: decision.evidenceIds,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function concurrencyCase(index) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `moss-concurrency-${index}-`));
  const agent = createAgent(temp);
  const id = `concurrency-${index}`;
  agent.executionStore.create({
    id,
    goal: `Concurrent expert team ${index}`,
    policy: { maxConcurrency: 4 },
    nodes: Array.from({ length: 4 }, (_, nodeIndex) => ({
      id: `expert-${nodeIndex + 1}`,
      kind: 'analysis',
      title: `expert ${nodeIndex + 1}`,
      dependencies: [],
      requiredCapabilities: ['architecture'],
    })),
  });
  agent.tasks.resume(id);
  let active = 0;
  let maxActive = 0;
  const { schedule: result } = await agent.runExecutionGraph(id, async (node) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15 + index));
    active -= 1;
    return {
      success: true,
      evidence: [
        {
          id: `${id}-${node.id}`,
          kind: 'expert_claim',
          nodeId: node.id,
          summary: `${node.id} structured claim`,
          createdAt: Date.now(),
        },
      ],
    };
  });
  assert.equal(result.startedNodeIds.length, 4);
  assert.equal(maxActive, 4);
  assert.equal(
    Object.values(result.graph.nodes).every((node) => node.status === 'succeeded'),
    true
  );
  results.push({
    suite: 'subagents_concurrency',
    caseId: `subagents_concurrency-${String(index).padStart(2, '0')}`,
    passed: true,
    graphId: id,
    revision: result.graph.revision,
    actualMaxConcurrency: maxActive,
    startedNodeIds: result.startedNodeIds,
  });
  await agent.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

const cli = spawnSync(process.execPath, ['scripts/smoke-moss-cli.mjs'], {
  cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  encoding: 'utf8',
  timeout: 180_000,
});
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.match(cli.stdout, /\[smoke:moss-cli\] PASS/);

for (let index = 1; index <= 10; index++) await longTaskCase(index);
for (let index = 1; index <= 10; index++) await concurrencyCase(index);

const summary = {
  schemaVersion: 1,
  productPaths: { packagedCliSmoke: true, webTaskInspection: '10/10' },
  totals: {
    long_task_loop: results.filter((result) => result.suite === 'long_task_loop' && result.passed)
      .length,
    subagents_concurrency: results.filter(
      (result) => result.suite === 'subagents_concurrency' && result.passed
    ).length,
  },
  results,
};
assert.deepEqual(summary.totals, { long_task_loop: 10, subagents_concurrency: 10 });
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'long-horizon-results.json');
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`long_task_loop: ${summary.totals.long_task_loop}/10`);
console.log(`subagents_concurrency: ${summary.totals.subagents_concurrency}/10`);
console.log(`evidence: ${output}`);
