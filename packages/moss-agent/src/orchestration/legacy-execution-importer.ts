import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { ErrorCode, MossError } from '../errors.js';
import type {
  ExecutionGraphSnapshot,
  ExecutionNodeDefinition,
  ExecutionStore,
} from './execution-types.js';

/** Legacy checkpoint family accepted by the one-release migration bridge. @beta */
export type LegacyExecutionKind = 'goal' | 'task-frame' | 'plan' | 'loop';

/** Explicit legacy checkpoint migration request. @beta */
export interface LegacyExecutionImportRequest {
  readonly kind: LegacyExecutionKind;
  readonly sourcePath: string;
  readonly state: Readonly<Record<string, unknown>>;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function stableId(kind: LegacyExecutionKind, state: Readonly<Record<string, unknown>>): string {
  const identity = text(state.id ?? state.runId ?? state.sessionKey, JSON.stringify(state));
  return `legacy_${kind.replace('-', '_')}_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function nodesFor(
  kind: LegacyExecutionKind,
  state: Readonly<Record<string, unknown>>
): ExecutionNodeDefinition[] {
  if (kind === 'plan' && Array.isArray(state.steps)) {
    return state.steps.map((raw, index) => {
      const step = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const number = Number.isInteger(step.step) ? Number(step.step) : index + 1;
      const dependencies = Array.isArray(step.dependsOn)
        ? step.dependsOn.filter(Number.isInteger).map((dependency) => `step-${dependency}`)
        : number > 1
          ? [`step-${number - 1}`]
          : [];
      return {
        id: `step-${number}`,
        kind: list(step.writePaths).length ? 'implementation' : 'analysis',
        title: text(step.description, `Step ${number}`),
        dependencies,
        ...(list(step.writePaths).length ? { writePaths: list(step.writePaths) } : {}),
      };
    });
  }
  if (kind === 'task-frame') {
    const completed = list(state.completedSteps);
    const pending = list(state.pendingSteps);
    return [...completed, text(state.currentStep, 'Resume task'), ...pending].map(
      (title, index) => ({
        id: `frame-${index + 1}`,
        kind: 'manual',
        title,
        dependencies: index === 0 ? [] : [`frame-${index}`],
      })
    );
  }
  if (kind === 'loop') {
    const count = Math.max(1, Number(state.currentIteration) || 1);
    return Array.from({ length: count }, (_, index) => ({
      id: `iteration-${index + 1}`,
      kind: 'analysis' as const,
      title: `Loop iteration ${index + 1}`,
      dependencies: index === 0 ? [] : [`iteration-${index}`],
    }));
  }
  return [
    { id: 'goal', kind: 'manual', title: text(state.objective, 'Resume goal'), dependencies: [] },
  ];
}

/** Imports legacy state without deleting or rewriting its source file. @beta */
export class LegacyExecutionImporter {
  constructor(private readonly store: ExecutionStore) {}

  import(request: LegacyExecutionImportRequest): ExecutionGraphSnapshot {
    const id = stableId(request.kind, request.state);
    const marker = `${request.sourcePath}.execution-graph-migration-v1.json`;
    if (fs.existsSync(marker)) {
      const graph = this.store.load(id);
      if (!graph) {
        throw new MossError({
          code: ErrorCode.EXECUTION_STORE_FAILED,
          message: `migration marker exists but execution graph is missing: ${id}`,
        });
      }
      return graph;
    }
    const goal = text(
      request.state.goal ?? request.state.objective ?? request.state.prompt,
      `Imported ${request.kind}`
    );
    let graph = this.store.create({
      id,
      sessionId:
        typeof request.state.sessionKey === 'string' ? request.state.sessionKey : undefined,
      goal,
      nodes: nodesFor(request.kind, request.state),
      now: Number(request.state.createdAt ?? request.state.startedAt) || Date.now(),
    });
    const completed = request.state.status === 'completed';
    graph = this.store.append(id, {
      expectedRevision: graph.revision,
      type: completed ? 'graph.blocked' : 'graph.recovered',
      data: completed
        ? { reason: 'needs_evidence', source: request.kind }
        : {
            recovery: {
              recoveredAt: Date.now(),
              requiresUserResume: true,
              interruptedNodeIds: [],
              blockedMutationNodeIds: [],
            },
          },
    });
    const temporary = `${marker}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, graphId: id, kind: request.kind, importedAt: Date.now() })}\n`,
      { mode: 0o600 }
    );
    fs.renameSync(temporary, marker);
    return graph;
  }
}
