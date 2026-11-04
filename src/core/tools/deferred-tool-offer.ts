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

const DEFERRED_GROUPS: Record<string, readonly string[]> = {
  subagent: SUBAGENT_DEFERRED_TOOLS,
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
    return [
      `Loaded ${group} tools: ${names.join(', ')}.`,
      'Their schemas are on the tool list for the next model call.',
      'Empty sub-agent output is failure. One task uses create_subagent; two or more use fan_out_subagents.',
    ].join(' ');
  }
}
