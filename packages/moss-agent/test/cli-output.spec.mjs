#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/cli-output.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCliRunRenderer,
  resolveCliDetailMode,
  summarizeForCli,
} from '../dist/cli/output.js';

function createCapture() {
  let text = '';
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    read() {
      return text;
    },
  };
}

assert.equal(resolveCliDetailMode([], {}), 'progress');
assert.equal(resolveCliDetailMode(['--quiet'], {}), 'quiet');
assert.equal(resolveCliDetailMode(['--json'], {}), 'quiet');
assert.equal(resolveCliDetailMode([], { MOSS_CLI_DETAIL: 'verbose' }), 'verbose');
assert.equal(resolveCliDetailMode(['--json'], { MOSS_CLI_DETAIL: 'progress' }), 'progress');
assert.equal(resolveCliDetailMode([], { MOSS_VERBOSE_CLI: 'true' }), 'verbose');

const summary = summarizeForCli({
  command: 'echo ok',
  password: 'secret',
  host: '192.168.1.2',
});
assert.match(summary, /\[REDACTED\]/);
assert.match(summary, /\[IP_REDACTED\]/);
assert.doesNotMatch(summary, /secret/);

// Verbose previews must stay READABLE: a long multi-line file/JSON result must
// NOT collapse to "[REDACTED]" (that gutted verbose mode). Secrets are still
// scrubbed; benign content is shown.
{
  const fileLike =
    'export const config = {\n' +
    Array.from({ length: 12 }, (_, i) => `  key${i}: "value-${i}",`).join('\n') +
    '\n};\n';
  const shown = summarizeForCli(fileLike, 4000);
  assert.doesNotMatch(shown, /\[REDACTED\]/, 'benign multi-line file content must not be blanket-redacted');
  assert.match(shown, /export const config/, 'file content is visible in the verbose preview');
}
{
  // An inline secret key in a tool result is STILL masked (sanitizeSecrets),
  // even though file-content redaction is skipped on this path. The key below is
  // an OSS-boundary-allowlisted fake fragment.
  const fakeKey = 'sk-ant-api03-abcdef1234567890ghij';
  const leaky = `token saved: ${fakeKey} and done`;
  const masked = summarizeForCli(leaky, 4000);
  assert.doesNotMatch(masked, new RegExp(fakeKey), 'inline API keys must still be masked');
}

{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({
    detailMode: 'progress',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  renderer.handle({ type: 'turn_start', turn: 1 });
  renderer.handle({
    type: 'tool_start',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    input: { command: 'hostname', password: 'secret' },
  });
  renderer.handle({
    type: 'tool_end',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    result: 'rdk-x5\n',
    isError: false,
  });
  renderer.handle({ type: 'text_delta', delta: 'Done' });
  renderer.handle({
    type: 'done',
    result: { response: 'Done', toolCalls: [], toolResults: [] },
  });

  assert.equal(stdout.read(), 'Done\n');
  assert.match(stderr.read(), /- thinking turn 1/);
  assert.match(stderr.read(), /- device command running/);
  assert.match(stderr.read(), /ok device command ok \d+ms/);
  assert.doesNotMatch(stderr.read(), /device_exec/);
  assert.doesNotMatch(stderr.read(), /hostname/);
  assert.doesNotMatch(stderr.read(), /rdk-x5/);
  assert.doesNotMatch(stderr.read(), /secret/);
}

{
  // Answer text resumed AFTER a tool call must be separated on stdout, not run
  // on as a wall ("running it.The crash is…"). First segment has no separator.
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({ detailMode: 'progress', stdout: stdout.stream, stderr: stderr.stream });
  renderer.handle({ type: 'text_delta', delta: 'Let me run it.' });
  renderer.handle({ type: 'tool_start', toolName: 'exec', toolCallId: 't1', input: { command: 'pytest' } });
  renderer.handle({ type: 'tool_end', toolName: 'exec', toolCallId: 't1', result: 'boom', isError: false });
  renderer.handle({ type: 'text_delta', delta: 'The crash is on line 42.' });
  renderer.handle({ type: 'done', result: { response: '', toolCalls: [], toolResults: [] } });
  assert.equal(stdout.read(), 'Let me run it.\n\nThe crash is on line 42.\n', 'answer segments are separated, not concatenated');
}

{
  // Verification nudge: edited code + a real package.json test script + no test
  // run => one stderr note. (Embodies "no success without a verified outcome".)
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-verify-nudge-'));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const stdout = createCapture();
  const stderr = createCapture();
  const r = createCliRunRenderer({ detailMode: 'progress', stdout: stdout.stream, stderr: stderr.stream, workspaceDir: ws });
  r.handle({ type: 'tool_start', toolName: 'edit_file', toolCallId: 'e1', input: { path: 'a.js', old_string: 'x', new_string: 'y' } });
  r.handle({ type: 'tool_end', toolName: 'edit_file', toolCallId: 'e1', result: 'ok', isError: false });
  r.handle({ type: 'done', result: { response: 'Fixed it.', toolCalls: [], toolResults: [] } });
  assert.match(stderr.read(), /edited files but did not run the project's tests/);
  assert.match(stderr.read(), /npm test/);
  fs.rmSync(ws, { recursive: true, force: true });
}
{
  // No nudge when the run DID run tests after editing.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-verify-ok-'));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const stdout = createCapture();
  const stderr = createCapture();
  const r = createCliRunRenderer({ detailMode: 'progress', stdout: stdout.stream, stderr: stderr.stream, workspaceDir: ws });
  r.handle({ type: 'tool_start', toolName: 'edit_file', toolCallId: 'e1', input: { path: 'a.js' } });
  r.handle({ type: 'tool_end', toolName: 'edit_file', toolCallId: 'e1', result: 'ok', isError: false });
  r.handle({ type: 'tool_start', toolName: 'exec', toolCallId: 'x1', input: { command: 'node --test' } });
  r.handle({ type: 'tool_end', toolName: 'exec', toolCallId: 'x1', result: 'pass', isError: false });
  r.handle({ type: 'done', result: { response: 'done', toolCalls: [], toolResults: [] } });
  assert.doesNotMatch(stderr.read(), /did not run the project's tests/);
  fs.rmSync(ws, { recursive: true, force: true });
}
{
  // No nudge when there's no real test script (doc/config-only project).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-verify-none-'));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: {} }));
  const stdout = createCapture();
  const stderr = createCapture();
  const r = createCliRunRenderer({ detailMode: 'progress', stdout: stdout.stream, stderr: stderr.stream, workspaceDir: ws });
  r.handle({ type: 'tool_start', toolName: 'write_file', toolCallId: 'w1', input: { path: 'README.md' } });
  r.handle({ type: 'tool_end', toolName: 'write_file', toolCallId: 'w1', result: 'ok', isError: false });
  r.handle({ type: 'done', result: { response: 'done', toolCalls: [], toolResults: [] } });
  assert.doesNotMatch(stderr.read(), /did not run the project's tests/);
  fs.rmSync(ws, { recursive: true, force: true });
}

{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({
    detailMode: 'verbose',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  renderer.handle({
    type: 'tool_start',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    input: { command: 'hostname', password: 'secret' },
  });
  renderer.handle({
    type: 'tool_end',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    result: 'rdk-x5\n',
    isError: false,
  });
  assert.match(stderr.read(), /device_exec/);
  assert.match(stderr.read(), /hostname/);
  assert.match(stderr.read(), /rdk-x5/);
  assert.match(stderr.read(), /\[REDACTED\]/);
  assert.doesNotMatch(stderr.read(), /secret/);
}

{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({
    detailMode: 'quiet',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  renderer.handle({ type: 'turn_start', turn: 1 });
  renderer.handle({
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'tool-1',
    input: { path: 'README.md' },
  });
  renderer.handle({ type: 'text_delta', delta: 'Only answer' });
  renderer.handle({
    type: 'done',
    result: { response: 'Only answer', toolCalls: [], toolResults: [] },
  });
  assert.equal(stdout.read(), 'Only answer\n');
  assert.equal(stderr.read(), '');
}

console.log('[PASS] CLI output renderer shows safe beginner progress');
