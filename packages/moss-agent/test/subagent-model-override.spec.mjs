#!/usr/bin/env node
/**
 * resolveSubagentModelDef — the per-call model override for sub-agents.
 * Tested from the contract side: when create_subagent is called with a
 * `model` override, does the runner build a modelDef whose id is the override
 * (so the provider's stream function routes to the right model)?
 *
 * The stream function routes by `model.id` (llm-provider-stream-adapter.ts:
 * `request.model = model.id`), so the override takes effect at the request
 * level iff the cloned modelDef carries the overridden id.
 */
import assert from 'node:assert/strict';

import { resolveSubagentModelDef } from '../dist/core/subagent/subagent-runner.js';

const parentModelDef = {
  id: 'parent-model',
  name: 'parent-model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};

const deps = { modelDef: parentModelDef };

// ─── no override → parent's modelDef, identity (same id) ──────────────────

{
  const got = resolveSubagentModelDef(deps, { runId: 'r', parentRunId: 'p', scope: 'explore', task: 't' });
  assert.equal(got.id, 'parent-model', 'no model override: id stays the parent id');
  assert.equal(got.name, 'parent-model', 'no model override: name stays the parent name');
  // Same reference — no unnecessary clone when there's no override.
  assert.equal(got, parentModelDef, 'no override returns the parent modelDef by reference');
}

// ─── override → cloned modelDef with the overridden id ────────────────────

{
  const got = resolveSubagentModelDef(deps, {
    runId: 'r',
    parentRunId: 'p',
    scope: 'explore',
    task: 't',
    model: 'cheap-explorer-model',
  });
  assert.equal(got.id, 'cheap-explorer-model', 'override: id is the overridden model');
  assert.equal(got.name, 'cheap-explorer-model', 'override: name is the overridden model');
  assert.notEqual(got, parentModelDef, 'override: returns a new object (clone), not the parent');
  // Non-model fields are inherited from the parent (provider, api, cost, …).
  assert.equal(got.provider, 'test', 'override: provider inherited from parent');
  assert.equal(got.api, 'openai-completions', 'override: api inherited from parent');
  assert.equal(got.contextWindow, 200_000, 'override: contextWindow inherited (known limitation — not re-detected)');
  // The parent is not mutated.
  assert.equal(parentModelDef.id, 'parent-model', 'override: parent modelDef is not mutated');
}

console.error('subagent-model-override: resolveSubagentModelDef clones with overridden id ✓');
