#!/usr/bin/env node
/**
 * Command-surface honesty (v0.14-S3): every advertised command must have a
 * real implementation, and every known-but-unimplemented subcommand must
 * hard-fail instead of silently falling through into chat.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');

// ─── Ghost subcommands must hard-fail with a clear error ─────────────────────

// 'mcp' graduated from ghost to a real lifecycle command (mcp add/list/
// remove/test) — it answers with usage, exit 2, and is covered by
// test/mcp-lifecycle.spec.mjs.
const GHOSTS = ['plugins', 'migrate', 'web', 'agent'];
for (const ghost of GHOSTS) {
  const res = spawnSync(process.execPath, [cli, ghost], {
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
    env: isolatedCliEnv({
      overrides: {
        MOSS_CONFIG_DIR: path.join(here, '.tmp-command-surface-config'),
        MOSS_NO_COLOR: '1',
      },
    }),
  });
  assert.notEqual(res.status, 0, `moss ${ghost} must exit non-zero (got ${res.status})`);
  const combined = `${res.stderr ?? ''}${res.stdout ?? ''}`;
  assert.match(
    combined,
    /not implemented|unknown|unsupported|not available/i,
    `moss ${ghost} must print a clear error, got: ${combined.slice(0, 300)}`
  );
}

// ─── The interactive catalog only advertises commands with handlers ──────────

const { SLASH_MENU_ROWS, INTERACTIVE_COMPLETION_COMMANDS, REPL_COMMAND_SECTIONS } = await import(
  pathToFileURL(path.join(here, '..', 'dist', 'cli', 'interactive-commands.js')).href
);

// The everyday menu is the commands a person sees by typing `/`. Hidden
// aliases (/steer /queue /mode /task) and retired names (/history /loop /log)
// stay out of it. /resume and /goal are real REPL commands.
const menu = new Set([
  ...SLASH_MENU_ROWS.map((row) => row.command),
  ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
  ...INTERACTIVE_COMPLETION_COMMANDS,
]);
for (const hidden of [
  '/steer',
  '/queue',
  '/history',
  '/loop',
  '/log',
  '/quickstart',
  '/mode',
  '/task',
]) {
  assert.ok(!menu.has(hidden), `"${hidden}" must not be in the everyday REPL menu`);
}
for (const shown of ['/goal', '/plan', '/resume', '/clear', '/help', '/model']) {
  assert.ok(menu.has(shown), `"${shown}" is an everyday command`);
}
// /theme is TUI chrome. The REPL menu must not advertise a command it cannot run.
assert.ok(!menu.has('/theme'), '"/theme" is not an everyday REPL command');
const { SHELL_COMMAND_NAMES } = await import(
  pathToFileURL(path.join(here, '..', 'dist', 'cli', 'tui', 'help.js')).href
);
assert.ok(SHELL_COMMAND_NAMES.includes('/theme'), '"/theme" stays on the TUI menu');
const replCommands = new Set(
  REPL_COMMAND_SECTIONS.flatMap((section) => section.rows.map((row) => row.command))
);
for (const both of ['/goal', '/plan', '/resume', '/clear', '/steer', '/queue']) {
  assert.ok(replCommands.has(both), `"${both}" is in the REPL catalog (it dispatches)`);
}

// ─── The dead queued-input module is gone ─────────────────────────────────────

assert.ok(
  !existsSync(path.join(here, '..', 'dist', 'cli', 'input-queue.js')),
  'input-queue.js removed from dist'
);
assert.ok(
  !existsSync(path.join(here, '..', 'src', 'cli', 'input-queue.ts')),
  'input-queue.ts removed from src'
);

console.log('[PASS] cli command surface honesty');
