import fs from 'node:fs';
import path from 'node:path';

/**
 * Sub-agent tools stay registered (callers and tests still reach them) but
 * are omitted from the model tool list until `tool_search` reveals the group.
 * Revealing is sticky for the agent so the tool list does not flap.
 */

export const TOOL_SEARCH_NAME = 'tool_search';

export const SUBAGENT_DEFERRED_TOOLS = [
  'create_subagent',
  'fan_out_subagents',
  'subagent_status',
  'subagent_stop',
  'merge_subagent_patch',
] as const;

/**
 * Task OS ledger (goal → evidence → acceptance). These six tools are the
 * vocabulary of a verifiable-task run; a plain chat or a small fix never calls
 * them, yet they used to sit in every headless prompt (~5.6 KB of schemas,
 * measured in backlog B05). They stay deferred until the run shows task intent,
 * the workspace already has a ledger, or the host explicitly asks for task flow.
 */
export const TASK_DEFERRED_TOOLS = [
  'task_define',
  'task_acceptance',
  'task_plan_update',
  'record_evidence',
  'record_failure',
  'record_repair',
] as const;

const DEFERRED_GROUPS: Record<string, readonly string[]> = {
  subagent: SUBAGENT_DEFERRED_TOOLS,
  task: TASK_DEFERRED_TOOLS,
};

const DEFERRED_NAMES = new Set<string>(Object.values(DEFERRED_GROUPS).flat());

export function isDeferredToolName(name: string): boolean {
  return DEFERRED_NAMES.has(name);
}

/** Group a deferred tool belongs to, for the "load this first" error path. */
export function deferredGroupFor(name: string): string | null {
  for (const [group, names] of Object.entries(DEFERRED_GROUPS)) {
    if (names.includes(name)) return group;
  }
  return null;
}

export function deferredToolGroupNames(): readonly string[] {
  return Object.keys(DEFERRED_GROUPS);
}

export class DeferredToolOffer {
  private readonly revealed = new Set<string>();

  isRevealed(group: string): boolean {
    return this.revealed.has(group);
  }

  isOffered(name: string): boolean {
    for (const [group, names] of Object.entries(DEFERRED_GROUPS)) {
      if (names.includes(name) && !this.revealed.has(group)) return false;
    }
    return true;
  }

  /** Reveal one group. Returns the model-facing note. */
  reveal(group: string): string {
    const names = DEFERRED_GROUPS[group];
    if (!names) {
      return `Error: unknown tool group "${group}". Groups: ${deferredToolGroupNames().join(', ')}.`;
    }
    this.revealed.add(group);
    const guidance =
      group === 'task'
        ? 'task_define takes a goal plus machine-checkable acceptance criteria; record_evidence records Expected/Observed/Result for each criterion, and task_acceptance evaluates the latest evidence (no evidence means not done).'
        : 'Empty sub-agent output is failure. One task uses create_subagent; two or more use fan_out_subagents.';
    return [
      `Loaded ${group} tools: ${names.join(', ')}.`,
      'Their schemas are on the tool list for the next model call.',
      guidance,
    ].join(' ');
  }
}

/**
 * Does this message ask for a verifiable task (a goal with acceptance criteria,
 * evidence, milestones)? Deliberately conservative: the cost of a false positive
 * is a few KB of schemas, the cost of a false negative is a task run that cannot
 * define or accept its contract.
 */
const TASK_INTENT_RE =
  /\b(tasks?|goals?|acceptance\s+criteria?|accept(ance)?|definition\s+of\s+done|milestones?|deliverables?|evidence|task_define|task_acceptance|record_evidence)\b|任务|目标|验收|证据|交付物|完成标准|里程碑|闭环/u;

export function messageRequestsTaskLedger(text: string): boolean {
  if (!text) return false;
  // Slash entry points (Claude Code `/goal`, Moss `/task`) always mean task flow.
  if (/(?:^|\s)\/(?:goal|task)\b/u.test(text)) return true;
  return TASK_INTENT_RE.test(text);
}

/**
 * A workspace that already has task-ledger entries is continuing Task OS work,
 * so the ledger tools should be offered even when the current message does not
 * repeat the intent (a short "continue" after a previous task run).
 */
export function workspaceHasTaskLedger(workspaceDir: string): boolean {
  try {
    return fs.statSync(path.join(workspaceDir, '.moss', 'tasks.jsonl')).size > 0;
  } catch {
    return false;
  }
}
