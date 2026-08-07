/**
 * DockerToolsNudge — mid-run reminder when the user asked for docker/container
 * work but no docker/podman/compose exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedDockerCompletionGate.
 */

import { collectExecCommands, isConceptualQuestion } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const DOCKER_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const DOCKER_USER_RE =
  /(?:\bdocker\b|\bpodman\b|\bcompose\b|\bcontainer\b|容器|镜像构建)/iu;

const DOCKER_ACTION_RE = /(?:run|build|compose|start|up|启动|构建)/iu;

export type DockerToolsNudgeRequest = NudgeRequest;
export type DockerToolsNudgeResult = NudgeResult;

function sawDockerExec(messages: NudgeMessage[] | undefined): boolean {
  for (const cmd of collectExecCommands(messages)) {
    if (/\b(?:docker|podman|docker-compose|compose)\b/i.test(cmd)) return true;
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
  if (isConceptualQuestion(user, DOCKER_ACTION_RE)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked about docker/containers, and tools have already run without a `docker`/`podman`/`compose` command. ' +
      'If container actions are required: run them via `exec`/`exec_background` and report real output. ' +
      'If answering conceptually only, say so — do not invent container state.',
  };
}
