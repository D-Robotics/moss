#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OpenVocabularySkillComposerAdapter,
  SkillComposerOrchestrator,
  SkillRegistry,
  normalizeSkillComposerConfig,
} from '../dist/skills/index.js';
import { buildComposedSkillContext } from '../dist/cli/tui-utils.js';
import { loadSkillTool } from '../dist/tools/skill-tools.js';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dependencyNames = Object.keys(packageJson.dependencies ?? {});
assert.ok(
  !dependencyNames.some((name) => /onnx|transformers|tensorflow|torch/i.test(name)),
  'core package has no mandatory model inference dependency',
);

function meta(name, description, extra = {}) {
  return {
    name,
    description,
    sourcePath: `builtin://${name}/SKILL.md`,
    stableId: `test:${name}`,
    contentHash: name,
    version: '1',
    tags: [],
    trigger: [name],
    risk: 'low',
    permissions: {},
    enabled: true,
    updatedAt: 1,
    ...extra,
  };
}

const alpha = meta('alpha', 'Inspect alpha repositories');
const beta = meta('beta', 'Verify beta deployments');
const input = {
  task: 'alpha',
  environment: { deployment: 'host', hasBoard: false },
  skills: [alpha, beta],
  maxSkills: 4,
  registryDigest: 'provider-test',
};
const traces = [];

let lazyCalls = 0;
const rulesConfig = normalizeSkillComposerConfig({ enabled: true, mode: 'rules' });
const rulesOrchestrator = new SkillComposerOrchestrator({
  config: rulesConfig,
  providers: {
    'local-model': () => {
      lazyCalls++;
      throw new Error('must remain lazy');
    },
  },
});
const rules = await rulesOrchestrator.compose(input);
assert.equal(rules.plan.provider, 'rules');
assert.equal(lazyCalls, 0, 'rules mode never initializes optional providers');

const localConfig = normalizeSkillComposerConfig({
  enabled: true,
  mode: 'local-model',
  localModelEnabled: true,
  deadlineMs: 30,
});
const unknownProvider = {
  provider: 'local-model',
  async compose() {
    return {
      skills: [{ stableId: 'unknown:id', name: 'unknown', score: 1, reasonCode: 'bad' }],
      confidence: 1,
      rejected: false,
      provider: 'local-model',
    };
  },
};
const malformed = await new SkillComposerOrchestrator({
  config: localConfig,
  providers: { 'local-model': () => unknownProvider },
}).compose(input);
assert.equal(malformed.plan.provider, 'fallback');
assert.match(malformed.plan.diagnostics.fallbackReason, /unknown skill/i);

const slowProvider = {
  provider: 'local-model',
  async compose() {
    return await new Promise(() => {});
  },
};
const slowStarted = Date.now();
const timedOut = await new SkillComposerOrchestrator({
  config: localConfig,
  providers: { 'local-model': () => slowProvider },
}).compose(input);
assert.equal(timedOut.plan.provider, 'fallback');
assert.match(timedOut.plan.diagnostics.fallbackReason, /deadline/i);
assert.ok(Date.now() - slowStarted < 500, 'timeout fallback is bounded even if provider ignores abort');

const slowFactoryStarted = Date.now();
const slowFactory = await new SkillComposerOrchestrator({
  config: localConfig,
  providers: { 'local-model': () => new Promise(() => {}) },
}).compose(input);
assert.equal(slowFactory.plan.provider, 'fallback');
assert.match(slowFactory.plan.diagnostics.fallbackReason, /deadline/i);
assert.ok(Date.now() - slowFactoryStarted < 500, 'provider initialization shares the deadline');

const parentAbort = new AbortController();
const abortStarted = Date.now();
const abortPromise = new SkillComposerOrchestrator({
  config: normalizeSkillComposerConfig({
    enabled: true,
    mode: 'local-model',
    localModelEnabled: true,
    deadlineMs: 2_000,
  }),
  providers: { 'local-model': () => slowProvider },
}).compose(input, parentAbort.signal);
setTimeout(() => parentAbort.abort(new Error('parent cancelled')), 10);
await assert.rejects(abortPromise, /parent cancelled/i);
assert.ok(Date.now() - abortStarted < 250, 'parent abort does not wait for provider deadline');

const failed = await new SkillComposerOrchestrator({
  config: localConfig,
  providers: { 'local-model': () => { throw new Error('provider init failed'); } },
}).compose(input);
assert.equal(failed.plan.provider, 'fallback');
assert.match(failed.plan.diagnostics.fallbackReason, /provider init failed/i);

const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const secretFailure = await new SkillComposerOrchestrator({
  config: localConfig,
  providers: { 'local-model': () => { throw new Error(`provider rejected ${secret}`); } },
  onTrace: (trace) => traces.push({ trace, kind: 'secret' }),
}).compose({ ...input, task: `alpha with ${secret}` });
assert.equal(secretFailure.plan.provider, 'fallback');
assert.ok(!JSON.stringify(traces).includes(secret), 'trace does not persist detected secrets');

const adapter = new OpenVocabularySkillComposerAdapter('remote-model', async ({ candidates }) => ({
  skills: [{ stableId: candidates[0].stableId, reason: 'metadata match' }],
  confidence: 0.9,
}));
const adapterPlan = await adapter.compose(input);
assert.equal(adapterPlan.skills[0].name, 'alpha');
const localAdapter = new OpenVocabularySkillComposerAdapter('local-model', async ({ candidates }) => ({
  skills: [{ stableId: candidates[0].stableId, reason: 'host-side metadata match' }],
  confidence: 0.9,
}));

let overBudgetCalls = 0;
const overBudget = await new SkillComposerOrchestrator({
  config: normalizeSkillComposerConfig({
    enabled: true,
    mode: 'auto',
    localModelEnabled: true,
    maxMemoryMb: 128,
  }),
  capabilities: {
    localModelRuntimeAvailable: true,
    modelArtifactsAvailable: true,
    localModelEstimatedMemoryMb: 256,
    availableMemoryMb: 1024,
  },
  providers: {
    'local-model': () => {
      overBudgetCalls++;
      return localAdapter;
    },
  },
}).compose(input);
assert.equal(overBudget.plan.provider, 'rules');
assert.equal(overBudgetCalls, 0, 'auto mode does not initialize a provider above its memory budget');

let boardLocalCalls = 0;
const boardAuto = await new SkillComposerOrchestrator({
  config: normalizeSkillComposerConfig({
    enabled: true,
    mode: 'auto',
    localModelEnabled: true,
    maxMemoryMb: 128,
  }, 'board'),
  capabilities: {
    localModelRuntimeAvailable: true,
    modelArtifactsAvailable: true,
    availableMemoryMb: 1024,
  },
  providers: {
    'local-model': () => {
      boardLocalCalls++;
      return adapter;
    },
  },
}).compose({ ...input, environment: { deployment: 'board', hasBoard: true } });
assert.equal(boardAuto.plan.provider, 'rules');
assert.equal(boardLocalCalls, 0, 'board auto mode stays model-free');

let hostLocalCalls = 0;
const hostControlsBoard = await new SkillComposerOrchestrator({
  config: normalizeSkillComposerConfig({
    enabled: true,
    mode: 'auto',
    localModelEnabled: true,
  }, 'host-controls-board'),
  capabilities: {
    localModelRuntimeAvailable: true,
    modelArtifactsAvailable: true,
  },
  providers: {
    'local-model': () => {
      hostLocalCalls++;
      return localAdapter;
    },
  },
}).compose({ ...input, environment: { deployment: 'host-controls-board', hasBoard: true } });
assert.equal(hostControlsBoard.plan.provider, 'local-model');
assert.equal(hostLocalCalls, 1, 'host-controls-board resolves optional inference on the host');

// Keep trace collection below the provider fallback checks so both security
// and shadow records use the same public trace surface.
const shadowConfig = normalizeSkillComposerConfig({
  enabled: true,
  mode: 'rules',
  shadowMode: true,
  shadowProvider: 'remote-model',
  remoteModelEnabled: true,
});
const shadow = await new SkillComposerOrchestrator({
  config: shadowConfig,
  providers: { 'remote-model': () => adapter },
  onTrace: (trace, kind) => traces.push({ trace, kind }),
}).compose(input);
assert.equal(shadow.plan.provider, 'rules');
assert.equal(shadow.shadowPlan.provider, 'remote-model');
assert.deepEqual(traces.slice(-2).map((entry) => entry.kind), ['active', 'shadow']);
assert.ok(!JSON.stringify(traces).includes('Inspect alpha repositories'), 'trace omits metadata bodies/descriptions');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-composed-context-'));
try {
  const skillDir = path.join(ws, '.moss', 'skills', 'alpha');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: alpha',
    'description: Inspect alpha repositories and map their runtime flow.',
    'trigger: alpha inspection',
    '---',
    '',
    'Always map the runtime flow before editing.',
  ].join('\n'));
  const registry = new SkillRegistry({
    workspaceDir: ws,
    includeBuiltin: false,
    includeBundledRdkSkills: false,
  });
  const contextTraces = [];
  const composed = await buildComposedSkillContext(registry, 'alpha inspection', {
    config: normalizeSkillComposerConfig({
      enabled: true,
      mode: 'rules',
      minConfidence: 0,
      minScore: 0.05,
    }),
    environment: { deployment: 'host', hasBoard: false },
    sessionKey: 'provider-test-session',
    onTrace: (trace, kind) => contextTraces.push({ trace, kind }),
  });
  assert.match(composed.context, /Ordered Skill Plan/);
  assert.match(composed.context, /Always map the runtime flow/);
  assert.equal(composed.suppressSkillIndex, true);
  assert.equal(contextTraces.length, 1);
  assert.equal(contextTraces[0].trace.injectedChars, composed.context.length);
  const duplicate = await loadSkillTool.execute(
    { name: 'alpha' },
    { workspaceDir: ws, sessionKey: 'provider-test-session' },
  );
  assert.match(duplicate, /already active/i);
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

console.error('skill-composer-provider: lazy providers, fallback, timeout, shadow, context integration ✓');
