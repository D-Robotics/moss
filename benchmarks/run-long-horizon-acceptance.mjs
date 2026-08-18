#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CompletionArbiter,
  ExecutionGraphScheduler,
  JsonlExecutionStore,
  InMemoryExecutionStore,
} from '../packages/moss-agent/dist/orchestration/index.js';

const results = [];

async function longTaskCase(index) {
  const startedAt = Date.now();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `moss-long-task-${index}-`));
  try {
    let store = new JsonlExecutionStore({ rootDir: path.join(temp, 'executions') });
    store.create({
      id: `long-task-${index}`,
      goal: `Durable long task ${index}`,
      nodes: [
        { id: 'analyse', kind: 'analysis', title: 'analyse', dependencies: [] },
        { id: 'implement', kind: 'analysis', title: 'implement', dependencies: ['analyse'] },
        { id: 'verify', kind: 'analysis', title: 'verify', dependencies: ['implement'] },
      ],
    });
    let graph = store.load(`long-task-${index}`);
    store.append(graph.id, { expectedRevision: graph.revision, type: 'graph.resumed' });
    let executions = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      const scheduler = new ExecutionGraphScheduler(store);
      await scheduler.runAvailable(`long-task-${index}`, async (node) => {
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
      // Reopen the durable adapter between every cycle to exercise process-restart reads and CAS.
      store = new JsonlExecutionStore({ rootDir: path.join(temp, 'executions') });
    }
    const decision = await new CompletionArbiter(store).decide(`long-task-${index}`, {
      taskKind: 'analysis',
    });
    graph = store.load(`long-task-${index}`);
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
      durationMs: Date.now() - startedAt,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function concurrencyCase(index) {
  const startedAt = Date.now();
  const store = new InMemoryExecutionStore();
  const id = `concurrency-${index}`;
  store.create({
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
  let graph = store.load(id);
  store.append(id, { expectedRevision: graph.revision, type: 'graph.resumed' });
  let active = 0;
  let maxActive = 0;
  const result = await new ExecutionGraphScheduler(store).runAvailable(id, async (node) => {
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
    durationMs: Date.now() - startedAt,
  });
}

for (let index = 1; index <= 10; index++) await longTaskCase(index);
for (let index = 1; index <= 10; index++) await concurrencyCase(index);

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
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
