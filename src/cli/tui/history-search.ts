/**
 * Ctrl+R prompt search (A2.22): a query box plus a filtered list of the
 * session's submitted prompts, mirroring the reference's search overlay.
 * Pure projection — the shell owns the state machine.
 */
import { clip, line, type TuiLine } from './text.js';

export const HISTORY_SEARCH_MAX_ROWS = 6;

export interface HistorySearchOptions {
  width: number;
  selected: number;
  maxRows?: number;
}

/** Case-insensitive substring match, newest first, deduplicated. */
export function filterHistory(
  entries: readonly string[],
  query: string,
  max = HISTORY_SEARCH_MAX_ROWS
): string[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...entries].reverse()) {
    const text = entry.trim();
    if (!text || seen.has(text)) continue;
    if (q && !text.toLowerCase().includes(q)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export function renderHistorySearch(
  query: string,
  matches: readonly string[],
  options: HistorySearchOptions
): TuiLine[] {
  const maxRows = Math.max(1, options.maxRows ?? HISTORY_SEARCH_MAX_ROWS);
  const out: TuiLine[] = [line(clip(`⌕ ${query}▌`, options.width), { color: 'cyan', bold: true })];
  const selected = Math.max(0, Math.min(options.selected, matches.length - 1));
  matches.slice(0, maxRows).forEach((match, index) => {
    out.push(
      line(
        clip(
          `${index === selected ? '❯ ' : '  '}${match.replace(/\s+/g, ' ').slice(0, 72)}`,
          options.width
        ),
        index === selected ? { bold: true } : { dim: true }
      )
    );
  });
  if (matches.length > maxRows) {
    out.push(line(clip(`  … ${matches.length - maxRows} more`, options.width), { dim: true }));
  }
  if (matches.length === 0) {
    out.push(line(clip('  no matching prompt', options.width), { dim: true }));
  }
  out.push(line(clip('  ↑/↓ to nav · Enter to use · Esc to cancel', options.width), { dim: true }));
  return out;
}
