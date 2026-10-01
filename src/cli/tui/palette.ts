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
    return index === selected
      ? line(clip(text, options.width), { color: options.accent ?? 'cyan', bold: true })
      : line(clip(text, options.width), { dim: true });
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
