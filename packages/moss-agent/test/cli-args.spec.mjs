#!/usr/bin/env node
/**
 * CLI argument parsing — tested from the user's perspective:
 * what happens when a user types different `moss` invocations.
 */
import assert from 'node:assert/strict';

import { parseCliArgs, closestKnownCommand } from '../dist/cli/args.js';

// ─── Version and help flags ──────────────────────────────────────────────────

{
  const args = parseCliArgs(['--version']);
  assert.equal(args.version, true, '--version sets version flag');
  assert.equal(args.help, false);
}

{
  const args = parseCliArgs(['--help']);
  assert.equal(args.help, true, '--help sets help flag');
}

{
  const args = parseCliArgs(['-h']);
  assert.equal(args.help, true, '-h is short for --help');
}

// ─── One-shot print mode ─────────────────────────────────────────────────────

{
  const args = parseCliArgs(['--print', 'What is 2+2?']);
  assert.equal(args.print, true, '--print enables non-interactive mode');
  assert.equal(args.prompt, 'What is 2+2?', 'remaining text becomes the prompt');
}

{
  const args = parseCliArgs(['-p', 'hello']);
  assert.equal(args.print, true, '-p is short for --print');
  assert.equal(args.prompt, 'hello');
}

// ─── Commands ────────────────────────────────────────────────────────────────

for (const cmd of ['setup', 'config', 'doctor', 'sessions', 'resume', 'update', 'mcp']) {
  const args = parseCliArgs([cmd]);
  assert.equal(args.command, cmd, `'${cmd}' is recognized as a subcommand`);
}

{
  const args = parseCliArgs([]);
  assert.equal(args.command, 'chat', 'no args defaults to chat mode');
}

// ─── Model selection ─────────────────────────────────────────────────────────

{
  const args = parseCliArgs(['--model', 'deepseek-v4-pro']);
  assert.equal(args.configOverrides.model, 'deepseek-v4-pro', '--model sets the model override');
}

{
  const args = parseCliArgs(['-m', 'qwen3-plus']);
  assert.equal(args.configOverrides.model, 'qwen3-plus', '-m is short for --model');
}

// ─── Provider selection ───────────────────────────────────────────────────────

{
  const args = parseCliArgs(['--provider', 'anthropic']);
  assert.equal(args.configOverrides.provider, 'anthropic', '--provider sets provider override');
}

// ─── Session resumption ───────────────────────────────────────────────────────

{
  const args = parseCliArgs(['--last']);
  assert.equal(args.sessionLast, true, '--last resumes the most recent session');
}

{
  const args = parseCliArgs(['--continue']);
  assert.equal(args.continueLast, true, '--continue auto-resumes the latest session on chat start');
}

{
  const args = parseCliArgs(['--session', 'abc123']);
  assert.equal(args.sessionKey, 'abc123', '--session specifies a session key to resume');
}

// ─── Output format ────────────────────────────────────────────────────────────

{
  const args = parseCliArgs(['--output-format', 'json', '--print', 'hi']);
  assert.equal(args.outputFormat, 'json', '--output-format json enables JSON output');
}

{
  const args = parseCliArgs(['--output-format', 'stream-json', '--print', 'hi']);
  assert.equal(args.outputFormat, 'stream-json', '--output-format stream-json enables streaming JSON');
}

// ─── Safety mode ──────────────────────────────────────────────────────────────

{
  const args = parseCliArgs(['--full-access']);
  assert.equal(args.safetyModeOverride, 'full-access', '--full-access sets full-access safety mode override');
}

{
  const args = parseCliArgs(['--read-only']);
  assert.equal(args.safetyModeOverride, 'read-only', '--read-only sets read-only safety mode override');
}

// ─── closestKnownCommand — typo correction ────────────────────────────────────

assert.equal(closestKnownCommand('confgi'), 'config', 'corrects "confgi" to "config"');
assert.equal(closestKnownCommand('setup'), null, 'exact match returns null (no suggestion needed)');
assert.equal(closestKnownCommand('setpu'), 'setup', 'corrects "setpu" to "setup"');
assert.equal(closestKnownCommand('doctr'), 'doctor', 'corrects "doctr" to "doctor"');
assert.equal(closestKnownCommand('completelyWrong'), null, 'very wrong token returns null (no suggestion)');
assert.equal(closestKnownCommand(''), null, 'empty string returns null');

// ─── Prompt accumulation from positional args ─────────────────────────────────

{
  const args = parseCliArgs(['--print', 'hello', 'world']);
  assert.equal(args.prompt, 'hello world', 'multiple positional words join with space');
}

// ─── Unknown option detection ─────────────────────────────────────────────────

{
  const args = parseCliArgs(['--hepl']);
  assert.ok(args.unknownOption, '--hepl triggers unknown option detection');
  assert.equal(args.unknownOption, '--hepl');
}

console.log('[PASS] CLI argument parsing');
