import { isZhLocale } from './cli-locale.js';

/**
 * THE command catalog — one table both interaction surfaces derive from:
 *
 *   - the readline REPL (help sections, slash menu, completion) takes the rows
 *     available on the `repl` surface (`REPL_COMMAND_SECTIONS`,
 *     `SLASH_MENU_ROWS`, `INTERACTIVE_COMPLETION_COMMANDS`),
 *   - the TUI shell (`src/cli/tui/help.ts`) takes the `tui` rows and derives
 *     `SHELL_COMMANDS` (help overlay, `?` keys, `/` palette).
 *
 * A command lives in exactly one row — name, argument hint, description, and
 * surface availability — so wording and availability cannot drift between the
 * REPL and the TUI. `test/cli-interactive-commands.spec.mjs` locks the two
 * derivations together.
 */
export type CommandSurface = 'repl' | 'tui';

/** What a command does when a run is already in flight. */
export type RunAvailability = 'immediate' | 'queue' | 'reject';

export interface InteractiveCommandRow {
  /** Bare token both surfaces dispatch, e.g. `/goal`. */
  command: string;

  /** Usage hint printed after the command, e.g. `[plan|default|accept-edits]`. */
  args?: string;

  description: string;

  menuDescription?: string;

  aliases?: readonly string[];

  /** Rank the command out of the everyday menu. It still dispatches when typed. */
  hidden?: boolean;

  /** Surfaces the command answers on; default: both. */
  surfaces?: readonly CommandSurface[];

  /** Required: running-turn policy, aligned with Codex `available_during_task`. */
  availableDuringRun: RunAvailability;
}

export interface InteractiveCommandSection {
  title: string;

  rows: InteractiveCommandRow[];
}

export const INTERACTIVE_COMMAND_SECTIONS: readonly InteractiveCommandSection[] = [
  {
    title: 'Work',
    rows: [
      {
        command: '/status',
        description: 'view model, workspace, and tool state',
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/model',
        args: '[name|number]',
        description: 'choose or switch the active model for this session',
        availableDuringRun: 'immediate',
      },
      {
        command: '/compact',
        args: '[instructions]',
        description: 'compress older conversation history into a summary',
        availableDuringRun: 'reject',
      },
      {
        command: '/goal',
        args: '<condition> | clear',
        description: 'work until a condition is met; /goal clear cancels',
        availableDuringRun: 'queue',
      },
      {
        command: '/plan',
        args: '[description]',
        description: 'enter plan mode; with a description, start planning immediately',
        availableDuringRun: 'reject',
      },
      {
        command: '/review',
        args: '[PR#]',
        description: 'review the working-tree diff (or a GitHub PR) for bugs and security',
        availableDuringRun: 'reject',
      },
      {
        command: '/task',
        args: 'status|timeline|resume|view|verify',
        description:
          'Task OS entry (hidden): status, timeline, resume, view, and verify — everyday work is /goal',
        hidden: true,
        availableDuringRun: 'queue',
      },
      {
        command: '/context',
        description: 'show current context-window usage',
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/usage',
        description: 'show cumulative token usage for this session',
        aliases: ['/cost', '/stats'],
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/export',
        args: '[path]',
        description: 'export this session to markdown (path optional; - prints to stdout)',
        hidden: true,
        availableDuringRun: 'queue',
      },
    ],
  },
  {
    title: 'Inspect',
    rows: [
      {
        command: '/doctor',
        description: 'health-check model, egress, and config in this session',
        availableDuringRun: 'immediate',
      },
      {
        command: '/diff',
        description: 'show git working-tree changes',
        availableDuringRun: 'immediate',
      },
      {
        command: '/resume',
        args: '[id|name]',
        description: 'resume a saved conversation',
        availableDuringRun: 'queue',
      },
      {
        command: '/rewind',
        args: '[seq]',
        description: 'undo file edits from a checkpoint',
        aliases: ['/undo', '/checkpoint'],
        hidden: true,
        availableDuringRun: 'queue',
      },
      {
        command: '/mcp',
        description: 'list MCP server status',
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/skills',
        description: 'list discovered skills; create more with moss skill create',
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/agents',
        description: 'list file-defined sub-agents with source paths and warnings',
        availableDuringRun: 'immediate',
      },
      {
        command: '/tasks',
        description: 'list background shell and sub-agent jobs',
        aliases: ['/ps', '/bashes'],
        hidden: true,
        availableDuringRun: 'immediate',
      },
    ],
  },
  {
    title: 'Configure',
    rows: [
      {
        command: '/permissions',
        args: '[--verbose]',
        description: 'show safety and approval settings; --verbose prints every knob',
        availableDuringRun: 'immediate',
      },
      {
        command: '/theme',
        args: '[dark|light|mono]',
        description: 'show or set the terminal colour theme for this session',
        // The readline REPL has no theme chrome. Advertising it there makes
        // `/theme` an unknown command (U2).
        surfaces: ['tui'],
        availableDuringRun: 'immediate',
      },
      {
        command: '/mode',
        args: '[manual|accept-edits|plan|full]',
        description: 'show or set interaction mode (plan = read-only planning; Shift+Tab cycles)',
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/hooks',
        description: 'list configured lifecycle hooks and where to edit them',
        hidden: true,
        availableDuringRun: 'immediate',
      },
    ],
  },
  {
    title: 'Control',
    rows: [
      {
        command: '/stop',
        description: 'stop background processes; Esc interrupts the current run',
        aliases: ['/abort'],
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/init',
        description: 'create or update an AGENTS.md project memory file',
        hidden: true,
        availableDuringRun: 'reject',
      },
      {
        command: '/clear',
        description: 'start a new conversation with an empty context',
        aliases: ['/new', '/reset'],
        availableDuringRun: 'reject',
      },
      {
        command: '/quit',
        description: 'exit moss',
        aliases: ['/exit'],
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/help',
        description: 'show the key and command reference',
        availableDuringRun: 'immediate',
      },
      {
        command: '/queue',
        args: '[pause|resume|drop|clear]',
        description: 'inspect or control the input queue',
        hidden: true,
        availableDuringRun: 'immediate',
      },
      {
        command: '/steer',
        args: '<constraint>',
        description: 'inject a constraint into the live run',
        hidden: true,
        availableDuringRun: 'immediate',
      },
    ],
  },
] as const;

/**
 * Retired names. Checked before catalog aliases so a moss-only name can print
 * a one-line migration and then run the canonical command. `/loop` is the
 * exception: it only suggests `/goal` and does not run. Silent aliases
 * (`/cost`, `/new`, `/ps`, …) live on the row and are not listed here.
 * `replaceAll` drops any trailing args (`/history extra` → `/task view history`).
 */
const RETIRED_SLASH: Readonly<
  Record<string, { command: string; migration: string; replaceAll?: boolean; suggest?: boolean }>
> = {
  '/loop': { command: '/goal', migration: '', suggest: true },
  '/jobs': { command: '/tasks', migration: '/jobs is now /tasks.' },
  '/bg': { command: '/tasks', migration: '/bg is now /tasks.' },
  '/subs': { command: '/tasks', migration: '/subs is now /tasks.' },
  '/history': {
    command: '/task view history',
    migration: '/history is now /task view history.',
    replaceAll: true,
  },
  '/evidence': {
    command: '/task view evidence',
    migration: '/evidence is now /task view evidence.',
    replaceAll: true,
  },
  '/deployments': {
    command: '/task view deployments',
    migration: '/deployments is now /task view deployments.',
    replaceAll: true,
  },
  '/failures': {
    command: '/task view failures',
    migration: '/failures is now /task view failures.',
    replaceAll: true,
  },
  '/sessions': { command: '/resume', migration: '/sessions is now /resume.' },
  '/mode': {
    command: '/mode',
    migration:
      'Switch modes with Shift+Tab, /plan, or /permissions. /mode remains for one version.',
  },
  '/steer': {
    command: '/steer',
    migration: 'A message sent during a run steers it. /steer remains as a hidden alias.',
  },
  '/queue': {
    command: '/queue',
    migration:
      'A message sent during a run queues when it cannot steer. /queue remains as a hidden alias.',
  },
};

function catalogRows(): readonly InteractiveCommandRow[] {
  return INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows);
}

export interface SlashRewrite {
  text: string;
  migration?: string;
  /**
   * When set, the shell must not dispatch `text`. Show `migration` and put
   * this line in the composer for the user to confirm or edit.
   */
  suggestion?: string;
}

const LOOP_EXAMPLE_EN = '/goal make the tests pass';
const LOOP_EXAMPLE_ZH = '/goal 让测试通过';

/**
 * `/loop` is now `/goal`. One localized line, plus the `/goal` command the
 * user confirms or edits. Arguments are kept as the example. The line names
 * only `/loop` and `/goal`.
 */
export function loopRetirement(
  args: string,
  locale?: string
): { notice: string; suggestion: string } {
  const zh = isZhLocale(locale);
  const trimmed = args.trim();
  const example = zh ? LOOP_EXAMPLE_ZH : LOOP_EXAMPLE_EN;
  const suggestion = trimmed.length > 0 ? `/goal ${trimmed}` : example;
  const notice = zh
    ? `/loop 已改为 /goal。例如：${suggestion}`
    : `/loop is now /goal. Example: ${suggestion}`;
  return { notice, suggestion };
}

/**
 * True when the first token is a command the shell dispatches even if the
 * everyday menu's fuzzy match would highlight something else. Hidden aliases
 * (`/mode` beside `/model`) and retired names (`/loop`) must run as typed.
 */
export function isExactSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return false;
  const head = (trimmed.split(/\s+/, 1)[0] ?? trimmed).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(RETIRED_SLASH, head)) return true;
  return catalogRows().some((row) => row.command === head || (row.aliases ?? []).includes(head));
}

/** Map a typed slash line onto the canonical command, once. */
export function rewriteSlashInput(input: string, locale?: string): SlashRewrite {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { text: trimmed };
  const rawHead = trimmed.split(/\s+/, 1)[0] ?? trimmed;
  const head = rawHead.toLowerCase();
  const args = trimmed.slice(rawHead.length).trim();
  const retired = RETIRED_SLASH[head];
  if (retired?.suggest) {
    const { notice, suggestion } = loopRetirement(args, locale);
    return { text: trimmed, migration: notice, suggestion };
  }
  if (retired) {
    const text = retired.replaceAll
      ? retired.command
      : `${retired.command}${args ? ` ${args}` : ''}`;
    return { text, migration: retired.migration };
  }
  for (const row of catalogRows()) {
    if (row.aliases?.some((alias) => alias.toLowerCase() === head)) {
      return { text: `${row.command}${args ? ` ${args}` : ''}` };
    }
  }
  return { text: trimmed };
}

/** Running-turn policy for a typed command (aliases resolved first). */
export function availabilityFor(input: string): RunAvailability {
  const rewritten = rewriteSlashInput(input.startsWith('/') ? input : `/${input}`);
  const head = (rewritten.text.split(/\s+/, 1)[0] ?? '').toLowerCase();
  const row = catalogRows().find((entry) => entry.command === head);
  return row?.availableDuringRun ?? 'queue';
}

/** Lines for `/help --all`: silent aliases and retired names. */
export function slashAliasHelpLines(locale?: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const row of catalogRows()) {
    for (const alias of row.aliases ?? []) {
      seen.add(alias);
      lines.push(`  ${alias.padEnd(24)} alias of ${row.command}`);
    }
  }
  for (const [name, spec] of Object.entries(RETIRED_SLASH)) {
    if (seen.has(name)) continue;
    const detail = spec.suggest ? loopRetirement('', locale).notice : spec.migration;
    lines.push(`  ${name.padEnd(24)} ${detail}`);
  }
  return lines;
}

function availableOn(row: InteractiveCommandRow, surface: CommandSurface): boolean {
  return !row.surfaces || row.surfaces.includes(surface);
}

/** Catalog rows that answer on the given surface, in catalog order. */
export function rowsForSurface(surface: CommandSurface): readonly InteractiveCommandRow[] {
  return INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows).filter((row) =>
    availableOn(row, surface)
  );
}

/** The REPL's view of the catalog: sections with only repl-answerable rows. */
export const REPL_COMMAND_SECTIONS: readonly InteractiveCommandSection[] =
  INTERACTIVE_COMMAND_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.filter((row) => availableOn(row, 'repl')),
  })).filter((section) => section.rows.length > 0);

function uniqueMenuRows(): InteractiveCommandRow[] {
  // The slash menu is the everyday set. `hidden` rows stay in the catalog and
  // still dispatch when typed in full; they leave the menu, completion, and
  // did-you-mean so `/` is not a dump of every subsystem.
  const seen = new Set<string>();
  const common: InteractiveCommandRow[] = [];
  for (const row of rowsForSurface('repl')) {
    if (row.hidden || seen.has(row.command)) continue;
    seen.add(row.command);
    common.push({
      command: row.command,
      description: row.menuDescription ?? row.description,
      availableDuringRun: row.availableDuringRun,
      ...(row.aliases ? { aliases: row.aliases } : {}),
    });
  }
  return common;
}

export const SLASH_MENU_ROWS: readonly InteractiveCommandRow[] = uniqueMenuRows();

export const INTERACTIVE_COMPLETION_COMMANDS: readonly string[] = Array.from(
  new Set([
    ...SLASH_MENU_ROWS.map((row) => row.command),
    ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
  ])
);

/**
 * Subsequence-fuzzy match of `query` against `candidate` (both lowercased,
 * leading slash stripped). Returns a rank tuple `[tier, span, firstIndex]`
 * (lower = better) or null when `query`'s chars don't appear in order.
 * tier 0 = exact, 1 = prefix, 2 = subsequence; ties break on tighter spans,
 * then earliest first match, so e.g. `/cmp`→`/compact`, `/rsm`→`/resume`.
 * @internal
 */
function fuzzyCommandRank(candidate: string, query: string): [number, number, number] | null {
  const cand = candidate.replace(/^\//, '');
  const q = query.replace(/^\//, '');
  if (q.length === 0) return [1, 0, 0];
  if (cand === q) return [0, 0, 0];
  if (cand.startsWith(q)) return [1, q.length, 0];
  let ci = 0;
  let first = -1;
  let last = -1;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]!;
    let found = -1;
    while (ci < cand.length) {
      if (cand[ci] === ch) {
        found = ci;
        ci += 1;
        break;
      }
      ci += 1;
    }
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
  }
  return [2, last - first, first];
}

export function commandRowsForSlashInput(
  value: string,
  extra: ReadonlyArray<readonly [string, string]> = []
): Array<[string, string]> {
  if (!value.startsWith('/')) return [];
  const normalized = value.trim().toLowerCase();
  // Built-ins first, then file-based custom commands (.moss/commands/*.md).
  const rows: Array<[string, string]> = [
    ...SLASH_MENU_ROWS.map((row): [string, string] => [row.command, row.description]),
    ...extra.map(([command, description]): [string, string] => [command, description]),
  ];
  if (normalized === '/') return rows;
  // Fuzzy (subsequence) match, prefix-first. Keep original order as the final
  // tie-breaker so equally-ranked rows stay in their declared section order.
  const ranked: Array<{ row: [string, string]; rank: [number, number, number]; order: number }> =
    [];
  rows.forEach((row, order) => {
    const rank = fuzzyCommandRank(row[0].toLowerCase(), normalized);
    if (rank) ranked.push({ row, rank, order });
  });
  ranked.sort(
    (a, b) =>
      a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || a.order - b.order
  );
  return ranked.map((entry) => entry.row);
}

export function formatInteractiveCommandSections(
  options: {
    indent?: string;
    commandWidth?: number;
    includeHidden?: boolean;
  } = {}
): string[] {
  const indent = options.indent ?? '    ';
  const commandWidth = options.commandWidth ?? 23;
  const lines: string[] = [];
  for (const section of REPL_COMMAND_SECTIONS) {
    lines.push(`  ${section.title}`);
    for (const row of section.rows) {
      if (row.hidden && !options.includeHidden) continue;
      const usage = row.args ? `${row.command} ${row.args}` : row.command;
      lines.push(`${indent}${usage.padEnd(commandWidth)} ${row.description}`);
    }
  }
  return lines;
}
