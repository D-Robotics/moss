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
const { buildProviderToolDeclarations, shouldLeanToolDescriptions } = await load(
  'core/loop/agent-loop-context-prep.js'
);
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

  // B08: a description that only says how to use a tool cannot prevent the
  // wrong-tool call. The high-traffic and mutating tools name the sibling that
  // should have been used instead, and the added guidance stays inside a budget
  // so it cannot quietly double the declaration cost.
  const NEGATIVE_GUIDANCE = {
    read_file: [/not for/i, /list_directory/, /read_image/, /search_code/],
    exec: [/not for/i, /read_file/, /edit_file/, /search_code/],
    search_code: [/not for/i, /read_file/, /list_directory/],
    search_files: [/not for/i, /search_code/, /list_directory/],
    write_file: [/not for/i, /edit_file/],
    edit_file: [/not for/i, /write_file/, /apply_patch/],
    multi_edit: [/not for/i, /write_file/, /edit_file/],
    apply_patch: [/not for/i, /edit_file/, /write_file/],
    move_file: [/not for/i, /edit_file/],
    list_directory: [/not for/i, /search_files/, /search_code/],
    read_image: [/not for/i, /read_file/],
  };
  const MAX_DESCRIPTION_CHARS = 1_200;
  for (const [name, patterns] of Object.entries(NEGATIVE_GUIDANCE)) {
    const tool = builtinTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    const description = String(tool.description ?? '');
    for (const pattern of patterns) {
      if (!pattern.test(description)) {
        throw new Error(
          `${name} description does not match ${pattern} (missing negative guidance)`
        );
      }
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(
        `${name} description is ${description.length} chars (budget ${MAX_DESCRIPTION_CHARS})`
      );
    }
  }
  // B08 lean tier: `MOSS_LEAN_TOOLS=1` swaps the long description for the
  // declared short one, and the swap must be real (declarations, not just
  // metadata) while the default surface stays exactly as before.
  const leanTools = builtinTools.filter((tool) => tool.metadata?.leanDescription);
  if (leanTools.length < 2) throw new Error('lean descriptions are missing on the exec tools');
  for (const tool of leanTools) {
    const lean = String(tool.metadata.leanDescription);
    const full = String(tool.description);
    if (lean.length >= full.length) {
      throw new Error(`${tool.name} lean description is not shorter than the full one`);
    }
    // A short full description cannot be cut to 60% and still name a scope; for
    // those require a real (20-char) cut instead of a ratio, so the lean tier
    // still removes declaration bytes rather than just relabeling them.
    if (full.length > 150 && lean.length > full.length * 0.6) {
      throw new Error(
        `${tool.name} lean description is ${lean.length} chars (budget 60% of ${full.length})`
      );
    }
    if (full.length <= 150 && lean.length > full.length - 20) {
      throw new Error(
        `${tool.name} lean description is ${lean.length} chars (needs >=20 chars less than ${full.length})`
      );
    }
    // D3: the lean tier is one sentence plus the "not for" hint; anything
    // longer is the full description with a shorter wrapper and defeats the
    // point of a small-window surface.
    if (lean.length > 120) {
      throw new Error(`${tool.name} lean description is ${lean.length} chars (budget 120)`);
    }
  }
  // B08 lean tier coverage: a declared tool whose description is long enough to
  // matter for a small window must ship a short variant, otherwise the lean
  // surface is only lean for whichever tools happened to be done first.
  const LEAN_REQUIRED_DESCRIPTION_CHARS = 150;
  for (const scenarioId of ['main-headless', 'main-tty', 'main-plan']) {
    for (const name of names(scenarioId)) {
      const tool = builtinTools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`${scenarioId} declares unknown tool ${name}`);
      if (tool.metadata?.leanDescription) continue;
      if (String(tool.description ?? '').length < LEAN_REQUIRED_DESCRIPTION_CHARS) continue;
      throw new Error(
        `declared tool ${name} has a ${String(tool.description ?? '').length}-char description but no lean tier (${scenarioId})`
      );
    }
  }

  const plainDeclarations = buildProviderToolDeclarations(builtinTools);
  const plainExec = plainDeclarations.find((entry) => entry.name === 'exec');
  process.env.MOSS_LEAN_TOOLS = '1';
  const leanDeclarations = buildProviderToolDeclarations(builtinTools);
  delete process.env.MOSS_LEAN_TOOLS;
  const leanExec = leanDeclarations.find((entry) => entry.name === 'exec');
  const execTool = builtinTools.find((tool) => tool.name === 'exec');
  if (plainExec.description !== String(execTool.description)) {
    throw new Error('the default surface must keep the full exec description');
  }
  if (leanExec.description !== execTool.metadata.leanDescription) {
    throw new Error('MOSS_LEAN_TOOLS=1 must declare the lean exec description');
  }
  const plainChars = plainDeclarations.reduce((sum, entry) => sum + entry.description.length, 0);
  const leanChars = leanDeclarations.reduce((sum, entry) => sum + entry.description.length, 0);
  if (leanChars >= plainChars) {
    throw new Error(`lean surface is not smaller (${leanChars} vs ${plainChars} chars)`);
  }

  // B08 auto tier: small context windows get the lean surface without a flag
  // (Cursor/Claude Code ship reduced descriptions per window), the flag still
  // forces either side, and the chosen surface is the one really declared.
  const leanChosen = (options) => buildProviderToolDeclarations(builtinTools, options);
  const charsOf = (declarations) => declarations.reduce((sum, e) => sum + e.description.length, 0);
  if (!shouldLeanToolDescriptions({ contextWindowTokens: 32_000, env: {} })) {
    throw new Error('a 32k context window must select the lean surface');
  }
  if (shouldLeanToolDescriptions({ contextWindowTokens: 200_000, env: {} })) {
    throw new Error('a 200k context window must keep the full surface');
  }
  if (shouldLeanToolDescriptions({ contextWindowTokens: 32_000, env: { MOSS_LEAN_TOOLS: '0' } })) {
    throw new Error('MOSS_LEAN_TOOLS=0 must force the full surface');
  }
  if (
    !shouldLeanToolDescriptions({ contextWindowTokens: 200_000, env: { MOSS_LEAN_TOOLS: '1' } })
  ) {
    throw new Error('MOSS_LEAN_TOOLS=1 must force the lean surface');
  }
  const smallChars = charsOf(leanChosen({ contextWindowTokens: 32_000 }));
  const bigChars = charsOf(leanChosen({ contextWindowTokens: 200_000 }));
  if (smallChars >= bigChars) {
    throw new Error(`a 32k window must declare fewer chars (${smallChars} vs ${bigChars})`);
  }

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
