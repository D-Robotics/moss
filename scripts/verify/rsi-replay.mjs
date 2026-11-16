#!/usr/bin/env node
// Offline native-observer/asset protocol probe; no model calls or learning-gain claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RsiReplayCaseStore,
  RsiDailyStore,
  RsiAssetStore,
  RsiEngine,
  rsiDigest,
} from '../../dist/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-replay-'));
const scope = { ownerKey: 'replay-owner', environment: 'test' };
const foreign = { ...scope, ownerKey: 'other-owner' };
const taskScope = {
  projectId: 'project',
  repositoryRevision: 'a'.repeat(40),
  taskFamily: 'json-config-edit-v1',
  taskFamilyVersion: '1',
  capabilitiesDigest: rsiDigest('data-only-tools'),
};
const replay = new RsiReplayCaseStore(root),
  daily = new RsiDailyStore(root),
  assets = new RsiAssetStore(root);
const engine = new RsiEngine({ rootDir: root });
const revision = () => replay.listProfiles(scope).revision;
const configure = (enabled = true, contentConsent = true) =>
  replay.configureProfile(scope, {
    projectId: 'project',
    file: 'config.json',
    enabled,
    contentConsent,
    expectedRevision: revision(),
  }).profiles[0];
const grader = (content, rules) => ({
  passed: JSON.parse(content).enabled === rules.enabled,
  checks: ['enabled-equality'],
});
try {
  assert.deepEqual(replay.listProfiles(scope).profiles, []);
  assert.throws(
    () =>
      replay.configureProfile(scope, {
        projectId: 'project',
        file: '../secret.json',
        enabled: true,
        contentConsent: true,
        expectedRevision: revision(),
      }),
    /invalid_replay_profile/
  );
  let profile = configure(true, false);
  const input = (n, regression = false) => ({
    profileId: profile.id,
    runId: `source-${n}`,
    taskScope,
    request: 'Set enabled to true.',
    initialContent: JSON.stringify({ family: n, enabled: regression }),
    contractDigest: rsiDigest('actual-host-contract'),
    sourceGroupDigest: rsiDigest(`independent-family-${n}`),
  });
  assert.throws(() => replay.beginCapture(scope, input(0)), /replay_content_consent_required/);
  profile = configure();
  assert.throws(() => replay.beginCapture(scope, input(0)), /replay_index_consent_required/);
  daily.configure(scope, { projectId: 'project', enabled: true, expectedRevision: revision() });
  for (const key of [
    'token',
    'auth',
    'authentication',
    'clientSecret',
    'client_secret',
    'secretKey',
    'session_token',
  ]) {
    assert.throws(
      () =>
        replay.beginCapture(scope, {
          ...input(0),
          initialContent: JSON.stringify({ [key]: 'not-a-real-secret' }),
        }),
      /asset_contains_credentials/,
      `credential-looking key ${key} must be rejected before asset persistence`
    );
  }
  assert.throws(
    () => replay.beginCapture(scope, { ...input(0), initialContent: '{"password":"secret"}' }),
    /asset_contains_credentials/
  );
  assert.throws(
    () => replay.beginCapture(scope, { ...input(0), initialContent: '{"__proto__":{}}' }),
    /replay_json_invalid/
  );
  const build = (n, regression = false, overrides = {}) => {
    const source = { ...input(n, regression), ...overrides };
    const capture = replay.beginCapture(scope, source);
    assert.deepEqual(replay.beginCapture(scope, source), capture, 'idempotent before-task capture');
    assert.throws(
      () => replay.beginCapture(scope, { ...source, request: 'changed request' }),
      /replay_capture_conflict/
    );
    assert.throws(
      () => replay.completeCapture(scope, { captureId: capture.id, finalContent: '{}' }),
      /replay_source_pending/
    );
    const observer = engine.createRunObserver({
      scope,
      runId: source.runId,
      adapter: engine.captureAdapter(scope, { taskScope }),
    });
    assert.ok(observer);
    observer.onEvent({ type: 'turn_start', turn: 1 });
    observer.finish('completed');
    assert.throws(
      () => replay.completeCapture(scope, { captureId: capture.id, finalContent: '{}' }),
      /replay_source_pending/,
      'receipt alone cannot replace consented daily source'
    );
    daily.record(scope, {
      runId: source.runId,
      projectId: 'project',
      completedAt: Date.now(),
      outcome: 'completed',
    });
    const finalContent = JSON.stringify({ ...JSON.parse(source.initialContent), enabled: true });
    const completed = replay.completeCapture(scope, { captureId: capture.id, finalContent });
    assert.equal(completed.status, 'completed');
    assert.throws(() => replay.readCaptureReview(foreign, capture.id), /replay_capture_not_found/);
    assert.throws(
      () =>
        replay.qualify(
          scope,
          {
            captureId: capture.id,
            rules: { enabled: false },
            kind: regression ? 'regression' : 'problem',
            graderVersion: 'json-judge-v1',
          },
          grader
        ),
      /replay_not_qualified/
    );
    const item = replay.qualify(
      scope,
      {
        captureId: capture.id,
        rules: { enabled: true },
        kind: regression ? 'regression' : 'problem',
        graderVersion: 'json-judge-v1',
      },
      grader
    );
    assert.deepEqual(Object.keys(replay.readActorInput(scope, item.id)).sort(), [
      'initialContent',
      'request',
    ]);
    assert.equal(replay.readGraderInput(scope, item.id).referenceContent, finalContent);
    assert.equal('rules' in item, false);
    assert.equal('privateAssetId' in item, false);
    return { capture, item };
  };
  const rows = Array.from({ length: 16 }, (_, i) => build(i, i >= 12));
  const selected = Object.fromEntries(
    ['training', 'validation', 'holdout', 'regression'].map((split, i) => [
      split,
      rows.slice(i * 4, i * 4 + 4).map((row) => row.item.id),
    ])
  );
  assert.throws(
    () =>
      replay.freezeManifest(scope, {
        taskScope,
        cases: { ...selected, training: selected.training.slice(0, 3) },
        expectedRevision: revision(),
      }),
    /four_cases/
  );
  assert.throws(
    () => replay.freezeManifest(scope, { taskScope, cases: selected, expectedRevision: 0 }),
    /replay_revision_conflict/
  );
  const manifest = replay.freezeManifest(scope, {
    taskScope,
    cases: selected,
    expectedRevision: revision(),
  });
  assert.equal(Object.values(manifest.cases).flat().length, 16);
  assert.deepEqual(replay.getManifestSourceAssetIds(scope, manifest.id), [manifest.id]);
  assert.deepEqual(new RsiReplayCaseStore(root).readManifest(scope, manifest.id), manifest);
  const sameInitial = build(100, false, {
    initialContent: input(0).initialContent,
    request: 'Enable the setting, leaving the family unchanged.',
  });
  const aliasSelection = structuredClone(selected);
  aliasSelection.validation[0] = sameInitial.item.id;
  assert.notEqual(sameInitial.item.fixtureDigest, rows[0].item.fixtureDigest);
  assert.throws(
    () =>
      replay.freezeManifest(scope, {
        taskScope,
        cases: aliasSelection,
        expectedRevision: revision(),
      }),
    /training_splits_overlap/,
    'a new request/run cannot move the same initial payload across splits'
  );
  const sameSource = build(101, false, { sourceGroupDigest: rows[0].item.groupDigest });
  aliasSelection.validation[0] = sameSource.item.id;
  assert.throws(
    () =>
      replay.freezeManifest(scope, {
        taskScope,
        cases: aliasSelection,
        expectedRevision: revision(),
      }),
    /training_splits_overlap/,
    'source variants inherit their original group'
  );
  let gradingCalls = 0;
  assert.throws(
    () =>
      replay.qualify(
        scope,
        {
          captureId: rows[0].capture.id,
          rules: { enabled: true },
          kind: 'problem',
          graderVersion: 'unstable',
        },
        () => ({ passed: ++gradingCalls > 1, checks: ['stable-check-id'] })
      ),
    /replay_grader_nondeterministic/
  );
  const originalQuota = assets.status(scope).quotaBytes;
  assets.configure(scope, { expectedRevision: revision(), quotaBytes: 1 });
  const countBeforeQuota = replay.listCaptures(scope).length;
  assert.throws(() => replay.beginCapture(scope, input(102)), /asset_quota_exceeded/);
  assert.equal(replay.listCaptures(scope).length, countBeforeQuota);
  assets.configure(scope, { expectedRevision: revision(), quotaBytes: originalQuota });
  const shuffled = structuredClone(selected);
  [shuffled.training[0], shuffled.validation[0]] = [shuffled.validation[0], shuffled.training[0]];
  assert.throws(
    () =>
      replay.freezeManifest(scope, { taskScope, cases: shuffled, expectedRevision: revision() }),
    /case_split_immutable/
  );
  configure(false);
  assert.throws(() => replay.readManifest(scope, manifest.id), /replay_content_consent_required/);
  assert.throws(
    () => replay.readActorInput(scope, rows[0].item.id),
    /replay_content_consent_required/
  );
  configure();
  const provider = {
    hermit: {
      version: '0.2.0',
      commit: 'b'.repeat(40),
      method: 'gepa',
      configDigest: rsiDigest('config'),
      templateDigest: rsiDigest('template'),
    },
    model: 'offline',
    evaluatorVersion: 'judge-v1',
    providerIdentityDigest: rsiDigest('provider'),
    runtimeConfig: {
      runnerVersion: 'replay-v1',
      oracleVersion: 'json-judge-v1',
      modelConfigDigest: rsiDigest('model'),
      tools: ['read', 'write'],
      permissionsDigest: rsiDigest('permission'),
    },
    verifyCandidate: async () => false,
    confirm: async () => {
      throw new Error('not called');
    },
  };
  const training = new RsiEngine({ rootDir: root, externalTraining: () => provider });
  const stage = { maxTokens: 1000, maxModelCalls: 10, maxWallMs: 10000 };
  const plan = {
    taskScope,
    cases: manifest.cases,
    seed: 42,
    budget: {
      totalTokens: 3000,
      training: { ...stage },
      confirmation: { ...stage },
      adoptionRollback: { ...stage },
      maxTaskModelCalls: 1,
      maxTaskToolCalls: 2,
      maxTaskWallMs: 1000,
      maxOutputTokens: 100,
    },
  };
  const tampered = structuredClone(plan);
  tampered.cases.training[0].groupDigest = rsiDigest('laundered-group');
  assert.throws(() => training.freezeTrainingSession(scope, tampered), /replay_manifest_required/);
  const session = training.freezeTrainingSession(scope, plan);
  configure(false);
  assert.throws(
    () =>
      training.reserveTrainingCall(scope, session.id, {
        stage: 'training',
        maxInputTokens: 1,
        maxOutputTokens: 1,
      }),
    /replay_content_consent_required/
  );
  configure();
  const backup = assets.backup(scope);
  const lease = assets.reserveWorkspace(scope, taskScope, {
    sessionId: session.id,
    maxBytes: 1000,
    kind: 'training',
    expectedRevision: revision(),
  });
  const experienceId = daily
    .read(scope)
    .experiences.find((item) => item.runId === rows[0].capture.runId).id;
  assert.throws(
    () => daily.deleteExperience(scope, experienceId, { expectedRevision: revision() }),
    /replay_source_requires_deletion/
  );
  const deletion = replay.beginSourceDeletion(scope, {
    captureId: rows[0].capture.id,
    expectedRevision: revision(),
  });
  assert.ok(deletion.requiredStopSessions.includes(session.id));
  assert.throws(() => replay.readManifest(scope, manifest.id), /replay_source_deleted/);
  assert.throws(
    () =>
      replay.completeSourceDeletion(scope, {
        captureId: rows[0].capture.id,
        deletionId: deletion.id,
      }),
    /deletion_jobs_still_running/
  );
  assets.finishWorkspace(scope, taskScope, lease.id, 'cancelled');
  replay.completeSourceDeletion(scope, { captureId: rows[0].capture.id, deletionId: deletion.id });
  assert.equal(
    daily.read(scope).experiences.some((item) => item.id === experienceId),
    false
  );
  assert.equal(
    replay.listCaptures(scope).find((item) => item.id === rows[0].capture.id).status,
    'revoked'
  );
  assets.restore(scope, backup, { expectedRevision: revision() });
  assert.equal(replay.listProfiles(scope).profiles[0].contentConsent, false);
  configure();
  assert.throws(() => replay.readManifest(scope, manifest.id), /replay_source_deleted/);
  assert.throws(() => replay.beginCapture(scope, input(0)), /replay_source_deleted/);
  console.log(
    'rsi-replay: consent, pre-task snapshot, native receipt+daily source, independent grading, private projections, immutable manifests, split exposure, quota-backed assets and ordered deletion/restore passed (offline; no learning-gain claim)'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
