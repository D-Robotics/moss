import path from 'node:path';
import { createInMemoryMossAsyncTaskRegistry } from '@rdk-moss/core/contracts/async-task';
import { PlanControllerStore } from '../../plan-execute/plan-controller-store.js';
import { AdaptiveWorkspaceLeaseAdapter } from '../../orchestration/adaptive-workspace-lease.js';
import { CompletionArbiter } from '../../orchestration/completion-arbiter.js';
import { ExecutionBackedAsyncTaskRegistry } from '../../orchestration/execution-async-task-registry.js';
import { DEFAULT_ORCHESTRATION_POLICY } from '../../orchestration/execution-projector.js';
import { ExecutionTaskController } from '../../orchestration/execution-task-controller.js';
import { JsonlExecutionStore } from '../../orchestration/jsonl-execution-store.js';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';
import type { MossAgentConfig } from './moss-agent-types.js';

export function createAgentOrchestrationServices(config: MossAgentConfig, workspaceDir: string) {
  const runtimeDir = getMossWorkspacePaths(workspaceDir).runtimeDir;
  const executionStore =
    config.executionStore ??
    new JsonlExecutionStore({ rootDir: path.join(runtimeDir, 'executions') });

  return {
    executionStore,
    asyncTasks: new ExecutionBackedAsyncTaskRegistry(
      config.asyncTaskRegistry ?? createInMemoryMossAsyncTaskRegistry(),
      executionStore
    ),
    tasks: new ExecutionTaskController(executionStore),
    completionArbiter: new CompletionArbiter(executionStore),
    orchestrationPolicy: {
      ...DEFAULT_ORCHESTRATION_POLICY,
      ...config.orchestrationPolicy,
    },
    workspaceLeaseAdapter:
      config.workspaceLeaseAdapter ??
      new AdaptiveWorkspaceLeaseAdapter({ rootDir: path.join(runtimeDir, 'workspaces') }),
    planControllerStore: config.planControllerStore ?? new PlanControllerStore(),
  };
}
