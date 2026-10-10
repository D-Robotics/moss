/**
 * Tools the model is offered for one run.
 *
 * Device tools stay registered (SDK hosts and `/device add` still reach them)
 * but are omitted from the model list until a target exists, so a docs
 * question cannot spend a turn on device_info. The whole task ledger is omitted
 * when the host has already marked the turn as ordinary chat (`taskFlow: false`).
 * Headless `moss -p` leaves taskFlow unset, so bench prompts still see the ledger.
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

export function toolVisibleForRun(
  toolName: string,
  options: { taskFlow?: boolean; deviceConfigured?: boolean } = {}
): boolean {
  const deviceConfigured = options.deviceConfigured ?? deviceTargetConfigured();
  if (isDeviceToolName(toolName) && !deviceConfigured) return false;
  if (options.taskFlow === false && TASK_LEDGER_TOOL_NAMES.has(toolName)) return false;
  return true;
}
