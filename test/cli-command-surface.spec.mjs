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

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');

// ─── Ghost subcommands must hard-fail with a clear error ─────────────────────

const GHOSTS = ['mcp', 'plugins', 'migrate', 'web', 'agent', 'update'];
for (const ghost of GHOSTS) {
  const res = spawnSync(process.execPath, [cli, ghost], {
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      MOSS_CONFIG_DIR: path.join(here, '.tmp-command-surface-config'),
      MOSS_NO_COLOR: '1',
    },
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

const { SLASH_MENU_ROWS, INTERACTIVE_COMPLETION_COMMANDS, INTERACTIVE_COMMAND_SECTIONS } =
  await import(pathToFileURL(path.join(here, '..', 'dist', 'cli', 'interactive-commands.js')).href);

// /steer /queue /history /resume /clear were advertised in v0.13 without any
// REPL handler. They must stay out of the catalog until the TUI control plane
// (v0.18) and resume replay (v0.17) land their real implementations.
const DEAD = ['/steer', '/queue', '/history', '/resume', '/clear'];
const tokens = new Set([
  ...SLASH_MENU_ROWS.map((row) => row.command),
  ...SLASH_MENU_ROWS.flatMap((row) => row.aliases ?? []),
  ...INTERACTIVE_COMPLETION_COMMANDS,
  ...INTERACTIVE_COMMAND_SECTIONS.flatMap((section) =>
    section.rows.map((row) => row.command.split(/\s+/, 1)[0])
  ),
]);
for (const dead of DEAD) {
  assert.ok(!tokens.has(dead), `dead command "${dead}" must not be advertised`);
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
