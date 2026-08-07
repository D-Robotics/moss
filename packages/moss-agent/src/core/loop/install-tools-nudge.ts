/**
 * InstallToolsNudge — mid-run reminder when the user asked to install
 * dependencies but no package-manager install exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedInstallCompletionGate.
 */

import { collectExecCommands } from './nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from './nudge-helpers.js';

export const INSTALL_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const INSTALL_USER_RE =
  /(?:\bnpm\s+install\b|\bpnpm\s+i(?:nstall)?\b|\byarn\s+install\b|\bbun\s+install\b|install (?:the )?dependencies|install deps|装依赖|安装依赖)/iu;

export type InstallToolsNudgeRequest = NudgeRequest;
export type InstallToolsNudgeResult = NudgeResult;

function sawInstallExec(
  messages: NudgeMessage[] | undefined,
): boolean {
  for (const cmd of collectExecCommands(messages)) {
    if (
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b/i.test(cmd) ||
      /\bpip(?:3)?\s+install\b/i.test(cmd)
    ) {
      return true;
    }
  }
  return false;
}

export function evaluateInstallToolsNudge(
  request: InstallToolsNudgeRequest,
): InstallToolsNudgeResult {
  if (request.attempts >= INSTALL_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  if (request.totalToolCalls < 1) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !INSTALL_USER_RE.test(user)) return { fire: false };

  if (sawInstallExec(request.messages)) return { fire: false };

  return {
    fire: true,
    correction:
      '[System] The user asked to install dependencies, and tools have already run without an install command ' +
      '(`npm`/`pnpm`/`yarn`/`bun` install/ci/add, or `pip install`). ' +
      'Run the real package-manager install via `exec` and report the output, or clearly say install was skipped. ' +
      'Do not invent install success.',
  };
}
