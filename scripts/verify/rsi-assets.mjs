#!/usr/bin/env node
// Local filesystem lifecycle probe; no model calls or claimed learning efficacy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RsiAssetStore,
  RsiStore,
  RsiEngine,
  RSI_BASELINE,
  rsiDigest,
  rsiAdapterDigest,
  rsiTaskScopeDigest,
} from '../../dist/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-assets-'));
const scope = { ownerKey: 'asset-owner', environment: 'test' };
const taskScope = {
  projectId: 'asset-project',
  repositoryRevision: 'a'.repeat(40),
  taskFamily: 'python-fix',
  taskFamilyVersion: '1',
  capabilitiesDigest: rsiDigest('capabilities'),
};
const otherTask = { ...taskScope, projectId: 'other-project' };
const service = new RsiAssetStore(root),
  store = new RsiStore(root);
const current = () => service.status(scope).revision;
const put = (content, extra = {}) =>
  service.put(scope, taskScope, {
    kind: 'experience',
    content,
    expectedRevision: current(),
    ...extra,
  });
try {
  const legacy = store.read(scope);
  const adapter = {
    id: 'legacy-adapter',
    version: '1',
    instructions: 'LEGACY-TEXT-DO-NOT-RESURRECT',
  };
  adapter.digest = rsiAdapterDigest(adapter);
  legacy.candidates.push({
    adapter,
    createdAt: Date.now(),
    origin: 'import',
    baseDigest: RSI_BASELINE.digest,
    caseIds: ['case-one'],
    taskScope,
  });
  const directory = service.status(scope).storageDirectory;
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'state.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.equal(service.migrate(scope).schemaVersion, 3);
  assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 1);
  assert.equal(
    store.read(scope).candidates[0].origin,
    'import',
    'migration preserves legacy provenance'
  );
  assert.equal(store.read(scope).candidates[0].trainingSessionId, undefined);
  const migrated = JSON.parse(fs.readFileSync(file));
  assert.equal(migrated.candidates, undefined, 'large records are outside state index');
  assert.equal(migrated.documents.candidates.length, 1);
  const revision = current();
  service.migrate(scope);
  assert.equal(current(), revision, 'migration is idempotent');

  const experience = put('owner-scoped evidence', { sourceId: 'case-one' });
  const adapterAsset = put(adapter.instructions, {
    kind: 'adapter',
    adapterDigest: adapter.digest,
    dependencies: [experience.id],
  });
  assert.equal(service.read(scope, taskScope, experience.id), 'owner-scoped evidence');
  assert.throws(
    () => service.read({ ...scope, ownerKey: 'other-owner' }, taskScope, experience.id),
    /asset_not_found/
  );
  assert.throws(() => service.read(scope, otherTask, experience.id), /asset_not_found/);
  assert.throws(
    () =>
      service.put(scope, taskScope, {
        kind: 'experience',
        content: 'bad cas',
        expectedRevision: revision,
      }),
    /asset_revision_conflict/
  );
  assert.throws(() => put('password=secret-value-123'), /asset_contains_credentials/);
  assert.throws(() => put('x'.repeat(8193), { kind: 'adapter' }), /asset_too_large/);
  const exported = service.exportAdapter(scope, taskScope, adapter.digest);
  assert.equal(exported.adapter.instructions, adapter.instructions);
  assert.equal('cases' in exported, false);
  assert.throws(() => service.exportAdapter(scope, otherTask, adapter.digest), /adapter_not_found/);

  const candidateFile = path.join(
    directory,
    'documents',
    'candidates',
    `${migrated.documents.candidates[0]}.json`
  );
  const candidateBytes = fs.readFileSync(candidateFile);
  fs.appendFileSync(candidateFile, 'tampered');
  assert.throws(() => store.read(scope), /asset_integrity_failed/);
  fs.writeFileSync(candidateFile, candidateBytes);
  const blob = path.join(directory, 'assets', `${experience.id}.bin`);
  fs.renameSync(blob, `${blob}.saved`);
  fs.symlinkSync(`${blob}.saved`, blob);
  assert.throws(() => service.read(scope, taskScope, experience.id), /asset_symlink_refused/);
  fs.unlinkSync(blob);
  fs.renameSync(`${blob}.saved`, blob);

  // Trusted persisted policies, sessions and leases, never a browser-provided protected list.
  store.update(scope, (state) => {
    state.trainingPolicies = {
      [rsiTaskScopeDigest(taskScope)]: {
        version: 1,
        activeDigest: adapter.digest,
        previousDigest: RSI_BASELINE.digest,
        updatedAt: Date.now(),
      },
    };
    state.trainingSessions.push({
      id: 'asset-session',
      taskScope,
      status: 'frozen',
      baselineDigest: adapter.digest,
      createdAt: Date.now(),
      cases: { training: [{ id: 'case-one' }], validation: [], holdout: [], regression: [] },
    });
    for (const record of state.assets.records) record.createdAt = Date.now() - 200 * 86_400_000;
  });
  service.prune(scope);
  assert.equal(
    service.list(scope, taskScope).length,
    2,
    'active adapter and its dependencies survive retention'
  );
  const lease = service.reserveWorkspace(scope, taskScope, {
    sessionId: 'asset-session',
    maxBytes: 10000,
    kind: 'training',
    expectedRevision: current(),
  });
  fs.writeFileSync(path.join(lease.directory, 'work.txt'), 'running material');
  service.checkWorkspace(scope, taskScope, lease.id);
  assert.equal(service.status(scope).reservedBytes, 10000 - Buffer.byteLength('running material'));
  assert.throws(() => service.backup(scope), /backup_jobs_still_running/);
  fs.writeFileSync(path.join(lease.directory, 'overflow'), Buffer.alloc(10001));
  assert.throws(() => service.checkWorkspace(scope, taskScope, lease.id), /asset_quota_exceeded/);
  fs.unlinkSync(path.join(lease.directory, 'overflow'));
  service.finishWorkspace(scope, taskScope, lease.id, 'completed');
  const backup = service.backup(scope);
  const forged = structuredClone(backup);
  forged.state.trainingPolicies[rsiTaskScopeDigest(taskScope)].activeDigest = 'f'.repeat(64);
  const { digest: ignoredDigest, signature: ignoredSignature, ...forgedBody } = forged;
  void ignoredDigest;
  void ignoredSignature;
  forged.digest = rsiDigest(JSON.stringify(forgedBody));
  assert.throws(
    () => service.restore(scope, forged, { expectedRevision: current() }),
    /backup_integrity_or_owner_mismatch/,
    'rehashing a forged policy does not authenticate a backup'
  );
  const second = service.reserveWorkspace(scope, taskScope, {
    sessionId: 'asset-session',
    maxBytes: 10000,
    kind: 'upload',
    expectedRevision: current(),
  });
  store.update(scope, (state) => {
    state.holdoutConsumptions.push({ digest: rsiDigest('consumed-after-backup'), at: Date.now() });
  });
  const deletion = service.beginDeletion(scope, taskScope, {
    assetIds: [experience.id],
    expectedRevision: current(),
  });
  assert.deepEqual(new Set(deletion.assetIds), new Set([experience.id, adapterAsset.id]));
  assert.equal(
    store.read(scope).trainingPolicies[rsiTaskScopeDigest(taskScope)].activeDigest,
    RSI_BASELINE.digest
  );
  assert.equal(store.read(scope).trainingSessions[0].status, 'cancelled');
  assert.throws(
    () => service.completeDeletion(scope, taskScope, deletion.id),
    /deletion_jobs_still_running/
  );
  assert.throws(
    () => service.checkWorkspace(scope, taskScope, second.id),
    /workspace_lease_revoked/
  );
  service.finishWorkspace(scope, taskScope, second.id, 'cancelled');
  service.completeDeletion(scope, taskScope, deletion.id);
  assert.equal(fs.existsSync(blob), false);
  assert.equal(
    fs.existsSync(candidateFile),
    false,
    'deletion removes superseded raw candidate bytes'
  );
  assert.equal(
    fs.existsSync(path.join(directory, 'backups')),
    false,
    'local backup containing deleted text is removed'
  );
  assert.throws(() => put('owner-scoped evidence'), /asset_deleted/);
  assert.throws(
    () => service.restore({ ...scope, ownerKey: 'other-owner' }, backup, { expectedRevision: 0 }),
    /backup_integrity_or_owner_mismatch/
  );
  service.restore(scope, backup, { expectedRevision: current() });
  assert.equal(
    store.read(scope).holdoutConsumptions.length,
    1,
    'restore never renews a consumed holdout'
  );
  assert.equal(
    store.read(scope).candidates.length,
    0,
    'restore never resurrects a revoked adapter'
  );
  assert.equal(
    service.list(scope, taskScope).length,
    0,
    'restore never resurrects deleted material'
  );
  assert.equal(
    store.read(scope).trainingPolicies[rsiTaskScopeDigest(taskScope)].activeDigest,
    RSI_BASELINE.digest
  );

  service.configure(scope, { expectedRevision: current(), quotaBytes: 1 });
  assert.equal(service.status(scope).quotaExceeded, true);
  assert.throws(() => put('cannot exceed filesystem quota'), /asset_quota_exceeded/);
  assert.throws(() => store.assertAssetCapacity(scope), /asset_quota_exceeded/);
  service.configure(scope, { expectedRevision: current(), quotaBytes: 1_073_741_824 });
  const restored = new RsiAssetStore(root).status(scope);
  assert.equal(restored.schemaVersion, 3);
  assert.equal(restored.records.length, 0);
  assert.equal(new RsiEngine({ rootDir: root }).store.read(scope).holdoutConsumptions.length, 1);
  console.log(
    'rsi-assets: migration/idempotence, immutable bytes, owner/scope isolation, export, CAS, lease quotas, protected retention, revoke/delete ordering, backup/monotonic restore passed'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
