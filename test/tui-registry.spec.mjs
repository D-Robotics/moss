#!/usr/bin/env node
/**
 * CLI shell control-command registry (M1): the commands the shell advertises
 * must DO the real thing, not just print a block.
 *
 *   /model <name>   switches the session model + provider (status row follows)
 *   /model          lists the real catalog
 *   /mode plan      drives the shared interaction-mode policy layer
 *   /compact        runs the real compaction and reports its numbers
 *   /diff           shows the real working-tree diff
 *   /review         hands the real diff to the agent as a review prompt
 *   /context        reports provider-reported context usage when available
 *
 * Hermetic: config resolution is pointed at an empty temp dir with the bundled
 * gateway disabled, so no command reaches the network from a spec.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-reg-config-'));
process.env.MOSS_CONFIG_DIR = configDir;
process.env.MOSS_NO_BUNDLED_DEFAULT = '1';

const { TuiAppRoot, commandBlockTitle, shellContextUsage } = await import('../dist/cli/tui/app.js');
const { HELP_COMMANDS } = await import('../dist/cli/tui/help.js');
const { TaskRuntime } = await import('../dist/core/task-runtime/runtime.js');
const { applyAgentEvent, createTuiStore } = await import('../dist/cli/tui/render-bridge.js');
const { getCliInteractionMode, setCliInteractionMode } =
  await import('../dist/cli/interaction-mode.js');

const { render: renderInk } = await import('ink-testing-library');
const React = await import('react');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveHandle() {
  const listeners = new Set();
  return {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

async function type(instance, text) {
  for (const ch of text) {
    instance.stdin.write(ch);
    await sleep(12);
  }
  instance.stdin.write('\r');
  await sleep(30);
}

function mockAgent() {
  const calls = { stream: [], compact: [] };
  const agent = {
    steer: () => null,
    asyncTasks: { list: () => [] },
    async compactSession(sessionKey, instructions) {
      calls.compact.push({ sessionKey, instructions });
      return { compacted: true, droppedMessages: 7, summaryChars: 99, tokensAfter: 4242 };
    },
    config: {
      model: 'spec-model',
      contextTokens: 100_000,
      llmProvider: { id: 'spec-model' },
      sessionStore: {
        loadMessages: async () => [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      },
    },
    tools: { getAll: () => [], getNames: () => [], size: 0 },
    async *streamChat(_sessionKey, message) {
      calls.stream.push(message);
      yield { type: 'done', result: { response: 'reviewed', stopReason: 'end_turn' } };
    },
  };
  return { agent, calls };
}

function mount(options) {
  const handle = liveHandle();
  const runtime = new TaskRuntime({
    workspaceDir: options.workspaceDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-reg-')),
  });
  const instance = renderInk(React.createElement(TuiAppRoot, { options, handle, runtime }));
  return { instance, handle, runtime };
}

/** A git workspace with one commit and one uncommitted modification. */
function makeGitWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-reg-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'moss@example.com');
  git('config', 'user.name', 'Moss Test');
  fs.writeFileSync(path.join(dir, 'demo.txt'), 'one\n');
  git('add', 'demo.txt');
  git('commit', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'demo.txt'), 'one\ntwo\n');
  return dir;
}

const blockTexts = (handle) =>
  handle.store.rows.filter((r) => r.kind === 'tool').map((r) => r.text);
const allText = (handle) => handle.store.rows.map((r) => r.text).join('\n');

// ─── pure helpers ────────────────────────────────────────────────────────────

assert.equal(commandBlockTitle('/status'), 'Status', 'a command names its block');
assert.equal(commandBlockTitle('/quickstart'), 'Quickstart');
assert.equal(commandBlockTitle(''), 'Command');
assert.equal(
  shellContextUsage({
    tokensIn: 0,
    tokensOut: 0,
    runTokensIn: 0,
    runTokensOut: 0,
    contextUsed: 0,
    contextTotal: 0,
    compactions: 0,
  }),
  undefined,
  'no provider window → no provider snapshot (the registry estimates instead)'
);
assert.deepEqual(
  shellContextUsage({
    tokensIn: 0,
    tokensOut: 0,
    runTokensIn: 0,
    runTokensOut: 0,
    contextUsed: 11_500,
    contextTotal: 100_000,
    compactions: 0,
  }),
  { used: 11_500, total: 100_000, source: 'provider' },
  'a reported window is surfaced as provider usage'
);

// ─── /model: a session switch that the status row follows ────────────────────

{
  const { agent } = mockAgent();
  const providerBefore = agent.config.llmProvider;
  const { instance, handle } = mount({ agent, workspaceDir: '/tmp/ws', model: 'spec-model' });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  await type(instance, '/model spec-two');
  const switched = await waitFor(() => allText(handle).includes('spec-two'));
  assert.ok(switched, `/model answered: ${JSON.stringify(allText(handle).slice(-200))}`);
  assert.equal(agent.config.model, 'spec-two', 'the session model really changed');
  assert.notEqual(agent.config.llmProvider, providerBefore, 'the provider was rebuilt');
  assert.ok(blockTexts(handle).includes('Model'), 'the switch is reported in the Model block');
  const status = instance.lastFrame();
  assert.match(status, /spec-two/, 'the status row follows the new model');
  instance.unmount();
  await sleep(100);
}

// ─── /model with no argument lists the real catalog ──────────────────────────

{
  const { agent } = mockAgent();
  const { instance, handle } = mount({ agent, workspaceDir: '/tmp/ws', model: 'spec-model' });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  await type(instance, '/model');
  const listed = await waitFor(() => instance.lastFrame().includes('Select model'));
  assert.ok(
    listed,
    `/model opened the picker: ${JSON.stringify(instance.lastFrame().slice(-300))}`
  );
  assert.match(instance.lastFrame(), /spec-model/, 'the picker includes the active model');
  instance.unmount();
  await sleep(100);
}

// ─── /mode drives the shared policy layer and shows up in the chrome ─────────

{
  setCliInteractionMode('manual');
  const { agent } = mockAgent();
  const { instance, handle } = mount({ agent, workspaceDir: '/tmp/ws' });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  // v0.26 (PRD W1): the four-mode help block lists manual/accept-edits/plan/full
  // — full is the new default and its line names the deny-rule guardrail.
  await type(instance, '/mode');
  const helped = await waitFor(() => allText(handle).includes('/mode full'));
  assert.ok(
    helped,
    `the /mode help lists all four modes: ${JSON.stringify(allText(handle).slice(-400))}`
  );
  assert.match(allText(handle), /\/mode manual/, 'the help lists manual');
  assert.match(allText(handle), /\/mode accept-edits/, 'the help lists accept-edits');
  assert.match(allText(handle), /\/mode plan/, 'the help lists plan');
  assert.match(
    allText(handle),
    /\/mode full.*deny rules/i,
    'the full line names the deny-rule guardrail'
  );
  await type(instance, '/mode plan');
  const answered = await waitFor(() => allText(handle).includes('Switched to plan'));
  assert.ok(answered, `/mode answered: ${JSON.stringify(allText(handle).slice(-200))}`);
  assert.equal(getCliInteractionMode(), 'plan', 'the interaction-mode policy layer changed');
  assert.match(
    instance.lastFrame(),
    /interaction mode: plan/,
    'the shell reflects the mode instead of silently changing it'
  );
  await type(instance, '/mode full');
  await waitFor(() => allText(handle).includes('Switched to full'));
  assert.equal(
    getCliInteractionMode(),
    'full',
    'v0.26: /mode full switches to the full mode (four-state)'
  );
  assert.match(
    allText(handle),
    /deny rules and dangerous-command blocks still apply/i,
    'the full switch copy names what still applies'
  );
  await type(instance, '/mode default');
  await waitFor(() => getCliInteractionMode() === 'manual');
  assert.equal(
    getCliInteractionMode(),
    'manual',
    '/mode default restores the manual mode (v0.26 rename, alias kept)'
  );
  instance.unmount();
  await sleep(100);
}

// ─── /compact runs the real compaction and reports its numbers ───────────────

{
  const { agent, calls } = mockAgent();
  const { instance, handle } = mount({ agent, workspaceDir: '/tmp/ws' });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  await type(instance, '/compact focus on the parser');
  const compacted = await waitFor(() => allText(handle).includes('dropped messages'));
  assert.ok(compacted, `/compact answered: ${JSON.stringify(allText(handle).slice(-300))}`);
  assert.equal(calls.compact.length, 1, 'the real compaction ran once');
  assert.equal(calls.compact[0].instructions, 'focus on the parser', 'instructions are forwarded');
  assert.match(allText(handle), /dropped messages: 7/, 'the real dropped-message count is shown');
  assert.match(allText(handle), /4,242/, 'the real post-compaction token count is shown');
  instance.unmount();
  await sleep(100);
}

// ─── /diff renders the real working-tree diff ────────────────────────────────

{
  const workspace = makeGitWorkspace();
  const { agent } = mockAgent();
  const { instance, handle } = mount({ agent, workspaceDir: workspace });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  await type(instance, '/diff');
  const diffed = await waitFor(() =>
    handle.store.rows.some((r) => r.kind === 'result' && r.text.includes('+two'))
  );
  assert.ok(diffed, `/diff showed the diff: ${JSON.stringify(allText(handle).slice(-300))}`);
  assert.ok(blockTexts(handle).includes('Diff'), 'the diff is announced in its own block');
  instance.unmount();
  await sleep(100);
}

// ─── /review hands the real diff to the agent ────────────────────────────────

{
  const workspace = makeGitWorkspace();
  const { agent, calls } = mockAgent();
  const { instance, handle } = mount({ agent, workspaceDir: workspace });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  await type(instance, '/review');
  const submitted = await waitFor(() => calls.stream.length === 1);
  assert.ok(submitted, `/review started a run: ${JSON.stringify(allText(handle).slice(-300))}`);
  assert.match(calls.stream[0], /You are reviewing the following code change/);
  assert.match(calls.stream[0], /\+two/, 'the review prompt carries the real diff');
  assert.ok(blockTexts(handle).includes('Review'), 'the review is announced in its own block');
  instance.unmount();
  await sleep(100);
}

// ─── /context prefers the provider-reported window ───────────────────────────

{
  const { agent } = mockAgent();
  const { instance, handle } = mount({ agent, workspaceDir: '/tmp/ws' });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  applyAgentEvent(handle.store, {
    type: 'llm_usage',
    inputTokens: 8000,
    outputTokens: 10,
    cacheReadTokens: 3000,
    cacheCreationTokens: 500,
    contextTokens: 100_000,
  });
  await type(instance, '/context');
  const answered = await waitFor(() => allText(handle).includes('provider-reported'));
  assert.ok(answered, `/context answered: ${JSON.stringify(allText(handle).slice(-300))}`);
  assert.match(allText(handle), /11,500 \/ 100,000/);
  instance.unmount();
  await sleep(100);
}

// ─── unknown input is still honest, and nothing new leaks into the surface ───

{
  const { agent } = mockAgent();
  const { instance, handle } = mount({ agent, workspaceDir: '/tmp/ws' });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  await type(instance, '/definitely-not-a-command');
  const unknown = await waitFor(() =>
    handle.store.rows.some((r) => r.text.includes('unknown command "/definitely-not-a-command"'))
  );
  assert.ok(unknown, 'unknown commands still say so');
  instance.unmount();
  await sleep(100);
}

for (const command of [
  '/model',
  '/mode',
  '/compact',
  '/status',
  '/diff',
  '/context',
  '/export',
  '/doctor',
  '/permissions',
  '/review',
]) {
  assert.ok(
    HELP_COMMANDS.some((entry) => entry.split(' ')[0] === command),
    `${command} is advertised by the shell`
  );
}

// ─── /permissions is the v0.26 rule manager (T04) ───────────────────────────

{
  setCliInteractionMode('manual');
  const { PermissionRuleRegistry } = await import('../dist/cli/permission-rules.js');
  const registry = new PermissionRuleRegistry();
  const { agent } = mockAgent();
  const { instance, handle } = mount({
    agent,
    workspaceDir: '/tmp/ws',
    // The TUI context takes the runtime (registry + live rule getter) from
    // options.cliRuntime — exactly what cli-main passes via liveRuntime.
    cliRuntime: {
      workspace: '/tmp/ws',
      sessionKey: 'tui-permissions',
      permissionRuleRegistry: registry,
      permissionsRules: () => ({
        rules: [...registry.list()],
        sources: { userPath: `${configDir}/config.json` },
      }),
    },
  });
  await waitFor(() => handle.store.rows.some((r) => r.kind === 'banner'));
  // The default view names the mode, counts rules, and advertises the
  // manager subcommands.
  await type(instance, '/permissions');
  const viewed = await waitFor(() => allText(handle).includes('default mode'));
  assert.ok(
    viewed,
    `the /permissions view rendered: ${JSON.stringify(allText(handle).slice(-300))}`
  );
  assert.match(allText(handle), /default mode:\s*full/, 'the view names the default mode');
  assert.match(
    allText(handle),
    /\/permissions add\|remove\|persist/,
    'the view advertises the manager subcommands'
  );
  // add → remove round-trip through the registry the TUI shares with the hook.
  await type(instance, '/permissions add deny "read_file(./.env)"');
  const added = await waitFor(() => allText(handle).includes('Session deny rule added'));
  assert.ok(added, 'add confirms the session rule in the shell');
  assert.equal(registry.list().length, 1, 'the rule landed in the shared registry');
  await type(instance, '/permissions remove "read_file(./.env)"');
  const removed = await waitFor(() => allText(handle).includes('Session rule removed'));
  assert.ok(removed, 'remove works from the shell');
  assert.equal(registry.list().length, 0, 'the rule is gone from the registry');
  instance.unmount();
  await sleep(100);
}

console.log('[PASS] TUI control-command registry (model/mode/compact/diff/review/context)');
