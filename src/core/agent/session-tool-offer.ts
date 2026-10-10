/**
 * Tools the model is offered for one run.
 *
 * Device tools stay registered (SDK hosts and `/device add` still reach them)
 * but are omitted from the model list until a target exists, so a docs
 * question cannot spend a turn on device_info. The whole task ledger is omitted
 * when the host has already marked the turn as ordinary chat (`taskFlow: false`).
 * Headless `moss -p` leaves taskFlow unset, so bench prompts still see the ledger.
 * A tool with `requiresUserQuestion` is omitted when the run has no asker
 * (`userQuestions: false`): headless `-p` and any non-interactive host.
 * The tool name is not the signal. A host that injects an asker keeps it.
 */
import type { ToolContext } from '../tools/tool-types.js';
import { deviceTargetConfigured, isDeviceToolName } from '../../device/device-tool-offer.js';

/** Task ledger. Hidden when taskFlow is false; kept when taskFlow is unset. */
const TASK_LEDGER_TOOL_NAMES = new Set([
  'task_define',
  'task_acceptance',
  'task_plan_update',
  'record_evidence',
  'record_failure',
  'record_repair',
]);

/**
 * A question is visible when this agent has an asker, a process asker is
 * installed and stdin is a TTY, or a host hook supplies an asker.
 * Headless `-p` has none of those.
 */
export function userQuestionsOffered(options: {
  agentAsker: boolean;
  processAsker: boolean;
  stdinIsTTY: boolean;
  hookAsker?: boolean;
}): boolean {
  return (
    options.agentAsker || options.hookAsker === true || (options.processAsker && options.stdinIsTTY)
  );
}

/**
 * Model-facing result when a question tool was hidden and the model calls it
 * anyway. The old guidance: there is no user, so continue and say what was assumed.
 */
export const HIDDEN_USER_QUESTION_MESSAGE =
  'No user is available to answer this question. Proceed with your best judgment and state assumptions.';

export function hiddenUserQuestionMessage(
  tool: { metadata?: { requiresUserQuestion?: boolean } } | undefined,
  userQuestions: boolean
): string | undefined {
  if (userQuestions || tool?.metadata?.requiresUserQuestion !== true) return undefined;
  return HIDDEN_USER_QUESTION_MESSAGE;
}

/**
 * Call `hooks.enrichToolContext` once for this run. The base includes `runId`,
 * which already exists. Later tool calls reuse the returned context instead of
 * calling the hook again. A throw means the host supplied no asker.
 */
export function enrichRunToolContext(
  enrich: ((base: ToolContext, sessionKey: string) => ToolContext) | undefined,
  base: ToolContext
): ToolContext {
  if (!enrich) return base;
  try {
    return enrich(base, base.sessionKey);
  } catch {
    return base;
  }
}

export function toolVisibleForRun(
  toolName: string,
  options: {
    taskFlow?: boolean;
    deviceConfigured?: boolean;
    userQuestions?: boolean;
    requiresUserQuestion?: boolean;
  } = {}
): boolean {
  const deviceConfigured = options.deviceConfigured ?? deviceTargetConfigured();
  if (isDeviceToolName(toolName) && !deviceConfigured) return false;
  if (options.taskFlow === false && TASK_LEDGER_TOOL_NAMES.has(toolName)) return false;
  if (options.requiresUserQuestion === true && options.userQuestions === false) return false;
  return true;
}
