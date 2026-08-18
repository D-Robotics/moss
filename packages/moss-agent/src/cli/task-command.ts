import type { MossAgent } from '../core/agent/moss-agent.js';
import type { ExecutionGraphSnapshot } from '../orchestration/index.js';
import { errorMessage } from '../errors.js';

function summary(graph: ExecutionGraphSnapshot): string {
  const nodes = Object.values(graph.nodes);
  const done = nodes.filter((node) => ['succeeded', 'skipped'].includes(node.status)).length;
  return `${graph.id}  ${graph.status}  rev=${graph.revision}  nodes=${done}/${nodes.length}  ${graph.goal}`;
}

function details(graph: ExecutionGraphSnapshot): string {
  const nodeLines = Object.values(graph.nodes).map(
    (node) =>
      `  ${node.id}  ${node.status}  kind=${node.kind}  attempts=${node.attempts}` +
      (node.error ? `  error=${node.error}` : '')
  );
  return [summary(graph), ...nodeLines, `evidence=${graph.evidence.length}`].join('\n');
}

/** Execute /tasks and /task control commands against the shared graph controller. @internal */
export function handleTaskCommand(agent: Pick<MossAgent, 'tasks'>, input: string): string {
  try {
    const parts = input.trim().split(/\s+/);
    if (parts[0] === '/tasks') {
      const tasks = agent.tasks.list();
      return tasks.length ? tasks.map(summary).join('\n') : 'No durable tasks.';
    }
    const action = parts[1];
    const graphId = parts[2];
    if (!action || !graphId) {
      return 'Usage: /task <inspect|resume|retry|stop> <task-id> [node-id]';
    }
    if (action === 'inspect') return details(agent.tasks.inspect(graphId));
    if (action === 'resume') return `Resumed ${summary(agent.tasks.resume(graphId))}`;
    if (action === 'stop') return `Stopped ${summary(agent.tasks.stop(graphId))}`;
    if (action === 'retry') {
      const nodeId = parts[3];
      if (!nodeId) return 'Usage: /task retry <task-id> <node-id>';
      return `Retry requested: ${details(agent.tasks.retry(graphId, nodeId))}`;
    }
    return 'Usage: /task <inspect|resume|retry|stop> <task-id> [node-id]';
  } catch (error) {
    return `Error: ${errorMessage(error)}`;
  }
}
