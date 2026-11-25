#!/usr/bin/env node
// Offline signed-distribution API example and adversarial behavior probe.
// No learning, remote provider or claimed model gain is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash, verify } from 'node:crypto';
import {
  RsiSharedAdapterStore,
  RsiEngine,
  RsiAssetStore,
  MossAgent,
  InMemorySessionStore,
  rsiAdapterDigest,
  rsiDigest,
} from '../dist/index.js';
import {
  canonicalRsiSharedJson,
  createRsiSharedEnvelope,
  verifyRsiSharedPackage,
  verifyRsiSharedIndex,
  validateRsiSharedPackage,
} from '@rdk-moss/agent/rsi-shared';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-shared-example-')));
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyId = createHash('sha256')
  .update(keys.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const trust = { registryId: 'example-registry', publicKeys: { [keyId]: publicKey } };
const scope = { ownerKey: 'example-a', environment: 'test' };
const other = { ownerKey: 'example-b', environment: 'test' };
let now = Date.now();
const profile = rsiDigest('offline-json-execution-profile');
const packageFor = (version, instructions) => {
  const adapter = { id: 'shared-json-editor', version, instructions };
  return {
    kind: 'rsi-shared-package',
    schemaVersion: 1,
    registryId: trust.registryId,
    packageId: 'json-editor',
    version,
    channel: 'engineering',
    source: 'curated',
    publishedAt: now,
    summary: 'Offline distribution proof; not model learning gain.',
    adapter: { ...adapter, digest: rsiAdapterDigest(adapter) },
    compatibility: {
      sdkApiVersion: 1,
      taskFamily: 'json-config-edit-v1',
      executionProfileDigest: profile,
      models: ['offline-shared-model'],
      tools: ['read', 'write'],
      providerKinds: ['openai-compatible'],
    },
  };
};
const package1 = createRsiSharedEnvelope(
  packageFor('1.0.0', 'Preserve unrelated JSON fields. OFFLINE_SHARED_ONE.'),
  keyId,
  privateKey
);
const package2 = createRsiSharedEnvelope(
  packageFor('1.1.0', 'Read back edited JSON. OFFLINE_SHARED_TWO.'),
  keyId,
  privateKey
);
const entry = (envelope, status = 'published') => ({
  packageId: envelope.payload.packageId,
  version: envelope.payload.version,
  digest: envelope.digest,
  channel: 'engineering',
  status,
});
const indexFor = (revision, entries, issuedAt = now) =>
  createRsiSharedEnvelope(
    {
      kind: 'rsi-shared-index',
      schemaVersion: 1,
      registryId: trust.registryId,
      revision,
      issuedAt,
      expiresAt: issuedAt + 300000,
      entries,
    },
    keyId,
    privateKey
  );
const index1 = indexFor(1, [entry(package1), entry(package2)]);
const store = new RsiSharedAdapterStore(root, { now: () => now });
const context = (projectId) => ({
  taskScope: {
    projectId,
    repositoryRevision: 'a'.repeat(40),
    taskFamily: 'json-config-edit-v1',
    taskFamilyVersion: 'receiver-version',
    capabilitiesDigest: rsiDigest('tools'),
  },
  model: 'offline-shared-model',
  executionProfileDigest: profile,
  tools: ['read', 'write'],
  providerKind: 'openai-compatible',
});
const revision = (owner = scope) => store.overview(owner).revision;
const configure = (owner = scope, overrides = {}) =>
  store.configure(owner, {
    ...trust,
    channel: 'engineering',
    enabled: true,
    expectedRevision: revision(owner),
    ...overrides,
  });
const sync = (index, packages = [], owner = scope) =>
  store.sync(owner, {
    index,
    packages,
    expectedRevision: revision(owner),
  });
const adopt = (projectId, packageDigest, owner = scope) =>
  store.adopt(owner, {
    projectId,
    packageDigest,
    expectedRevision: revision(owner),
  });
try {
  assert.equal(store.capture(scope, context('project-a')), null);
  assert.throws(
    () => configure(scope, { publicKeys: { [keyId]: privateKey } }),
    /invalid_public_key/
  );
  assert.throws(
    () => configure(scope, { publicKeys: { [keyId]: publicKey + privateKey } }),
    /invalid_public_key/
  );
  configure();
  assert.throws(() => configure(scope, { expectedRevision: 0 }), /revision_conflict/);
  assert(
    verify(
      null,
      Buffer.from(
        'moss-rsi-shared/v1\0' + canonicalRsiSharedJson({ keyId, payload: package1.payload })
      ),
      keys.publicKey,
      Buffer.from(package1.signature, 'base64')
    )
  );
  assert.equal(verifyRsiSharedPackage(package1, trust, now).digest, package1.digest);
  assert.equal(verifyRsiSharedIndex(index1, trust, now).payload.revision, 1);
  const tampered = structuredClone(package1);
  tampered.payload.adapter.instructions += ' altered';
  assert.throws(() => sync(index1, [tampered]));
  sync(index1);
  assert.equal(
    store.overview(scope).installed.length,
    0,
    'Directory synchronization does not silently install'
  );
  assert.throws(() => adopt('project-a', package1.digest), /package_unavailable/);
  sync(index1, [package1, package2]);
  adopt('project-a', package1.digest);
  adopt('project-b', package1.digest);
  assert.equal(store.capture(scope, context('project-c')), null);
  assert.equal(store.capture(other, context('project-a')), null);
  configure(other);
  sync(index1, [package1], other);
  adopt('foreign-project', package1.digest, other);
  assert.equal(
    store.capture(other, context('foreign-project')).adapter.digest,
    package1.payload.adapter.digest
  );
  assert.equal(store.capture(scope, { ...context('project-a'), model: 'another-model' }), null);
  assert.equal(
    store.capture(scope, { ...context('project-a'), tools: ['read', 'write', 'exec'] }),
    null
  );
  assert.equal(
    store.capture(scope, {
      ...context('project-a'),
      executionProfileDigest: rsiDigest('changed-profile'),
    }),
    null
  );
  const selected = store.capture(scope, context('project-a'));
  assert.equal(selected.receipt.registry.packageDigest, package1.digest);
  assert.equal(selected.receipt.applicationMode, 'native-sdk');

  // Drive the ordinary native adapter path with a scripted provider, not a forged run receipt.
  const engine = new RsiEngine({ rootDir: root });
  const observer = engine.createRunObserver({
    scope,
    runId: 'shared-native',
    adapter: selected,
    model: 'offline-shared-model',
  });
  assert(observer);
  const agent = new MossAgent({
    model: 'offline-shared-model',
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    llmProvider: {
      id: 'offline-shared-model',
      capabilities: { streaming: false },
      async complete(request) {
        assert(request.systemPrompt.includes(package1.payload.adapter.instructions));
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'OFFLINE_SHARED_APPLIED' }],
        };
      },
    },
    onAgentLoopEvent(event, identity) {
      if (identity.runId === 'shared-native') observer.onEvent(event);
    },
  });
  try {
    const result = await agent.chat('shared-session', 'Reply once.', {
      runId: 'shared-native',
      taskFlow: false,
      harnessAdapter: selected.harnessAdapter,
    });
    assert.equal(result.response, 'OFFLINE_SHARED_APPLIED');
    observer.finish('completed');
    assert.equal(
      engine.getRun(scope, 'shared-native').adapter.registry.packageDigest,
      package1.digest
    );
  } finally {
    await agent.close({ stopBackgroundProcesses: false });
  }

  adopt('project-a', package2.digest);
  const reopened = new RsiSharedAdapterStore(root, { now: () => now });
  assert.equal(
    reopened.capture(scope, context('project-a')).receipt.registry.packageDigest,
    package2.digest
  );
  store.rollback(scope, { projectId: 'project-a', expectedRevision: revision() });
  assert.equal(
    store.capture(scope, context('project-a')).receipt.registry.packageDigest,
    package1.digest
  );
  store.rollback(scope, { projectId: 'project-a', expectedRevision: revision() });
  assert.equal(
    store.capture(scope, context('project-a')),
    null,
    'First adopted version rolls back to baseline'
  );
  assert(store.capture(scope, context('project-b')), 'Other projects keep their own policy');
  adopt('project-a', package1.digest);
  const assets = new RsiAssetStore(root),
    backup = assets.backup(scope);
  const index2 = indexFor(2, [entry(package1, 'revoked'), entry(package2)]);
  sync(index2);
  assert.equal(store.capture(scope, context('project-a')), null);
  assets.restore(scope, backup, { expectedRevision: assets.status(scope).revision });
  assert.equal(
    store.capture(scope, context('project-a')),
    null,
    'Personal backup cannot resurrect a revoked registry package'
  );
  assert.throws(() => sync(index1), /index_rollback/);
  assert.throws(() => sync(indexFor(2, [entry(package1), entry(package2)])), /index_fork/);
  assert.throws(
    () => sync(indexFor(3, [entry(package1), entry(package2)])),
    /revoked_package_republished/
  );
  const replacement = createRsiSharedEnvelope(
    packageFor('1.0.0', 'Different content.'),
    keyId,
    privateKey
  );
  assert.throws(() => sync(indexFor(3, [entry(replacement), entry(package2)])), /version_conflict/);
  now++;
  sync(indexFor(2, [entry(package1, 'revoked'), entry(package2)]));
  assert.equal(
    store.overview(scope).indexFresh,
    true,
    'Same revision refreshes signed freshness without changing content'
  );
  for (const value of [
    ['s', 'k', '-'].join('') + 'a'.repeat(30),
    'Authorization: ' + 'Bearer ' + 'b'.repeat(24),
    'apiKey=' + 'c'.repeat(24),
  ])
    assert.throws(
      () => validateRsiSharedPackage(packageFor('2.0.0', value)),
      /package_contains_credentials/
    );
  adopt('project-a', package2.digest);
  configure(scope, { channel: 'stable' });
  assert.equal(
    store.capture(scope, context('project-a')),
    null,
    'Engineering is never silently a stable package'
  );
  configure();
  now += 300001;
  assert.equal(store.capture(scope, context('project-a')), null);
  assert.throws(() => sync(index2), /index_expired/);
  console.log(
    'rsi-shared example: signed distribution, native receipt, project/owner isolation, tamper, revocation, expiry, backup, restart and rollback PASS (offline; no model learning claim)'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
