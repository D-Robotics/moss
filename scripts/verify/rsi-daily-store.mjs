#!/usr/bin/env node
// Offline behavior probe: persistence/consent/isolation only, not learning efficacy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RsiDailyStore, RsiEngine, RSI_DAILY_ALL_PROJECTS, rsiDigest } from '../../dist/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-daily-'));
const scope = { ownerKey: 'owner-one', environment: 'test' };
const other = { ownerKey: 'owner-two', environment: 'test' };
const store = new RsiDailyStore(root);
const run = {
  runId: 'native-run-one',
  projectId: 'project-one',
  completedAt: Date.now(),
  outcome: 'completed',
  adapterDigest: rsiDigest('adapter'),
};
try {
  assert.deepEqual(store.read(scope).projects, []);
  assert.equal(store.read(scope).retentionDays, 30);
  assert.equal(store.read(scope).quotaBytes, 1_073_741_824);
  assert.equal(store.record(scope, run).reason, 'disabled');
  assert.equal(store.read(scope).experiences.length, 0);
  const revision = store.read(scope).revision;
  store.configure(scope, { expectedRevision: revision, projectId: run.projectId, enabled: true });
  assert.throws(
    () =>
      store.configure(scope, {
        expectedRevision: revision,
        projectId: run.projectId,
        enabled: false,
      }),
    /rsi_daily_revision_conflict/
  );
  assert.equal(
    store.record(scope, { ...run, prompt: 'must not be stored', token: 'private' }).recorded,
    true
  );
  assert.equal(store.record(scope, run).reason, 'duplicate');
  assert.equal(store.record(scope, { ...run, projectId: 'not-consented' }).reason, 'disabled');
  const view = store.read(scope);
  assert.equal(view.experiences.length, 1);
  assert.equal(view.experiences[0].eligibility, 'needs_judge');
  assert.equal(JSON.stringify(view).includes('must not be stored'), false);
  assert.equal(JSON.stringify(view).includes('private'), false);
  assert.equal(store.read(other).experiences.length, 0);
  assert.notEqual(store.read(other).storageDirectory, view.storageDirectory);
  assert.deepEqual(
    new RsiDailyStore(root).read(scope),
    view,
    'restart preserves references and prefs'
  );
  assert.equal(new RsiEngine({ rootDir: root }).status(scope).policy.activeDigest.length, 64);
  assert.equal(
    store.record(scope, { ...run, runId: 'old', completedAt: Date.now() - 31 * 86_400_000 }).reason,
    'expired'
  );
  store.deleteExperience(scope, view.experiences[0].id, {
    expectedRevision: store.read(scope).revision,
  });
  assert.equal(
    store.record(scope, run).reason,
    'deleted',
    'late completion cannot recreate deletion'
  );
  assert.equal(store.read(scope).experiences.length, 0);
  store.configure(scope, {
    expectedRevision: store.read(scope).revision,
    projectId: run.projectId,
    enabled: true,
    quotaBytes: 1,
  });
  assert.equal(store.record(scope, { ...run, runId: 'new' }).reason, 'quota');
  const paused = store.read(scope);
  assert.equal(paused.collectionStatus.state, 'paused');
  assert.equal(paused.collectionStatus.reason, 'quota');
  assert.equal(paused.indexQuota.bytes, paused.metadataBytes);
  assert.equal(paused.indexQuota.limitBytes, 1);
  assert.equal(paused.indexQuota.exceeded, true);
  assert.deepEqual(new RsiDailyStore(root).read(scope).collectionStatus, paused.collectionStatus);
  assert.equal(store.record(scope, { ...run, runId: 'retry' }).reason, 'paused');
  assert.deepEqual(
    store.read(scope).collectionStatus,
    paused.collectionStatus,
    'pause does not grow on retries'
  );
  const before = store.read(scope).revision;
  const lock = path.join(store.read(scope).storageDirectory, 'state.json.lock');
  fs.writeFileSync(lock, String(process.pid));
  assert.throws(
    () =>
      store.configure(scope, {
        expectedRevision: before,
        projectId: run.projectId,
        enabled: false,
      }),
    /rsi_store_busy/
  );
  fs.unlinkSync(lock);
  assert.equal(store.read(scope).revision, before, 'failed lock never writes');
  store.configure(scope, { expectedRevision: before, projectId: run.projectId, enabled: false });
  assert.equal(store.record(scope, { ...run, runId: 'after-opt-out' }).reason, 'disabled');
  assert.throws(() => store.read({ ...scope, ownerKey: '' }), /invalid_scope/);
  assert.throws(
    () => store.record(scope, { ...run, adapterDigest: '../escape' }),
    /invalid_daily_reference/
  );
  store.configure(scope, {
    expectedRevision: store.read(scope).revision,
    projectId: RSI_DAILY_ALL_PROJECTS,
    enabled: true,
    quotaBytes: 1_073_741_824,
  });
  assert.equal(
    store.record(scope, { ...run, projectId: 'new-admitted-project' }).reason,
    'paused',
    'increasing quota or re-enabling consent never silently resumes collection'
  );
  store.configure(scope, {
    expectedRevision: store.read(scope).revision,
    projectId: RSI_DAILY_ALL_PROJECTS,
    enabled: true,
    resetCollectionStatus: true,
  });
  assert.equal(store.record(scope, { ...run, projectId: 'new-admitted-project' }).recorded, true);
  assert.equal(
    store.record(scope, { ...run, runId: 'explicit-opt-out-project' }).reason,
    'disabled'
  );
  store.reportCollectionError(scope, new Error('raw sensitive error must be discarded'));
  const errorStatus = new RsiDailyStore(root).read(scope).collectionStatus;
  assert.equal(errorStatus.state, 'paused');
  assert.equal(errorStatus.reason, 'error');
  assert.equal(
    store.record(scope, { ...run, projectId: 'new-admitted-project', runId: 'after-error' }).reason,
    'paused'
  );
  assert.equal(store.read(other).collectionStatus.state, 'ready');
  const exported = store.exportMetadata(scope);
  assert.equal(exported.experiences.length, 1);
  assert.equal('storageDirectory' in exported, false);
  assert.equal('deletedRunDigests' in exported, false);
  assert.equal(JSON.stringify(exported).includes('raw sensitive'), false);
  assert.equal(JSON.stringify(exported).includes(root), false);
  const beforeDelete = store.read(scope);
  assert.throws(
    () => store.deleteMetadata(scope, { expectedRevision: beforeDelete.revision - 1 }),
    /rsi_daily_revision_conflict/
  );
  store.deleteMetadata(scope, { expectedRevision: beforeDelete.revision });
  const afterDelete = new RsiDailyStore(root).read(scope);
  assert.equal(afterDelete.experiences.length, 0);
  assert.deepEqual(afterDelete.projects, beforeDelete.projects);
  assert.deepEqual(afterDelete.collectionStatus, errorStatus);
  assert.equal(
    store.record(scope, { ...run, projectId: 'new-admitted-project' }).reason,
    'deleted'
  );
  assert.equal(store.exportMetadata(scope).experiences.length, 0);
  // Old schema-1 documents migrate in memory with no opt-in or status history invented.
  const stateFile = path.join(afterDelete.storageDirectory, 'state.json');
  const legacy = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete legacy.daily.collectionStatus;
  fs.writeFileSync(stateFile, JSON.stringify(legacy));
  assert.deepEqual(new RsiDailyStore(root).read(scope).collectionStatus, {
    state: 'ready',
    updatedAt: 0,
  });
  console.log(
    'rsi-daily-store: consent, CAS, isolation, restart, deletion, quota pause/reset, bounded error status, metadata export, expiration and lock checks passed'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
