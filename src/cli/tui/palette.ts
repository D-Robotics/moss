/**
 * Slash-command palette — typing `/` in the composer opens a filtered menu of
 * commands with their descriptions, like the reference CLIs. It is a pure
 * projection over the command tables the REPL already owns
 * (`commandRowsForSlashInput`), so the shell and the REPL can never disagree
 * about which commands exist or what they do.
 */
import { commandRowsForSlashInput } from '../interactive-commands.js';
import { clip, line, padEndTo, displayWidth, type TuiColor, type TuiLine } from './text.js';

export type PaletteRow = readonly [command: string, description: string];

export const PALETTE_MAX_ROWS = 8;

/**
 * Rows for the palette, or [] when it should stay closed. The menu is only
 * active while the user is still typing the command NAME (`/comp`), not after
 * arguments start (`/rewind 1`) — the same boundary the REPL's completer uses.
 */
export function slashPaletteRows(
  value: string,
  extra: ReadonlyArray<PaletteRow> = []
): PaletteRow[] {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('/')) return [];
  if (trimmed.includes(' ')) return [];
  return commandRowsForSlashInput(trimmed, extra);
}

export interface PaletteOptions {
  width: number;
  selected: number;
  maxRows?: number;
  /** Colour for the selected row. */
  accent?: TuiColor;
  /**
   * The text after `/` the user has typed so far. Matched characters of each
   * command name are rendered bold (reference §3), so the user can see WHY a
   * fuzzy result like `/cmp → /compact` ranked in.
   */
  query?: string;
}

/**
 * Character offsets (into `command`, leading `/` included) that the query
 * matched, using the same subsequence walk as the ranker. Empty set when the
 * query is empty or not a subsequence (a filtered-in row always matches, but
 * the unfiltered `/` menu has no query to bold).
 */
function matchPositions(command: string, query: string): Set<number> {
  const positions = new Set<number>();
  const q = query.replace(/^\//, '').toLowerCase();
  if (!q) return positions;
  const offset = command.startsWith('/') ? 1 : 0;
  const cand = command.slice(offset).toLowerCase();
  let ci = 0;
  for (const ch of q) {
    let found = -1;
    while (ci < cand.length) {
      if (cand[ci] === ch) {
        found = ci;
        ci += 1;
        break;
      }
      ci += 1;
    }
    if (found === -1) return new Set();
    positions.add(offset + found);
  }
  return positions;
}

/** Runs for `❯ /compact   description`, bolding the query-matched name chars. */
function paletteRowRuns(
  command: string,
  description: string,
  commandWidth: number,
  marker: string,
  matched: Set<number>
): NonNullable<TuiLine['runs']> {
  const label = padEndTo(command, commandWidth);
  const runs: NonNullable<TuiLine['runs']> = [{ text: marker }];
  // Group consecutive same-style characters so a 9-char name is 2 runs, not 9.
  let buf = '';
  let bufBold: boolean | undefined;
  for (let i = 0; i < label.length; i += 1) {
    const bold = matched.has(i);
    if (bufBold !== undefined && bold !== bufBold) {
      runs.push({ text: buf, ...(bufBold ? { bold: true } : {}) });
      buf = '';
    }
    bufBold = bold;
    buf += label[i];
  }
  runs.push({ text: buf, ...(bufBold ? { bold: true } : {}) });
  if (description) runs.push({ text: description });
  return runs;
}

export function renderSlashPalette(
  rows: readonly PaletteRow[],
  options: PaletteOptions
): TuiLine[] {
  if (rows.length === 0) return [];
  const maxRows = Math.max(1, options.maxRows ?? PALETTE_MAX_ROWS);
  const visible = rows.slice(0, maxRows);
  const commandWidth =
    Math.min(
      30,
      visible.reduce((widest, [command]) => Math.max(widest, displayWidth(command)), 0) + 2
    ) || 2;
  const selected = Math.max(0, Math.min(options.selected, visible.length - 1));
  const out: TuiLine[] = visible.map(([command, description], index) => {
    const marker = index === selected ? '❯ ' : '  ';
    const label = padEndTo(command, commandWidth);
    const text = `${marker}${label}${description}`;
    const selectedRow = index === selected;
    const base = selectedRow
      ? { color: options.accent ?? ('cyan' as const), bold: true }
      : { dim: true };
    // Runs only when they can stay exact: a clipped row falls back to plain
    // text (runs must concatenate back to the line's text).
    if (options.query && clip(text, options.width) === text) {
      const matched = matchPositions(command, options.query);
      if (matched.size > 0) {
        return {
          text,
          ...base,
          runs: paletteRowRuns(command, description, commandWidth, marker, matched),
        };
      }
    }
    return line(clip(text, options.width), base);
  });
  if (rows.length > visible.length) {
    out.push(line(clip(`  … ${rows.length - visible.length} more`, options.width), { dim: true }));
  }
  return out;
}

/** Move the palette selection, clamped (wrapping at the ends). */
export function movePaletteSelection(selected: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  const next = selected + delta;
  if (next < 0) return count - 1;
  if (next >= count) return 0;
  return next;
}

/** The command a Tab/Enter should act on. */
export function paletteCommand(row: PaletteRow | undefined): string | undefined {
  return row?.[0];
}
