import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { trackTempDir } from './helpers/temp-home.mjs';

const root = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-hook-quoted-')));
const workspace = path.join(root, "space ' 中文 workspace");
fs.mkdirSync(workspace);
const script = path.join(workspace, "hook ' script.mjs");
fs.writeFileSync(
  script,
  [
    "import fs from 'node:fs';",
    "let raw = '';",
    "process.stdin.on('data', (chunk) => { raw += chunk; });",
    "process.stdin.on('end', () => {",
    '  fs.writeFileSync(process.argv[2], JSON.stringify({',
    '    payload: JSON.parse(raw), cwd: process.cwd(), argument: process.argv[3],',
    '  }));',
    "  if (process.argv[4] === 'deny') { console.error('real quoted hook veto'); process.exit(7); }",
    '});',
    '',
  ].join('\n')
);

function quote(value) {
  return process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

const argument = "literal space & ' 中文";
function command(output, mode = 'allow') {
  return [process.execPath, script, output, argument, mode].map(quote).join(' ');
}

const startOutput = path.join(workspace, 'start output.json');
await createConfiguredHookCallbacks(
  { SessionStart: [{ command: command(startOutput) }] },
  { workspaceDir: workspace }
).runSessionStart();
const started = JSON.parse(fs.readFileSync(startOutput, 'utf8'));
assert.equal(started.payload.event, 'SessionStart');
assert.equal(fs.realpathSync.native(started.cwd), fs.realpathSync.native(workspace));
assert.equal(started.argument, argument);

const denyOutput = path.join(workspace, 'denied output.json');
const forbiddenOutput = path.join(workspace, 'must not run.json');
const denied = await createConfiguredHookCallbacks(
  {
    Stop: [
      { command: command(denyOutput, 'deny'), blocking: true },
      { command: command(forbiddenOutput) },
    ],
  },
  { workspaceDir: workspace }
).runStop({ sessionKey: 'quoted-stop', stopReason: 'end_turn', response: 'finished' });
const stopped = JSON.parse(fs.readFileSync(denyOutput, 'utf8'));
assert.equal(stopped.payload.event, 'Stop');
assert.equal(stopped.payload.stopReason, 'end_turn');
assert.equal(stopped.payload.response, 'finished');
assert.equal(stopped.argument, argument);
assert.equal(denied.blocked, true);
assert.match(denied.reason, /real quoted hook veto/);
assert.equal(fs.existsSync(forbiddenOutput), false, 'a real exit 7 stops subsequent hooks');

console.log('[PASS] real quoted hook commands preserve cwd, stdin, arguments and blocking');
