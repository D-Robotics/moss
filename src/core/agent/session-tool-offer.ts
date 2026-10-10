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
 * `hooks.enrichToolContext` can install an asker after the tool list is built.
 * Probe it with a minimal context. A throw means no asker.
 */
export function hookProvidesUserQuestionAsker(
  enrich: ((base: ToolContext, sessionKey: string) => ToolContext) | undefined,
  base: Pick<ToolContext, 'workspaceDir' | 'sessionKey' | 'abortSignal'>
): boolean {
  if (!enrich) return false;
  try {
    const probed = enrich(
      {
        workspaceDir: base.workspaceDir,
        sessionKey: base.sessionKey,
        ...(base.abortSignal ? { abortSignal: base.abortSignal } : {}),
      },
      base.sessionKey
    );
    return probed.askUserQuestion !== undefined;
  } catch {
    return false;
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
