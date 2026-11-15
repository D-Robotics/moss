#!/usr/bin/env node
// Local filesystem lifecycle probe; no model calls or claimed learning efficacy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../../dist/utils/run-process.js';
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
  const otherExperience = service.put(scope, otherTask, {
    kind: 'experience',
    content: 'owner-scoped evidence',
    expectedRevision: current(),
  });
  assert.notEqual(otherExperience.id, experience.id);
  assert.equal(otherExperience.contentDigest, experience.contentDigest);
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
    for (const record of state.assets.records)
      if (record.taskScopeDigest === rsiTaskScopeDigest(taskScope))
        record.createdAt = Date.now() - 200 * 86_400_000;
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
  assert.equal(service.status(scope, taskScope).pendingDeletions[0].id, deletion.id);
  assert.deepEqual(service.status(scope, otherTask).pendingDeletions, []);
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
  assert.deepEqual(service.status(scope, taskScope).pendingDeletions, []);
  assert.equal(
    service.read(scope, otherTask, otherExperience.id),
    'owner-scoped evidence',
    'deleting identical bytes in one project does not affect another'
  );
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
  assert.throws(() => put('owner-scoped evidence', { sourceId: 'case-one' }), /asset_deleted/);
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
  // Separate processes race one CAS revision; at most one may commit, no lost update.
  const sdkUrl = pathToFileURL(path.resolve('dist/index.js')).href;
  const raceRevision = current();
  const childSource = `import { RsiAssetStore } from ${JSON.stringify(sdkUrl)};
    const store = new RsiAssetStore(${JSON.stringify(root)});
    try { store.configure(${JSON.stringify(scope)}, { expectedRevision: ${raceRevision}, quotaBytes: 1073741824 }); console.log('committed'); }
    catch (error) { if (!['asset_revision_conflict','rsi_store_busy'].includes(error.rsiCode)) throw error; console.log('rejected'); }`;
  const races = await Promise.all(
    [0, 1].map(() =>
      runProcess(process.execPath, {
        args: ['--input-type=module', '-e', childSource],
        timeout: 10000,
        maxBuffer: 4096,
      })
    )
  );
  assert.deepEqual(races.map((result) => result.stdout.trim()).sort(), ['committed', 'rejected']);
  assert.equal(current(), raceRevision + 1);
  const beforeRunning = store.read(scope);
  store.update(scope, (state) => {
    state.runs = [
      { runId: 'in-flight', outcome: 'running', adapter: { digest: RSI_BASELINE.digest } },
      ...Array.from({ length: 201 }, (_, index) => ({
        runId: `ended-${index}`,
        outcome: 'completed',
      })),
    ];
  });
  assert.equal(
    store.read(scope).runs.some((run) => run.runId === 'in-flight'),
    true,
    'bounded run retention must preserve in-flight references'
  );
  assert.throws(
    () => service.restore(scope, backup, { expectedRevision: current() }),
    /restore_runs_still_running/
  );
  store.update(scope, (state) => {
    state.runs = beforeRunning.runs;
  });
  // A consumed claim written before a failed main-index replacement is never refunded.
  const previousIndex = fs.readFileSync(file);
  store.update(scope, (state) => {
    state.holdoutConsumptions.push({
      digest: rsiDigest('write-before-state-claim'),
      at: Date.now(),
    });
  });
  fs.writeFileSync(file, previousIndex);
  assert.equal(
    store.read(scope).holdoutConsumptions.length,
    2,
    'durable ledger wins over an older index'
  );
  const recoveryRevision = service.recoveryStatus(scope).revision;
  fs.writeFileSync(file, '{broken index');
  assert.throws(() => service.status(scope), /rsi_store_unavailable/);
  service.restore(scope, backup, { expectedRevision: recoveryRevision });
  assert.equal(store.read(scope).holdoutConsumptions.length, 2);
  assert.equal(store.read(scope).candidates.length, 0);
  assert.equal(
    store.read(scope).trainingPolicies[rsiTaskScopeDigest(taskScope)].activeDigest,
    RSI_BASELINE.digest,
    'corrupt-index recovery always selects baseline'
  );
  const safetyFile = path.join(directory, 'safety-ledger.json');
  const validLedger = fs.readFileSync(safetyFile);
  fs.writeFileSync(file, '{broken again');
  const forgedLedger = JSON.parse(validLedger);
  forgedLedger.body.holdoutConsumptions = [];
  fs.writeFileSync(safetyFile, JSON.stringify(forgedLedger));
  assert.throws(
    () => service.restore(scope, backup, { expectedRevision: recoveryRevision }),
    /safety_ledger_unavailable/
  );
  fs.unlinkSync(safetyFile);
  assert.throws(
    () => service.restore(scope, backup, { expectedRevision: recoveryRevision }),
    /safety_ledger_unavailable/,
    'missing safety history is explicitly unrecoverable'
  );
  fs.writeFileSync(safetyFile, validLedger);
  fs.unlinkSync(file);
  assert.throws(
    () => store.read(scope),
    /rsi_store_unavailable/,
    'missing owner index never resets history'
  );
  service.restore(scope, backup, { expectedRevision: service.recoveryStatus(scope).revision });
  const restored = new RsiAssetStore(root).status(scope);
  assert.equal(restored.schemaVersion, 3);
  assert.equal(restored.records.length, 1);
  assert.equal(restored.records[0].id, otherExperience.id);
  assert.equal(new RsiEngine({ rootDir: root }).store.read(scope).holdoutConsumptions.length, 2);
  const repairScope = { ...scope, ownerKey: 'repair-owner' };
  const repairAsset = service.put(repairScope, taskScope, {
    kind: 'experience',
    content: 'authenticated recovery bytes',
    expectedRevision: 0,
  });
  const repairBackup = service.backup(repairScope);
  const repairFile = path.join(
    service.status(repairScope).storageDirectory,
    'assets',
    `${repairAsset.id}.bin`
  );
  fs.writeFileSync(repairFile, 'corrupted');
  assert.throws(
    () => service.read(repairScope, taskScope, repairAsset.id),
    /asset_integrity_failed/
  );
  service.restore(repairScope, repairBackup, {
    expectedRevision: service.status(repairScope).revision,
  });
  assert.equal(
    service.read(repairScope, taskScope, repairAsset.id),
    'authenticated recovery bytes'
  );
  store.update(repairScope, (state) => {
    state.runs.push({ runId: 'repair-document', outcome: 'completed' });
  });
  const documentBackup = service.backup(repairScope);
  service.configure(repairScope, {
    expectedRevision: service.status(repairScope).revision,
    quotaBytes: 1,
  });
  const lowQuotaBackup = service.backup(repairScope);
  const repairDirectory = service.status(repairScope).storageDirectory;
  const repairIndex = JSON.parse(fs.readFileSync(path.join(repairDirectory, 'state.json')));
  const documentFile = path.join(
    repairDirectory,
    'documents',
    'runs',
    `${repairIndex.documents.runs[0]}.json`
  );
  fs.writeFileSync(documentFile, 'corrupted document');
  assert.throws(
    () =>
      service.restore(repairScope, lowQuotaBackup, {
        expectedRevision: service.recoveryStatus(repairScope).revision,
      }),
    /asset_quota_exceeded/
  );
  assert.equal(
    fs.readFileSync(documentFile, 'utf8'),
    'corrupted document',
    'quota refusal precedes authenticated document repair'
  );
  service.restore(repairScope, documentBackup, {
    expectedRevision: service.recoveryStatus(repairScope).revision,
  });
  assert.equal(store.read(repairScope).runs[0].runId, 'repair-document');
  const bindingScope = { ...scope, ownerKey: 'binding-owner' };
  store.update(bindingScope, (state) => {
    state.trainingSessions = ['first-session', 'second-session'].map((id) => ({
      id,
      taskScope,
      status: 'frozen',
      cases: { training: [], validation: [], holdout: [], regression: [] },
    }));
  });
  const boundAsset = (sessionId, adapterDigest, kind = 'adapter') =>
    service.put(bindingScope, taskScope, {
      kind,
      content: 'identical learned instructions',
      sessionId,
      adapterDigest,
      expectedRevision: service.status(bindingScope).revision,
    });
  const firstBinding = boundAsset('first-session', '1'.repeat(64));
  const secondBinding = boundAsset('second-session', '2'.repeat(64));
  assert.notEqual(
    firstBinding.id,
    secondBinding.id,
    'same text with distinct candidate/session provenance must not alias'
  );
  assert.equal(firstBinding.contentDigest, secondBinding.contentDigest);
  assert.equal(secondBinding.sessionId, 'second-session');
  assert.equal(secondBinding.adapterDigest, '2'.repeat(64));
  assert.equal(
    boundAsset('second-session', '2'.repeat(64)).id,
    secondBinding.id,
    'identical binding remains idempotent'
  );
  assert.notEqual(
    boundAsset('second-session', '2'.repeat(64), 'manifest').id,
    secondBinding.id,
    'distinct asset kinds do not alias'
  );
  const firstDeletion = service.beginDeletion(bindingScope, taskScope, {
    assetIds: [firstBinding.id],
    expectedRevision: service.status(bindingScope).revision,
  });
  service.completeDeletion(bindingScope, taskScope, firstDeletion.id);
  assert.equal(
    service.read(bindingScope, taskScope, secondBinding.id),
    'identical learned instructions'
  );
  assert.equal(
    store.read(bindingScope).trainingSessions.find((item) => item.id === 'second-session').status,
    'frozen'
  );
  console.log(
    'rsi-assets: migration, integrity, owner/scope isolation, cross-process CAS, lease quotas, protected retention, ordered deletion, authenticated backup, monotonic crash recovery and corrupt-ledger refusal passed'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
