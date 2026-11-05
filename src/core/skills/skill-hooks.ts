/**
 * D11: skill-declared hooks (session-sticky), the Moss counterpart of Claude
 * Code's skill-frontmatter hooks.
 *
 * Claude Code lets a skill declare `hooks` in its frontmatter; those hooks apply
 * for the rest of the session once the skill is invoked (research note
 * `claude-code.md` §hooks: "skill frontmatter | rest of session after invoke").
 * SKILL.md frontmatter in Moss is a deliberately shallow YAML subset (one nested
 * level, no lists of maps), so the same capability is expressed the way Moss
 * already ships hooks: the frontmatter names a JSON file (`hooks: hooks.json`)
 * next to the skill, using the exact same hook-entry schema as `.moss/config.json`.
 *
 * The skill tool parses and validates that file, then calls `activateSkillHooks`.
 * This module only stores the raw entries; the CLI hooks layer merges them into
 * its pipeline per event, so the agent loop still owns execution and the
 * existing hook semantics (matcher / if / deny > ask > allow) are unchanged.
 *
 * Scope: tool events only (PreToolUse, PostToolUse, PostToolUseFailure). A
 * skill hook that names another event is reported and dropped, so a skill can
 * never veto `Stop` or compactions behind the user's back.
 */
import type { SkillHookEvent } from '../../contracts/skill.js';

export type { SkillHookEvent } from '../../contracts/skill.js';

/** Events a skill-declared hook may attach to. */
export const SKILL_HOOK_EVENTS: readonly SkillHookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
];

export interface ActivatedSkillHooks {
  skill: string;
  /** Raw per-event entries, in declaration order, already shape-validated. */
  events: Partial<Record<SkillHookEvent, readonly unknown[]>>;
  /** Non-fatal notes the skill tool shows the model (unknown events, bad entries). */
  warnings: string[];
}

const activated = new Map<string, ActivatedSkillHooks>();

/**
 * `once` bookkeeping. Claude removes a skill hook after its first successful
 * run; PostToolUse hooks fire asynchronously, so "claimed" is what prevents a
 * second concurrent call from running the same once hook twice.
 */
interface OnceEntryState {
  skill: string;
  event: SkillHookEvent;
}
const onceEntries = new Map<unknown, OnceEntryState>();
const claimedOnce = new Set<unknown>();
/** Retired once entries never run again, even if an old reference is claimed. */
const retiredOnce = new WeakSet<object>();

/** Shape-check one hook entry without trusting the file (no `any`). */
function isHookEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const type = entry.type;
  if (type !== undefined && type !== 'command' && type !== 'http') return false;
  // Claude parity: `once: true` retires the hook after its first successful
  // run. Only a boolean counts; a string `"true"` is a typo, not a feature.
  if (entry.once !== undefined && typeof entry.once !== 'boolean') return false;
  if (type === 'http') return typeof entry.url === 'string' && entry.url.trim().length > 0;
  return typeof entry.command === 'string' && entry.command.trim().length > 0;
}

function isOnceEntry(entry: unknown): boolean {
  return Boolean(entry && typeof entry === 'object' && (entry as { once?: unknown }).once === true);
}

/**
 * Validate a parsed `hooks.json` object. Returns the accepted per-event entries
 * plus warnings for everything dropped; a malformed top level is an error the
 * skill tool turns into a failed skill load (fail closed, no silent no-op).
 */
export function parseSkillHooks(
  skill: string,
  raw: unknown
): { ok: true; hooks: ActivatedSkillHooks } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `hooks for skill "${skill}" must be a JSON object` };
  }
  const events: ActivatedSkillHooks['events'] = {};
  const warnings: string[] = [];
  let total = 0;
  for (const [event, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SKILL_HOOK_EVENTS as readonly string[]).includes(event)) {
      warnings.push(
        `skill "${skill}" declares hooks for "${event}"; skill hooks only support ${SKILL_HOOK_EVENTS.join(', ')} and that event was ignored`
      );
      continue;
    }
    if (!Array.isArray(list)) {
      warnings.push(`skill "${skill}" ${event} hooks must be an array; ignored`);
      continue;
    }
    const accepted = list.filter(isHookEntry);
    if (accepted.length !== list.length) {
      warnings.push(
        `skill "${skill}" ${event}: ${String(list.length - accepted.length)} entr${
          list.length - accepted.length === 1 ? 'y' : 'ies'
        } without a string command (or http url) were ignored`
      );
    }
    if (accepted.length > 0) {
      events[event as SkillHookEvent] = accepted;
      total += accepted.length;
    }
  }
  if (total === 0) {
    warnings.push(`skill "${skill}" hooks.json contained no usable hook entries`);
  }
  return { ok: true, hooks: { skill, events, warnings } };
}

/**
 * Make one skill's hooks active for the rest of the session. Re-invoking the
 * same skill replaces its entries (no duplicate execution); the map is bounded
 * by the number of skills in the catalog, which is already bounded.
 */
export function activateSkillHooks(hooks: ActivatedSkillHooks): void {
  // Re-invocation replaces the skill's entries, so stale once-bookkeeping for
  // the old entry objects must not outlive them.
  for (const [entry, state] of onceEntries) {
    if (state.skill === hooks.skill) {
      onceEntries.delete(entry);
      claimedOnce.delete(entry);
    }
  }
  activated.set(hooks.skill, hooks);
  for (const [event, list] of Object.entries(hooks.events) as Array<
    [SkillHookEvent, readonly unknown[]]
  >) {
    for (const entry of list) {
      if (isOnceEntry(entry)) onceEntries.set(entry, { skill: hooks.skill, event });
    }
  }
}

/** Entries for one event, across every activated skill, in activation order. */
export function activeSkillHookEntries(event: SkillHookEvent): readonly unknown[] {
  const entries: unknown[] = [];
  for (const state of activated.values()) {
    const list = state.events[event];
    if (list) entries.push(...list);
  }
  return entries;
}

export function activeSkillHookSkills(): readonly string[] {
  return [...activated.keys()];
}

/**
 * Reserve a hook entry for one execution. Non-`once` entries are always
 * claimable; a `once` entry is claimable exactly once until its run reports a
 * result, so two PostToolUse events in flight cannot both run it.
 */
export function claimSkillHookEntry(entry: unknown): boolean {
  if (entry && typeof entry === 'object' && retiredOnce.has(entry)) return false;
  if (!onceEntries.has(entry)) return true;
  if (claimedOnce.has(entry)) return false;
  claimedOnce.add(entry);
  return true;
}

/**
 * Report how a claimed run ended. A successful run retires a `once` entry for
 * the rest of the session; a failed one releases the claim so it can retry.
 */
export function noteSkillHookEntryResult(entry: unknown, success: boolean): void {
  const state = onceEntries.get(entry);
  if (!state) return;
  claimedOnce.delete(entry);
  if (!success) return;
  removeOnceEntry(state, entry);
}

function removeOnceEntry(state: OnceEntryState, entry: unknown): void {
  onceEntries.delete(entry);
  claimedOnce.delete(entry);
  if (entry && typeof entry === 'object') retiredOnce.add(entry);
  const hooks = activated.get(state.skill);
  if (!hooks) return;
  const list = hooks.events[state.event];
  if (!list) return;
  const remaining = list.filter((candidate) => candidate !== entry);
  const events = { ...hooks.events };
  if (remaining.length > 0) events[state.event] = remaining;
  else delete events[state.event];
  activated.set(state.skill, { ...hooks, events });
}

/** One line the skill tool can show the model after activation. */
export function describeActivatedSkillHooks(hooks: ActivatedSkillHooks): string {
  const counts = SKILL_HOOK_EVENTS.map((event) => {
    const count = hooks.events[event]?.length ?? 0;
    if (count === 0) return '';
    const once = (hooks.events[event] ?? []).filter(isOnceEntry).length;
    return once > 0
      ? `${event} ${String(count)} (${String(once)} once)`
      : `${event} ${String(count)}`;
  }).filter(Boolean);
  return `Skill hooks active for the rest of this session: ${counts.join(', ')}.`;
}

/** Probes reset between cases; a fresh process starts empty anyway. */
export function clearSkillHookState(): void {
  activated.clear();
  onceEntries.clear();
  claimedOnce.clear();
}
