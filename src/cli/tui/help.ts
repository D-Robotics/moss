import { rowsForSurface, type InteractiveCommandRow } from '../interactive-commands.js';

/**
 * The key/command reference. Single source of truth: the input handler and the
 * `?` help block both read these tables, so the shell can never advertise a
 * shortcut nothing listens for.
 *
 * Ctrl+H is deliberately absent — every terminal delivers it as 0x08 and ink
 * reports that as Backspace with `key.ctrl` unset
 * (node_modules/ink/build/parse-keypress.js: name = 'backspace' for '\b'), so it
 * is unreachable. History rides Ctrl+R instead.
 */
export const CTRL_BINDINGS = [
  // Task artifacts are slash commands (`/tasks`, `/evidence`, `/failures`,
  // `/deployments`). Ctrl+R searches prompts; Ctrl+G opens $EDITOR.
  { letter: 'l', action: 'clear', label: 'clear the composer' },
] as const;

export type CtrlAction = (typeof CTRL_BINDINGS)[number]['action'];

export function ctrlBinding(letter: string): CtrlAction | undefined {
  return CTRL_BINDINGS.find((binding) => binding.letter === letter)?.action;
}

export function ctrlHintFor(action: CtrlAction): string | undefined {
  const binding = CTRL_BINDINGS.find((candidate) => candidate.action === action);
  return binding ? `Ctrl+${binding.letter.toUpperCase()}` : undefined;
}

export const HELP_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', 'send the goal · run the shell command in `!` mode'],
  ['Shift+Tab', 'cycle the interaction mode (default → accept-edits → plan)'],
  ['!', 'first character only: run a shell command inline'],
  ['Esc', 'interrupt the run · cancel `!` shell mode · press again to clear the composer'],
  ['↑ ↓', 'walk back through what you typed'],
  ['Ctrl+A / Ctrl+E', 'caret to line start / end'],
  ['Ctrl+U / Ctrl+Y', 'delete to line start · paste deleted text'],
  ['Ctrl+S', 'stash the draft · press again to bring it back'],
  ['Ctrl+R', 'search your earlier prompts'],
  ['Ctrl+G', 'edit the draft in $EDITOR'],
  ['PgUp / PgDn', 'scroll the transcript'],
  ['Ctrl+C', 'interrupt the run · press again to quit'],
  ['Ctrl+D', 'quit'],
  ['Ctrl+L', 'clear the composer'],
  ['/tasks /evidence /failures', 'print task artifacts'],
  ['?', 'this list'],
];

/**
 * The three input prefixes, documented exactly once (R1 §5 / target-spec §E6):
 * `!` shell, `/` commands, `@` paths. Each is dispatched in `app.ts` — nothing
 * here may advertise a prefix the shell does not route.
 */
export const HELP_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['!', 'run a shell command inline (result lands in the transcript)'],
  ['/', 'run a moss command (/help lists them all)'],
  ['@', 'reference a workspace file or directory'],
];

/** One entry of the shell's command surface. */
export interface ShellCommand {
  /** Bare token the palette inserts and `app.ts` dispatches, e.g. `/status`. */
  readonly command: string;
  /** Usage form `/help` prints, e.g. `/resume [id]`. */
  readonly usage: string;
  /** One-line description, printed by the `/` palette next to the name. */
  readonly description: string;
}

/**
 * THE advertised command surface — derived from the one command catalog
 * (`interactive-commands.ts`), taking the rows that answer on `tui`. Three
 * consumers read this table:
 *
 *   - `HELP_COMMANDS` (below) is what `/help` and `?` print,
 *   - `SHELL_COMMAND_ROWS` feeds the `/` palette (`shellPaletteRows` in `app.ts`),
 *   - `SHELL_COMMAND_NAMES` is the guard that keeps the palette from offering
 *     anything else.
 *
 * Adding a command to the catalog advertises it everywhere at once, and
 * `test/tui-command-surface.spec.mjs` fails if any entry answers "unknown
 * command" or is missing from the palette for its own prefix.
 */
function toShellCommand(row: InteractiveCommandRow): ShellCommand {
  return {
    command: row.command,
    usage: row.args ? `${row.command} ${row.args}` : row.command,
    description: row.description,
  };
}

/** Everyday `/` menu and compact help. Hidden catalog rows are omitted. */
export const SHELL_COMMANDS: readonly ShellCommand[] = rowsForSurface('tui')
  .filter((row) => !row.hidden)
  .map(toShellCommand);

/** `/help --all`: every TUI command that still dispatches, including hidden ones. */
export const ALL_SHELL_COMMANDS: readonly ShellCommand[] =
  rowsForSurface('tui').map(toShellCommand);

/** `/help` and `?` print these; the bare name is what the shell dispatches. */
export const HELP_COMMANDS: readonly string[] = SHELL_COMMANDS.map((entry) => entry.usage);

/** Palette rows (`command`, `description`) sourced from the table above. */
export const SHELL_COMMAND_ROWS: ReadonlyArray<readonly [string, string]> = SHELL_COMMANDS.map(
  (entry) => [entry.command, entry.description] as const
);

/** Bare names the shell answers — everything else is filtered out of the menu. */
export const SHELL_COMMAND_NAMES: readonly string[] = SHELL_COMMANDS.map((entry) => entry.command);
