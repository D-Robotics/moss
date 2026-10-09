/**
 * Tools the model is offered for one run.
 *
 * Device tools stay registered (SDK hosts and `/device add` still reach them)
 * but are omitted from the model list until a target exists, so a docs
 * question cannot spend a turn on device_info. Task-ledger tools are omitted
 * when the host has already marked the turn as ordinary chat (`taskFlow: false`).
 */
import { deviceTargetConfigured, isDeviceToolName } from '../../device/device-tool-offer.js';

/** Opening or writing the task ledger. Hidden for plain Q&A. */
const TASK_LEDGER_TOOL_NAMES = new Set(['task_define', 'record_evidence']);

export function toolVisibleForRun(
  toolName: string,
  options: { taskFlow?: boolean; deviceConfigured?: boolean } = {}
): boolean {
  const deviceConfigured = options.deviceConfigured ?? deviceTargetConfigured();
  if (isDeviceToolName(toolName) && !deviceConfigured) return false;
  if (options.taskFlow === false && TASK_LEDGER_TOOL_NAMES.has(toolName)) return false;
  return true;
}
