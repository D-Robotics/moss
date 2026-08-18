#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchPlugin, pluginCommandRows } from '../dist/cli/plugin-interactive-commands.js';

function fixture() {
  const calls = [];
  return {
    calls,
    listCommands: () => [
      { id: 'review-pack', title: 'Review pack', description: 'Run the plugin review' },
      { id: 'status', title: 'Must not shadow built-in' },
    ],
    async expandCommand(id, args) {
      calls.push([id, args]);
      return id === 'review-pack' ? `Review ${args}` : undefined;
    },
  };
}

test('plugin command rows exclude reserved built-ins', () => {
  assert.deepEqual(pluginCommandRows(fixture()), [['/review-pack', 'Run the plugin review']]);
});

test('plugin command dispatch preserves the complete argument string', async () => {
  const plugins = fixture();
  const prompts = [];
  assert.equal(
    await dispatchPlugin('/review-pack src --strict', plugins, (value) => prompts.push(value)),
    true
  );
  assert.deepEqual(plugins.calls, [['review-pack', 'src --strict']]);
  assert.deepEqual(prompts, ['Review src --strict']);
});

test('plugin command dispatch never shadows a built-in', async () => {
  const plugins = fixture();
  assert.equal(
    await dispatchPlugin('/status', plugins, () => assert.fail('must not submit')),
    false
  );
  assert.deepEqual(plugins.calls, []);
});
