#!/usr/bin/env node
/**
 * D9 organization policy layer probe (`MOSS_POLICY_FILE`): read-only rule file
 * that outranks user/workspace permissions. Loader + real rule engine, plus one
 * real CLI startup that must announce the policy.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const policyModule = await import(pathToFileURL(path.join(root, 'dist/cli/org-policy.js')).href);
const rulesModule = await import(
  pathToFileURL(path.join(root, 'dist/cli/permission-rules.js')).href
);
const errorsModule = await import(pathToFileURL(path.join(root, 'dist/errors.js')).href);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-policy-probe-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-policy-home-'));
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[org-policy] ok ${name}`);
};

function writePolicy(name, value) {
  const file = path.join(workspace, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

const policyFile = writePolicy('policy.json', {
  version: 1,
  allow: ['read_file'],
  ask: ['write_file'],
  deny: ['exec(rm *)', 'device_*'],
});
const loaded = policyModule.loadOrgPolicy({ MOSS_POLICY_FILE: policyFile }, workspace);
assert.equal(loaded.path, policyFile);
assert.equal(loaded.rules.length, 4);
assert.deepEqual(
  loaded.rules.map((rule) => rule.level),
  ['allow', 'ask', 'deny', 'deny']
);
assert.ok(loaded.rules.every((rule) => rule.source === 'policy'));
assert.equal(loaded.rules[2].toolName, 'exec');
assert.equal(loaded.rules[2].operandPattern, 'rm *');
ok('loads allow/ask/deny rule specs from MOSS_POLICY_FILE with source=policy');

assert.deepEqual(policyModule.loadOrgPolicy({}, workspace), { rules: [] });
assert.equal(policyModule.orgPolicyNotice(policyModule.loadOrgPolicy({}, workspace), false), null);
const notice = policyModule.orgPolicyNotice(loaded, false);
assert.match(notice, /organization policy loaded/);
assert.match(notice, /deny 2 · ask 1 · allow 1/);
assert.match(notice, /outranks user\/workspace rules/);
ok('no env means no policy; the startup notice counts each level');

const relative = policyModule.loadOrgPolicy({ MOSS_POLICY_FILE: 'policy.json' }, workspace);
assert.equal(relative.path, policyFile);
ok('a relative MOSS_POLICY_FILE resolves against the workspace');

for (const [label, env, pattern] of [
  ['invalid JSON', { MOSS_POLICY_FILE: writePolicy('bad.json', '{oops') }, /not valid JSON/],
  [
    'unsupported version',
    { MOSS_POLICY_FILE: writePolicy('v2.json', { version: 2, deny: [] }) },
    /"version": 1/,
  ],
  [
    'non-array level',
    { MOSS_POLICY_FILE: writePolicy('levels.json', { version: 1, deny: 'exec' }) },
    /"deny" must be an array/,
  ],
  [
    'malformed rule spec',
    { MOSS_POLICY_FILE: writePolicy('spec.json', { version: 1, deny: ['exec('] }) },
    /invalid rule in MOSS_POLICY_FILE "deny"/,
  ],
  [
    'missing file',
    { MOSS_POLICY_FILE: path.join(workspace, 'nope.json') },
    /cannot read MOSS_POLICY_FILE/,
  ],
]) {
  assert.throws(
    () => policyModule.loadOrgPolicy(env, workspace),
    (error) => error instanceof errorsModule.MossError && pattern.test(error.message),
    label
  );
  ok(`rejects ${label} (fail closed)`);
}

// Real engine: policy rules participate in resolvePermissionDecision, and deny
// still wins in full mode (where user allow rules usually auto-approve).
const resolvedRules = { rules: loaded.rules, sources: { policyPath: policyFile } };
const denyExec = rulesModule.resolvePermissionDecision(
  {
    toolName: 'exec',
    operand: 'rm -rf /tmp/build',
    sideEffect: 'local_write',
    requiresApproval: true,
    mode: 'full',
    readOnlyCeiling: false,
    boardMode: false,
  },
  resolvedRules
);
assert.equal(denyExec.decision, 'deny');
assert.match(denyExec.reason, /policy/);
ok('a policy deny rule blocks the tool even in full mode');

const askWrite = rulesModule.resolvePermissionDecision(
  {
    toolName: 'write_file',
    operand: 'notes.txt',
    sideEffect: 'local_write',
    requiresApproval: true,
    mode: 'full',
    readOnlyCeiling: false,
    boardMode: false,
  },
  resolvedRules
);
assert.equal(askWrite.decision, 'ask-rule');
ok('a policy ask rule forces a prompt even in full mode');

const allowRead = rulesModule.resolvePermissionDecision(
  {
    toolName: 'read_file',
    operand: 'src/index.ts',
    sideEffect: 'readonly',
    requiresApproval: false,
    mode: 'manual',
    readOnlyCeiling: false,
    boardMode: false,
  },
  resolvedRules
);
assert.equal(allowRead.decision, 'allow');
ok('a policy allow rule covers a readonly tool in manual mode');

const globDeny = rulesModule.resolvePermissionDecision(
  {
    toolName: 'device_exec',
    operand: 'uptime',
    sideEffect: 'device_mutation',
    requiresApproval: true,
    mode: 'full',
    readOnlyCeiling: false,
    boardMode: false,
  },
  resolvedRules
);
assert.equal(globDeny.decision, 'deny');
ok('a policy tool glob (`device_*`) denies the whole family');

// Real CLI startup must say the policy is active (silence would hide a
// boundary change). --mock keeps this offline.
const cli = spawnSync(
  process.execPath,
  [path.join(root, 'dist/cli.js'), '-p', '--mock', 'say hi'],
  {
    cwd: workspace,
    env: { ...process.env, HOME: home, MOSS_NO_RDK_DOCS: '1', MOSS_POLICY_FILE: policyFile },
    encoding: 'utf8',
    timeout: 120_000,
  }
);
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stderr, /\[policy\] organization policy loaded from/);
ok('the real CLI startup announces the loaded organization policy');

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`[org-policy] PASS (${checks} checks)`);
