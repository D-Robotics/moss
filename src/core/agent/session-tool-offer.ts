/**
 * Tools the model is offered for one run.
 *
 * Device tools stay registered (SDK hosts and `/device add` still reach them)
 * but are omitted from the model list until a target exists, so a docs
 * question cannot spend a turn on device_info. The whole task ledger is omitted
 * when the host has already marked the turn as ordinary chat (`taskFlow: false`).
 * Headless `moss -p` leaves taskFlow unset, so bench prompts still see the ledger.
 * `ask_user_question` is omitted when the run cannot show a question
 * (`userQuestions: false`): headless `-p` and any non-interactive host.
 */
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

const USER_QUESTION_TOOL = 'ask_user_question';

/**
 * A question is visible when this agent has an asker, or a process asker is
 * installed and stdin is a TTY. Headless `-p` has neither.
 */
export function userQuestionsOffered(options: {
  agentAsker: boolean;
  processAsker: boolean;
  stdinIsTTY: boolean;
}): boolean {
  return options.agentAsker || (options.processAsker && options.stdinIsTTY);
}

export function toolVisibleForRun(
  toolName: string,
  options: { taskFlow?: boolean; deviceConfigured?: boolean; userQuestions?: boolean } = {}
): boolean {
  const deviceConfigured = options.deviceConfigured ?? deviceTargetConfigured();
  if (isDeviceToolName(toolName) && !deviceConfigured) return false;
  if (options.taskFlow === false && TASK_LEDGER_TOOL_NAMES.has(toolName)) return false;
  if (options.userQuestions === false && toolName === USER_QUESTION_TOOL) return false;
  return true;
}
