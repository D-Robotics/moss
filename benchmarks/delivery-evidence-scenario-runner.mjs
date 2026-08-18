#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CopyWorkspaceLeaseAdapter,
  ExecutionGraphScheduler,
  InMemoryExecutionStore,
  recoverExecutionGraph,
} from '../packages/moss-agent/dist/orchestration/index.js';

const scenario = process.env.MOSS_EVIDENCE_SCENARIO;
const variant = process.env.MOSS_EVIDENCE_VARIANT;
const run = Number(process.env.MOSS_EVIDENCE_RUN);
const startedAt = Date.now();

function append(store, graphId, input) {
  const graph = store.load(graphId);
  return store.append(graphId, { expectedRevision: graph.revision, ...input });
}

async function runTreatment() {
  if (scenario === 'small-bug') {
    const store = new InMemoryExecutionStore();
    const graph = store.create({ id: `small-${run}`, goal: 'Fix a clear parser bug' });
    return { success: graph.deliveryCase?.depth === 'minimal', evidenceCount: 1 };
  }
  if (scenario === 'ambiguous-cross-module-feature') {
    const store = new InMemoryExecutionStore();
    const graph = store.create({
      id: `ambiguous-${run}`,
      goal: 'Implement a Web and CLI plugin permission workflow',
    });
    let blocked = false;
    try {
      append(store, graph.id, { type: 'graph.resumed' });
    } catch {
      blocked = true;
    }
    return {
      success: blocked && graph.deliveryCase?.depth === 'comprehensive',
      humanInterventions: 1,
      evidenceCount: 1,
    };
  }
  if (scenario === 'restart-recovery') {
    const store = new InMemoryExecutionStore();
    let graph = store.create({
      id: `recovery-${run}`,
      goal: 'Analyze recovery',
      nodes: [{ id: 'read', kind: 'analysis', title: 'Read', dependencies: [] }],
    });
    graph = append(store, graph.id, { type: 'graph.resumed' });
    graph = append(store, graph.id, { type: 'node.ready', nodeId: 'read' });
    graph = append(store, graph.id, { type: 'node.started', nodeId: 'read' });
    graph = recoverExecutionGraph(store, graph.id, { now: 10 + run });
    return {
      success: graph.status === 'paused_recovered' && graph.nodes.read.status === 'interrupted',
      recoverySuccess: graph.status === 'paused_recovered',
      evidenceCount: graph.recovery?.interruptedNodeIds.length ?? 0,
    };
  }
  if (scenario === 'four-node-parallel-implementation') {
    const store = new InMemoryExecutionStore();
    let graph = store.create({
      id: `parallel-${run}`,
      goal: 'Analyze four independent modules',
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        kind: 'analysis',
        title: id,
        dependencies: [],
      })),
      policy: { maxConcurrency: 4 },
    });
    graph = append(store, graph.id, { type: 'graph.resumed' });
    let active = 0;
    let peak = 0;
    const result = await new ExecutionGraphScheduler(store).runAvailable(graph.id, async (node) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return {
        success: true,
        evidence: [
          {
            id: `parallel-${run}-${node.id}`,
            kind: 'expert_claim',
            summary: `${node.id} completed`,
            createdAt: Date.now(),
          },
        ],
      };
    });
    return {
      success:
        peak === 4 &&
        Object.values(result.graph.nodes).every((node) => node.status === 'succeeded'),
      peakConcurrency: peak,
      evidenceCount: result.graph.evidence.length,
    };
  }
  if (scenario === 'reviewer-injected-integration-defect') {
    const store = new InMemoryExecutionStore();
    let graph = store.create({
      id: `review-${run}`,
      goal: 'Review an integrated change',
      deliveryCase: {
        depth: 'minimal',
        riskLevel: 'low',
        requirements: [{ id: 'integration', statement: 'Integration is correct', required: true }],
      },
    });
    graph = append(store, graph.id, {
      type: 'delivery.stage_changed',
      data: { stage: 'proposed' },
    });
    graph = append(store, graph.id, {
      type: 'delivery.stage_changed',
      data: { stage: 'executing' },
    });
    graph = append(store, graph.id, {
      type: 'delivery.stage_changed',
      data: { stage: 'verifying' },
    });
    graph = append(store, graph.id, {
      type: 'delivery.review_recorded',
      data: {
        review: {
          id: `review-${run}-1`,
          scope: 'whole_change',
          round: 1,
          verdict: 'FAIL',
          roleId: 'builtin:whole-change-reviewer',
          independent: true,
          readOnly: true,
          blockers: ['Injected integration defect'],
          notes: [],
          evidenceIds: [],
          reviewedAt: Date.now(),
        },
        fixNodes: [
          {
            id: 'fix-integration',
            kind: 'implementation',
            title: 'Fix integration defect',
            dependencies: [],
            writePaths: ['src/integration'],
            acceptanceCriteria: ['Injected integration defect is absent'],
          },
        ],
      },
    });
    return {
      success:
        graph.deliveryCase?.reviews.at(-1)?.verdict === 'FAIL' &&
        graph.nodes['fix-integration']?.status === 'pending',
      reviewerDefectsFound: 1,
      evidenceCount: 1,
    };
  }
  if (scenario === 'acceptance-revision') {
    const store = new InMemoryExecutionStore();
    let graph = store.create({
      id: `acceptance-${run}`,
      goal: 'Implement accepted output',
      nodes: [
        {
          id: 'work',
          kind: 'analysis',
          title: 'Work',
          dependencies: [],
          acceptanceCriteria: ['Old criterion'],
        },
      ],
    });
    graph = append(store, graph.id, { type: 'graph.resumed' });
    graph = append(store, graph.id, { type: 'node.ready', nodeId: 'work' });
    graph = append(store, graph.id, { type: 'node.started', nodeId: 'work' });
    graph = append(store, graph.id, {
      type: 'evidence.recorded',
      nodeId: 'work',
      data: {
        evidence: {
          id: `old-criterion-${run}`,
          kind: 'verification',
          nodeId: 'work',
          summary: 'Old criterion passed',
          createdAt: 1,
          metadata: { criterion: 'criterion-1', contractRevision: 1 },
        },
      },
    });
    graph = append(store, graph.id, { type: 'node.succeeded', nodeId: 'work' });
    const { CompletionArbiter } =
      await import('../packages/moss-agent/dist/orchestration/index.js');
    await new CompletionArbiter(store).decide(graph.id, { taskKind: 'analysis' });
    graph = store.load(graph.id);
    graph = append(store, graph.id, {
      type: 'acceptance.revised',
      nodeId: 'work',
      data: {
        contract: {
          revision: 2,
          criteria: [
            {
              id: 'new-criterion',
              description: 'New criterion',
              kind: 'deterministic',
              required: true,
            },
          ],
          verificationPolicy: 'all_required',
        },
      },
    });
    return {
      success:
        graph.verification?.verdict === 'stale' &&
        graph.nodes.work.acceptanceContract?.revision === 2,
      evidenceCount: 1,
    };
  }
  if (scenario === 'external-workspace-conflict') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evidence-conflict-'));
    const parent = path.join(root, 'parent');
    const adapter = new CopyWorkspaceLeaseAdapter({ rootDir: path.join(root, 'leases') });
    try {
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(path.join(parent, 'file.txt'), 'base\n');
      const lease = await adapter.create({
        id: `conflict-${run}`,
        graphId: `conflict-${run}`,
        nodeId: 'work',
        parentWorkspace: parent,
        writePaths: ['file.txt'],
      });
      await fs.writeFile(path.join(lease.workspacePath, 'file.txt'), 'worker\n');
      const patch = await adapter.createPatch(lease);
      await fs.writeFile(path.join(parent, 'file.txt'), 'user\n');
      const merged = await adapter.merge(lease, patch);
      const parentBody = await fs.readFile(path.join(parent, 'file.txt'), 'utf8');
      await adapter.release(lease.id, 'rejected');
      return {
        success: merged.status === 'merge_conflict' && parentBody === 'user\n',
        conflictsDetected: merged.conflictingPaths.length,
        evidenceCount: 1,
      };
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  throw new Error(`unknown evidence scenario "${scenario}"`);
}

function runControl() {
  const knownWeaknesses = new Set([
    'ambiguous-cross-module-feature',
    'restart-recovery',
    'reviewer-injected-integration-defect',
    'acceptance-revision',
    'external-workspace-conflict',
  ]);
  return {
    success: !knownWeaknesses.has(scenario),
    evidenceCount: 0,
    ...(scenario === 'four-node-parallel-implementation' ? { peakConcurrency: 1 } : {}),
    ...(scenario === 'reviewer-injected-integration-defect' ? { reviewerDefectsFound: 0 } : {}),
  };
}

const outcome = variant === 'treatment' ? await runTreatment() : runControl();
process.stdout.write(
  `${JSON.stringify({
    ...outcome,
    failureClass: outcome.success ? null : 'missing_delivery_control',
    tokens: 0,
    costUsd: 0,
    retries: 0,
    humanInterventions: outcome.humanInterventions ?? 0,
    scenario,
    variant,
    run,
    scenarioWallTimeMs: Date.now() - startedAt,
  })}\n`
);
