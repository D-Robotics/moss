import fs from 'node:fs';
import path from 'node:path';
import { createInMemoryMossAsyncTaskRegistry } from '@rdk-moss/core/contracts/async-task';
import { PlanControllerStore } from '../../plan-execute/plan-controller-store.js';
import { AdaptiveWorkspaceLeaseAdapter } from '../../orchestration/adaptive-workspace-lease.js';
import { CompletionArbiter } from '../../orchestration/completion-arbiter.js';
import { ExecutionBackedAsyncTaskRegistry } from '../../orchestration/execution-async-task-registry.js';
import { DEFAULT_ORCHESTRATION_POLICY } from '../../orchestration/execution-projector.js';
import { ExecutionTaskController } from '../../orchestration/execution-task-controller.js';
import { JsonlExecutionStore } from '../../orchestration/jsonl-execution-store.js';
import { ExecutionGraphScheduler } from '../../orchestration/execution-graph-scheduler.js';
import { LegacyExecutionImporter } from '../../orchestration/legacy-execution-importer.js';
import { recoverExecutionGraph } from '../../orchestration/execution-recovery.js';
import { ErrorCode, isMossError } from '../../errors.js';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';
import type { MossAgentConfig } from './moss-agent-types.js';

export function createAgentOrchestrationServices(config: MossAgentConfig, workspaceDir: string) {
  const runtimeDir = getMossWorkspacePaths(workspaceDir).runtimeDir;
  const executionRuntimeDir = path.join(runtimeDir, 'runtime');
  const executionStore =
    config.executionStore ??
    new JsonlExecutionStore({ rootDir: path.join(executionRuntimeDir, 'executions') });
  const legacyImporter = new LegacyExecutionImporter(executionStore);
  const loopStatePath = path.join(runtimeDir, 'loop-state.json');
  if (
    fs.existsSync(loopStatePath) &&
    !fs.existsSync(`${loopStatePath}.execution-graph-migration-v1.json`)
  ) {
    legacyImporter.import({
      kind: 'loop',
      sourcePath: loopStatePath,
      state: JSON.parse(fs.readFileSync(loopStatePath, 'utf8')) as Readonly<
        Record<string, unknown>
      >,
    });
  }
  for (const graph of executionStore.list()) {
    if (graph.status !== 'running' && graph.status !== 'ready') continue;
    try {
      const ownerLease = executionStore.acquireLease(graph.id, {
        ownerId: `startup-recovery:${process.pid}`,
        ttlMs: 30_000,
      });
      try {
        recoverExecutionGraph(executionStore, graph.id, { ownerLease });
      } finally {
        executionStore.releaseLease(graph.id, ownerLease);
      }
    } catch (error) {
      if (!isMossError(error) || error.code !== ErrorCode.EXECUTION_LEASE_HELD) throw error;
    }
  }

  return {
    executionStore,
    legacyImporter,
    asyncTasks: new ExecutionBackedAsyncTaskRegistry(
      config.asyncTaskRegistry ?? createInMemoryMossAsyncTaskRegistry(),
      executionStore
    ),
    tasks: new ExecutionTaskController(executionStore),
    completionArbiter: new CompletionArbiter(executionStore),
    scheduler: new ExecutionGraphScheduler(executionStore),
    orchestrationPolicy: {
      ...DEFAULT_ORCHESTRATION_POLICY,
      ...config.orchestrationPolicy,
    },
    workspaceLeaseAdapter:
      config.workspaceLeaseAdapter ??
      new AdaptiveWorkspaceLeaseAdapter({ rootDir: path.join(executionRuntimeDir, 'workspaces') }),
    planControllerStore: config.planControllerStore ?? new PlanControllerStore(),
  };
}
