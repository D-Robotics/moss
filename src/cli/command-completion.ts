import { INTERACTIVE_COMPLETION_COMMANDS } from './interactive-commands.js';

export const KNOWN_COMMANDS = INTERACTIVE_COMPLETION_COMMANDS;

/**
 * Up to `limit` registered commands closest to `token`, prefix matches first,
 * then edit distance. Exact matches are omitted. A pure edit-distance hit has
 * to be within 3 edits so an unrelated name is not offered.
 */
export function closestSlashCommands(
  token: string,
  candidates: readonly string[],
  limit = 3
): string[] {
  const query = token.trim().toLowerCase().replace(/^\//, '');
  if (!query || limit <= 0) return [];
  const unique = [
    ...new Set(
      candidates.map((candidate) => (candidate.startsWith('/') ? candidate : `/${candidate}`))
    ),
  ];
  const ranked = unique
    .map((candidate) => {
      const name = candidate.slice(1).toLowerCase();
      if (!name || name === query) return undefined;
      const prefix = name.startsWith(query);
      const distance = editDistance(name, query);
      if (!prefix && distance > 3) return undefined;
      // `/tmp` is three edits from `/help`. A very short token only suggests a
      // prefix, or a one-edit typo. Longer tokens still allow up to 3 edits.
      if (!prefix && query.length < 4 && distance > 1) return undefined;
      return { candidate, prefix, distance };
    })
    .filter(
      (item): item is { candidate: string; prefix: boolean; distance: number } => item !== undefined
    )
    .sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) ||
        a.distance - b.distance ||
        a.candidate.localeCompare(b.candidate)
    );
  return ranked.slice(0, limit).map((item) => item.candidate);
}

export function commandSuggestion(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized.startsWith('/')) return null;
  const firstMeaningfulChar = normalized.replace(/^\//, '')[0] ?? '';
  const preferSubcommand = normalized.includes(' ');
  const scored = KNOWN_COMMANDS.map((known, index) => {
    const prefixMatch = known.startsWith(normalized) || normalized.startsWith(known);
    if (prefixMatch) return { known, score: 0, prefixMatch, index };
    const knownToken = known.replace(/^\//, '');
    const knownFirstChar = knownToken[0] ?? '';
    if (!firstMeaningfulChar || knownFirstChar !== firstMeaningfulChar) {
      return { known, score: Number.POSITIVE_INFINITY, prefixMatch, index };
    }
    const score = editDistance(known, normalized);
    return { known, score, prefixMatch, index };
  }).sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.prefixMatch) - Number(a.prefixMatch) ||
      (a.prefixMatch && b.prefixMatch
        ? preferSubcommand
          ? b.known.length - a.known.length
          : a.index - b.index
        : a.index - b.index)
  );
  const best = scored[0];
  return best && best.score <= 2 ? best.known : null;
}

export function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost
      );
    }
  }
  return rows[a.length]![b.length]!;
}
