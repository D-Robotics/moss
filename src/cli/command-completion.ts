import { INTERACTIVE_COMPLETION_COMMANDS } from './interactive-commands.js';
import { clampPromptCursor, type PromptEditState } from './prompt-editor.js';

export const KNOWN_COMMANDS = INTERACTIVE_COMPLETION_COMMANDS;

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

export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] || '';
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function completeSlashCommandInput(value: string, cursor: number): PromptEditState | null {
  const currentCursor = clampPromptCursor(value, cursor);
  const beforeCursor = value.slice(0, currentCursor);
  const afterCursor = value.slice(currentCursor);
  if (!beforeCursor.startsWith('/')) return null;
  if (afterCursor && !/^\s/.test(afterCursor)) return null;

  const normalized = beforeCursor.toLowerCase();
  const exactCandidates = KNOWN_COMMANDS.filter((command) => command.startsWith(normalized));
  if (/\s/.test(beforeCursor) && exactCandidates.length === 0) return null;
  const prefixCompletion = exactCandidates.length > 0 ? commonPrefix(exactCandidates) : '';
  const completion =
    prefixCompletion && prefixCompletion !== beforeCursor
      ? prefixCompletion
      : beforeCursor.length >= 4
        ? commandSuggestion(normalized)
        : prefixCompletion;
  if (!completion || completion === beforeCursor) return null;
  return {
    value: `${completion}${afterCursor}`,
    cursor: completion.length,
  };
}

export function commandArgumentHint(value: string): string | null {
  const normalized = value.trimStart().toLowerCase();
  if (!normalized.startsWith('/')) return null;
  const [command, ...rest] = normalized.split(/\s+/);
  const hasArg = rest.some(Boolean);
  if (command === '/attach') return hasArg ? null : '<image-or-text-file>';
  if (command === '/model') return hasArg ? null : '<model-name-or-number>';
  if (command === '/auth') return hasArg ? null : '[status | logout]';
  if (command === '/status') return hasArg ? null : '[--verbose]';
  if (command === '/compact') return hasArg ? null : '[instructions]';
  if (command === '/steer') return hasArg ? null : '<constraint>';
  return null;
}
