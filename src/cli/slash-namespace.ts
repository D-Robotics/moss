/**
 * One namespace for slash names.
 *
 * Built-in commands, file commands (`.moss/commands`), user commands
 * (`<configDir>/commands`) and skills surfaced as `/name` used to be collected by
 * three loaders and resolved by three implicit orders. `resolveUserCommand` had
 * the right order hard-coded, but nothing told the user when a skill lost its
 * name to a command, and the capability registry never learned that commands and
 * skills exist.
 *
 * This module collects the three sources into `SlashEntry`s (the precedence is
 * data in `core/capabilities/slash.ts`), reports every shadowed name once, and
 * produces registry descriptors for the capability report.
 */
import type { CapabilityDescriptor } from '../contracts/capability.js';
import {
  SLASH_PRECEDENCE_DOC,
  findSlashConflicts,
  slashEntryLabel,
  type SlashConflict,
  type SlashEntry,
} from '../core/capabilities/slash.js';
import type { CommandSpec } from './commands/registry.js';
import type { SkillCommandRef } from './commands/custom-commands.js';

export interface SlashNamespaceInput {
  customCommands: readonly CommandSpec[];
  skills: readonly SkillCommandRef[];
  /** Built-in names (`/help`, `/status`, ...); they always win and cannot be loaded over. */
  builtinNames: ReadonlySet<string>;
}

export interface SlashNamespace {
  entries: SlashEntry[];
  conflicts: SlashConflict[];
  descriptors: CapabilityDescriptor[];
}

function bareSlashName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

export function collectSlashNamespace(input: SlashNamespaceInput): SlashNamespace {
  const entries: SlashEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: SlashEntry): void => {
    const key = `${entry.kind}\u0000${entry.scope}\u0000${bareSlashName(entry.name)}\u0000${entry.source ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const name of input.builtinNames) {
    add({ kind: 'builtin', name: bareSlashName(name), scope: 'builtin' });
  }
  for (const spec of input.customCommands) {
    add({
      kind: 'command',
      name: bareSlashName(spec.name),
      scope: spec.scope ?? 'workspace',
      source: spec.name,
    });
  }
  for (const skill of input.skills) {
    const scope = skill.scope ?? 'user';
    add({ kind: 'skill', name: bareSlashName(skill.name), scope, source: `skill ${skill.name}` });
    if (skill.slashAlias) {
      add({
        kind: 'skill',
        name: bareSlashName(skill.slashAlias),
        scope,
        source: `skill ${skill.name} (alias)`,
      });
    }
  }

  const conflicts = findSlashConflicts(entries);
  const descriptors: CapabilityDescriptor[] = [
    ...input.customCommands.map((spec) => ({
      id: `command:${bareSlashName(spec.name)}`,
      kind: 'command' as const,
      scope: spec.scope ?? ('workspace' as const),
      activation: 'manual' as const,
      source: `${spec.name}`,
      description: spec.summary,
    })),
    ...input.skills.map((skill) => ({
      id: `skill:${skill.name.toLowerCase()}`,
      kind: 'skill' as const,
      scope: skill.scope ?? ('user' as const),
      activation: 'manual' as const,
      source: `skill ${skill.name}`,
      ...(skill.description ? { description: skill.description } : {}),
    })),
  ];

  return { entries, conflicts, descriptors };
}

export function formatSlashConflict(conflict: SlashConflict): string {
  const winner = `${slashEntryLabel(conflict.winner)} /${conflict.winner.name}`;
  const losers = conflict.losers
    .map((entry) => `${slashEntryLabel(entry)} /${entry.name}`)
    .join(', ');
  const loserSources = conflict.losers
    .map((entry) => entry.source)
    .filter((source): source is string => Boolean(source));
  const hint =
    conflict.winner.kind === 'builtin'
      ? 'rename the file to a name that is not reserved by a built-in command'
      : 'rename the shadowed file, or invoke it as a skill tool instead of a slash command';
  return (
    `[slash] ${winner} shadows ${losers}` +
    (loserSources.length > 0 ? ` (${loserSources.join('; ')})` : '') +
    ` — ${hint}. Precedence: ${SLASH_PRECEDENCE_DOC}.`
  );
}
