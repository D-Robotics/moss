import type { MossAgent } from '../core/agent/moss-agent.js';
import { StoreExecutionQuery } from '../orchestration/index.js';
import type { ExecutionView } from '../orchestration/index.js';
import { errorMessage } from '../errors.js';

function summary(graph: ExecutionView): string {
  const nodes = graph.nodes;
  const done = nodes.filter((node) => ['succeeded', 'skipped'].includes(node.status)).length;
  const delivery = graph.deliveryCase
    ? `  case=${graph.deliveryCase.stage}/${graph.deliveryCase.depth}`
    : '';
  return `${graph.graphId}  ${graph.status}  rev=${graph.revision}  nodes=${done}/${nodes.length}${delivery}  ${graph.goal}`;
}

function details(graph: ExecutionView): string {
  const nodeLines = graph.nodes.map(
    (node) =>
      `  ${node.id}  ${node.status}  kind=${node.kind}  attempts=${node.attempts}` +
      (node.error ? `  error=${node.error}` : '')
  );
  return [summary(graph), ...nodeLines, `evidence=${graph.evidence.length}`].join('\n');
}

function requireView(query: StoreExecutionQuery, graphId: string): ExecutionView {
  const graph = query.get(graphId);
  if (!graph) throw new Error(`unknown task "${graphId}"`);
  return graph;
}

/** Execute /tasks and /task control commands against the shared graph controller. @internal */
export function handleTaskCommand(
  agent: Pick<MossAgent, 'tasks' | 'executionStore'>,
  input: string
): string {
  try {
    const query = new StoreExecutionQuery(agent.executionStore);
    const parts = input.trim().split(/\s+/);
    if (parts[0] === '/tasks') {
      const tasks = query.list();
      return tasks.length ? tasks.map(summary).join('\n') : 'No durable tasks.';
    }
    const action = parts[1];
    const graphId = parts[2];
    if (!action || !graphId) {
      return 'Usage: /task <inspect|resume|retry|stop> <task-id> [node-id]';
    }
    if (action === 'inspect') {
      return details(requireView(query, graphId));
    }
    if (action === 'resume') {
      agent.tasks.resume(graphId);
      return `Resumed ${summary(requireView(query, graphId))}`;
    }
    if (action === 'stop') {
      agent.tasks.stop(graphId);
      return `Stopped ${summary(requireView(query, graphId))}`;
    }
    if (action === 'retry') {
      const nodeId = parts[3];
      if (!nodeId) return 'Usage: /task retry <task-id> <node-id>';
      agent.tasks.retry(graphId, nodeId);
      return `Retry requested: ${details(requireView(query, graphId))}`;
    }
    return 'Usage: /task <inspect|resume|retry|stop> <task-id> [node-id]';
  } catch (error) {
    return `Error: ${errorMessage(error)}`;
  }
}
