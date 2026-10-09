#!/usr/bin/env node
/**
 * P0-3: file commands and skills resolve in one place, and the skill prompt
 * keeps the caller's arguments. On main the TUI built the skill prompt with
 * no $ARGUMENTS, and .moss/commands was REPL-only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermetic: the TUI import captures CLI config at module load. Point it at an
// empty directory before that import (same constraint as tui-command-surface).
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-user-cmd-config-'));
process.env.MOSS_CONFIG_DIR = configDir;
process.env.MOSS_NO_BUNDLED_DEFAULT = '1';

const { expandCommandBody, loadCustomCommands, reservedBuiltinNames, resolveUserCommand } =
  await import('../dist/cli/commands/custom-commands.js');
const { TuiAppRoot, shellPaletteRows } = await import('../dist/cli/tui/app.js');
const { createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');

const builtins = reservedBuiltinNames();

{
  const resolved = resolveUserCommand('/greet Ada', {
    builtinNames: builtins,
    customCommands: [],
    skills: [{ name: 'greet', description: 'say hello' }],
  });
  assert.equal(resolved.kind, 'skill');
  assert.match(resolved.prompt, /Ada/, 'a skill prompt keeps $ARGUMENTS');
  assert.match(resolved.prompt, /greet/);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-user-cmd-'));
  const dir = path.join(workspace, '.moss', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hi.md'),
    ['---', 'description: say hi', '---', 'Hello $ARGUMENTS from hi.md'].join('\n')
  );
  const custom = loadCustomCommands({
    workspace,
    configDir: path.join(workspace, '.moss'),
    reservedNames: builtins,
  });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].name, '/hi');
  const resolved = resolveUserCommand('/hi world', {
    builtinNames: builtins,
    customCommands: custom,
    skills: [{ name: 'hi', description: 'skill loses to the file' }],
  });
  assert.equal(resolved.kind, 'custom', 'a file command outranks a same-named skill');
  assert.match(resolved.prompt, /Hello world from hi\.md/);

  const builtinWins = resolveUserCommand('/plan the parser', {
    builtinNames: builtins,
    customCommands: [
      {
        name: '/plan',
        summary: 'should not win',
        body: 'custom $ARGUMENTS',
        run() {},
      },
    ],
    skills: [],
  });
  assert.equal(builtinWins.kind, 'builtin', 'a built-in outranks a file command');

  const rows = shellPaletteRows(
    '/',
    custom.map((command) => [command.name, command.summary])
  );
  assert.ok(
    rows.some(([command]) => command === '/hi'),
    '/hi from .moss/commands is offered in the / menu'
  );
}

{
  assert.equal(expandCommandBody('use $1 and $2', 'alpha beta'), 'use alpha and beta');
  assert.equal(expandCommandBody('no placeholder', 'tail'), 'no placeholder\n\ntail');
}

{
  const { render: renderInk } = await import('ink-testing-library');
  const React = await import('react');
  const streamCalls = [];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-user-cmd-tui-'));
  const dir = path.join(workspace, '.moss', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hi.md'), 'Hello $ARGUMENTS from the file\n');
  const listeners = new Set();
  const handle = {
    store: createTuiStore(),
    notify() {
      for (const listener of listeners) listener();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
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
        skills: [{ name: 'greet', description: 'say hello' }],
        listSessions: async () => [],
      },
      handle,
      runtime: new TaskRuntime({ workspaceDir: workspace }),
    })
  );
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(40);
    }
    return false;
  };
  const type = async (text) => {
    for (const ch of text) {
      instance.stdin.write(ch);
      await sleep(12);
    }
    instance.stdin.write('\r');
    await sleep(30);
  };
  assert.ok(await waitFor(() => handle.store.rows.some((row) => row.kind === 'banner')));
  await type('/greet Ada');
  assert.ok(
    await waitFor(() => streamCalls.some((message) => message.includes('Ada'))),
    `TUI skill dispatch keeps arguments: ${JSON.stringify(streamCalls)}`
  );
  await type('/hi Lin');
  assert.ok(
    await waitFor(() => streamCalls.some((message) => message.includes('Hello Lin from the file'))),
    `TUI file command keeps arguments: ${JSON.stringify(streamCalls)}`
  );
  instance.unmount();
  await sleep(80);
}

console.log('[PASS] cli user commands');
