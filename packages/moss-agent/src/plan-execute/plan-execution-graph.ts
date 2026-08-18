import type { ExecutionNodeKind, ExecutionStore } from '../orchestration/index.js';
import type { Plan, PlanStep } from './plan-execute-controller.js';

function nodeId(step: number): string {
  return `step-${step}`;
}

function kind(step: PlanStep): ExecutionNodeKind {
  if (step.expectedTools?.some((tool) => /verify|test|diagnostic/i.test(tool))) {
    return 'verification';
  }
  if (
    step.writePaths?.length ||
    step.expectedTools?.some((tool) => /write|edit|patch|move|exec/i.test(tool))
  ) {
    return 'implementation';
  }
  return 'analysis';
}

/** Create the authoritative graph projection for a compatibility Plan. @internal */
export function createExecutionGraphForPlan(
  store: ExecutionStore,
  plan: Plan,
  sessionId?: string
): void {
  store.create({
    id: plan.id,
    goal: plan.goal,
    ...(sessionId ? { sessionId } : {}),
    nodes: plan.steps.map((step) => ({
      id: nodeId(step.step),
      kind: kind(step),
      title: step.description,
      dependencies: (step.dependsOn ?? []).map(nodeId),
      ...(step.writePaths?.length ? { writePaths: step.writePaths } : {}),
      ...(step.expectedOutput || step.expectedAccept?.length
        ? {
            acceptanceCriteria: step.expectedOutput
              ? [step.expectedOutput]
              : step.expectedAccept?.map((skill) => `Satisfy acceptance contract: ${skill}`),
          }
        : {}),
    })),
  });
}

/** Mirror legacy Plan mutations into graph events while compatibility is supported. @internal */
export function syncExecutionGraphFromPlan(store: ExecutionStore, plan: Plan): void {
  let graph = store.load(plan.id);
  if (!graph) {
    createExecutionGraphForPlan(store, plan);
    graph = store.load(plan.id);
  }
  if (!graph) return;
  if (plan.status === 'executing' && graph.status !== 'running') {
    graph = store.append(plan.id, {
      expectedRevision: graph.revision,
      type: 'graph.resumed',
    });
  }
  for (const step of plan.steps) {
    const id = nodeId(step.step);
    let node = graph.nodes[id];
    if (
      step.status === 'in_progress' &&
      ['pending', 'interrupted', 'failed', 'blocked'].includes(node.status)
    ) {
      graph = store.append(plan.id, {
        expectedRevision: graph.revision,
        type: 'node.ready',
        nodeId: id,
      });
      graph = store.append(plan.id, {
        expectedRevision: graph.revision,
        type: 'node.started',
        nodeId: id,
      });
      node = graph.nodes[id];
    }
    if (step.status === 'completed' && node.status === 'running') {
      if (step.actualOutput) {
        graph = store.append(plan.id, {
          expectedRevision: graph.revision,
          type: 'evidence.recorded',
          nodeId: id,
          data: {
            evidence: {
              id: `plan-output-${plan.id}-${step.step}-${graph.revision + 1}`,
              kind: 'expert_claim',
              nodeId: id,
              summary: step.actualOutput,
              createdAt: Date.now(),
            },
          },
        });
      }
      graph = store.append(plan.id, {
        expectedRevision: graph.revision,
        type: 'node.succeeded',
        nodeId: id,
      });
    } else if (step.status === 'failed' && node.status === 'running') {
      graph = store.append(plan.id, {
        expectedRevision: graph.revision,
        type: 'node.failed',
        nodeId: id,
        data: { error: step.error ?? 'plan step failed' },
      });
    } else if (step.status === 'skipped' && ['pending', 'ready', 'blocked'].includes(node.status)) {
      graph = store.append(plan.id, {
        expectedRevision: graph.revision,
        type: 'node.skipped',
        nodeId: id,
      });
    } else if (step.status === 'blocked' && !['blocked', 'cancelled'].includes(node.status)) {
      graph = store.append(plan.id, {
        expectedRevision: graph.revision,
        type: 'node.blocked',
        nodeId: id,
        data: { blockedByDependencies: step.dependsOn?.map(nodeId) ?? [] },
      });
    }
  }
  if (plan.status === 'completed' && !['completed', 'blocked'].includes(graph.status)) {
    store.append(plan.id, {
      expectedRevision: graph.revision,
      type: 'graph.blocked',
      data: { reason: 'needs_evidence', source: 'legacy_plan_projection' },
    });
  } else if (plan.status === 'failed' && graph.status !== 'failed') {
    store.append(plan.id, { expectedRevision: graph.revision, type: 'graph.failed' });
  } else if (plan.status === 'cancelled' && graph.status !== 'cancelled') {
    store.append(plan.id, { expectedRevision: graph.revision, type: 'graph.cancelled' });
  }
}
