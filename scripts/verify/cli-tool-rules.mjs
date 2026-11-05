#!/usr/bin/env node
/**
 * Claude Code parity probe: `--allowed-tools` / `--disallowed-tools`.
 *
 * Scripted headless runs (CI, bench harnesses, autopilot loops) could not
 * pre-approve a narrow command: `--workspace-write` blocked every exec with
 * "needs approval (could not ask)", so automation had to choose between
 * `--full-access` (too broad) and nothing. These flags express the same rule
 * language as `permissions.*`, for this run only.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const argsModule = await import(pathToFileURL(path.join(root, 'dist/cli/args.js')).href);
const rulesModule = await import(
  pathToFileURL(path.join(root, 'dist/cli/permission-rules.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[cli-tool-rules] ok ${name}`);
};

// 1. Parsing: both spellings, commas, repetition, and `=` values.
{
  const parsed = argsModule.parseCliArgs([
    '-p',
    'do the thing',
    '--allowed-tools',
    'exec(echo *),write_file',
    '--allowedTools=read_file(.env)',
    '--disallowed-tools',
    'exec(rm *)',
    '--disallowedTools',
    'exec(sudo *)',
  ]);
  assert.deepEqual(parsed.toolRules, {
    allow: ['exec(echo *)', 'write_file', 'read_file(.env)'],
    deny: ['exec(rm *)', 'exec(sudo *)'],
  });
  const none = argsModule.parseCliArgs(['-p', 'x']);
  assert.equal(none.toolRules, undefined);

  let failed = false;
  try {
    argsModule.parseCliArgs(['-p', 'x', '--allowed-tools=']);
  } catch (error) {
    failed = /requires at least one rule/.test(
      String(error instanceof Error ? error.message : error)
    );
  }
  assert.equal(failed, true, 'an empty value is a usage error, not a silent no-op');
  ok('flags parse both spellings, split on commas, accumulate, and reject empty values');
}

// 2. The parsed specs become session rules with the rule engine's semantics.
{
  const rules = [
    ...['exec(echo *)', 'write_file'].map((spec) =>
      rulesModule.parsePermissionRuleSpec(spec, 'session', 'allow')
    ),
    ...['exec(rm *)'].map((spec) => rulesModule.parsePermissionRuleSpec(spec, 'session', 'deny')),
  ];
  const resolved = { rules, sources: {} };
  const decision = (input) =>
    rulesModule.resolvePermissionDecision(
      {
        sideEffect: 'local_write',
        requiresApproval: true,
        mode: 'manual',
        readOnlyCeiling: false,
        boardMode: false,
        ...input,
      },
      resolved
    );

  const allowedExec = decision({
    toolName: 'exec',
    operand: 'echo hi-from-exec > out.txt',
    sideEffect: 'local_write',
    requiresApproval: true,
  });
  assert.equal(allowedExec.decision, 'allow');
  assert.equal(allowedExec.reason, 'rule');
  assert.equal(allowedExec.matchedRule?.source, 'session');

  const allowedWrite = decision({ toolName: 'write_file', operand: 'src/a.ts' });
  assert.equal(allowedWrite.decision, 'allow');

  const notAllowed = decision({
    toolName: 'exec',
    operand: 'npm test',
    sideEffect: 'readonly',
    requiresApproval: false,
  });
  assert.notEqual(
    notAllowed.reason ?? 'no-rule',
    'rule',
    'a non-matching command is not pre-approved by the flag; it falls through to the mode default'
  );

  // Deny wins over a broad allow, even in full mode / with an allow rule.
  const denied = decision({ toolName: 'exec', operand: 'rm -rf /tmp/x', mode: 'full' });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.matchedRule?.source, 'session');
  ok('session rules allow the named calls, deny wins, and nothing else is pre-approved');
}

console.log(`[cli-tool-rules] ${checks}/2 checks passed`);
