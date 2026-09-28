/**
 * DockerToolsNudge — mid-run reminder when the user asked for docker/container
 * work but no docker/podman/compose exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedDockerCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const DOCKER_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type DockerToolsNudgeRequest = NudgeRequest;
export type DockerToolsNudgeResult = NudgeResult;

export const evaluateDockerToolsNudge = defineToolsNudge({
  userRe: /(?:\bdocker\b|\bpodman\b|\bcompose\b|\bcontainer\b|容器|镜像构建)/iu,
  actionRe: /(?:run|build|compose|start|up|启动|构建)/iu,
  sawEvidence: ({ messages }) => {
    for (const cmd of collectExecCommands(messages)) {
      if (/\b(?:docker|podman|docker-compose|compose)\b/i.test(cmd)) return true;
    }
    return false;
  },
  correction:
    '[System] The user asked about docker/containers, and tools have already run without a `docker`/`podman`/`compose` command. ' +
    'If container actions are required: run them via `exec`/`exec_background` and report real output. ' +
    'If answering conceptually only, say so — do not invent container state.',
});
