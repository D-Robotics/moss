#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RulesSkillComposer,
  SkillRegistry,
  normalizeSkillComposerConfig,
  orderPlannedSkills,
  retrieveSkillCandidates,
  resolveSkillConflicts,
  validateSkillPlan,
} from '../dist/skills/index.js';
import { mergeSkillFrontmatterDefaults } from '../dist/skill-learning/index.js';

function skill(name, description, extra = {}) {
  return {
    name,
    description,
    sourcePath: `builtin://${name}/SKILL.md`,
    stableId: `test:${name}`,
    contentHash: name,
    version: '1.0.0',
    tags: [],
    trigger: [],
    risk: 'low',
    permissions: {},
    runtimePolicy: { delegatePreference: 'hybrid', requiresBoard: false, approvalLevel: 'none' },
    enabled: true,
    updatedAt: 1,
    ...extra,
  };
}

const config = normalizeSkillComposerConfig({
  enabled: true,
  mode: 'rules',
  maxSkills: 4,
  candidateLimit: 12,
  minScore: 0.08,
});
assert.equal(config.mode, 'rules');
assert.equal(normalizeSkillComposerConfig(undefined).mode, 'legacy');
assert.throws(
  () => normalizeSkillComposerConfig({ enabled: true, mode: 'local-model' }, 'board'),
  /localModelEnabled/
);
assert.throws(() => normalizeSkillComposerConfig({ enabled: true, maxSkills: 99 }), /maxSkills/);

const inspect = skill('inspect', 'Inspect an unfamiliar repository and map architecture', {
  trigger: ['inspect codebase', '分析代码库'],
  outputs: ['architecture-map'],
  before: ['plan'],
});
const plan = skill('plan', 'Create an implementation plan from architecture evidence', {
  inputs: ['architecture-map'],
  outputs: ['implementation-plan'],
  requires: ['inspect'],
  before: ['refactor'],
});
const refactor = skill('refactor', 'Refactor code using a verified implementation plan', {
  inputs: ['implementation-plan'],
  trigger: ['重构'],
  requires: ['plan'],
});
const board = skill('board-deploy', 'Deploy and verify an application on an RDK board', {
  trigger: ['deploy to board'],
  permissions: { deviceExec: true },
  runtimePolicy: { delegatePreference: 'board', requiresBoard: true, approvalLevel: 'confirm' },
});
const docs = skill('docs', 'Write project documentation and API examples', {
  conflicts: ['minimal-answer'],
});
const minimal = skill('minimal-answer', 'Return a minimal direct answer without documentation', {
  conflicts: ['docs'],
});
const skills = [inspect, plan, refactor, board, docs, minimal];

const retrieval = retrieveSkillCandidates({
  task: '分析代码库，然后制定重构计划并完成重构',
  skills,
  environment: { deployment: 'host', hasBoard: false },
  limit: 10,
});
assert.ok(
  retrieval.candidates.some((candidate) => candidate.name === 'inspect'),
  'Chinese trigger is retrieved'
);
assert.ok(
  retrieval.candidates.some((candidate) => candidate.name === 'refactor'),
  'mixed Chinese metadata is retrieved'
);

const boardRetrieval = retrieveSkillCandidates({
  task: 'deploy to board',
  skills,
  environment: { deployment: 'host', hasBoard: false },
});
const sharedDigest = 'same-registry-different-environment';
retrieveSkillCandidates({
  task: 'deploy to board',
  skills,
  environment: { deployment: 'host', hasBoard: false },
  registryDigest: sharedDigest,
});
const connectedBoardRetrieval = retrieveSkillCandidates({
  task: 'deploy to board',
  skills,
  environment: { deployment: 'board', hasBoard: true, availablePermissions: ['device_exec'] },
  registryDigest: sharedDigest,
});
assert.ok(
  connectedBoardRetrieval.candidates.some((candidate) => candidate.name === 'board-deploy'),
  'eligibility-sensitive cache restores board skills'
);

const genericReview = skill('generic-review', 'Review source code', {
  tags: ['review', 'codebase'],
  trigger: ['bug'],
});
const exactReview = skill('code-review', 'Perform a structured code review', {
  tags: ['review'],
  trigger: ['code review'],
});
const reviewRetrieval = retrieveSkillCandidates({
  task: 'Please do a code review of this codebase and report any bugs.',
  skills: [genericReview, exactReview],
  environment: { deployment: 'host', hasBoard: false },
});
assert.equal(reviewRetrieval.candidates[0].name, 'code-review');
assert.ok(reviewRetrieval.candidates[0].score > reviewRetrieval.candidates[1].score);

const gitLookup = skill('git-workflow', 'Perform Git branch and commit operations', {
  tags: ['git', 'branch'],
  trigger: ['git', 'branch', 'commit'],
});
const lookupRetrieval = retrieveSkillCandidates({
  task: 'Which branch am I currently on?',
  skills: [gitLookup],
  environment: { deployment: 'host', hasBoard: false },
});
assert.ok(
  (lookupRetrieval.candidates[0]?.score ?? 0) < 0.16,
  'factual branch lookup stays below the composition threshold'
);
assert.ok(!boardRetrieval.candidates.some((candidate) => candidate.name === 'board-deploy'));
assert.ok(boardRetrieval.excluded.some((entry) => entry.name === 'board-deploy'));

const composer = new RulesSkillComposer(config);
const composed = await composer.compose({
  task: 'Inspect the codebase, create an implementation plan, then refactor it',
  environment: { deployment: 'host', hasBoard: false },
  skills,
  maxSkills: 4,
  registryDigest: 'test-registry',
});
assert.equal(composed.rejected, false);
assert.ok(composed.skills.length <= 4);
assert.equal(new Set(composed.skills.map((entry) => entry.stableId)).size, composed.skills.length);
const names = composed.skills.map((entry) => entry.name);
assert.ok(names.includes('inspect'));
assert.ok(names.includes('plan'));
assert.ok(names.indexOf('inspect') < names.indexOf('plan'));
if (names.includes('refactor')) assert.ok(names.indexOf('plan') < names.indexOf('refactor'));
assert.equal(
  validateSkillPlan(composed, {
    task: 'x',
    environment: {},
    skills,
    maxSkills: 4,
  }).valid,
  true
);
assert.doesNotThrow(() => JSON.stringify(composed), 'plan is provider-neutral JSON');

const empty = await composer.compose({
  task: 'xyzzy plugh unrelated',
  environment: {},
  skills,
  maxSkills: 4,
});
assert.deepEqual(empty.skills, []);
assert.equal(empty.rejected, true);

const repeated = await composer.compose({
  task: 'Inspect the codebase, create an implementation plan, then refactor it',
  environment: { deployment: 'host', hasBoard: false },
  skills,
  maxSkills: 4,
  registryDigest: 'test-registry',
});
assert.deepEqual(
  repeated.skills,
  composed.skills,
  'rules composition is deterministic for the same snapshot and input'
);

const conflictResult = resolveSkillConflicts(
  [
    { stableId: docs.stableId, name: docs.name, score: 0.9, reasonCode: 'test' },
    { stableId: minimal.stableId, name: minimal.name, score: 0.5, reasonCode: 'test' },
  ],
  skills
);
assert.deepEqual(
  conflictResult.skills.map((entry) => entry.name),
  ['docs']
);
assert.match(conflictResult.warnings[0], /conflicts/i);

const cycleA = skill('cycle-a', 'Cycle A', { before: ['cycle-b'] });
const cycleB = skill('cycle-b', 'Cycle B', { before: ['cycle-a'] });
const cycleOrder = orderPlannedSkills(
  [
    { stableId: cycleA.stableId, name: cycleA.name, score: 0.8, reasonCode: 'test' },
    { stableId: cycleB.stableId, name: cycleB.name, score: 0.7, reasonCode: 'test' },
  ],
  [cycleA, cycleB]
);
assert.equal(cycleOrder.skills.length, 2);
assert.ok(cycleOrder.warnings.some((warning) => /cycle/i.test(warning)));

const abort = new AbortController();
abort.abort(new Error('stop'));
await assert.rejects(
  composer.compose({ task: 'inspect', environment: {}, skills, maxSkills: 4 }, abort.signal),
  /stop|aborted/i
);

const unseen = skill(
  'newly-installed-camera-calibration',
  'Calibrate a stereo camera and verify reprojection error',
  {
    trigger: ['reprojection error'],
  }
);
const openVocabulary = await composer.compose({
  task: 'Calibrate my stereo camera and verify reprojection error',
  environment: {},
  skills: [...skills, unseen],
  maxSkills: 4,
});
assert.equal(
  openVocabulary.skills[0]?.name,
  unseen.name,
  'new skill participates without retraining'
);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-composer-registry-'));
try {
  const root = path.join(ws, '.moss', 'skills');
  const alphaDir = path.join(root, 'alpha');
  const betaDir = path.join(root, 'beta');
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.mkdirSync(betaDir, { recursive: true });
  fs.writeFileSync(
    path.join(alphaDir, 'SKILL.md'),
    [
      '---',
      'name: alpha',
      'description: Produce an architecture map',
      'outputs: [architecture-map]',
      'before: [beta]',
      '---',
      'Alpha body',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(betaDir, 'SKILL.md'),
    [
      '---',
      'name: beta',
      'description: Consume an architecture map',
      'inputs: [architecture-map]',
      'requires: [alpha]',
      '---',
      'Beta body',
    ].join('\n')
  );
  const registry = new SkillRegistry({
    workspaceDir: ws,
    includeBuiltin: false,
    includeBundledRdkSkills: false,
  });
  const first = registry.snapshot();
  assert.equal(first.skills.length, 2);
  assert.ok(first.skills.every((entry) => entry.stableId && entry.contentHash));
  assert.equal(first.diagnostics.length, 0);
  const alphaId = first.skills.find((entry) => entry.name === 'alpha').stableId;
  fs.appendFileSync(path.join(alphaDir, 'SKILL.md'), '\nMore guidance');
  const second = registry.reload() && registry.snapshot();
  assert.equal(second.skills.find((entry) => entry.name === 'alpha').stableId, alphaId);
  assert.notEqual(second.digest, first.digest, 'content change invalidates snapshot digest');
  fs.writeFileSync(
    path.join(betaDir, 'SKILL.md'),
    [
      '---',
      'name: beta',
      'description: Consume an architecture map',
      'requires: [missing-skill]',
      'before: [alpha]',
      '---',
      'Beta body',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(alphaDir, 'SKILL.md'),
    [
      '---',
      'name: alpha',
      'description: Produce an architecture map',
      'before: [beta]',
      '---',
      'Alpha body',
    ].join('\n')
  );
  registry.reload();
  const diagnosticCodes = new Set(registry.diagnostics().map((entry) => entry.code));
  assert.ok(diagnosticCodes.has('unknown-reference'));
  assert.ok(diagnosticCodes.has('dependency-cycle'));
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

const rdkRegistry = new SkillRegistry({
  workspaceDir: os.tmpdir(),
  includeBuiltin: false,
  includeBundledRdkSkills: true,
});
const rdkSnapshot = rdkRegistry.snapshot();
const rdkDevice = rdkSnapshot.skills.find((entry) => entry.name === 'rdk-device');
assert.ok(rdkDevice?.stableId);
assert.deepEqual(rdkDevice?.inputs, ['board-profile', 'model-artifact']);
assert.equal(rdkDevice?.runtimePolicy?.requiresBoard, true);

const learned = mergeSkillFrontmatterDefaults(
  [
    '---',
    'name: Learned Deploy Flow',
    'description: A learned workflow for deploying a verified artifact to a target device.',
    'version: 1.0.0',
    'trigger: deploy learned artifact',
    'risk: low',
    'permissions: workspace_read',
    'delegate_preference: local',
    'requires_board: false',
    'approval_level: none',
    'cooldown_seconds: 0',
    'scheduler_template: none',
    'category: learned',
    '---',
    'Run the verified workflow.',
  ].join('\n'),
  { skillId: 'learned-deploy-flow' }
);
assert.match(learned, /^stable_id: learned-learned-deploy-flow$/m);
assert.match(learned, /^summary: .+$/m);

console.error(
  'skill-composer: contracts, retrieval, open vocabulary, ordering, registry snapshots ✓'
);
