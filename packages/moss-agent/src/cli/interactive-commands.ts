export interface InteractiveCommandRow {
  command: string;
  description: string;
  menuDescription?: string;
  aliases?: readonly string[];
  hidden?: boolean;
}

export interface InteractiveCommandSection {
  title: string;
  rows: InteractiveCommandRow[];
}

export const INTERACTIVE_COMMAND_SECTIONS: readonly InteractiveCommandSection[] = [
  {
    title: 'Work',
    rows: [
      { command: '/status', description: 'view model, workspace, device, and tool state' },
      // De-surfaced (still dispatch for back-compat): /subagents (alias /agents) —
      // the background sub-agent registry is empty in a normal session (background
      // tasks are opt-in via create_subagent), so it almost always shows "none".
      { command: '/model', description: 'choose or switch the active model for this session' },
      { command: '/goal', description: 'show goal status, or pause / resume / complete / clear it' },
      { command: '/goal <objective>', description: 'set a goal and keep working toward it until you mark it done' },
      { command: '/compact', description: 'compress older conversation history into a summary' },
      { command: '/compact [instructions]', description: 'compact and focus the summary on the given instructions', hidden: true },
      { command: '/btw <question>', description: 'ask a side question on an isolated session — does not pollute the main task context; runs concurrently with an active run' },
      { command: '/context', description: 'show current context-window usage', hidden: true },
      // De-surfaced (still dispatch for back-compat): /attach — redundant with `@`
      // file mentions, which are the primary way to attach an image or text file.
      { command: '/connect <ip>', description: 'connect an RDK board and enter board mode (verifies SSH; flags: --user --port --key --password --no-verify --hybrid)' },
      { command: '/disconnect', description: 'leave board mode and restore local tools (Ctrl+D on an empty prompt also works)' },
      { command: '/review', description: 'review the working-tree diff for bugs, security, and simplification' },
      { command: '/review <PR#>', description: 'review a GitHub pull request via `gh pr diff`', hidden: true },
    ],
  },
  {
    title: 'Inspect',
    rows: [
      { command: '/sessions', description: 'list saved conversations (use /resume to switch into one)' },
      { command: '/resume [key|--last]', description: 'switch this session to a saved conversation (no arg opens a picker)' },
      { command: '/mcp', description: 'show configured MCP servers, connection status, and tool counts' },
      { command: '/doctor', description: 'health-check model, egress, board, MCP, and config in this session' },
      { command: '/cost', description: 'show recorded token usage and estimated cost', hidden: true },
      { command: '/diff', description: 'show git working-tree changes' },
      { command: '/rewind [seq]', description: 'undo file edits from a checkpoint', aliases: ['/undo'], hidden: true },
      { command: '/memory', description: 'show project memory (AGENTS.md) and learned memories', hidden: true },
      // De-surfaced (still dispatch for back-compat): /skills (+ promote/discard/forget).
      // moss's self-learning pipeline collides in NAME with Codex/Claude skills but
      // differs in meaning (auto-distilled candidates vs pre-authored skills); keep it
      // off the surface until the feature + naming are settled.
    ],
  },
  {
    title: 'Configure',
    rows: [
      { command: '/auth login', description: 'optional: link a D-Robotics developer community account' },
      { command: '/auth login --manual', description: 'optional browserless community login by pasting the redirect URL or token', hidden: true },
      { command: '/logout', description: 'log out of the D-Robotics developer community', hidden: true },
      {
        command: '/quickstart',
        description: 'configure model, workspace, board, and first tasks',
        aliases: ['/quick_start', '/start'],
        hidden: true,
      },
      { command: '/permissions', description: 'show safety, approvals, and how to grant full access', hidden: true },
      // De-surfaced (still dispatch for back-compat, just not presented): /examples
      // (→ /quickstart), /config (alias of /permissions), /tools (tools are internal),
      // /models (→ /model lists+switches), /yolo (full access is a mode/flag, set via
      // /permissions or --full-access). See command-curation rationale.
    ],
  },
  {
    title: 'Control',
    rows: [
      { command: '/stop', description: 'stop the active run', hidden: true },
      { command: '/clear', description: 'start a new conversation — clears the context window (aliases: /new, /reset)', aliases: ['/new', '/reset'] },
      // De-surfaced (still dispatch for back-compat): /queue (niche in-memory prompt
      // queue), /thinking (a display toggle — mainstream uses a keybind), /detail (a
      // display setting), /version (shown by /status and /doctor), /upgrade (updates
      // are out-of-band: `npm i -g @rdk-moss/agent` / the installer).
      { command: '/init', description: 'create an AGENTS.md project memory file', hidden: true },
      { command: '/help', description: 'show this command reference' },
      { command: '/quit', description: 'exit Moss', hidden: true },
    ],
  },
] as const;

function uniqueMenuRows(): InteractiveCommandRow[] {
  // Surface EVERY command in the slash menu + completion + did-you-mean, so a
  // user can discover and use the whole capability set (moss competes on being
  // usable, so hiding real features is self-defeating). `hidden` no longer
  // removes a command — it just ranks it after the common ones, so the menu
  // still leads with the everyday commands and fuzzy-filtering narrows the rest.
  const seen = new Set<string>();
  const common: InteractiveCommandRow[] = [];
  const advanced: InteractiveCommandRow[] = [];
  for (const row of INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows)) {
    const command = commandToken(row.command);
    if (seen.has(command)) continue;
    seen.add(command);
    const entry: InteractiveCommandRow = {
      command,
      description: row.menuDescription ?? row.description,
      ...(row.aliases ? { aliases: row.aliases } : {}),
    };
    (row.hidden ? advanced : common).push(entry);
  }
  return [...common, ...advanced];
}

export const SLASH_MENU_ROWS: readonly InteractiveCommandRow[] = uniqueMenuRows();

function commandToken(command: string): string {
  return command.split(/\s+/, 1)[0] ?? command;
}

export const INTERACTIVE_COMPLETION_COMMANDS: readonly string[] = Array.from(new Set([
  ...SLASH_MENU_ROWS.map((row) => row.command),
  ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
]));

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
      if (cand[ci] === ch) { found = ci; ci += 1; break; }
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
  extra: ReadonlyArray<readonly [string, string]> = [],
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
  const ranked: Array<{ row: [string, string]; rank: [number, number, number]; order: number }> = [];
  rows.forEach((row, order) => {
    const rank = fuzzyCommandRank(row[0].toLowerCase(), normalized);
    if (rank) ranked.push({ row, rank, order });
  });
  ranked.sort((a, b) =>
    a.rank[0] - b.rank[0]
    || a.rank[1] - b.rank[1]
    || a.rank[2] - b.rank[2]
    || a.order - b.order);
  return ranked.map((entry) => entry.row);
}

export function formatInteractiveCommandSections(options: {
  indent?: string;
  commandWidth?: number;
  includeHidden?: boolean;
} = {}): string[] {
  const indent = options.indent ?? '    ';
  const commandWidth = options.commandWidth ?? 23;
  const lines: string[] = [];
  for (const section of INTERACTIVE_COMMAND_SECTIONS) {
    lines.push(`  ${section.title}`);
    for (const row of section.rows) {
      if (row.hidden && !options.includeHidden) continue;
      lines.push(`${indent}${row.command.padEnd(commandWidth)} ${row.description}`);
    }
  }
  return lines;
}
