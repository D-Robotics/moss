/**
 * Model-facing builtin tool surface — the contract that `docs/design/tool-surface-rea.md`
 * describes.
 *
 * This spec drives the shipped path: `builtinTools` from `dist/tools/builtin.js`, registered
 * through `registerBuiltinTools`, filtered by the same `toolVisibleForRun` + `DeferredToolOffer`
 * the agent uses, and declared by `buildProviderToolDeclarations`. It then cross-checks every
 * name set the loop nudges and the TUI renderers rely on, so a rename cannot leave one of them
 * describing a tool that no longer exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { builtinTools, registerBuiltinTools } from '../dist/tools/builtin.js';
import { buildProviderToolDeclarations } from '../dist/core/loop/agent-loop-context-prep.js';
import { toolVisibleForRun } from '../dist/core/agent/session-tool-offer.js';
import { DeferredToolOffer } from '../dist/core/tools/deferred-tool-offer.js';
import { planGateEnabled } from '../dist/tools/plan-gate.js';
import {
  EDIT_TOOL_NAME_SET,
  EXEC_LIKE_TOOL_NAME_SET,
  EXEC_TOOL_NAME_SET,
  LEGACY_ALIAS_TOOL_NAMES,
  VERIFY_TOOL_NAME_SET,
} from '../dist/core/tools/tool-catalog.js';
import { EXEC_TOOLS, VERIFY_TOOLS } from '../dist/core/loop/nudge-helpers.js';
import { SPAWN_TOOL_SCOPE_SETS } from '../dist/core/subagent/spawn-profile.js';
import { READONLY_PREVIEW_TOOLS } from '../dist/cli/tui/transcript.js';
import * as sdk from '../dist/index.js';

/** The documented set: one entry per capability the model may call by default. */
const EXPECTED_MODEL_FACING = [
  'apply_patch',
  'ask_user_question',
  'device_cameras',
  'device_deploy',
  'device_exec',
  'device_file_list',
  'device_file_read',
  'device_file_write',
  'device_info',
  'device_network',
  'device_processes',
  'device_resources',
  'device_robotics_status',
  'device_temperature',
  'edit_file',
  'exec',
  'exec_logs',
  'exec_stop',
  'exec_wait',
  'list_directory',
  'move_file',
  'read_file',
  'record_evidence',
  'record_failure',
  'record_repair',
  'run_tests',
  'search_code',
  'search_files',
  'task_acceptance',
  'task_define',
  'task_plan_update',
  'todo_write',
  'tool_search',
  'web_fetch',
  'web_search',
  'write_file',
];

/** Baseline recorded in the research doc, before this surface change. */
const BASELINE_PAYLOAD_BYTES = 25_052;
/** Ceiling so the next addition has to update the doc and this number on purpose. */
const PAYLOAD_CEILING_BYTES = 24_000;

/** Names the CLI installs conditionally (`skill`) — not part of `builtinTools`. */
const HOST_INSTALLED_TOOL_NAMES = new Set(['skill']);
/** Names seen in transcripts written before the merges. Render-only compatibility. */
const RETIRED_TOOL_NAMES = new Set(['code_diagnostics', 'repo_outline']);

function registeredToolNames() {
  const registry = {
    tools: {
      names: [],
      register(tool) {
        this.names.push(tool.name);
      },
    },
  };
  registerBuiltinTools(registry);
  return registry.tools.names;
}

function modelFacingDeclarations() {
  const offer = new DeferredToolOffer();
  const visible = builtinTools.filter(
    (tool) =>
      (tool.name !== 'exit_plan' || planGateEnabled()) &&
      offer.isOffered(tool.name) &&
      toolVisibleForRun(tool.name, {
        taskFlow: true,
        deviceConfigured: true,
        userQuestions: true,
      })
  );
  return buildProviderToolDeclarations(visible);
}

test('the default model-facing list is the documented set', () => {
  const declarations = modelFacingDeclarations();
  assert.deepEqual(
    declarations.map((d) => d.name),
    EXPECTED_MODEL_FACING
  );
});

test('every registered tool is reachable, deferred, gated, or a documented alias', () => {
  const offer = new DeferredToolOffer();
  const names = registeredToolNames();
  assert.equal(names.length, new Set(names).size, 'no duplicate registrations');
  for (const name of names) {
    const reachable =
      EXPECTED_MODEL_FACING.includes(name) ||
      !offer.isOffered(name) ||
      LEGACY_ALIAS_TOOL_NAMES.includes(name) ||
      name === 'exit_plan';
    assert.ok(reachable, `${name} is registered but no run can offer it`);
  }
  for (const name of EXPECTED_MODEL_FACING) {
    assert.ok(names.includes(name), `${name} is offered but not registered`);
  }
});

test('retired tools are gone from the registration list and the SDK surface', () => {
  const names = new Set(registeredToolNames());
  for (const name of RETIRED_TOOL_NAMES) {
    assert.equal(names.has(name), false, `${name} must not be registered`);
  }
  assert.equal('codeDiagnosticsTool' in sdk, false, 'codeDiagnosticsTool was removed from the SDK');
  assert.equal('repoOutlineTool' in sdk, false, 'repoOutlineTool was never exported');
  // The capabilities stay reachable through the canonical path.
  assert.ok(names.has('list_directory') && names.has('search_files'));
  assert.ok(names.has('run_tests') && names.has('exec'));
});

test('merged aliases stay registered but are never offered', () => {
  const names = registeredToolNames();
  for (const name of LEGACY_ALIAS_TOOL_NAMES) {
    assert.ok(names.includes(name), `${name} stays registered for hosts and old transcripts`);
    assert.equal(
      toolVisibleForRun(name, { taskFlow: true, deviceConfigured: true, userQuestions: true }),
      false,
      `${name} must not reach the model`
    );
  }
});

test('edit_file is the canonical edit surface and carries the batch form', () => {
  const edit = builtinTools.find((tool) => tool.name === 'edit_file');
  assert.ok(edit);
  const props = edit.inputSchema.properties;
  assert.ok(props?.edits, 'edit_file exposes edits[]');
  assert.ok(props?.path && props?.old_string && props?.new_string);
  assert.equal(
    edit.inputSchema.required,
    undefined,
    'required is validated in code so edits[] works'
  );
});

test('exec offers line events and one background entry point', () => {
  const exec = builtinTools.find((tool) => tool.name === 'exec');
  assert.ok(exec);
  const props = exec.inputSchema.properties;
  assert.equal(props?.event?.type, 'boolean', 'exec.event is the Qoder Monitor parity parameter');
  assert.equal(
    props?.run_in_background?.type,
    'boolean',
    'background work stays a flag on the one shell tool'
  );
  assert.equal(
    modelFacingDeclarations().some((d) => d.name === 'exec_background'),
    false,
    'the legacy background tool is never advertised next to exec'
  );
});

test('exit_plan only appears with the plan gate on', () => {
  const previous = process.env.MOSS_PLAN_GATE;
  try {
    delete process.env.MOSS_PLAN_GATE;
    assert.equal(
      modelFacingDeclarations().some((d) => d.name === 'exit_plan'),
      false
    );
    process.env.MOSS_PLAN_GATE = '1';
    assert.equal(
      modelFacingDeclarations().some((d) => d.name === 'exit_plan'),
      true
    );
  } finally {
    if (previous === undefined) delete process.env.MOSS_PLAN_GATE;
    else process.env.MOSS_PLAN_GATE = previous;
  }
});

test('nudge and TUI name sets only name tools that exist', () => {
  const names = new Set(registeredToolNames());
  for (const [label, set] of [
    ['nudge EXEC_TOOLS', EXEC_TOOLS],
    ['nudge VERIFY_TOOLS', VERIFY_TOOLS],
    ['catalog EXEC', EXEC_TOOL_NAME_SET],
    ['catalog EXEC_LIKE', EXEC_LIKE_TOOL_NAME_SET],
    ['catalog EDIT', EDIT_TOOL_NAME_SET],
    ['catalog VERIFY', VERIFY_TOOL_NAME_SET],
    ['tui READONLY_PREVIEW_TOOLS', READONLY_PREVIEW_TOOLS],
  ]) {
    for (const name of set) {
      assert.ok(
        names.has(name) || HOST_INSTALLED_TOOL_NAMES.has(name),
        `${label} names ${name}, which no tool registers`
      );
      assert.equal(RETIRED_TOOL_NAMES.has(name), false, `${label} still names retired ${name}`);
    }
  }
});

test('sub-agent scopes do not scope in removed or hidden names', () => {
  for (const [scope, set] of Object.entries(SPAWN_TOOL_SCOPE_SETS)) {
    for (const name of set) {
      assert.equal(RETIRED_TOOL_NAMES.has(name), false, `${scope} scope names retired ${name}`);
      assert.equal(
        LEGACY_ALIAS_TOOL_NAMES.includes(name),
        false,
        `${scope} scope names hidden alias ${name}`
      );
    }
  }
  const verify = SPAWN_TOOL_SCOPE_SETS.verify;
  assert.ok(verify.has('run_tests') && verify.has('exec'));
});

test('the declaration payload stays under the documented budget', () => {
  const payload = JSON.stringify(modelFacingDeclarations());
  const bytes = Buffer.byteLength(payload);
  assert.ok(
    bytes < BASELINE_PAYLOAD_BYTES,
    `payload ${bytes}B must shrink below the ${BASELINE_PAYLOAD_BYTES}B baseline`
  );
  assert.ok(bytes <= PAYLOAD_CEILING_BYTES, `payload ${bytes}B exceeds ${PAYLOAD_CEILING_BYTES}B`);
});
