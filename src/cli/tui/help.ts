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
  { letter: 't', action: 'tasks', label: 'tasks' },
  { letter: 'r', action: 'history', label: 'history' },
  // Evidence rides Ctrl+V, not Ctrl+E: in the reference CLI (and readline
  // muscle memory) Ctrl+E moves the composer caret to the end of the line,
  // and that editing key wins over a panel shortcut that /evidence also has.
  { letter: 'v', action: 'evidence', label: 'evidence' },
  { letter: 'g', action: 'deployments', label: 'deployments' },
  { letter: 'f', action: 'failures', label: 'failures' },
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

function chordRow(actions: readonly CtrlAction[]): string {
  return `Ctrl+${actions
    .map((action) =>
      CTRL_BINDINGS.find((binding) => binding.action === action)?.letter.toUpperCase()
    )
    .join(' ')}`;
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
  ['Ctrl+C', 'interrupt the run · press again to quit'],
  ['Ctrl+D', 'quit'],
  [chordRow(['tasks', 'history', 'evidence']), 'print tasks · history · evidence'],
  [chordRow(['deployments', 'failures']), 'print deployments · failures'],
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
 * THE advertised command surface — one table, three consumers:
 *
 *   - `HELP_COMMANDS` (below) is what `/help` and `?` print,
 *   - `SHELL_COMMAND_ROWS` feeds the `/` palette (`shellPaletteRows` in `app.ts`),
 *   - `SHELL_COMMAND_NAMES` is the guard that keeps the palette from offering
 *     anything else (the REPL table `interactive-commands.ts` is a superset:
 *     `/loop`, `/goal`, `/task`, `/init` are still REPL/headless-only).
 *
 * Adding a command here advertises it in both places at once, and
 * `test/tui-command-surface.spec.mjs` fails if any entry answers "unknown
 * command" or is missing from the palette for its own prefix.
 */
export const SHELL_COMMANDS: readonly ShellCommand[] = [
  { command: '/help', usage: '/help', description: 'show this key and command reference' },
  { command: '/quit', usage: '/quit', description: 'exit moss' },
  {
    command: '/clear',
    usage: '/clear',
    description: 'clear the transcript (banner stays; the model context is kept)',
  },
  {
    command: '/status',
    usage: '/status',
    description: 'view model, workspace, and tool state',
  },
  {
    command: '/model',
    usage: '/model [name|number]',
    description: 'choose or switch the active model for this session',
  },
  {
    command: '/mode',
    usage: '/mode [plan|default|accept-edits]',
    description: 'show or set interaction mode (plan = read-only planning; Shift+Tab cycles)',
  },
  {
    command: '/permissions',
    usage: '/permissions',
    description: 'show safety mode, approval policy, and permissions',
  },
  {
    command: '/doctor',
    usage: '/doctor',
    description: 'health-check model, egress, and config in this session',
  },
  {
    command: '/context',
    usage: '/context',
    description: 'show current context-window usage',
  },
  {
    command: '/compact',
    usage: '/compact [instructions]',
    description: 'compress older conversation history into a summary',
  },
  { command: '/diff', usage: '/diff', description: 'show git working-tree changes' },
  {
    command: '/review',
    usage: '/review [PR#]',
    description: 'review the working-tree diff (or a GitHub PR) for bugs and security',
  },
  {
    command: '/export',
    usage: '/export [path]',
    description: 'export this session to markdown (path optional; - prints to stdout)',
  },
  {
    command: '/quickstart',
    usage: '/quickstart',
    description: 'show setup and next-steps guidance',
  },
  {
    command: '/usage',
    usage: '/usage',
    description: 'show cumulative token usage for this session',
  },
  {
    command: '/log',
    usage: '/log',
    description: 'show this session\u2019s on-disk conversation and run-event logs',
  },
  { command: '/stop', usage: '/stop', description: 'interrupt the active run' },
  { command: '/tasks', usage: '/tasks', description: 'print the task-runtime tasks' },
  {
    command: '/history',
    usage: '/history',
    description: 'print the lifecycle timeline of each task',
  },
  { command: '/evidence', usage: '/evidence', description: 'print recorded acceptance evidence' },
  { command: '/deployments', usage: '/deployments', description: 'print device deployments' },
  { command: '/failures', usage: '/failures', description: 'print recorded task failures' },
  {
    command: '/resume',
    usage: '/resume [id]',
    description: 'stage a prompt that resumes the task runtime',
  },
  {
    command: '/rewind',
    usage: '/rewind [seq]',
    description: 'undo file edits from a checkpoint',
  },
  {
    command: '/queue',
    usage: '/queue [pause|resume|drop|clear]',
    description: 'inspect or control the input queue',
  },
  {
    command: '/steer',
    usage: '/steer <constraint>',
    description: 'inject a constraint into the live run',
  },
  { command: '/bg', usage: '/bg', description: 'list background shell tasks' },
  { command: '/subs', usage: '/subs', description: 'list background sub-agent tasks' },
  { command: '/sessions', usage: '/sessions', description: 'list saved conversations' },
  { command: '/mcp', usage: '/mcp', description: 'list MCP server status' },
];

/** `/help` and `?` print these; the bare name is what the shell dispatches. */
export const HELP_COMMANDS: readonly string[] = SHELL_COMMANDS.map((entry) => entry.usage);

/** Palette rows (`command`, `description`) sourced from the table above. */
export const SHELL_COMMAND_ROWS: ReadonlyArray<readonly [string, string]> = SHELL_COMMANDS.map(
  (entry) => [entry.command, entry.description] as const
);

/** Bare names the shell answers — everything else is filtered out of the menu. */
export const SHELL_COMMAND_NAMES: readonly string[] = SHELL_COMMANDS.map((entry) => entry.command);
