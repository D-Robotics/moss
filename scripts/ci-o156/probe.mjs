// O156 CI-only probe: claude-format hooks whose command is a missing command
// run through Windows PowerShell 5.1 (powershell.exe) and pwsh 7.
import { createConfiguredHookCallbacks } from '../../dist/cli/hooks.js';
import { windowsMissingCommand } from '../../dist/utils/windows-missing-command.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MISSING = 'moss-o156-missing-cmd';
const shells = {
  'PS 5.1': `powershell -NoProfile -NonInteractive -Command ${MISSING}`,
  'pwsh 7': `pwsh -NoProfile -NonInteractive -Command ${MISSING}`,
};
const rows = [];
const quiet = async (fn) => {
  const o = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = o; }
};
for (const [label, command] of Object.entries(shells)) {
  const raw = spawnSync(command, { shell: true, encoding: 'utf8' });
  rows.push({ shell: label, event: 'raw', exit: raw.status, detector: windowsMissingCommand(raw.stderr ?? '') ?? null, stderr: raw.stderr });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o156-'));
  const h = { command, format: 'claude' };
  const cbs = createConfiguredHookCallbacks(
    { UserPromptSubmit: [h], Stop: [h], PermissionRequest: [h], PreToolUse: [h] },
    { workspaceDir: dir }
  );
  const ups = await quiet(() => cbs.runUserPromptSubmit('hi'));
  rows.push({ shell: label, event: 'UserPromptSubmit', blocked: !!ups.blocked, reason: ups.reason ?? null });
  const stop = await quiet(() => cbs.runStop({ stopReason: 'end_turn' }));
  rows.push({ shell: label, event: 'Stop', blocked: !!stop.blocked, reason: stop.reason ?? null });
  const perm = await quiet(() => cbs.runPermissionRequest({ toolName: 'write_file', input: {} }));
  rows.push({ shell: label, event: 'PermissionRequest', blocked: !!perm.denied, reason: perm.reason ?? null });
  const pre = await quiet(() => cbs.onBeforeToolExec({ tool: { name: 'write_file', metadata: { sideEffectClass: 'local_write' } }, input: {}, sessionKey: 's', runId: 'r', toolCallId: 't1', abortSignal: new AbortController().signal }));
  rows.push({ shell: label, event: 'PreToolUse', blocked: !!pre && pre.approved === false, reason: pre?.reason ?? null, raw: JSON.stringify(pre ?? null).slice(0, 300) });
}
console.log(JSON.stringify(rows, null, 2));
for (const r of rows.filter((r) => 'blocked' in r)) {
  console.log(`O156 VERDICT ${r.shell} ${r.event}: ${r.blocked ? 'BLOCKED' : 'ALLOWED (fail-open)'}${r.reason ? ' | ' + r.reason.split('\n')[0].slice(0, 160) : ''}`);
}
const failOpen = rows.filter((r) => r.blocked === false).length;
console.log(failOpen ? `O156 VERDICT: REPRODUCED (${failOpen} fail-open)` : 'O156 VERDICT: NOT REPRODUCED (all blocked)');
