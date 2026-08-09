#!/usr/bin/env node
/**
 * CLI command-dispatcher — phase routing + command lookup.
 *
 * The command-dispatcher (CliPhase routing, getPhaseForCommand, getCommandConfig,
 * COMMANDS table) had zero tests — the CLI review flagged it as a major gap.
 * These are pure functions/data, exercised directly.
 */
import assert from 'node:assert/strict';
import {
  CliPhase,
  COMMANDS,
  getPhaseForCommand,
  getCommandConfig,
} from '../dist/cli/command-dispatcher.js';

// ─── 1. each known command routes to the correct phase ────────────────────
const expectedPhases = {
  setup: CliPhase.None,
  auth: CliPhase.ConfigOnly,
  config: CliPhase.ConfigOnly,
  mcp: CliPhase.ConfigOnly,
  doctor: CliPhase.ConfigOnly,
  update: CliPhase.ConfigOnly,
  migrate: CliPhase.ConfigOnly,
  sessions: CliPhase.WorkspaceReady,
};

for (const [cmd, phase] of Object.entries(expectedPhases)) {
  assert.equal(getPhaseForCommand(cmd), phase, `${cmd} → ${phase}`);
}

// ─── 2. undefined command name → AgentReady (bare `moss` = interactive) ───
assert.equal(getPhaseForCommand(undefined), CliPhase.AgentReady, 'undefined → AgentReady');
assert.equal(getPhaseForCommand(''), CliPhase.AgentReady, 'empty string → AgentReady (bare moss)');

// ─── 3. unknown command → AgentReady (falls through to interactive/chat) ──
assert.equal(getPhaseForCommand('unknown-cmd'), CliPhase.AgentReady, 'unknown → AgentReady');

// ─── 4. getCommandConfig: known commands return config, unknown/undefined ──
for (const cmd of Object.keys(expectedPhases)) {
  const cfg = getCommandConfig(cmd);
  assert.ok(cfg, `${cmd} has a CommandConfig`);
  assert.equal(cfg.name, cmd, `${cmd} config name matches`);
  assert.equal(typeof cfg.handler, 'function', `${cmd} has a handler function`);
}
assert.equal(getCommandConfig(undefined), undefined, 'undefined → undefined');
assert.equal(getCommandConfig('nonexistent'), undefined, 'unknown → undefined');

// ─── 5. COMMANDS table has all expected commands ──────────────────────────
const commandNames = Object.keys(COMMANDS).sort();
assert.deepEqual(
  commandNames,
  Object.keys(expectedPhases).sort(),
  'COMMANDS table has exactly the expected commands'
);

// ─── 6. no two commands share the same (name, phase) incorrectly ──────────
// (This is a sanity check — each command's name in COMMANDS matches its key.)
for (const [key, cfg] of Object.entries(COMMANDS)) {
  assert.equal(cfg.name, key, `COMMANDS[${key}].name === ${key}`);
}

console.log('  [PASS] cli-command-dispatcher: phase routing + command lookup');
