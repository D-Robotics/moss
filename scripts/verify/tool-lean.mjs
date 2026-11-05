#!/usr/bin/env node
/**
 * D3 tool-surface slice probe.
 *
 * Deterministic: imports the compiled production modules (no model call) and
 * asserts that (a) the lean tier is really short (one sentence + "not for"
 * hint, <=120 chars each) and saves a large share of declaration chars, and
 * (b) the MOSS_HIDE_TOOLS experiment switch hides exactly the named tools and
 * reports unknown names. One real mock-mode CLI run checks the startup notice.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const load = async (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);
const { builtinTools } = await load('tools/builtin.js');
const { buildProviderToolDeclarations, toolDescriptionForModel } = await load(
  'core/loop/agent-loop-context-prep.js'
);
const { toolVisibleForRun, hiddenToolNames, unknownHiddenToolNames } = await load(
  'core/agent/session-tool-offer.js'
);
const cli = path.join(root, 'dist/cli.js');
const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const leanTools = builtinTools.filter((tool) => tool.metadata?.leanDescription);

await check('every lean description is one short sentence plus a "not for" hint', async () => {
  assert.ok(leanTools.length >= 30, `only ${String(leanTools.length)} lean descriptions`);
  const tooLong = leanTools
    .filter((tool) => String(tool.metadata.leanDescription).length > 120)
    .map((tool) => `${tool.name}=${String(tool.metadata.leanDescription).length}`);
  assert.deepEqual(tooLong, []);
  const noHint = leanTools
    .filter((tool) => !/\bnot for\b|\bprefer\b/i.test(String(tool.metadata.leanDescription)))
    .map((tool) => tool.name);
  assert.deepEqual(noHint, []);
});

await check('the lean surface is substantially smaller than the full one', async () => {
  // Measure the surface a headless coding run really gets: device tools stay
  // registered but hidden without a device, so counting all of builtinTools
  // would attribute their descriptions to the lean surface.
  const offered = builtinTools.filter((tool) =>
    toolVisibleForRun(tool.name, {
      taskFlow: true,
      deviceConfigured: false,
      userQuestions: true,
      requiresUserQuestion: tool.metadata?.requiresUserQuestion === true,
    })
  );
  const plain = buildProviderToolDeclarations(offered);
  process.env.MOSS_LEAN_TOOLS = '1';
  const lean = buildProviderToolDeclarations(offered);
  delete process.env.MOSS_LEAN_TOOLS;
  const chars = (declarations) =>
    declarations.reduce((sum, entry) => sum + entry.description.length, 0);
  const plainChars = chars(plain);
  const leanChars = chars(lean);
  assert.ok(leanChars <= 4_000, `lean description chars ${String(leanChars)} > 4000`);
  assert.ok(
    leanChars <= plainChars * 0.5,
    `lean ${String(leanChars)} chars is not <= 50% of full ${String(plainChars)}`
  );
  const execTool = builtinTools.find((tool) => tool.name === 'exec');
  assert.equal(toolDescriptionForModel(execTool, true), execTool.metadata.leanDescription);
  assert.equal(toolDescriptionForModel(execTool, false), execTool.description);
});

await check('MOSS_HIDE_TOOLS hides exactly the named tools', async () => {
  process.env.MOSS_HIDE_TOOLS = ' todo_write , multi_edit ';
  try {
    assert.deepEqual([...hiddenToolNames()], ['todo_write', 'multi_edit']);
    const offers = (name) =>
      toolVisibleForRun(name, { taskFlow: true, requiresUserQuestion: false });
    assert.equal(offers('todo_write'), false);
    assert.equal(offers('multi_edit'), false);
    assert.equal(offers('write_file'), true);
    assert.equal(offers('exec'), true);
  } finally {
    delete process.env.MOSS_HIDE_TOOLS;
  }
  assert.equal(
    toolVisibleForRun('todo_write', { taskFlow: true, requiresUserQuestion: false }),
    true,
    'without the switch the tool must stay visible'
  );
});

await check('unknown hidden names are reported instead of silently ignored', async () => {
  process.env.MOSS_HIDE_TOOLS = 'todo_write,not_a_tool';
  try {
    assert.deepEqual(
      unknownHiddenToolNames(
        builtinTools.map((tool) => tool.name),
        process.env
      ),
      ['not_a_tool']
    );
  } finally {
    delete process.env.MOSS_HIDE_TOOLS;
  }
});

await check('a real mock session announces the experiment on stderr', async () => {
  const home = path.join(os.tmpdir(), `moss-tool-lean-home-${String(Date.now())}`);
  const result = await captureProcess(process.execPath, [cli, '-p', 'say ok', '--mock'], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      HOME: home,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
      MOSS_HIDE_TOOLS: 'todo_write,not_a_tool',
    },
    timeoutMs: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /hides 1 tool\(s\) \(todo_write\)/);
  assert.match(result.stderr, /not registered tools and were ignored: not_a_tool/);
});

for (const line of checks) console.log(`[tool-lean] ${line}`);
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[tool-lean] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[tool-lean] ${checks.length} checks passed`);
