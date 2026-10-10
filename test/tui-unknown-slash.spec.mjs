#!/usr/bin/env node
/**
 * Unknown slash input stays local: no model call, up to three closest
 * commands, and a hint to type /help. A filesystem path and a slash followed
 * by whitespace stay ordinary prompts. The `/` menu does not offer unfilled
 * template skills.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-unknown-slash-config-'));
process.env.MOSS_CONFIG_DIR = configDir;
process.env.MOSS_NO_BUNDLED_DEFAULT = '1';

const { TuiAppRoot, shellPaletteRows } = await import('../dist/cli/tui/app.js');
const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
const { renderTranscriptRow } = await import('../dist/cli/tui/transcript.js');
const { closestSlashCommands } = await import('../dist/cli/command-completion.js');
const { reservedBuiltinNames } = await import('../dist/cli/commands/custom-commands.js');
const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
};

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify() {
      for (const listener of listeners) listener();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const type = async (instance, text) => {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(12);
  }
  instance.stdin.write('\r');
  await sleep(40);
};

const errors = (handle) =>
  handle.store.rows
    .filter((row) => row.kind === 'error')
    .map((row) => row.text)
    .join('\n');

{
  const menu = shellPaletteRows('/', [
    ['/{{name}}', '{{description}}'],
    ['/greet', 'say hello'],
  ]);
  assert.equal(
    menu.some(([command, description]) => /[{}]/.test(command) || /[{}]/.test(description)),
    false,
    'slash menu has no brace entries'
  );
  assert.ok(
    menu.some(([command]) => command === '/greet'),
    'a real skill stays in the slash menu'
  );
  assert.equal(shellPaletteRows('/halp').length, 0, '/halp must not be stolen by the palette');
  assert.equal(shellPaletteRows('/{{name}}').length, 0);
  assert.equal(shellPaletteRows('/usr/bin/foo').length, 0);
  assert.ok(closestSlashCommands('/halp', [...reservedBuiltinNames()]).includes('/help'));

  const notice =
    'Skipped /tmp/skill-creator/templates/skill/SKILL.md: name or description is an unfilled template placeholder';
  const painted = renderTranscriptRow({ id: 1, kind: 'summary', text: notice }, 120);
  assert.equal(painted.at(-1)?.dim, true, 'a catalog skip notice renders dim');
}

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');
  const streamCalls = [];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-unknown-slash-'));
  const handle = liveHandle();
  const listeners = new Set();
  const agent = {
    asyncTasks: { list: () => [] },
    config: {
      model: 'spec-model',
      contextTokens: 1000,
      sessionStore: { loadMessages: async () => [] },
    },
    tools: { getAll: () => [], getNames: () => [], size: 0 },
    async *streamChat(_sessionKey, message) {
      streamCalls.push(message);
      yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
    },
  };
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: {
        agent,
        workspaceDir: workspace,
        locale: 'en',
        skills: [
          { name: '{{name}}', description: '{{description}}' },
          { name: 'greet', description: 'say hello' },
        ],
        listSessions: async () => [],
        noticeSource: {
          subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
      },
      handle,
      runtime: new TaskRuntime({ workspaceDir: workspace }),
    })
  );
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  assert.ok(await waitFor(() => listeners.size > 0));
  const skip =
    'Skipped /tmp/skill-creator/templates/skill/SKILL.md: name or description is an unfilled template placeholder';
  for (const listener of listeners) listener(skip);
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.text === skip)));
  const skipRow = handle.store.rows.find((row) => row.text === skip);
  assert.equal(skipRow?.kind, 'summary', 'a skipped skill file is one dim notice');

  instance.stdin.write('/');
  await sleep(80);
  assert.equal(instance.lastFrame().includes('{{name}}'), false, 'slash menu has no brace entries');
  assert.equal(instance.lastFrame().includes('{{description}}'), false);
  instance.stdin.write('\x15');
  await sleep(40);

  await type(instance, '/{{name}}');
  assert.ok(
    await waitFor(() => errors(handle).includes('unknown command "/{{name}}"')),
    `placeholder slash entry stays local: ${errors(handle)}`
  );
  assert.match(errors(handle), /Type \/help for available commands/);
  assert.equal(streamCalls.length, 0, 'unknown slash command makes no model call');

  await type(instance, '/halp');
  assert.ok(
    await waitFor(() => errors(handle).includes('unknown command "/halp"')),
    `typo stays local: ${errors(handle)}`
  );
  assert.match(errors(handle), /Did you mean/);
  assert.match(errors(handle), /\/help/);
  assert.equal(streamCalls.length, 0, 'unknown slash command makes no model call');

  await type(instance, '/usr/bin/foo --version');
  assert.ok(
    await waitFor(() => streamCalls.some((message) => message.includes('/usr/bin/foo'))),
    `a filesystem path is still sent to the model: ${JSON.stringify(streamCalls)}`
  );
  assert.ok(await waitFor(() => handle.store.run.running === false));

  const callsAfterPath = streamCalls.length;
  await type(instance, '/ hello');
  assert.ok(
    await waitFor(() => streamCalls.length > callsAfterPath),
    'slash followed by whitespace is still sent to the model'
  );
  assert.ok(streamCalls.at(-1).includes('hello'));

  instance.unmount();
  await sleep(80);
}

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-unknown-slash-cmd-'));
  const dir = path.join(workspace, '.moss', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '{{name}}.md');
  fs.writeFileSync(file, '---\ndescription: {{description}}\n---\n\nstill a template\n');
  const handle = liveHandle();
  const instance = renderInk(
    React.createElement(TuiAppRoot, {
      options: {
        agent: {
          asyncTasks: { list: () => [] },
          config: {
            model: 'spec-model',
            contextTokens: 1000,
            sessionStore: { loadMessages: async () => [] },
          },
          tools: { getAll: () => [], getNames: () => [], size: 0 },
          async *streamChat() {
            yield { type: 'done', result: { response: 'ok', stopReason: 'end_turn' } };
          },
        },
        workspaceDir: workspace,
        locale: 'en',
        listSessions: async () => [],
      },
      handle,
      runtime: new TaskRuntime({ workspaceDir: workspace }),
    })
  );
  const noticed = await waitFor(() =>
    handle.store.rows.some((row) => row.kind === 'summary' && row.text.includes(file))
  );
  assert.ok(noticed, 'a skipped command file is named once');
  const copies = handle.store.rows.filter((row) => row.text.includes(file));
  assert.equal(copies.length, 1, 'each skipped command file is named once');
  assert.match(copies[0].text, /unfilled template placeholder/);
  instance.unmount();
  await sleep(80);
}

console.log('[PASS] tui unknown slash');
