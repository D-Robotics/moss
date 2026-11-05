/**
 * Slash catalog vs REPL dispatch: every command the REPL surface advertises must
 * actually be understood there. The catalog is data
 * (`src/cli/interactive-commands.ts`), the dispatch chain is code (`repl.ts`), so
 * a row can claim a command the REPL answers with "unknown command" — `/queue`
 * and `/steer` did, because mid-run input only exists in the TUI.
 *
 * The probe types each catalog command into one real PTY REPL (python3/pty, the
 * same dependency `smoke` uses) and fails when any of them is not understood.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDuration } from '../lib/proc.mjs';

/** Commands that end the session or open a picker cannot be typed blind. */
const NOT_SCRIPTABLE = new Set(['/quit', '/exit', '/model', '/resume']);

/**
 * Catalog invariants that need no PTY: duplicate rows make a command's
 * description arbitrary, and a TUI-only row must not leak into the REPL catalog
 * (that leak is how `/queue` and `/steer` got advertised on a surface that has
 * no mid-run input).
 */
function catalogProblems(module) {
  const problems = [];
  const rows = module.INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => section.rows);
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.command)) problems.push(`duplicate catalog row ${row.command}`);
    seen.add(row.command);
  }
  const repl = new Set(
    module.REPL_COMMAND_SECTIONS.flatMap((section) => section.rows.map((row) => row.command))
  );
  const advertised = new Set([
    ...module.DISPATCHABLE_SLASH_COMMANDS,
    ...module.INTERACTIVE_COMPLETION_COMMANDS,
  ]);
  for (const row of rows) {
    if (!row.surfaces?.includes('tui') || row.surfaces.includes('repl')) continue;
    if (repl.has(row.command)) problems.push(`${row.command} is TUI-only but listed for the REPL`);
    if (advertised.has(row.command)) {
      problems.push(`${row.command} is TUI-only but offered as a REPL slash command`);
    }
  }
  return problems;
}

async function replCommands(root) {
  const module = await import(
    pathToFileURL(path.join(root, 'dist', 'cli', 'interactive-commands.js')).href
  );
  const catalog = catalogProblems(module);
  if (catalog.length > 0) return { catalog, commands: [] };
  const commands = [
    ...new Set(
      module.REPL_COMMAND_SECTIONS.flatMap((section) => section.rows.map((row) => row.command))
    ),
  ]
    .filter((command) => !NOT_SCRIPTABLE.has(command))
    .sort();
  return { catalog, commands };
}

export const stage = {
  name: 'slash-dispatch',
  requires: ['build'],
  description: 'every REPL-catalogued slash command is understood by the REPL',
  async run(context) {
    const python =
      process.platform === 'win32'
        ? null
        : spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0
          ? 'python3'
          : null;
    if (!python) {
      console.log('[slash-dispatch] skipping: python3/pty unavailable');
      return { ok: true };
    }

    const { catalog, commands } = await replCommands(context.root);
    if (catalog.length > 0) return { ok: false, detail: catalog.join('; ') };
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-slash-'));
    const commandsFile = path.join(tempRoot, 'commands.json');
    fs.writeFileSync(commandsFile, JSON.stringify(commands));
    const started = Date.now();
    try {
      const result = spawnSync(
        python,
        [
          path.join(context.root, 'scripts/verify/slash-dispatch.py'),
          process.execPath,
          path.join(context.root, 'dist', 'cli.js'),
          tempRoot,
          commandsFile,
        ],
        { cwd: context.root, encoding: 'utf8', timeout: 120_000 }
      );
      const duration = formatDuration(Date.now() - started);
      if (result.error) return { ok: false, detail: `${result.error.message}` };
      const payload = (() => {
        try {
          return JSON.parse((result.stdout ?? '').trim().split('\n').pop() ?? '{}');
        } catch {
          return {};
        }
      })();
      if (payload.error) return { ok: false, detail: String(payload.error) };
      const unknown = Array.isArray(payload.unknown) ? payload.unknown : [];
      if (result.status !== 0 || unknown.length > 0) {
        const quote = (value) => `"${value}"`;
        return {
          ok: false,
          detail:
            unknown.length > 0
              ? `REPL does not understand catalogued command(s): ${unknown.map(quote).join(', ')}`
              : `probe exited ${result.status ?? result.signal}`,
        };
      }
      console.log(`[slash-dispatch] ${commands.length} commands understood in ${duration}`);
      return { ok: true };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
};
