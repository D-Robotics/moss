#!/usr/bin/env node
/**
 * Tool-surface baseline (backlog B05, measurement slice).
 *
 * Every run pays for its tool declarations: name, description and the JSON
 * schema of every parameter, on every turn. B05 suspects Moss pays for more than
 * it needs (deferred loading currently covers only the sub-agent group), but the
 * backlog had no numbers, so this script measures the surface before changing it.
 *
 * It uses the real production filters (`toolVisibleForRun`, `isDeferredToolName`,
 * the spawn-scope sets and the provider declaration builder) — not a copy of the
 * rules — so the numbers move when the behavior moves.
 *
 * Usage: node scripts/measure-tool-surface.mjs [--json] [--check]
 *   --json   machine-readable result
 *   --check  assert the invariants this slice promises (exit 1 on violation)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const load = async (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);

const { builtinTools } = await load('tools/builtin.js');
const { toolVisibleForRun } = await load('core/agent/session-tool-offer.js');
const { buildProviderToolDeclarations } = await load('core/loop/agent-loop-context-prep.js');
const { isDeferredToolName } = await load('core/tools/deferred-tool-offer.js');
const { SPAWN_TOOL_SCOPE_SETS } = await load('core/subagent/spawn-profile.js');
const { DEVICE_TOOL_NAMES } = await load('device/device-tool-offer.js');

const BASE = { taskFlow: true, planMode: false, userQuestions: false, deviceConfigured: false };

const scenarios = [
  { id: 'main-headless', note: '-p, no TTY, no device', options: BASE },
  {
    id: 'main-tty',
    note: 'TTY REPL, device configured',
    options: { ...BASE, userQuestions: true, deviceConfigured: true },
  },
  { id: 'main-plan', note: 'plan mode', options: { ...BASE, planMode: true } },
  { id: 'main-qa', note: 'plain Q&A (taskFlow:false)', options: { ...BASE, taskFlow: false } },
];

function visible(tool, options) {
  return toolVisibleForRun(tool.name, {
    taskFlow: options.taskFlow,
    planMode: options.planMode,
    userQuestions: options.userQuestions,
    deviceConfigured: options.deviceConfigured,
    requiresUserQuestion: tool.metadata?.requiresUserQuestion === true,
    hiddenFromModel: tool.metadata?.hiddenFromModel === true,
  });
}

function measure(tools) {
  const declarations = buildProviderToolDeclarations(tools);
  const payload = JSON.stringify(declarations);
  const chars = payload.length;
  return {
    count: declarations.length,
    chars,
    approxTokens: Math.ceil(chars / 4),
    biggest: declarations
      .map((declaration) => ({
        name: declaration.name,
        chars: JSON.stringify(declaration).length,
      }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 5),
  };
}

const result = { builtinTotal: builtinTools.length, deferred: [], scenarios: [], scopes: [] };

for (const tool of builtinTools) {
  if (isDeferredToolName(tool.name)) result.deferred.push(tool.name);
}

for (const scenario of scenarios) {
  const offered = builtinTools.filter((tool) => visible(tool, scenario.options));
  const declared = offered.filter((tool) => !isDeferredToolName(tool.name));
  result.scenarios.push({
    id: scenario.id,
    note: scenario.note,
    declared: measure(declared),
    deferredVisible: offered.length - declared.length,
    deferredNames: offered.filter((tool) => isDeferredToolName(tool.name)).map((tool) => tool.name),
    visibleNames: declared.map((tool) => tool.name),
  });
}

// Sub-agent scopes: the scope set is a hard allow-list, so measuring the set is
// exactly the child's declaration surface.
for (const [scope, names] of Object.entries(SPAWN_TOOL_SCOPE_SETS)) {
  const tools = builtinTools.filter((tool) => names.has(tool.name));
  result.scopes.push({ id: scope, ...measure(tools) });
}
{
  const tools = builtinTools; // `full` scope: no allow-list
  result.scopes.push({ id: 'full', ...measure(tools) });
}

function printTable() {
  const pad = (value, width) => String(value).padEnd(width);
  console.log(
    `builtin tools: ${result.builtinTotal}, deferred: ${result.deferred.length} (${result.deferred.join(', ')})`
  );
  console.log('');
  console.log(
    `${pad('scenario', 14)} ${pad('declared', 9)} ${pad('chars', 8)} ${pad('~tokens', 8)} deferred`
  );
  for (const scenario of result.scenarios) {
    console.log(
      `${pad(scenario.id, 14)} ${pad(scenario.declared.count, 9)} ${pad(scenario.declared.chars, 8)} ${pad(
        scenario.declared.approxTokens,
        8
      )} ${scenario.deferredVisible}`
    );
  }
  console.log('');
  console.log(`${pad('scope', 14)} ${pad('tools', 7)} ${pad('chars', 8)} ~tokens`);
  for (const scope of result.scopes) {
    console.log(
      `${pad(scope.id, 14)} ${pad(scope.count, 7)} ${pad(scope.chars, 8)} ${scope.approxTokens}`
    );
  }
  console.log('');
  const main = result.scenarios[0];
  console.log(
    `main-headless biggest declarations: ${main.declared.biggest.map((t) => `${t.name} ${t.chars}`).join(', ')}`
  );
}

function check() {
  const byId = new Map(result.scenarios.map((scenario) => [scenario.id, scenario]));
  const names = (id) => new Set(byId.get(id).visibleNames);

  if (result.deferred.length === 0) throw new Error('no deferred tools at all');
  for (const name of result.deferred) {
    if (names('main-headless').has(name)) {
      throw new Error(`deferred tool ${name} is declared up front in main-headless`);
    }
  }
  if (!names('main-plan').has('exit_plan')) throw new Error('plan mode does not declare exit_plan');
  if (names('main-headless').has('exit_plan')) throw new Error('normal mode declares exit_plan');
  // Legacy aliases stay registered but are never offered (hiddenFromModel), so
  // they are exempt from the "configured device exposes every device tool" rule.
  for (const name of DEVICE_TOOL_NAMES) {
    const tool = builtinTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`device tool ${name} is not registered at all`);
    if (tool.metadata?.hiddenFromModel === true) continue;
    if (names('main-headless').has(name)) {
      throw new Error(`device tool ${name} is declared without a configured device`);
    }
    if (!names('main-tty').has(name)) {
      throw new Error(`device tool ${name} is missing when a device is configured`);
    }
  }
  if (names('main-qa').has('task_define'))
    throw new Error('task ledger tool declared in plain Q&A');

  const scope = new Map(result.scopes.map((entry) => [entry.id, entry]));
  if (scope.get('critic').count !== 0) throw new Error('critic scope must have no tools');
  const order = ['read-only', 'explore', 'verify', 'full'];
  for (let i = 1; i < order.length; i += 1) {
    if (scope.get(order[i]).count <= scope.get(order[i - 1]).count) {
      throw new Error(`scope ${order[i]} is not larger than ${order[i - 1]}`);
    }
  }
}

if (process.argv.includes('--check')) {
  try {
    check();
  } catch (error) {
    console.error(`[tool-surface] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(
    `[tool-surface] PASS ${result.builtinTotal} builtin tools measured across ${result.scenarios.length} scenarios and ${result.scopes.length} scopes`
  );
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printTable();
}
