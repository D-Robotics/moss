#!/usr/bin/env node
/**
 * O105: defense in depth — direct `readFileTool.execute` on Moss credential
 * paths (project `.moss/config.json`, user moss config, `.apikey-key`) must
 * not return apiKey plaintext. Agent/model path (presentToolOutput) stays
 * redacted. Ordinary project files and non-credential fixtures are untouched.
 *
 * Red-on-revert: drop the `isMossCredentialPath` branch in
 * `src/tools/file-tools.ts` `readFileTool.execute` → these asserts fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readFileTool } from '../dist/tools/file-tools.js';
import { presentToolOutput } from '../dist/safety/tool-output-redact.js';
import { isMossCredentialPath } from '../dist/safety/read-scope.js';
import { ToolHookRegistry } from '../dist/core/tools/tool-hooks.js';

const SECRET = 'sk-O105FAKE0000000000000000000001';
const PLAIN = 'o105-plain-secret-must-not-leak-XYZ';

function ctx(workspaceDir) {
  return {
    workspaceDir,
    sessionKey: 'o105',
    abortSignal: new AbortController().signal,
  };
}

async function modelView(tool, input, context, raw) {
  const registry = new ToolHookRegistry();
  registry.registerPost({
    name: 'secret-sanitizer',
    priority: 10,
    async process({ tool: hooked, input: hookedInput, result, ctx: hookedCtx }) {
      const sanitized = presentToolOutput({
        toolName: hooked.name,
        input: hookedInput,
        text: result,
        workspaceDir: hookedCtx.workspaceDir,
      });
      return sanitized !== result ? { result: sanitized } : null;
    },
  });
  return registry.runPostHooks({
    tool,
    input,
    result: String(raw),
    ctx: context,
  });
}

async function setupProject(t, config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o105-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, '.moss'), { recursive: true });
  await fs.mkdir(path.join(home, '.moss'), { recursive: true });
  await fs.mkdir(path.join(home, '.config', 'moss'), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
  });
  await fs.writeFile(path.join(ws, '.moss', 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return { root, home, ws };
}

function assertNoSecret(text, label) {
  const s = String(text);
  assert.ok(!s.includes(SECRET), `${label}: sk- secret absent`);
  assert.ok(!s.includes(PLAIN), `${label}: plain secret absent`);
}

test('O105 A: direct execute on project .moss/config.json redacts apiKey', async (t) => {
  const { ws } = await setupProject(t, {
    provider: 'openai-compatible',
    model: 'test-model',
    apiKey: SECRET,
  });
  assert.equal(isMossCredentialPath(path.join(ws, '.moss', 'config.json')), true);
  const out = await readFileTool.execute({ path: '.moss/config.json' }, ctx(ws));
  assert.doesNotMatch(String(out), /denied|Command blocked/i, 'read is still allowed');
  assert.match(String(out), /openai-compatible/, 'non-secret fields stay visible');
  assert.match(String(out), /test-model/);
  assertNoSecret(out, 'direct execute');
  assert.match(String(out), /\[REDACTED\]/, 'secret field is masked');
});

test('O105 A: direct execute redacts a plain (non sk-) apiKey too', async (t) => {
  const { ws } = await setupProject(t, {
    provider: 'openai-compatible',
    apiKey: PLAIN,
  });
  const out = await readFileTool.execute({ path: '.moss/config.json' }, ctx(ws));
  assertNoSecret(out, 'plain apiKey execute');
  assert.match(String(out), /\[REDACTED\]|Moss credential values withheld/);
  assert.match(String(out), /openai-compatible/);
});

test('O105 A: user ~/.moss/config.json and ~/.config/moss/config.json', async (t) => {
  const { home, ws } = await setupProject(t, { apiKey: SECRET, provider: 'openai-compatible' });
  const body = JSON.stringify({ apiKey: SECRET, provider: 'openai-compatible' }, null, 2) + '\n';
  await fs.writeFile(path.join(home, '.moss', 'config.json'), body);
  await fs.writeFile(path.join(home, '.config', 'moss', 'config.json'), body);
  for (const target of ['~/.moss/config.json', '~/.config/moss/config.json']) {
    const out = await readFileTool.execute({ path: target }, ctx(ws));
    assertNoSecret(out, `direct execute ${target}`);
    assert.match(String(out), /openai-compatible/, target);
    assert.match(String(out), /\[REDACTED\]/, target);
  }
});

test('O105 A: .apikey-key is fully withheld on direct execute', async (t) => {
  const { home, ws } = await setupProject(t, { apiKey: SECRET });
  const keyPath = path.join(home, '.moss', '.apikey-key');
  await fs.writeFile(keyPath, `${PLAIN}\n`);
  const out = await readFileTool.execute({ path: keyPath }, ctx(ws));
  assertNoSecret(out, '.apikey-key execute');
  assert.match(String(out), /Moss credential values withheld/);
});

test('O105 B: agent/model path still has no plaintext (regression)', async (t) => {
  const { ws } = await setupProject(t, {
    provider: 'openai-compatible',
    apiKey: SECRET,
  });
  const raw = await readFileTool.execute({ path: '.moss/config.json' }, ctx(ws));
  const viewed = await modelView(readFileTool, { path: '.moss/config.json' }, ctx(ws), raw);
  assertNoSecret(viewed, 'model view');
  assert.match(viewed, /openai-compatible/);
  assert.match(viewed, /\[REDACTED\]/);
});

test('O105: ordinary project file is not redacted by path alone', async (t) => {
  const { ws } = await setupProject(t, { apiKey: SECRET });
  const note = `hello world\napiKey=${SECRET}\n`;
  await fs.writeFile(path.join(ws, 'notes.txt'), note);
  const out = await readFileTool.execute({ path: 'notes.txt' }, ctx(ws));
  // Not a moss credential path — execute returns body; pattern redaction may
  // still mask sk- tokens in the body, but the path gate itself must not fire.
  assert.equal(isMossCredentialPath(path.join(ws, 'notes.txt')), false);
  assert.match(String(out), /hello world/);
});

test('O105: non-credential fixture config.json outside .moss is not path-gated', async (t) => {
  const { ws } = await setupProject(t, { apiKey: SECRET });
  const fixture = path.join(ws, 'fixtures', 'sample-config.json');
  await fs.mkdir(path.dirname(fixture), { recursive: true });
  // Placeholder / short value — not a real key; must remain readable.
  await fs.writeFile(
    fixture,
    JSON.stringify({ apiKey: 'placeholder', provider: 'openai-compatible' }, null, 2) + '\n'
  );
  assert.equal(isMossCredentialPath(fixture), false);
  const out = await readFileTool.execute({ path: 'fixtures/sample-config.json' }, ctx(ws));
  assert.match(String(out), /placeholder/);
  assert.match(String(out), /openai-compatible/);
});

test('O105: project .moss/tasks.jsonl is not a credential path', async (t) => {
  const { ws } = await setupProject(t, { apiKey: SECRET });
  await fs.writeFile(path.join(ws, '.moss', 'tasks.jsonl'), '{"task":"ok"}\n');
  assert.equal(isMossCredentialPath(path.join(ws, '.moss', 'tasks.jsonl')), false);
  const out = await readFileTool.execute({ path: '.moss/tasks.jsonl' }, ctx(ws));
  assert.match(String(out), /"task":"ok"/);
});

test('O105: project .moss/devices.json is gated like config.json', async (t) => {
  const { ws } = await setupProject(t, { apiKey: SECRET });
  const devices = {
    devices: [{ host: 'board.local', password: PLAIN }],
  };
  await fs.writeFile(
    path.join(ws, '.moss', 'devices.json'),
    JSON.stringify(devices, null, 2) + '\n'
  );
  assert.equal(isMossCredentialPath(path.join(ws, '.moss', 'devices.json')), true);
  const out = await readFileTool.execute({ path: '.moss/devices.json' }, ctx(ws));
  assert.ok(!String(out).includes(PLAIN), 'device password absent from execute');
  assert.match(String(out), /board\.local/);
  assert.match(String(out), /\[REDACTED\]/);
});
