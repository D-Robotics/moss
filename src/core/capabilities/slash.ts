/**
 * Slash-namespace precedence.
 *
 * One typed line can name three different things: a built-in command, a file
 * command under `.moss/commands`, or a skill surfaced as `/skill-name`. Before
 * this module the order was encoded in the shape of `resolveUserCommand`: a
 * builtin `Set` check, then `Array.find` over commands, then `Array.find` over
 * skills. The order worked, but it was invisible — a user could not tell which
 * `/name` would win, and a skill shadowed by a command failed silently.
 *
 * The precedence is now data: workspace beats user for the same kind, a command
 * beats a skill with the same name, and a built-in always wins (its names are
 * reserved at load time, so a file cannot take one). `resolveSlashEntry` returns
 * both the winner and everything it shadowed so the host can say so once instead
 * of leaving a dead skill in the catalog.
 */

export type SlashEntryKind = 'builtin' | 'command' | 'skill';
export type SlashEntryScope = 'builtin' | 'workspace' | 'user';

export interface SlashEntry {
  kind: SlashEntryKind;
  /** Bare name, no leading slash, lower-case preserved for display. */
  name: string;
  scope: SlashEntryScope;
  /** File or origin, for conflict messages. */
  source?: string;
}

/** Smaller rank wins. A built-in never loses; workspace outranks user; a command outranks a skill. */
export function slashEntryRank(entry: SlashEntry): number {
  const order: Record<SlashEntryKind, number> = { builtin: -2, command: 0, skill: 2 };
  const scopeRank = entry.scope === 'workspace' ? 0 : entry.scope === 'user' ? 1 : -1;
  return order[entry.kind] + scopeRank;
}

export function slashEntryLabel(entry: SlashEntry): string {
  return entry.scope === 'builtin' ? 'built-in' : `${entry.kind} (${entry.scope})`;
}

function normalizeSlashName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

export interface SlashResolution {
  winner?: SlashEntry;
  shadowed: SlashEntry[];
}

/**
 * Resolve one slash name. Entries whose name does not match are ignored; ties are
 * impossible because rank is a total order over (kind, scope) and the loader
 * deduplicates within a kind.
 */
export function resolveSlashEntry(name: string, entries: readonly SlashEntry[]): SlashResolution {
  const head = normalizeSlashName(name);
  if (!head) return { shadowed: [] };
  const matches = entries
    .filter((entry) => normalizeSlashName(entry.name) === head)
    .sort((a, b) => slashEntryRank(a) - slashEntryRank(b));
  const [winner, ...shadowed] = matches;
  return winner ? { winner, shadowed } : { shadowed: [] };
}

export interface SlashConflict {
  winner: SlashEntry;
  losers: SlashEntry[];
}

/**
 * Every name claimed by more than one entry, with the winner. Used once at load
 * time to tell the user that, say, a skill is shadowed by a workspace command.
 */
export function findSlashConflicts(entries: readonly SlashEntry[]): SlashConflict[] {
  const byName = new Map<string, SlashEntry[]>();
  for (const entry of entries) {
    const key = normalizeSlashName(entry.name);
    if (!key) continue;
    const bucket = byName.get(key);
    if (bucket) bucket.push(entry);
    else byName.set(key, [entry]);
  }
  const conflicts: SlashConflict[] = [];
  for (const bucket of byName.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => slashEntryRank(a) - slashEntryRank(b));
    const [winner, ...losers] = sorted;
    if (winner) conflicts.push({ winner, losers });
  }
  return conflicts;
}

/** The documented precedence, for help text and reports. */
export const SLASH_PRECEDENCE_DOC =
  'builtin command > workspace command > user command > workspace skill > user skill';
