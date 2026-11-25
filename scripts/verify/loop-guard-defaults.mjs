#!/usr/bin/env node
/**
 * Offline regression for the tool-loop-guard limits.
 *
 * Every limit is opt-in. With no MOSS_TOOL_LOOP_* variable set the guard lets
 * the model repeat a call, rerun a failing check, retry a URL and widen a
 * search; a run ends on its own turn and tool-call budgets. A host that sets a
 * limit gets the block and its reason back. What stays on without any variable
 * is checked here too: the in-flight fresh-news dedupe and the two budgets for
 * fresh observations.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (file) => import(pathToFileURL(path.join(root, 'dist', file)).href);
const { builtinTools } = await load('tools/builtin.js');
const { installToolClassifications } = await load('core/tools/tool-classes.js');
const { createToolLoopGuardState, recordToolLoopOutcome, shouldShortCircuitToolCall } = await load(
  'core/tools/tool-loop-guard.js'
);

installToolClassifications(builtinTools);

const discoveryTool = builtinTools.find((tool) => tool.metadata?.classification?.discovery);
assert.ok(discoveryTool, 'a builtin tool declares the discovery classification');

const exitCode = (code, body) => `exit_code: ${code}\n${body}`;
const cases = [
  {
    name: 'identical input',
    env: { MOSS_TOOL_LOOP_IDENTICAL_LIMIT: '3' },
    tool: 'read_file',
    input: { path: 'src/a.ts' },
    prepare(state, tool, input) {
      for (let i = 0; i < 3; i += 1)
        assert.equal(shouldShortCircuitToolCall(state, tool, input), null);
    },
    reason: /^identical input was already requested 3 time\(s\) in this user turn/,
  },
  {
    name: 'same failing check',
    env: { MOSS_TOOL_LOOP_SAME_COMMAND_LIMIT: '3' },
    tool: 'exec',
    input: { command: 'npm test' },
    prepare(state, tool, input) {
      for (let i = 0; i < 3; i += 1)
        recordToolLoopOutcome(state, tool, true, exitCode(1, 'Test Results: ❌ 1 FAILED'), input);
    },
    reason: /^same check failed repeatedly \(3×\): npm test$/,
  },
  {
    name: 'tool fault',
    env: { MOSS_TOOL_LOOP_FAILURE_LIMIT: '3' },
    tool: 'exec',
    input: { command: 'npm run build' },
    prepare(state, tool) {
      for (let i = 0; i < 3; i += 1)
        recordToolLoopOutcome(state, tool, true, 'timed out after 5000ms', {
          command: 'sleep 100',
        });
    },
    reason: /^exec timed out 3 time\(s\) in this user turn$/,
  },
  {
    name: 'discovery failure',
    env: { MOSS_TOOL_LOOP_DISCOVERY_FAILURE_LIMIT: '2' },
    tool: discoveryTool.name,
    input: { pattern: '**/*.ts', path: 'src' },
    prepare(state, tool, input) {
      for (let i = 0; i < 2; i += 1)
        recordToolLoopOutcome(state, tool, true, 'Error: probe failed', input);
    },
    reason: new RegExp(`^${discoveryTool.name} has failed 2 time\\(s\\) in this user turn$`),
  },
  {
    name: 'web_fetch per URL',
    env: { MOSS_TOOL_LOOP_FAILURE_LIMIT: '3' },
    tool: 'web_fetch',
    input: { url: 'https://example.com/a' },
    prepare(state, tool, input) {
      for (let i = 0; i < 3; i += 1)
        recordToolLoopOutcome(state, tool, true, 'web_fetch_error: HTTP 500', input);
    },
    reason: /^web_fetch on https:\/\/example\.com\/a has failed 3 time\(s\) in this user turn$/,
  },
  {
    name: 'web_search variation',
    env: { MOSS_WEB_SEARCH_VARIATION_LIMIT: '6' },
    tool: 'web_search',
    input: { query: 'seventh angle' },
    prepare(state, tool) {
      for (let i = 0; i < 6; i += 1)
        assert.equal(shouldShortCircuitToolCall(state, tool, { query: `angle ${i}` }), null);
    },
    reason: /^web_search has already been called with 6 different queries in this user turn$/,
  },
];

for (const name of Object.keys(process.env)) {
  assert.ok(
    !/^MOSS_TOOL_LOOP_|^MOSS_WEB_SEARCH_VARIATION_LIMIT$/.test(name),
    `${name} is set in the probe environment`
  );
}

for (const item of cases) {
  {
    const state = createToolLoopGuardState();
    item.prepare(state, item.tool, item.input);
    assert.equal(
      shouldShortCircuitToolCall(state, item.tool, item.input),
      null,
      `${item.name}: no block without a host limit`
    );
  }
  for (const [name, value] of Object.entries(item.env)) process.env[name] = value;
  try {
    const state = createToolLoopGuardState();
    item.prepare(state, item.tool, item.input);
    assert.match(
      shouldShortCircuitToolCall(state, item.tool, item.input) ?? '',
      item.reason,
      `${item.name}: the host limit blocks with its reason`
    );
  } finally {
    for (const name of Object.keys(item.env)) delete process.env[name];
  }
  console.log(`[loop-guard-defaults] ok ${item.name}: off by default, blocks when set`);
}

// One fresh-news search per assistant step; a batched duplicate in the same
// step is not a second attempt.
{
  const state = createToolLoopGuardState();
  assert.equal(
    shouldShortCircuitToolCall(state, 'web_search', { query: 'launch date', recency: 'day' }),
    null
  );
  assert.match(
    shouldShortCircuitToolCall(state, 'web_search', { query: '发布日期', recency: 'week' }) ?? '',
    /^a fresh-news search is already in progress in this assistant step$/
  );
  assert.equal(
    shouldShortCircuitToolCall(
      state,
      'web_search',
      { query: '发布日期', recency: 'week' },
      { parallelBatch: true }
    ),
    null
  );
}
console.log(
  '[loop-guard-defaults] ok fresh-news dedupe: one in flight per step, batched duplicates pass'
);

// A bounded probe may repeat one signature 12 times; the 13th is over budget.
{
  const state = createToolLoopGuardState();
  const input = { kind: 'temperature' };
  for (let i = 0; i < 12; i += 1)
    assert.equal(
      shouldShortCircuitToolCall(state, 'device_probe', input, { freshObservation: true }),
      null
    );
  assert.match(
    shouldShortCircuitToolCall(state, 'device_probe', input, { freshObservation: true }) ?? '',
    /^identical input was already requested 12 time\(s\) in this user turn$/
  );
}
console.log('[loop-guard-defaults] ok fresh observation budget: 12 of one signature, then stopped');
