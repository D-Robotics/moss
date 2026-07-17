/**
 * DockerToolsNudge — mid-run reminder when the user asked for docker/container
 * work but no docker/podman/compose exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedDockerCompletionGate.
 */

export const DOCKER_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const DOCKER_USER_RE =
  /(?:\bdocker\b|\bpodman\b|\bcompose\b|\bcontainer\b|容器|镜像构建)/iu;

const EXEC_TOOLS = new Set(['exec', 'exec_background']);

export interface DockerToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  messages?: Array<{ role?: string; content?: unknown }>;
  totalToolCalls: number;
  attempts: number;
}

export type DockerToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function sawDockerExec(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): boolean {
  if (!messages?.length) return false;
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type !== 'tool_use' || !b.name || !EXEC_TOOLS.has(b.name)) continue;
      const input = b.input;
      if (!input || typeof input !== 'object') continue;
      const o = input as Record<string, unknown>;
      let cmd = '';
      for (const key of ['command', 'cmd', 'input'] as const) {
        if (typeof o[key] === 'string' && String(o[key]).trim()) {
          cmd = String(o[key]);
          break;
        }
      }
      if (/\b(?:docker|podman|docker-compose|compose)\b/i.test(cmd)) return true;
    }
  }
  return false;
}

export function evaluateDockerToolsNudge(
  request: DockerToolsNudgeRequest,
): DockerToolsNudgeResult {
  if (request.attempts >= DOCKER_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };
  if (sawDockerExec(request.messages)) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !DOCKER_USER_RE.test(user)) return { fire: false };

  // Conceptual "what is docker?" without asking to run containers.
  if (
    /(?:what is|how does|文档|原理|介绍)/iu.test(user) &&
    !/(?:run|build|compose|start|up|build|启动|构建)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked about docker/containers, and tools have already run without a `docker`/`podman`/`compose` command. ' +
      'If container actions are required: run them via `exec`/`exec_background` and report real output. ' +
      'If answering conceptually only, say so — do not invent container state.',
  };
}
