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

export interface InteractiveCommandRow {
  /** Bare token both surfaces dispatch, e.g. `/mode`. */
  command: string;

  /** Usage hint printed after the command, e.g. `[plan|default|accept-edits]`. */
  args?: string;

  description: string;

  menuDescription?: string;

  aliases?: readonly string[];

  /** REPL only: rank the command after the common ones in menus/help. */
  hidden?: boolean;

  /** Surfaces the command answers on; default: both. */
  surfaces?: readonly CommandSurface[];
}

export interface InteractiveCommandSection {
  title: string;

  rows: InteractiveCommandRow[];
}

export const INTERACTIVE_COMMAND_SECTIONS: readonly InteractiveCommandSection[] = [
  {
    title: 'Work',
    rows: [
      { command: '/status', description: 'view model, workspace, and tool state' },
      {
        command: '/model',
        args: '[name|number]',
        description: 'choose or switch the active model for this session',
      },
      {
        command: '/mode',
        args: '[manual|accept-edits|plan|full]',
        description: 'show or set interaction mode (plan = read-only planning; Shift+Tab cycles)',
      },
      {
        command: '/compact',
        args: '[instructions]',
        description: 'compress older conversation history into a summary',
      },
      // One autonomous engine: /task run (plan → execute → verify → repair →
      // accept). /loop and /goal are dispatch-level compat aliases of it.
      {
        command: '/loop',
        args: '<goal>',
        description:
          'compat alias of /task run <goal> — Ctrl+C interrupts (resumable via /task resume); MOSS_LOOP_MAX becomes the turn budget',
        hidden: true,
        surfaces: ['repl'],
      },
      {
        command: '/goal',
        args: '<goal> --accept "<verification command>"',
        description:
          'compat alias of /task run <goal> --accept "<cmd>" — completes only when the command exits 0',
        hidden: true,
        surfaces: ['repl'],
      },
      {
        command: '/task',
        args: 'run|resume|status|timeline|view',
        description:
          'run or inspect a verified Task OS task; view [tasks|history|evidence|deployments|failures] prints its artifacts',
      },
      {
        command: '/resume',
        args: '[id]',
        description: 'resume a failed, blocked, or abandoned task through Task OS',
        surfaces: ['tui'],
      },
      { command: '/context', description: 'show current context-window usage', hidden: true },
      {
        command: '/usage',
        description: 'show cumulative token usage for this session',
        hidden: true,
      },
      {
        command: '/export',
        args: '[path]',
        description: 'export this session to markdown (path optional; - prints to stdout)',
      },
      {
        command: '/review',
        args: '[PR#]',
        description: 'review the working-tree diff (or a GitHub PR) for bugs and security',
      },
    ],
  },
  {
    title: 'Inspect',
    rows: [
      { command: '/sessions', description: 'list saved conversations', hidden: true },
      { command: '/doctor', description: 'health-check model, egress, and config in this session' },
      { command: '/diff', description: 'show git working-tree changes' },
      {
        command: '/rewind',
        args: '[seq]',
        description: 'undo file edits from a checkpoint',
        aliases: ['/undo'],
        hidden: true,
      },
      { command: '/mcp', description: 'list MCP server status', surfaces: ['tui'], hidden: true },
      {
        command: '/skills',
        description: 'list discovered skills; create more with moss skill create',
        hidden: true,
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
      },
      {
        command: '/hooks',
        description: 'list configured lifecycle hooks and where to edit them',
        surfaces: ['tui'],
        hidden: true,
      },
      // De-surfaced (still dispatch for back-compat): /quickstart — after the
      // config-snapshot unification its content duplicates /status + the
      // first-boot guidance; /log — its whole value (two on-disk paths) now
      // rides on /doctor's footer. See the simplification v2 ledger.
    ],
  },
  {
    title: 'Control',
    rows: [
      { command: '/stop', description: 'interrupt the active run', hidden: true },
      {
        command: '/init',
        description: 'create an AGENTS.md project memory file',
        hidden: true,
        surfaces: ['repl'],
      },
      {
        command: '/clear',
        description: 'clear the transcript (banner stays; the model context is kept)',
        surfaces: ['tui'],
      },
      { command: '/quit', description: 'exit moss', hidden: true },
      { command: '/help', description: 'show the key and command reference' },
      {
        command: '/jobs',
        description: 'list background shell and sub-agent jobs',
        surfaces: ['tui'],
        hidden: true,
      },
      {
        command: '/queue',
        args: '[pause|resume|drop|clear]',
        description: 'inspect or control the input queue',
        surfaces: ['tui'],
        hidden: true,
      },
      {
        command: '/steer',
        args: '<constraint>',
        description: 'inject a constraint into the live run',
        surfaces: ['tui'],
        hidden: true,
      },
    ],
  },
] as const;

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
