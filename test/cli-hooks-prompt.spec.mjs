#!/usr/bin/env node
/**
 * UserPromptSubmit (input guardrail) and PermissionRequest (deny-only).
 * Claude-format hooks block only on exit 2; moss-native hooks block on any
 * non-zero exit. PreToolUse honors permissionDecision deny and Claude tool_input.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfiguredHookCallbacks, formatUserPromptHookContext } from '../dist/cli/hooks.js';
import {
  runWithApprovalRequest,
  setPermissionRequestRunner,
  wrapApprovalAsker,
} from '../dist/cli/permission-request.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-hooks-prompt-'));
const hook = (command, extra = {}) => ({ command: `node ${command}`, ...extra });
const cbs = (events) => createConfiguredHookCallbacks(events, { workspaceDir: ws });
const write = (name, body) => fs.writeFileSync(path.join(ws, name), body);
const decisionScript = (field, needle, choice, reason) =>
  `import fs from 'node:fs';const i=JSON.parse(fs.readFileSync(0,'utf8'));const v=i.tool_input?.${field}??'';if(String(v).includes(${JSON.stringify(needle)}))process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:${JSON.stringify(choice)},permissionDecisionReason:${JSON.stringify(reason)}}}));\n`;

write('exit2.mjs', "console.error('no secrets');\nprocess.exit(2);\n");
write('exit1.mjs', "console.error('warn');\nprocess.exit(1);\n");
write('context.mjs', "process.stdout.write('remember the fixture');\n");
write('context-fail.mjs', "process.stdout.write('do not inject');\nprocess.exit(1);\n");
for (const [name, body] of [
  ['block-json.mjs', { decision: 'block', reason: 'policy' }],
  ['allow-json.mjs', { decision: 'allow', reason: 'fine' }],
  ['deny-json.mjs', { decision: 'deny', reason: 'not this tool' }],
]) {
  write(name, `process.stdout.write(${JSON.stringify(JSON.stringify(body))});\n`);
}
write(
  'block-rm.mjs',
  decisionScript('command', 'rm -rf', 'deny', 'Destructive command blocked by hook')
);
write('block-path.mjs', decisionScript('file_path', 'secret.txt', 'deny', 'secret file'));
write('allow-rm.mjs', decisionScript('command', '', 'allow', 'ok'));

const promptRows = [
  ['exit2.mjs', {}, true, /UserPromptSubmit/, /no secrets/],
  ['block-json.mjs', {}, true, /policy/, null],
  ['context.mjs', {}, false, null, 'remember the fixture'],
  ['exit1.mjs', {}, true, null, null],
  ['exit1.mjs', { format: 'claude' }, false, null, null],
  ['exit2.mjs', { format: 'claude' }, true, null, null],
  ['context-fail.mjs', { format: 'claude' }, false, null, undefined],
];
for (const [command, extra, blocked, reason, detail] of promptRows) {
  const result = await cbs({ UserPromptSubmit: [hook(command, extra)] }).runUserPromptSubmit(
    'hello'
  );
  assert.equal(result.blocked, blocked, command);
  if (reason) assert.match(result.reason, reason);
  if (detail instanceof RegExp) assert.match(result.reason, detail);
  else if (detail !== null) assert.equal(result.extraContext, detail);
}

const secret = `sk-${'a'.repeat(24)}`;
const wrapped = formatUserPromptHookContext('hello', `remember ${secret}`);
assert.match(wrapped, /^hello\n\n<hook-output source="UserPromptSubmit">/);
assert.match(wrapped, /<\/hook-output>$/);
assert.equal(wrapped.includes(secret), false);
assert.match(wrapped, /\[REDACTED\]/);

async function pre(command, matcher, tool, input, approved, reason) {
  const extra = matcher ? { format: 'claude', matcher } : {};
  const decision = await cbs({ PreToolUse: [hook(command, extra)] }).onBeforeToolExec({
    tool: { name: tool },
    input,
  });
  assert.equal(decision.approved, approved, `${command} ${tool} ${matcher}`);
  if (reason) assert.match(decision.reason, reason);
}

await pre('exit1.mjs', '', 'exec', { command: 'ls' }, false);
await pre('exit1.mjs', 'Bash', 'exec', { command: 'ls' }, true);
await pre('exit2.mjs', 'Bash', 'exec', {}, false);
await pre('exit2.mjs', 'Bash', 'read_file', {}, true);
await pre('block-rm.mjs', '*', 'exec', { command: 'rm -rf /tmp/x' }, false, /Destructive/);
await pre('block-rm.mjs', '*', 'exec', { command: 'ls' }, true);
await pre('block-rm.mjs', 'Bash, Edit', 'exec', { command: 'rm -rf .' }, false);
await pre('block-rm.mjs', 'Bash, Edit', 'search_code', { pattern: 'rm -rf' }, true);
await pre(
  'block-path.mjs',
  'Edit|Write',
  'edit_file',
  { path: 'secret.txt' },
  false,
  /secret file/
);
await pre('block-path.mjs', 'Edit|Write', 'read_file', { path: 'secret.txt' }, true);
await pre('allow-rm.mjs', 'Bash', 'exec', { command: 'rm -rf /' }, true);

for (const [command, extra, denied, reason] of [
  ['deny-json.mjs', {}, true, /not this tool/],
  ['allow-json.mjs', {}, false, null],
  ['exit1.mjs', { format: 'claude', matcher: 'Bash' }, false, null],
]) {
  const perm = await cbs({ PermissionRequest: [hook(command, extra)] }).runPermissionRequest({
    toolName: 'exec',
    input: { command: 'rm' },
  });
  assert.equal(perm.denied, denied, command);
  if (reason) assert.match(perm.reason, reason);
}

let asked = 0;
for (const [denied, expected, calls] of [
  [true, 'n', 0],
  [false, 'y', 1],
]) {
  setPermissionRequestRunner(async () =>
    denied ? { denied: true, reason: 'Blocked by PermissionRequest hook: nope' } : { denied: false }
  );
  const answer = await runWithApprovalRequest(
    { tool: { name: 'exec' }, input: { command: 'ls' } },
    () =>
      wrapApprovalAsker(async () => {
        asked += 1;
        return 'y';
      })('approve?', undefined, undefined)
  );
  assert.equal(answer, expected);
  assert.equal(asked, calls);
}
setPermissionRequestRunner(undefined);

console.log('[PASS] cli-hooks-prompt');
