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
 * Plan-only tools (`exit_plan`) are offered only while the interaction mode is
 * `plan`; outside it they stay registered but unreachable from the model.
 */
import type { ToolContext } from '../tools/tool-types.js';
import { deviceTargetConfigured, isDeviceToolName } from '../../device/device-tool-offer.js';
import { isLegacyAliasToolName, isPlanOnlyToolName } from '../tools/tool-catalog.js';

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

/**
 * D3 experiment switch: `MOSS_HIDE_TOOLS=todo_write,multi_edit` hides those
 * tools from the model for this process, so a tool-surface A/B needs no code
 * edit. It parses per read so probes can flip it; an unknown name is simply
 * never visible (the CLI warns when the list is set).
 */
let hiddenNamesCache: { raw: string; names: ReadonlySet<string> } | undefined;

export function hiddenToolNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.MOSS_HIDE_TOOLS ?? '';
  if (hiddenNamesCache?.raw === raw) return hiddenNamesCache.names;
  const names = new Set(
    raw
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  );
  hiddenNamesCache = { raw, names };
  return names;
}

/** Tool names in `MOSS_HIDE_TOOLS` that are not registered (for a CLI warning). */
export function unknownHiddenToolNames(
  registered: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const known = new Set(registered);
  return [...hiddenToolNames(env)].filter((name) => !known.has(name));
}

export function toolVisibleForRun(
  toolName: string,
  options: {
    taskFlow?: boolean;
    deviceConfigured?: boolean;
    userQuestions?: boolean;
    requiresUserQuestion?: boolean;
    /** True while the interaction mode is `plan` (the mode, not a tool flag). */
    planMode?: boolean;
    /** Registered but subsumed by a newer tool; never offered to the model. */
    hiddenFromModel?: boolean;
  } = {}
): boolean {
  // Compatibility aliases stay registered for hosts and old transcripts but are
  // never offered: each one duplicates a canonical tool the model already has.
  if (isLegacyAliasToolName(toolName)) return false;
  if (options.hiddenFromModel === true) return false;
  if (hiddenToolNames().has(toolName)) return false;
  // The plan-exit action is part of plan mode, not a global tool: offering it
  // in normal mode invites a call that cannot open anything.
  if (isPlanOnlyToolName(toolName) && options.planMode !== true) return false;
  const deviceConfigured = options.deviceConfigured ?? deviceTargetConfigured();
  if (isDeviceToolName(toolName) && !deviceConfigured) return false;
  if (options.taskFlow === false && TASK_LEDGER_TOOL_NAMES.has(toolName)) return false;
  if (options.requiresUserQuestion === true && options.userQuestions === false) return false;
  return true;
}
